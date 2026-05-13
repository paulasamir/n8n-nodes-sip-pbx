import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { DIAL_STATUS_ANSWERED, LEG_STATUS_CALLBACK, LEG_STATUS_ENDED } from "../../shared/result-events";
import { normalizeStringList } from "../../shared/string-utils";
import { daemonError } from "../core/daemon-error";
import { newQueueEntryId } from "../core/ids";
import { nowMs } from "../core/time";
import { DialService } from "../dials/dial-service";
import type { DialStatus } from "../dials/types";
import { LegService } from "../legs/leg-service";
import { QueueEntryRegistry } from "./queue-entry-registry";
import { QueueStatsTracker } from "./queue-stats-tracker";
import { QueueTriggerPublisherService } from "./queue-trigger-publisher";
import { QueueEntry, type QueueEntryDialConfig, type QueueTriggerConfig } from "./types";

type QueueDialMaker = (input: Record<string, unknown>) => { dialId: string; legId?: string };

export class QueueService {
  private readonly entries: QueueEntryRegistry;
  private readonly legService: LegService;
  private readonly dialService: DialService;
  private readonly publisher: QueueTriggerPublisherService;
  private readonly resolveTriggerConfig: (ref: string) => QueueTriggerConfig | null;
  private readonly resolveOnlineExtensionNumbers: (workflowScopeKey: string, configuredExtensionNumbers: string[]) => string[];
  private readonly resolveAvailableExtensionNumbers: (workflowScopeKey: string, configuredExtensionNumbers: string[]) => string[];
  private readonly stats = new QueueStatsTracker();
  private readonly branchTimers = new Map<string, NodeJS.Timeout>();
  private readonly makeQueueDial: QueueDialMaker;

  constructor(
    entries: QueueEntryRegistry,
    legService: LegService,
    dialService: DialService,
    publisher: QueueTriggerPublisherService,
    makeQueueDial: QueueDialMaker,
    resolveTriggerConfig?: (ref: string) => QueueTriggerConfig | null,
    resolveOnlineExtensionNumbers?: (workflowScopeKey: string, configuredExtensionNumbers: string[]) => string[],
    resolveAvailableExtensionNumbers?: (workflowScopeKey: string, configuredExtensionNumbers: string[]) => string[],
  ) {
    this.entries = entries;
    this.legService = legService;
    this.dialService = dialService;
    this.publisher = publisher;
    this.makeQueueDial = makeQueueDial;
    this.resolveTriggerConfig = resolveTriggerConfig || (() => null);
    this.resolveOnlineExtensionNumbers = resolveOnlineExtensionNumbers || ((_workflowScopeKey, configuredExtensionNumbers) => configuredExtensionNumbers.slice());
    this.resolveAvailableExtensionNumbers = resolveAvailableExtensionNumbers || ((_workflowScopeKey, configuredExtensionNumbers) => configuredExtensionNumbers.slice());
  }

  enqueueLeg(
    ref: string,
    legId: string,
    placement: "front" | "back",
    queueDialConfig?: Partial<QueueEntryDialConfig>,
    options?: { rejoinExisting?: boolean; retryAttempts?: number; retryPauseMs?: number },
  ): { legId: string } {
    const triggerConfig = this.getTriggerConfig(ref, true);
    if (this.entries.getByLegId(legId)) {
      throw daemonError("invalid_queue_entry", `Leg ${legId} already owns an active queue entry`);
    }
    const leg = this.legService.requireLeg(legId);
    const triggerMetadata = leg.triggerMetadata as { publicRef?: unknown; ref?: unknown; extensionNumber?: unknown };
    const trunkRef = String(triggerMetadata?.publicRef || triggerMetadata?.ref || "").trim();
    const hasExtensionMarker = String(triggerMetadata?.extensionNumber || "").trim() !== "";
    if (leg.direction !== "inbound" || leg.transportType !== "sip" || hasExtensionMarker || !trunkRef) {
      throw daemonError(
        "invalid_queue_leg",
        `Leg ${legId} must be an inbound SIP leg originating from a trunk trigger`,
      );
    }
    const signaling = leg.signalingDetails as { callerNumber?: unknown; callerName?: unknown };
    const callerNumber = String(queueDialConfig?.callerNumber || "").trim() || String(signaling?.callerNumber || "").trim();
    const callerName = String(queueDialConfig?.callerName || "").trim() || String(signaling?.callerName || "").trim();
    const retryAttempts = options?.retryAttempts == null
      ? OPTION_DEFAULTS.trigger.queue.retryAttempts
      : Math.max(0, Math.round(Number(options.retryAttempts)));
    const retryPauseMs = options?.retryPauseMs == null
      ? Math.round(OPTION_DEFAULTS.trigger.queue.retryPauseSeconds * 1000)
      : Math.max(0, Math.round(Number(options.retryPauseMs)));
    if (options?.rejoinExisting !== false && callerNumber) {
      const rejoinCandidate = this.findRejoinCandidate(ref, trunkRef, callerNumber);
      if (rejoinCandidate) {
        const retention = this.legService.retainLeg(legId, `queue:${rejoinCandidate.queueEntryId}`);
        rejoinCandidate.toRejoined(legId, retention);
        rejoinCandidate.retryAttempts = retryAttempts;
        rejoinCandidate.retryPauseMs = retryPauseMs;
        this.entries.replaceLegBinding(rejoinCandidate, legId);
        this.legService.updateStatus(legId, "queued");
        this.scheduleEntryBranch(rejoinCandidate, 0);
        return { legId };
      }
    }
    const queueEntryId = newQueueEntryId();
    const entry = new QueueEntry({
      queueEntryId,
      ref,
      legId,
      workflowScopeKey: triggerConfig.workflowScopeKey,
      trunkRef,
      retryAttempts,
      retryPauseMs,
      queueDialConfig: {
        callStrategy: queueDialConfig?.callStrategy === "sequential" ? "sequential" : "parallel",
        callerNumber,
        callerName,
        customSipHeaders: Array.isArray(queueDialConfig?.customSipHeaders)
          ? queueDialConfig!.customSipHeaders
            .filter((value) => value && typeof value === "object")
            .map((value) => ({
              name: String((value as { name?: string }).name || "").trim(),
              value: String((value as { value?: string }).value || ""),
            }))
            .filter((value) => value.name)
          : [],
        extensionListOnlyFreeEndpoints: queueDialConfig?.extensionListOnlyFreeEndpoints !== false,
        sequentialAttemptTimeoutSeconds: Math.max(0, Number(queueDialConfig?.sequentialAttemptTimeoutSeconds || OPTION_DEFAULTS.dial.sequentialAttemptTimeoutSeconds)),
        sequentialGapSeconds: Math.max(0, Number(queueDialConfig?.sequentialGapSeconds || OPTION_DEFAULTS.dial.sequentialGapSeconds)),
      },
      retention: this.legService.retainLeg(legId, `queue:${queueEntryId}`),
    });
    this.entries.create(entry, placement);
    this.legService.updateStatus(legId, "queued");
    this.scheduleEntryBranch(entry, 0);
    return { legId };
  }

  removeEntryForLeg(legId: string): { legId: string; removed: boolean } {
    const entry = this.entries.getByLegId(legId);
    if (!entry) {
      return { legId, removed: false };
    }
    if (entry.callbackEnabled && entry.mode === "live") {
      this.abortActiveDial(entry, "queue_callback");
      entry.toCallback();
      this.retryEntry(entry, entry.retryPauseMs);
      return { legId, removed: false };
    }
    this.endEntry(entry, "queue_entry_removed");
    return { legId, removed: true };
  }

  setQueueCallback(legId: string, callbackEnabled: boolean): { legId: string; callbackEnabled: boolean } {
    const entry = this.entries.getByLegId(legId);
    if (!entry) {
      throw daemonError("invalid_queue_entry", `Leg ${legId} does not own an active queue entry`);
    }
    entry.callbackEnabled = callbackEnabled;
    entry.updatedAt = nowMs();
    return { legId, callbackEnabled };
  }

  takeQueueEntry(queueEntryId: string): { queueEntryId: string } {
    const entry = this.entries.get(queueEntryId);
    if (!entry) {
      throw daemonError("invalid_queue_entry", `Unknown queue entry ${queueEntryId}`);
    }
    this.stats.recordCompletion(entry.ref, nowMs() - entry.createdAt);
    this.endEntry(entry, "queue_taken");
    return { queueEntryId };
  }

  handleDialFinalized(dialId: string, status: DialStatus, _reason?: string): void {
    const entry = this.entries.getByDialId(dialId);
    if (!entry) {
      return;
    }
    if (status === DIAL_STATUS_ANSWERED) {
      this.takeQueueEntry(entry.queueEntryId);
      return;
    }
    const config = this.getTriggerConfig(entry.ref);
    entry.retryCount += 1;
    if (entry.retryCount > entry.retryAttempts) {
      this.endEntry(entry, "queue_retries_exhausted");
      this.publisher.publishOffline(entry.ref, config.publicRef, {
        mode: entry.mode,
        legId: this.resolvePublishedLiveLegId(entry),
      });
      return;
    }
    this.maybePublishPlaced(entry, config);
    this.retryEntry(entry, entry.retryPauseMs);
  }

  private retryEntry(entry: QueueEntry, delayMs: number): void {
    this.abortActiveDial(entry, "queue_retry");
    const normalizedDelay = Math.max(0, delayMs);
    entry.retryNotBeforeAt = nowMs() + normalizedDelay;
    entry.updatedAt = nowMs();
    this.scheduleEntryBranch(entry, normalizedDelay);
  }

  private maybePublishPlaced(entry: QueueEntry, config: QueueTriggerConfig): void {
    if (entry.mode !== "live" || entry.placedPublished) {
      return;
    }
    entry.placedPublished = true;
    entry.updatedAt = nowMs();
    this.publisher.publishPlaced(entry.ref, config.publicRef, entry.legId);
  }

  getQueueStats(target: { ref?: string; legId?: string }): Record<string, unknown> {
    const resolvedRef = target.ref || this.entries.getByLegId(String(target.legId || ""))?.ref;
    if (!resolvedRef) {
      throw daemonError("invalid_queue_stats_target", "Unknown queue target");
    }
    const config = this.getTriggerConfig(resolvedRef, Boolean(target.ref));
    const entries = this.entries.listByRef(resolvedRef);
    if (target.legId) {
      const entry = this.entries.getByLegId(target.legId);
      if (!entry) {
        throw daemonError("invalid_queue_stats_target", `Leg ${target.legId} is not in queue`);
      }
      const position = entries.findIndex((item) => item.legId === target.legId) + 1;
      return {
        ref: config.publicRef,
        legId: entry.legId,
        size: entries.length,
        averageWaitSeconds: this.stats.getAverageWaitMs(resolvedRef) / 1000,
        completedCount: this.stats.getCompletedCount(resolvedRef),
        updatedAt: nowMs(),
        position,
        estimatedAnswerSeconds: this.stats.getEstimatedAnswerMs(resolvedRef, position) / 1000,
      };
    }
    return {
      ref: config.publicRef,
      size: entries.length,
      averageWaitSeconds: this.stats.getAverageWaitMs(resolvedRef) / 1000,
      completedCount: this.stats.getCompletedCount(resolvedRef),
      updatedAt: nowMs(),
    };
  }

  refreshWorkflowScope(workflowScopeKey: string): void {
    for (const entry of this.entries.values()) {
      if (entry.workflowScopeKey !== workflowScopeKey) {
        continue;
      }
      if (entry.isDispatching()) {
        continue;
      }
      const retryDelayMs = Math.max(0, entry.retryNotBeforeAt - nowMs());
      this.scheduleEntryBranch(entry, retryDelayMs);
    }
  }

  private endEntry(entry: QueueEntry, reason: string): void {
    if (entry.isEnded()) {
      return;
    }
    this.abortActiveDial(entry, reason);
    this.clearBranchTimer(entry.queueEntryId);
    this.entries.removeEntry(entry.queueEntryId);
    entry.toEnded();
  }

  private scheduleEntryBranch(entry: QueueEntry, delayMs: number): void {
    this.clearBranchTimer(entry.queueEntryId);
    const handle = setTimeout(() => {
      const activeEntry = this.entries.getByLegId(entry.legId);
      if (!activeEntry || activeEntry.queueEntryId !== entry.queueEntryId || activeEntry.isDispatching()) {
        return;
      }
      const retryDelayMs = Math.max(0, activeEntry.retryNotBeforeAt - nowMs());
      if (retryDelayMs > 0) {
        this.scheduleEntryBranch(activeEntry, retryDelayMs);
        return;
      }
      this.publishEntryBranch(activeEntry);
    }, Math.max(0, delayMs));
    this.branchTimers.set(entry.queueEntryId, handle);
  }

  private publishEntryBranch(entry: QueueEntry): void {
    const config = this.getTriggerConfig(entry.ref);
    const onlineExtensionNumbers = normalizeStringList(
      this.resolveOnlineExtensionNumbers(entry.workflowScopeKey, config.queueExtensions),
    );
    const reserved = this.reservedExtensionNumbers(entry.workflowScopeKey);
    const availableExtensionNumbers = normalizeStringList(
      this.resolveAvailableExtensionNumbers(entry.workflowScopeKey, config.queueExtensions),
    ).filter((extensionNumber) => !reserved.has(extensionNumber));
    if (onlineExtensionNumbers.length === 0) {
      this.endEntry(entry, "queue_offline");
      this.publisher.publishOffline(entry.ref, config.publicRef, {
        mode: entry.mode,
        legId: this.resolvePublishedLiveLegId(entry),
      });
      return;
    }
    if (availableExtensionNumbers.length === 0) {
      this.maybePublishPlaced(entry, config);
      return;
    }

    const dialResult = this.makeQueueDial({
      callMode: "extension",
      workflowScopeKey: entry.workflowScopeKey,
      extensionNumbers: availableExtensionNumbers.slice(),
      callStrategy: entry.queueDialConfig.callStrategy,
      callerNumber: entry.queueDialConfig.callerNumber,
      callerName: entry.queueDialConfig.callerName,
      customSipHeaders: entry.queueDialConfig.customSipHeaders,
      extensionListOnlyFreeEndpoints: entry.queueDialConfig.extensionListOnlyFreeEndpoints,
      sequentialAttemptTimeoutSeconds: entry.queueDialConfig.sequentialAttemptTimeoutSeconds,
      sequentialGapSeconds: entry.queueDialConfig.sequentialGapSeconds,
    });
    const dialId = String(dialResult?.dialId || "").trim();
    if (!dialId) {
      throw daemonError("invalid_dial", `Queue ${config.publicRef} did not receive a dialId from signaling`);
    }
    entry.toDispatching(dialId, availableExtensionNumbers);

    this.publisher.publishDispatch(entry.ref, config.publicRef, {
      mode: entry.mode,
      legId: this.resolvePublishedLiveLegId(entry),
      dialId,
      callerNumber: entry.queueDialConfig.callerNumber,
      callerName: entry.queueDialConfig.callerName,
      trunkRef: entry.trunkRef,
    });
  }

  private resolvePublishedLiveLegId(entry: QueueEntry): string | undefined {
    if (entry.mode !== "live") {
      return undefined;
    }
    const leg = this.legService.getLeg(entry.legId);
    if (!leg || leg.status === LEG_STATUS_ENDED || leg.status === LEG_STATUS_CALLBACK) {
      return undefined;
    }
    return leg.legId;
  }

  private findRejoinCandidate(
    ref: string,
    trunkRef: string,
    callerNumber: string,
  ): QueueEntry | null {
    let best: QueueEntry | null = null;
    for (const entry of this.entries.listByRef(ref)) {
      if (entry.trunkRef !== trunkRef) {
        continue;
      }
      if (entry.queueDialConfig.callerNumber !== callerNumber) {
        continue;
      }
      const existingLeg = this.legService.getLeg(entry.legId);
      if (existingLeg && existingLeg.status !== LEG_STATUS_ENDED) {
        continue;
      }
      if (!best || entry.createdAt < best.createdAt) {
        best = entry;
      }
    }
    return best;
  }

  private abortActiveDial(entry: QueueEntry, reason: string): void {
    const dialId = entry.dispatchedDialId;
    if (!dialId) {
      return;
    }
    entry.toIdle();
    const dial = this.dialService.getDial(dialId);
    if (dial && !dial.finalizedAt) {
      this.dialService.breakDial(dialId, reason);
    }
  }

  private clearBranchTimer(queueEntryId: string): void {
    const handle = this.branchTimers.get(queueEntryId);
    if (!handle) {
      return;
    }
    clearTimeout(handle);
    this.branchTimers.delete(queueEntryId);
  }

  private getTriggerConfig(ref: string, requireExisting = false): QueueTriggerConfig {
    const config = this.resolveTriggerConfig(ref);
    if (requireExisting && !config) {
      throw daemonError("invalid_queue_stats_target", `Unknown queue ref ${ref}`);
    }
    return {
      ref,
      publicRef: String(config?.publicRef || ref || "").trim(),
      workflowScopeKey: String(config?.workflowScopeKey || "").trim(),
      queueExtensions: normalizeStringList(config?.queueExtensions),
    };
  }

  private reservedExtensionNumbers(workflowScopeKey: string): Set<string> {
    const reserved = new Set<string>();
    for (const entry of this.entries.values()) {
      if (!entry.isDispatching()) {
        continue;
      }
      if (entry.workflowScopeKey !== workflowScopeKey) {
        continue;
      }
      for (const extensionNumber of entry.reservedExtensions) {
        reserved.add(extensionNumber);
      }
    }
    return reserved;
  }

}

import { daemonError } from "../core/daemon-error";
import type { RetentionTicket } from "../core/operation-retainer";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { nowMs } from "../core/time";
import { MapRegistry } from "../../shared/map-registry";
import { TerminalSnapshotStore } from "../core/terminal-snapshot-store";
import { LegCoordinator } from "../legs/leg-coordinator";
import { LegService } from "../legs/leg-service";
import {
  DIAL_EVENT_ANSWERED,
  DIAL_EVENT_FAILED,
  DIAL_EVENT_PROGRESS,
  DIAL_EVENT_REJECTED,
  DIAL_EVENT_TIMEOUT,
  DIAL_STATUS_ANSWERED,
  DIAL_STATUS_FAILED,
  DIAL_STATUS_REJECTED,
} from "../../shared/result-events";
import { Dial, formatDialTarget, type DialEvent, type DialInput, type DialTarget } from "./types";

export class DialService {
  private readonly registry: MapRegistry<string, Dial>;
  private readonly legService: LegService;
  private readonly legCoordinator: LegCoordinator;
  private readonly terminalSnapshots: TerminalSnapshotStore<DialEvent & { dialId: string }>;
  private readonly winnerLegRetentions = new Map<string, RetentionTicket>();
  private onAttemptStarted: (dial: Dial, legId: string, target: DialTarget) => void;
  private onAttemptAnswered: (dial: Dial, legId: string) => void;
  private onDialFinalized: (dial: Dial, status: Dial["status"], reason?: string) => void;

  constructor(
    registry: MapRegistry<string, Dial>,
    legService: LegService,
    legCoordinator?: LegCoordinator,
    terminalSnapshots?: TerminalSnapshotStore<DialEvent & { dialId: string }>,
  ) {
    this.registry = registry;
    this.legService = legService;
    this.legCoordinator = legCoordinator || new LegCoordinator();
    this.terminalSnapshots = terminalSnapshots || new TerminalSnapshotStore<DialEvent & { dialId: string }>();
    this.onAttemptStarted = () => undefined;
    this.onAttemptAnswered = () => undefined;
    this.onDialFinalized = () => undefined;
  }

  setOnAttemptStarted(onAttemptStarted: (dial: Dial, legId: string, target: DialTarget) => void): void {
    this.onAttemptStarted = onAttemptStarted;
  }

  setOnAttemptAnswered(onAttemptAnswered: (dial: Dial, legId: string) => void): void {
    this.onAttemptAnswered = onAttemptAnswered;
  }

  setOnDialFinalized(onDialFinalized: (dial: Dial, status: Dial["status"], reason?: string) => void): void {
    this.onDialFinalized = onDialFinalized;
  }

  createDial(input: DialInput): Dial {
    const plannedTargets = input.targets.slice();
    if (plannedTargets.length === 0) {
      throw daemonError("invalid_dial_targets", "Dial requires at least one target");
    }
    const dial = Dial.create(this.registry, {
      strategy: input.strategy,
      mode: input.mode,
      targets: plannedTargets,
      metadata: { ...(input.metadata || {}) },
      sequentialAttemptTimeoutMs: Number(input.sequentialAttemptTimeoutMs || 0),
      sequentialGapMs: Number(input.sequentialGapMs || 0),
      onDestroy: this.handleDialDestroy.bind(this),
    });
    console.error(
      `[sip-pbx:dial] create; dial=${dial.dialId}; mode=${String(dial.mode || "") || "none"}; strategy=${dial.strategy}; targets=${dial.targets.map((target) => formatDialTarget(target)).join(",") || "none"}`,
    );
    if (input.strategy === "parallel") {
      while (dial.pendingTargets.length > 0) {
        this.startNextAttempt(dial);
      }
    } else {
      this.startNextAttempt(dial);
    }
    return dial;
  }

  getDial(dialId: string): Dial | null {
    return this.registry.get(dialId);
  }

  requireDial(dialId: string): Dial {
    const dial = this.getDial(dialId);
    if (!dial) {
      throw daemonError("invalid_dial", `Unknown dial ${dialId}`);
    }
    return dial;
  }

  /** Convenience: acquire a retention ticket on the dial identified by `dialId`. */
  retainDial(dialId: string, tag: string): RetentionTicket {
    return this.requireDial(dialId).retain(tag);
  }

  breakDial(dialId: string, reason: string): { dialId: string } {
    const dial = this.requireDial(dialId);
    if (dial.finalizedAt) {
      return { dialId };
    }
    this.finalizeDial(dialId, "failed", reason || OPTION_DEFAULTS.dial.breakReason);
    return { dialId };
  }

  markAttemptBridged(dialId: string, legId: string): void {
    const dial = this.requireDial(dialId);
    if (dial.finalizedAt || dial.winnerLegId || !dial.activeAttemptLegIds.includes(legId)) {
      return;
    }
    console.error(`[sip-pbx:dial] attempt bridged; dial=${dialId}; leg=${legId}; activeAttempts=${dial.activeAttemptLegIds.length}`);
    this.markAttemptAnswered(dialId, legId);
  }

  finalizeDial(dialId: string, status: Dial["status"], reason?: string): void {
    const dial = this.registry.get(dialId);
    if (!dial) return;
    if (dial.finalizedAt) {
      return;
    }
    void dial.destroy(status, reason).catch((error) => {
      console.error(
        `[sip-pbx:dial] dial finalization failed; dial=${dialId}; status=${status}; reason=${String(reason || "") || "none"}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    });
  }

  markAttemptAnswered(dialId: string, legId: string): void {
    const dial = this.requireDial(dialId);
    if (dial.finalizedAt) return;

    dial.clearAttemptTimeout(legId);
    dial.winnerLegId = legId;
    dial.status = "answered";

    // Transfer ownership of the answered leg from the dial attempt
    // to the live call lifecycle.
    if (!this.winnerLegRetentions.has(legId)) {
      this.winnerLegRetentions.set(
        legId,
        this.legService.retainLeg(legId, `dial-winner:${dialId}`),
      );
    }

    this.onAttemptAnswered(dial, legId);
    dial.publishEvent({
      eventType: DIAL_EVENT_ANSWERED,
      legId,
      createdAt: nowMs(),
    });

    for (const attemptLegId of dial.attemptLegIds) {
      if (attemptLegId === legId) continue;

      if (dial.releaseAttemptOwnership(attemptLegId)) {
        dial.releaseAttemptRetention(attemptLegId);
      }

      this.legService.hangupLeg(attemptLegId, "parallel_loser");
    }

    this.finalizeDial(dialId, "answered");
  }

  handleAttemptLegEnded(legId: string): void {
    const winnerRetention = this.winnerLegRetentions.get(legId);

    if (winnerRetention) {
      this.winnerLegRetentions.delete(legId);
      winnerRetention.release();
    }
    for (const dial of this.registry.values()) {
      if (!dial.hasActiveAttempt(legId)) {
        continue;
      }
      dial.clearAttemptTimeout(legId);
      if (!dial.releaseAttemptOwnership(legId)) {
        continue;
      }
      dial.releaseAttemptRetention(legId);
      if (dial.finalizedAt) {
        continue;
      }
      if (dial.activeAttemptLegIds.length === 0 && dial.strategy === "sequential" && dial.pendingTargets.length > 0) {
        this.scheduleSequentialNextAttempt(dial);
        continue;
      }
      if (dial.activeAttemptLegIds.length === 0) {
        this.finalizeDial(dial.dialId, "failed", "leg_ended");
      }
    }
  }

  markAttemptProgress(dialId: string, legId: string): void {
    const dial = this.requireDial(dialId);
    if (dial.finalizedAt) return;
    if (!dial.activeAttemptLegIds.includes(legId)) {
      return;
    }
    dial.publishEvent({ eventType: DIAL_EVENT_PROGRESS, legId, createdAt: nowMs() });
  }

  markAttemptRejected(dialId: string, legId: string, reason = "rejected"): void {
    const dial = this.requireDial(dialId);
    if (dial.finalizedAt) return;
    dial.clearAttemptTimeout(legId);
    dial.publishEvent({ eventType: DIAL_EVENT_REJECTED, legId, reason, createdAt: nowMs() });
    if (dial.releaseAttemptOwnership(legId)) {
      dial.releaseAttemptRetention(legId);
    }
    this.legService.hangupLeg(legId, reason);
    if (dial.activeAttemptLegIds.length === 0 && dial.strategy === "sequential" && dial.pendingTargets.length > 0) {
      this.scheduleSequentialNextAttempt(dial);
      return;
    }
    if (dial.activeAttemptLegIds.length === 0) {
      this.finalizeDial(dialId, "failed", reason);
    }
  }

  markAttemptFailed(dialId: string, legId: string, reason = "failed"): void {
    const dial = this.requireDial(dialId);
    if (dial.finalizedAt) return;
    console.error(`[sip-pbx:dial] attempt failed; dial=${dialId}; leg=${legId}; reason=${reason}`);
    dial.clearAttemptTimeout(legId);
    if (dial.releaseAttemptOwnership(legId)) {
      dial.releaseAttemptRetention(legId);
    }
    this.legService.hangupLeg(legId, reason);
    this.finalizeDial(dialId, "failed", reason);
  }

  private startNextAttempt(dial: Dial): void {
    const target = dial.pendingTargets.shift();
    if (!target) {
      console.error(
        `[sip-pbx:dial] startNextAttempt skipped; dial=${dial.dialId}; reason=no_target; activeAttempts=${dial.activeAttemptLegIds.length}; pendingTargets=${dial.pendingTargets.length}; finalized=${Boolean(dial.finalizedAt)}`,
      );
      return;
    }
    const extensionTarget = dial.mode === "extension" && target.kind === "extension"
      ? target
      : null;
    const targetLabel = formatDialTarget(target);
    const leg = this.legService.createLeg({
      direction: "outbound",
      transportType: dial.mode === "websocket" ? "websocket" : "sip",
      triggerMetadata: dial.mode === "extension"
        ? {
          ref: extensionTarget?.ref || "",
          extensionNumber: extensionTarget?.extensionNumber || targetLabel,
          endpointId: extensionTarget?.endpointId || "",
        }
        : {},
      signalingDetails: {
        ...(dial.metadata || {}),
        target: extensionTarget?.extensionNumber || targetLabel,
        dialId: dial.dialId,
        attemptIndex: dial.attemptLegIds.length,
        strategy: dial.strategy,
      },
    });
    dial.addAttemptLeg(leg.legId, this.legService.retainLeg(leg.legId, `dial-attempt:${dial.dialId}`));
    console.error(
      `[sip-pbx:dial] startNextAttempt; dial=${dial.dialId}; leg=${leg.legId}; mode=${String(dial.mode || "") || "none"}; target=${targetLabel}; strategy=${dial.strategy}; pendingTargets=${dial.pendingTargets.length}`,
    );
    this.onAttemptStarted(dial, leg.legId, target);
    if (dial.strategy === "sequential" && dial.sequentialAttemptTimeoutMs > 0) {
      const timeoutHandle = setTimeout(() => {
        this.markAttemptRejected(dial.dialId, leg.legId, "timeout");
      }, dial.sequentialAttemptTimeoutMs);
      dial.attemptTimeoutTimers.set(leg.legId, timeoutHandle);
    }
  }

  private scheduleSequentialNextAttempt(dial: Dial): void {
    dial.clearGapTimer();
    dial.gapTimer = setTimeout(() => {
      dial.gapTimer = null;
      if (dial.finalizedAt) {
        return;
      }
      this.startNextAttempt(dial);
      if (dial.activeAttemptLegIds.length === 0 && dial.pendingTargets.length === 0) {
        this.finalizeDial(dial.dialId, "failed", "rejected");
      }
    }, Math.max(0, dial.sequentialGapMs));
  }

  private handleDialDestroy(dial: Dial, status: Dial["status"], reason?: string): void {
    const eventType: DialEvent["eventType"] = status === DIAL_STATUS_ANSWERED
      ? DIAL_EVENT_ANSWERED
      : status === DIAL_STATUS_REJECTED
        ? DIAL_EVENT_REJECTED
        : status === DIAL_STATUS_FAILED
          ? DIAL_EVENT_FAILED
          : DIAL_EVENT_TIMEOUT;
    const event: DialEvent = {
      eventType,
      reason,
      legId: dial.winnerLegId || undefined,
      createdAt: dial.finalizedAt || nowMs(),
    };
    console.error(
      `[sip-pbx:dial] finalize; dial=${dial.dialId}; status=${status}; reason=${String(reason || "") || "none"}; winnerLeg=${dial.winnerLegId || "none"}; activeAttempts=${dial.activeAttemptLegIds.length}`,
    );
    this.onDialFinalized(dial, status, reason);
    this.terminalSnapshots.remember(dial.dialId, {
      dialId: dial.dialId,
      ...event,
    });
    dial.publishEvent(event);
    dial.rejectEventWaiters(new Error("dial_finalized"));
    for (const legId of dial.activeAttemptLegIds.slice()) {
      if (!dial.releaseAttemptOwnership(legId)) {
        continue;
      }
      dial.releaseAttemptRetention(legId);
      if (!(status === DIAL_STATUS_ANSWERED && legId === dial.winnerLegId)) {
        this.legService.hangupLeg(legId, reason || OPTION_DEFAULTS.dial.breakReason);
      }
    }
    dial.pendingTargets = [];
    dial.activeAttemptLegIds = [];
  }
}

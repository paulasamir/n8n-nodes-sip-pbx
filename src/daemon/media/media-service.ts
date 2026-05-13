import os from "node:os";
import { Worker, isMainThread } from "worker_threads";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { DIAL_STATUS_REJECTED, LEG_STATUS_ANSWERED, LEG_STATUS_ENDED, MEDIA_EVENT_STARTED, MEDIA_EVENT_TIMEOUT } from "../../shared/result-events";
import { MapRegistry } from "../../shared/map-registry";
import { daemonError, isDaemonError } from "../core/daemon-error";
import type { RequestContext } from "../core/request-context";
import { newMediaId } from "../core/ids";
import { nowMs } from "../core/time";
import type { RetentionTicket } from "../core/operation-retainer";
import { LegCoordinator } from "../legs/leg-coordinator";
import { LegService } from "../legs/leg-service";
import { createReadableMediaEndpoint } from "./io/media-endpoint";
import { PlayAudioOperation } from "./operations/play-audio-operation";
import { findExactPlayTonePreset, getPlayToneDurationMs, parseCanonicalToneSegments, PlayTonesOperation } from "./operations/play-tones-operation";
import { RecordAudioOperation } from "./operations/record-audio-operation";
import { type MediaStatus, MediaOperation, type MediaEvent, requireMediaOperation } from "./operations/media-operation";
import { WaitMediaOperation } from "./operations/wait-media-operation";
import type { LegMediaSessionSnapshot } from "./worker/entities/leg";
import {
  createWorkerControlPlane,
  type WorkerControlPlane,
  type WorkerEnsureEndpointResult,
  type WorkerEndpointState,
  type WorkerRuntimeTransportType,
  type WorkerTransportOutputMessage,
  startWorkerRuntime,
} from "./worker/media-worker";
import { createRtpTransportAttachment } from "./transports/rtp-transport";
import type { MediaTransportDetails, TransportAttachment } from "./transports/media-transport";
import { createWebSocketTransportAttachment } from "./transports/websocket-transport";
import type { WebSocketVoiceAgentEvent } from "./transports/websocket-profiles";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function resolveTonePlaybackDurationMs(input: Record<string, unknown>): number {
  const repeatInfinite = Boolean(input.repeatInfinite);
  if (repeatInfinite) {
    return 0;
  }
  return getPlayToneDurationMs({
    tone: input.tone || OPTION_DEFAULTS.playTone.tone,
    customTone: input.customTone,
  });
}

function validatePlayToneInput(input: Record<string, unknown>): void {
  const tone = String(input.tone || "").trim().toLowerCase();
  if (!tone) {
    throw daemonError("invalid_media", "playTone tone is required");
  }
  if (tone === "custom") {
    const customTone = String(input.customTone || "").trim();
    if (!customTone) {
      throw daemonError("invalid_media", "playTone customTone is required when tone=custom");
    }
    if (!parseCanonicalToneSegments(customTone)) {
      throw daemonError("invalid_media", `Invalid custom tone pattern: ${customTone}`);
    }
    return;
  }
  if (!findExactPlayTonePreset(tone)) {
    throw daemonError("invalid_media", `Unsupported playTone tone: ${tone}`);
  }
}

function buildVoiceInterruptTargets(
  operations: MediaOperation[],
  level: number,
  durationMs: number,
): string[] {
  return operations
    .filter((operation) => operation instanceof PlayAudioOperation || operation instanceof PlayTonesOperation)
    .filter((operation) => Boolean(operation.options.interruptOnVoice))
    .filter((operation) => level >= Math.max(0, Number(operation.options.voiceThreshold || 0)))
    .filter((operation) => durationMs >= Math.max(0, Number(operation.options.voiceDurationMs || 0)))
    .map((operation) => operation.mediaId);
}

function buildDtmfInterruptTargets(operations: MediaOperation[]): string[] {
  return operations
    .filter((operation) => operation instanceof PlayAudioOperation || operation instanceof PlayTonesOperation)
    .filter((operation) => Boolean(operation.options.interruptOnDtmf))
    .map((operation) => operation.mediaId);
}

type EndpointTransportType = WorkerRuntimeTransportType;

type WorkerHandle = {
  workerId: string;
  worker: Worker;
  control: WorkerControlPlane;
};

type BridgePeerInfo = {
  peerLegId: string;
  relayDtmf: string;
  emitDtmfEvents: boolean;
};

type GlobalCallRecordingState = {
  legId: string;
  mediaId: string;
  createdAt: number;
  options: Record<string, unknown>;
  startupPromise: Promise<void>;
  completionPromise: Promise<Record<string, unknown>>;
  resolveCompletion: (result: Record<string, unknown>) => void;
  rejectCompletion: (error: unknown) => void;
  finalizationPromise: Promise<Record<string, unknown>> | null;
};

function buildMediaDetails(snapshot: LegMediaSessionSnapshot): Record<string, unknown> {
  return {
    playbackCount: snapshot.playbackCount,
    recordingActive: snapshot.recordingActive,
    activePlaybackMediaIds: snapshot.activePlaybackMediaIds.slice(),
    activeRecordingMediaId: snapshot.activeRecordingMediaId,
    playbackMix: snapshot.playbackMix.map((entry) => ({ ...entry })),
  };
}

function compareWorkerIds(left: string, right: string): number {
  return left.localeCompare(right);
}


// Execution plane: worker lifecycle, placement, transport control, and worker messaging.
const MEDIA_EXECUTION_WORKER_ID_PREFIX = "worker:";
const MEDIA_EXECUTION_MAX_WORKER_COUNT = Math.max(
  1,
  Math.min(8, typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length || 1),
);
const MEDIA_EXECUTION_IDLE_WORKER_REAP_DELAY_MS = 250;

type MediaExecutionPlane = ReturnType<typeof createMediaExecutionPlane>;

function createMediaExecutionPlane(legService: LegService, legCoordinator: LegCoordinator, options?: {
  onVoiceActivity?: (legId: string, level: number, durationMs: number) => void;
  onInboundDtmf?: (legId: string, digits: string) => void;
  onPlaybackFinished?: (legId: string, mediaId: string) => void;
  onMediaFailure?: (legId: string, mediaId: string, reason: string, error?: string | null) => void;
  onMediaInterrupt?: (legId: string, mediaId: string, reason: string, details?: Record<string, unknown>) => void;
  onVoiceAgentEvent?: (legId: string, event: WebSocketVoiceAgentEvent) => void;
}) {
  const onVoiceActivity = options?.onVoiceActivity || (() => undefined);
  const onInboundDtmf = options?.onInboundDtmf || (() => undefined);
  const onPlaybackFinished = options?.onPlaybackFinished || (() => undefined);
  const onMediaFailure = options?.onMediaFailure || (() => undefined);
  const onMediaInterrupt = options?.onMediaInterrupt || (() => undefined);
  const onVoiceAgentEvent = options?.onVoiceAgentEvent || (() => undefined);
  const workers = new Map<string, WorkerHandle>();
  const legAssignments = new Map<string, string>();
  const transportAttachments = new Map<string, TransportAttachment>();
  const bridgePeerByLegId = new Map<string, BridgePeerInfo>();
  const migratingLegIds = new Set<string>();
  const migrationWaiters = new Map<string, Array<() => void>>();
  const recordingStartupByLegId = new Map<string, Promise<unknown>>();
  const workerReapTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let workerSequence = 0;

  async function withLegLock<T>(legId: string, callback: () => Promise<T> | T): Promise<T> {
    return await legCoordinator.withLeg(legId, callback);
  }

  async function withLegLockMany<T>(legIds: Array<string | null | undefined>, callback: () => Promise<T> | T): Promise<T> {
    return await legCoordinator.withLegs(legIds, callback);
  }

  function clearWorkerReapTimer(workerId: string): void {
    const timer = workerReapTimers.get(workerId) || null;
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    workerReapTimers.delete(workerId);
  }

  function scheduleWorkerReap(workerId: string, delayMs = MEDIA_EXECUTION_IDLE_WORKER_REAP_DELAY_MS): void {
    clearWorkerReapTimer(workerId);
    const timer = setTimeout(() => {
      workerReapTimers.delete(workerId);
      void removeWorkerIfEmpty(workerId);
    }, Math.max(1, delayMs));
    timer.unref?.();
    workerReapTimers.set(workerId, timer);
  }

  async function registerPlayback(input: {
    legId: string;
    mediaId: string;
    kind: "playback" | "tone";
    tone?: string;
    priority?: number;
    duckingFactor?: number;
    interruptOnDtmf?: boolean;
    interruptOnVoice?: boolean;
    voiceThreshold?: number;
    voiceDurationMs?: number;
    sourceRef?: string | null;
    durationMs?: number;
    loopPlayback?: boolean;
    startedAt?: number;
    input?: Record<string, unknown>;
  }): Promise<LegMediaSessionSnapshot> {
    await waitForLegMigrations([input.legId]);
    const worker = await ensureWorkerForLeg(input.legId);
    const snapshot = await worker.control.registerPlayback(
      input.legId,
      resolveTransportType(input.legId),
      input,
    );
    publishSnapshot(snapshot);
    return snapshot;
  }

  async function unregisterPlayback(legId: string, mediaId: string): Promise<LegMediaSessionSnapshot | null> {
    return await withLegLock(legId, async () => {
      await waitForLegMigrations([legId]);
      const worker = findWorkerByLegId(legId);
      if (!worker) {
        return null;
      }
      const snapshot = await worker.control.unregisterPlayback(legId, mediaId);
      if (!snapshot) {
        return null;
      }
      publishSnapshot(snapshot);
      return snapshot;
    });
  }

  async function startRecording(
    legId: string,
    mediaId: string,
    startedAt?: number,
    input?: Record<string, unknown>,
  ): Promise<LegMediaSessionSnapshot> {
    const startup = (async () => {
      await waitForLegMigrations([legId]);
      const worker = await ensureWorkerForLeg(legId);
      const snapshot = await worker.control.startRecording(
        legId,
        resolveTransportType(legId),
        mediaId,
        startedAt,
        input,
      );
      publishSnapshot(snapshot);
      return snapshot;
    })();
    recordingStartupByLegId.set(legId, startup);
    try {
      return await startup;
    } finally {
      if (recordingStartupByLegId.get(legId) === startup) {
        recordingStartupByLegId.delete(legId);
      }
    }
  }

  async function stopRecording(legId: string, mediaId: string): Promise<LegMediaSessionSnapshot | null> {
    return await withLegLock(legId, async () => {
      await waitForLegMigrations([legId]);
      await waitForRecordingStartup(legId);
      const worker = findWorkerByLegId(legId);
      if (!worker) {
        return null;
      }
      const snapshot = await worker.control.stopRecording(legId, mediaId);
      if (!snapshot) {
        return null;
      }
      publishSnapshot(snapshot);
      return snapshot;
    });
  }

  async function activateGlobalRecording(
    legId: string,
    mediaId: string,
    startedAt?: number,
    input?: Record<string, unknown>,
  ): Promise<LegMediaSessionSnapshot> {
    const startup = (async () => {
      await waitForLegMigrations([legId]);
      const worker = await ensureWorkerForLeg(legId);
      const snapshot = await worker.control.activateGlobalRecording(
        legId,
        resolveTransportType(legId),
        mediaId,
        startedAt,
        input,
      );
      publishSnapshot(snapshot);
      return snapshot;
    })();
    recordingStartupByLegId.set(legId, startup);
    try {
      return await startup;
    } finally {
      if (recordingStartupByLegId.get(legId) === startup) {
        recordingStartupByLegId.delete(legId);
      }
    }
  }

  async function deactivateGlobalRecording(legId: string, mediaId: string): Promise<LegMediaSessionSnapshot | null> {
    return await withLegLock(legId, async () => {
      await waitForLegMigrations([legId]);
      await waitForRecordingStartup(legId);
      const worker = findWorkerByLegId(legId);
      if (!worker) {
        return null;
      }
      const snapshot = await worker.control.deactivateGlobalRecording(legId, mediaId);
      if (!snapshot) {
        return null;
      }
      publishSnapshot(snapshot);
      return snapshot;
    });
  }

  async function finalizeRecording(legId: string, mediaId: string, result: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await withLegLock(legId, async () => {
      await waitForRecordingStartup(legId);
      const worker = findWorkerByLegId(legId);
      if (!worker) {
        return { ...(result || {}) };
      }
      return await worker.control.finalizeRecording(legId, mediaId, result);
    });
  }

  async function pauseGlobalRecording(legId: string): Promise<LegMediaSessionSnapshot | null> {
    return await withLegLock(legId, async () => {
      await waitForLegMigrations([legId]);
      const worker = findWorkerByLegId(legId);
      if (!worker) {
        return null;
      }
      const snapshot = await worker.control.pauseGlobalRecording(legId);
      if (snapshot) {
        publishSnapshot(snapshot);
      }
      return snapshot;
    });
  }

  async function resumeGlobalRecording(legId: string): Promise<LegMediaSessionSnapshot | null> {
    return await withLegLock(legId, async () => {
      await waitForLegMigrations([legId]);
      const worker = findWorkerByLegId(legId);
      if (!worker) {
        return null;
      }
      const snapshot = await worker.control.resumeGlobalRecording(legId);
      if (snapshot) {
        publishSnapshot(snapshot);
      }
      return snapshot;
    });
  }

  function getRecordingMediaId(legId: string): string | null {
    return findWorkerByLegId(legId)?.control.getRecordingMediaId(legId) || null;
  }

  async function sendDtmf(legId: string, digits: string, method: string): Promise<boolean> {
    await waitForLegMigrations([legId]);
    const worker = await ensureWorkerForLeg(legId);
    return await worker.control.sendDtmf(
      legId,
      resolveTransportType(legId),
      digits,
      method,
    );
  }

  function isBridgeMediaReady(legId: string): boolean {
    const leg = legService.getLeg(legId);
    if (!leg || leg.status === LEG_STATUS_ENDED) {
      return false;
    }
    if (leg.transportType !== "sip") {
      return true;
    }
    const details = leg.signalingDetails || {};
    const remoteRtpHost = String(details.remoteRtpHost || "").trim();
    const remoteRtpPort = Math.max(0, Number(details.remoteRtpPort || 0) || 0);
    return Boolean(remoteRtpHost && remoteRtpPort > 0);
  }

  async function syncBridgeRouting(legAId: string, legBId: string): Promise<boolean> {
    await waitForLegMigrations([legAId, legBId]);
    const bridgePeerA = bridgePeerByLegId.get(legAId) || null;
    const bridgePeerB = bridgePeerByLegId.get(legBId) || null;
    if (!bridgePeerA || !bridgePeerB) {
      return false;
    }
    if (bridgePeerA.peerLegId !== legBId || bridgePeerB.peerLegId !== legAId) {
      return false;
    }
    const readyA = isBridgeMediaReady(legAId);
    const readyB = isBridgeMediaReady(legBId);
    if (!readyA || !readyB) {
      return false;
    }
    await clearBridgeRouting([legAId, legBId]);
    let worker = await ensureWorkerForLeg(legAId);
    const peerWorker = await ensureWorkerForLeg(legBId);
    if (worker.workerId !== peerWorker.workerId) {
      worker = await colocateBridgeLegs(legAId, legBId, worker, peerWorker);
    }
    await worker.control.bindBridge(legAId, legBId);
    return true;
  }

  async function ensureTransportEndpoint(legId: string): Promise<MediaTransportDetails> {
    await waitForLegMigrations([legId]);
    await ensureWorkerForLeg(legId);
    const bridgePeer = bridgePeerByLegId.get(legId) || null;
    if (bridgePeer?.peerLegId) {
      await syncBridgeRouting(legId, bridgePeer.peerLegId);
    }
    return { ...(legService.requireLeg(legId).signalingDetails || {}) };
  }

  async function sendWebSocketJson(legId: string, payload: Record<string, unknown>): Promise<boolean> {
    await waitForLegMigrations([legId]);
    const attachment = transportAttachments.get(legId) || null;
    if (!attachment || attachment.transportType !== "websocket") {
      return false;
    }
    return await attachment.sendControlJson(payload);
  }

  async function activateBridge(
    legAId: string,
    legBId: string,
    options?: { relayDtmf?: string; emitDtmfEvents?: boolean },
  ): Promise<void> {
    await waitForLegMigrations([legAId, legBId]);
    const relayDtmf = String(options?.relayDtmf || OPTION_DEFAULTS.call.relayDtmf);
    const emitDtmfEvents = options?.emitDtmfEvents !== false;
    const previousA = bridgePeerByLegId.get(legAId) || null;
    const previousB = bridgePeerByLegId.get(legBId) || null;
    await withLegLockMany([legAId, legBId], async () => {
      bridgePeerByLegId.set(legAId, { peerLegId: legBId, relayDtmf, emitDtmfEvents });
      bridgePeerByLegId.set(legBId, { peerLegId: legAId, relayDtmf, emitDtmfEvents });
    });
    try {
      await syncBridgeRouting(legAId, legBId);
    } catch (error) {
      await withLegLockMany([legAId, legBId], async () => {
        if (previousA) {
          bridgePeerByLegId.set(legAId, previousA);
        } else {
          bridgePeerByLegId.delete(legAId);
        }
        if (previousB) {
          bridgePeerByLegId.set(legBId, previousB);
        } else {
          bridgePeerByLegId.delete(legBId);
        }
      });
      throw error;
    }
    await withLegLockMany([legAId, legBId], async () => {
      publishLegState(legAId);
      publishLegState(legBId);
    });
  }

  async function deactivateBridge(legIds: Array<string | null | undefined>): Promise<void> {
    const normalized = Array.from(new Set(legIds.filter((value): value is string => Boolean(value))));
    await waitForLegMigrations(normalized);
    await clearBridgeRouting(normalized);
    await withLegLockMany(normalized, async () => {
      for (const legId of normalized) {
        bridgePeerByLegId.delete(legId);
        legService.updateBridgeState(legId, null);
        publishLegState(legId);
      }
    });
  }

  async function beginBridgeTermination(legId: string): Promise<BridgePeerInfo | null> {
    const bridgePeer = bridgePeerByLegId.get(legId) || null;
    const lockIds = bridgePeer?.peerLegId ? [legId, bridgePeer.peerLegId] : [legId];
    return await withLegLockMany(lockIds, async () => {
      const current = bridgePeerByLegId.get(legId) || null;
      if (!current) {
        return null;
      }
      bridgePeerByLegId.delete(legId);
      bridgePeerByLegId.delete(current.peerLegId);
      legService.updateBridgeState(legId, null);
      legService.updateBridgeState(current.peerLegId, null);
      publishLegState(legId);
      publishLegState(current.peerLegId);
      return current;
    });
  }

  async function orphanBridgeAfterLegEnd(legId: string, peerLegId?: string | null): Promise<void> {
    const lockLegId = peerLegId || legId;
    await withLegLock(lockLegId, async () => {
      await waitForLegMigrations([lockLegId]);
      const worker = findWorkerByLegId(lockLegId);
      if (!worker) {
        return;
      }
      await worker.control.orphanBridgeLeg(legId, peerLegId || undefined);
    });
  }

  async function pruneLegIfIdle(legId: string): Promise<void> {
    await waitForLegMigrations([legId]);
    await removeIfIdle(legId);
  }

  async function waitUntilLegStable(legId: string): Promise<void> {
    await waitForLegMigrations([legId]);
    await waitForRecordingStartup(legId);
  }

  async function waitForRecordingStartup(legId: string): Promise<void> {
    const startup = recordingStartupByLegId.get(legId) || null;
    if (!startup) {
      return;
    }
    await startup;
  }

  async function removeLeg(legId: string): Promise<void> {
    await withLegLock(legId, async () => {
      console.error(`[sip-pbx:media] removeLeg start; leg=${legId}`);
      await waitForLegMigrations([legId]);
      bridgePeerByLegId.delete(legId);
      const worker = findWorkerByLegId(legId);
      const attachment = transportAttachments.get(legId) || null;
      if (worker) {
        console.error(`[sip-pbx:media] removeLeg removing endpoint; leg=${legId}; worker=${worker.workerId}; endpoints=${worker.control.getEndpointCount()}; media=${worker.control.getActiveMediaCount()}`);
        await worker.control.removeEndpoint(legId);
      }
      legAssignments.delete(legId);
      transportAttachments.delete(legId);
      console.error(`[sip-pbx:media] removeLeg closing attachment; leg=${legId}; hasAttachment=${Boolean(attachment)}`);
      await attachment?.close?.();
      console.error(`[sip-pbx:media] removeLeg attachment closed; leg=${legId}`);
      legService.updateMediaDetails(legId, buildLegMediaDetails(legId, null));
      console.error(`[sip-pbx:media] removeLeg media details cleared; leg=${legId}`);
      if (worker) {
        scheduleWorkerReap(worker.workerId);
        console.error(`[sip-pbx:media] removeLeg scheduled reap; leg=${legId}; worker=${worker.workerId}; remainingWorkers=${workers.size}`);
        await removeWorkerIfEmpty(worker.workerId);
      }
      console.error(`[sip-pbx:media] removeLeg done; leg=${legId}`);
    });
  }

  function getSnapshot(legId: string): LegMediaSessionSnapshot | null {
    return findWorkerByLegId(legId)?.control.getSnapshot(legId) || null;
  }

  function getBridgePeerInfo(legId: string): BridgePeerInfo | null {
    return bridgePeerByLegId.get(legId) || null;
  }

  function getWorkerCount(): number {
    return workers.size;
  }

  async function shutdown(): Promise<void> {
    bridgePeerByLegId.clear();
    legAssignments.clear();
    migratingLegIds.clear();
    for (const workerId of Array.from(workerReapTimers.keys())) {
      clearWorkerReapTimer(workerId);
    }
    for (const [legId, waiters] of Array.from(migrationWaiters.entries())) {
      migrationWaiters.delete(legId);
      for (const waiter of waiters) {
        waiter();
      }
    }
    const attachments = Array.from(transportAttachments.values());
    transportAttachments.clear();
    const activeWorkers = Array.from(workers.values());
    workers.clear();
    for (const attachment of attachments) {
      await attachment.close();
    }
    for (const worker of activeWorkers) {
      await worker.control.shutdown();
      await worker.worker.terminate();
    }
  }

  async function ensureWorkerForLeg(legId: string): Promise<WorkerHandle> {
    return await withLegLock(legId, async () => {
      await waitForLegMigrations([legId]);
      const leg = legService.getLeg(legId);
      if (!leg) {
        throw daemonError("invalid_leg", `Unknown leg ${legId}`);
      }
      if (leg.status === LEG_STATUS_ENDED) {
        throw daemonError("invalid_leg", `Leg ${legId} is already ended`);
      }
      const transportType = resolveTransportType(legId);
      const attachment = await ensureTransportAttachment(legId, transportType);
      const transportConfig = await buildTransportConfig(legId, attachment);
      const worker = findWorkerByLegId(legId);
      const describeWorker = (candidate: WorkerHandle | null): string => {
        if (!candidate) {
          return "null";
        }
        return `${candidate.workerId}:endpoints=${candidate.control.getEndpointCount()}:media=${candidate.control.getActiveMediaCount()}`;
      };
      console.error(
        `[sip-pbx:media] ensureWorkerForLeg begin; leg=${legId}; transportType=${transportType}; existing=${describeWorker(worker)}; least=${describeWorker(pickLeastLoadedWorker())}; affinity=${describeWorker(findAffinityWorker(legId))}`,
      );
      if (worker) {
        clearWorkerReapTimer(worker.workerId);
        attachment.suspend();
        try {
          const startedAt = nowMs();
          const ensured = await worker.control.ensureEndpoint(legId, transportType, transportConfig);
          console.error(
            `[sip-pbx:media] ensureWorkerForLeg existing done; leg=${legId}; worker=${worker.workerId}; elapsedMs=${Math.max(0, nowMs() - startedAt)}`,
          );
          attachment.rebind(worker.control);
          attachment.resume();
          applyTransportDetails(legId, ensured.transportDetails);
          publishSnapshot(ensured.snapshot);
          return worker;
        } catch (error) {
          attachment.resume();
          throw error;
        }
      }
      const createdWorker = selectWorkerForNewLeg(legId);
      console.error(
        `[sip-pbx:media] ensureWorkerForLeg selected new; leg=${legId}; worker=${createdWorker.workerId}; endpoints=${createdWorker.control.getEndpointCount()}; media=${createdWorker.control.getActiveMediaCount()}`,
      );
      clearWorkerReapTimer(createdWorker.workerId);
      attachment.suspend();
      try {
        const startedAt = nowMs();
        const ensured = await createdWorker.control.ensureEndpoint(legId, transportType, transportConfig);
        console.error(
          `[sip-pbx:media] ensureWorkerForLeg new done; leg=${legId}; worker=${createdWorker.workerId}; elapsedMs=${Math.max(0, nowMs() - startedAt)}`,
        );
        legAssignments.set(legId, createdWorker.workerId);
        attachment.rebind(createdWorker.control);
        attachment.resume();
        applyTransportDetails(legId, ensured.transportDetails);
        publishSnapshot(ensured.snapshot);
        return createdWorker;
      } catch (error) {
        attachment.resume();
        throw error;
      }
    });
  }

  function createWorker(): WorkerHandle {
    const workerId = `${MEDIA_EXECUTION_WORKER_ID_PREFIX}${workerSequence++}`;
    const workerTitle = `sip-pbx:mw:${workerId.slice(MEDIA_EXECUTION_WORKER_ID_PREFIX.length)}`;
    console.error(
      `[sip-pbx:media] createWorker start; worker=${workerId}; currentWorkers=${workers.size}; maxWorkers=${MEDIA_EXECUTION_MAX_WORKER_COUNT}`,
    );
    const rawWorker = new Worker(__filename, {
      name: workerTitle,
      workerData: { workerId },
    });
    const worker = {
      workerId,
      worker: rawWorker,
      control: createWorkerControlPlane({
        workerId,
        worker: rawWorker,
        onTransportOutput: (message) => {
          void handleWorkerTransportOutput(message);
        },
        onVoiceActivity,
        onInboundDtmf,
        onPlaybackFinished,
        onMediaFailure,
        onMediaInterrupt,
        onTransportClosed: (legId, reason) => {
          void handleTransportClosed(legId, reason);
        },
      }),
    };
    workers.set(workerId, worker);
    console.error(
      `[sip-pbx:media] createWorker ready; worker=${workerId}; currentWorkers=${workers.size}; threadName=${workerTitle}`,
    );
    rawWorker.once("online", () => {
      const threadName = (rawWorker as Worker & { threadName?: string | null }).threadName || workerTitle;
      console.error(
        `[sip-pbx:media] worker online; worker=${workerId}; threadId=${rawWorker.threadId}; threadName=${threadName}`,
      );
    });
    rawWorker.on("exit", (code) => {
      console.error(`[sip-pbx:media] worker exit; worker=${workerId}; code=${code}; remainingBeforeCleanup=${workers.size}`);
      clearWorkerReapTimer(workerId);
      workers.delete(workerId);
      const ownedLegIds = Array.from(legAssignments.entries())
        .filter(([, assignedWorkerId]) => assignedWorkerId === workerId)
        .map(([legId]) => legId);
      console.error(
        `[sip-pbx:media] worker exit cleanup; worker=${workerId}; ownedLegs=${ownedLegIds.length > 0 ? ownedLegIds.join(",") : "none"}`,
      );
      for (const legId of ownedLegIds) {
        legAssignments.delete(legId);
        void handleTransportClosed(legId, `worker_exit_${code}`).catch((error) => {
          console.error(
            `[sip-pbx:media] worker-exit transport close failed; leg=${legId}; worker=${workerId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
          );
        });
      }
    });
    return worker;
  }

  function findWorkerByLegId(legId: string | null | undefined): WorkerHandle | null {
    if (!legId) {
      return null;
    }
    const workerId = legAssignments.get(legId) || null;
    if (!workerId) {
      return null;
    }
    const worker = workers.get(workerId) || null;
    if (!worker) {
      legAssignments.delete(legId);
      return null;
    }
    if (!worker.control.getSnapshot(legId)) {
      legAssignments.delete(legId);
      return null;
    }
    return worker;
  }

  async function waitForLegMigrations(legIds: Array<string | null | undefined>): Promise<void> {
    const normalized = Array.from(new Set(legIds.filter((value): value is string => Boolean(value)))).sort();
    for (const legId of normalized) {
      while (migratingLegIds.has(legId)) {
        await new Promise<void>((resolve) => {
          const waiters = migrationWaiters.get(legId) || [];
          waiters.push(resolve);
          migrationWaiters.set(legId, waiters);
        });
      }
    }
  }

  function beginLegMigration(legId: string): boolean {
    if (migratingLegIds.has(legId)) {
      return false;
    }
    migratingLegIds.add(legId);
    return true;
  }

  function endLegMigration(legId: string): void {
    if (!migratingLegIds.delete(legId)) {
      return;
    }
    const waiters = migrationWaiters.get(legId) || [];
    migrationWaiters.delete(legId);
    for (const waiter of waiters) {
      waiter();
    }
  }

  async function handleWorkerTransportOutput(message: WorkerTransportOutputMessage): Promise<void> {
    const attachment = transportAttachments.get(message.payload.legId) || null;
    if (!attachment) {
      return;
    }
    await attachment.handleWorkerOutput(message);
  }

  async function ensureTransportAttachment(
    legId: string,
    transportType: EndpointTransportType,
  ): Promise<TransportAttachment> {
    const existing = transportAttachments.get(legId) || null;
    if (existing) {
      return existing;
    }
    const created = transportType === "sip"
      ? createRtpTransportAttachment({
          legId,
          onRemoteRtpSourceChanged: (changedLegId) => {
            void handleRtpSourceChanged(changedLegId).catch((error) => {
              console.error(
                `[sip-pbx:media] RTP source change handling failed; leg=${changedLegId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
              );
            });
          },
        })
      : createWebSocketTransportAttachment({
          legId,
          onVoiceAgentEvent,
        });
    transportAttachments.set(legId, created);
    return created;
  }

  function selectWorkerForNewLeg(legId: string): WorkerHandle {
    const leastLoaded = pickLeastLoadedWorker();
    const affinityWorker = findAffinityWorker(legId);
    const describeWorker = (candidate: WorkerHandle | null): string => {
      if (!candidate) {
        return "null";
      }
      return `${candidate.workerId}:endpoints=${candidate.control.getEndpointCount()}:media=${candidate.control.getActiveMediaCount()}`;
    };
    if (affinityWorker) {
      const affinityEndpoints = affinityWorker.control.getEndpointCount();
      const leastEndpoints = leastLoaded?.control.getEndpointCount() ?? Number.POSITIVE_INFINITY;
      if (affinityEndpoints === 0 && affinityEndpoints <= leastEndpoints) {
        console.error(
          `[sip-pbx:media] worker selection; leg=${legId}; affinity=${describeWorker(affinityWorker)}; least=${describeWorker(leastLoaded)}; chosen=${affinityWorker.workerId}; reason=affinity`,
        );
        return affinityWorker;
      }
    }
    if (leastLoaded) {
      const leastEndpoints = leastLoaded.control.getEndpointCount();
      if (leastEndpoints === 0) {
        console.error(
          `[sip-pbx:media] worker selection; leg=${legId}; affinity=${describeWorker(affinityWorker)}; least=${describeWorker(leastLoaded)}; chosen=${leastLoaded.workerId}; reason=least_loaded_idle`,
        );
        return leastLoaded;
      }
      if (workers.size < MEDIA_EXECUTION_MAX_WORKER_COUNT) {
        const created = createWorker();
        console.error(
          `[sip-pbx:media] worker selection; leg=${legId}; affinity=${describeWorker(affinityWorker)}; least=${describeWorker(leastLoaded)}; chosen=${created.workerId}; reason=create_new`,
        );
        return created;
      }
      console.error(
        `[sip-pbx:media] worker selection; leg=${legId}; affinity=${describeWorker(affinityWorker)}; least=${describeWorker(leastLoaded)}; chosen=${leastLoaded.workerId}; reason=max_workers_reuse`,
      );
      return leastLoaded;
    }
    if (workers.size < MEDIA_EXECUTION_MAX_WORKER_COUNT) {
      const created = createWorker();
      console.error(
        `[sip-pbx:media] worker selection; leg=${legId}; affinity=${describeWorker(affinityWorker)}; least=null; chosen=${created.workerId}; reason=create_first`,
      );
      return created;
    }
    console.error(
      `[sip-pbx:media] worker selection; leg=${legId}; affinity=${describeWorker(affinityWorker)}; least=null; chosen=${leastLoaded?.workerId || "null"}; reason=fallback`,
    );
    return leastLoaded || createWorker();
  }

  function pickLeastLoadedWorker(): WorkerHandle | null {
    const workerList = Array.from(workers.values());
    if (workerList.length === 0) {
      return null;
    }
    workerList.sort((left, right) => {
      const loadDiff = left.control.getEndpointCount() - right.control.getEndpointCount();
      if (loadDiff !== 0) {
        return loadDiff;
      }
      const endpointDiff = left.control.getActiveMediaCount() - right.control.getActiveMediaCount();
      if (endpointDiff !== 0) {
        return endpointDiff;
      }
      return compareWorkerIds(left.workerId, right.workerId);
    });
    return workerList[0] || null;
  }

  function findAffinityWorker(legId: string): WorkerHandle | null {
    const affinityKey = resolveAffinityKey(legId);
    if (!affinityKey) {
      return null;
    }
    for (const [candidateLegId, workerId] of Array.from(legAssignments.entries())) {
      if (candidateLegId === legId) {
        continue;
      }
      if (resolveAffinityKey(candidateLegId) !== affinityKey) {
        continue;
      }
      const worker = workers.get(workerId) || null;
      if (worker) {
        return worker;
      }
    }
    return null;
  }

  function resolveAffinityKey(legId: string): string | null {
    const leg = legService.getLeg(legId);
    if (!leg) {
      return null;
    }
    const dialId = String(leg.signalingDetails?.dialId || "").trim();
    if (dialId) {
      return `dial:${dialId}`;
    }
    const triggerRef = String(leg.triggerMetadata?.ref || "").trim();
    const extensionNumber = String(leg.triggerMetadata?.extensionNumber || "").trim();
    if (triggerRef && extensionNumber) {
      return `extension:${triggerRef}:${extensionNumber}`;
    }
    return null;
  }

  async function clearBridgeRouting(legIds: Array<string | null | undefined>): Promise<void> {
    const normalized = Array.from(new Set(legIds.filter((value): value is string => Boolean(value))));
    for (const legId of normalized) {
      const worker = findWorkerByLegId(legId);
      if (!worker) {
        continue;
      }
      await worker.control.unbindBridgeLeg(legId);
    }
  }

  async function removeIfIdle(legId: string): Promise<void> {
    await withLegLock(legId, async () => {
      const leg = legService.getLeg(legId);
      if (leg && leg.status !== LEG_STATUS_ENDED) {
        console.error(`[sip-pbx:media] removeIfIdle skipped; leg=${legId}; reason=leg_active; status=${leg.status}`);
        return;
      }
      const worker = findWorkerByLegId(legId);
      if (!worker) {
        console.error(`[sip-pbx:media] removeIfIdle skipped; leg=${legId}; reason=no_worker`);
        return;
      }
      if (bridgePeerByLegId.has(legId)) {
        console.error(`[sip-pbx:media] removeIfIdle skipped; leg=${legId}; reason=bridge_peer_present; worker=${worker.workerId}`);
        return;
      }
      if (!worker.control.isEndpointIdle(legId)) {
        console.error(
          `[sip-pbx:media] removeIfIdle skipped; leg=${legId}; reason=endpoint_busy; worker=${worker.workerId}; endpoints=${worker.control.getEndpointCount()}; media=${worker.control.getActiveMediaCount()}`,
        );
        return;
      }
      console.error(
        `[sip-pbx:media] removeIfIdle removing endpoint; leg=${legId}; worker=${worker.workerId}; endpoints=${worker.control.getEndpointCount()}; media=${worker.control.getActiveMediaCount()}`,
      );
      await worker.control.removeEndpoint(legId);
      legAssignments.delete(legId);
      const attachment = transportAttachments.get(legId) || null;
      transportAttachments.delete(legId);
      await attachment?.close?.();
      legService.updateMediaDetails(legId, buildLegMediaDetails(legId, null));
      scheduleWorkerReap(worker.workerId);
      console.error(
        `[sip-pbx:media] removeIfIdle scheduled reap; leg=${legId}; worker=${worker.workerId}; delayMs=${MEDIA_EXECUTION_IDLE_WORKER_REAP_DELAY_MS}; remainingWorkers=${workers.size}`,
      );
      await removeWorkerIfEmpty(worker.workerId);
    });
  }

  async function removeWorkerIfEmpty(workerId: string): Promise<void> {
    const worker = workers.get(workerId) || null;
    if (!worker) {
      clearWorkerReapTimer(workerId);
      console.error(`[sip-pbx:media] removeWorkerIfEmpty skipped; worker=${workerId}; reason=missing`);
      return;
    }
    if (worker.control.getEndpointCount() > 0) {
      console.error(
        `[sip-pbx:media] removeWorkerIfEmpty skipped; worker=${workerId}; reason=busy; endpoints=${worker.control.getEndpointCount()}; media=${worker.control.getActiveMediaCount()}`,
      );
      return;
    }
    clearWorkerReapTimer(workerId);
    workers.delete(workerId);
    console.error(`[sip-pbx:media] removeWorkerIfEmpty shutting down; worker=${workerId}; remainingWorkers=${workers.size}`);
    await worker.control.shutdown();
    await worker.worker.terminate();
    console.error(`[sip-pbx:media] removeWorkerIfEmpty terminated; worker=${workerId}`);
  }

  async function colocateBridgeLegs(
    legAId: string,
    legBId: string,
    workerA: WorkerHandle,
    workerB: WorkerHandle,
  ): Promise<WorkerHandle> {
    const attempts = [
      { target: workerA, moveLegId: legBId, load: workerA.control.getEndpointCount() },
      { target: workerB, moveLegId: legAId, load: workerB.control.getEndpointCount() },
    ].sort((left, right) => {
      const loadDiff = right.load - left.load;
      if (loadDiff !== 0) {
        return loadDiff;
      }
      return compareWorkerIds(left.target.workerId, right.target.workerId);
    });

    for (const attempt of attempts) {
      if (await migrateLeg(attempt.moveLegId, attempt.target.workerId)) {
        return workers.get(attempt.target.workerId) || attempt.target;
      }
    }

    throw daemonError(
      "bridge_colocation_failed",
      `Unable to colocate legs ${legAId} and ${legBId} on one media worker`,
    );
  }

  async function migrateLeg(legId: string, targetWorkerId: string): Promise<boolean> {
    return await withLegLock(legId, async () => {
      const sourceWorker = findWorkerByLegId(legId);
      const targetWorker = workers.get(targetWorkerId) || null;
      if (!sourceWorker || !targetWorker) {
        return false;
      }
      if (sourceWorker.workerId === targetWorker.workerId) {
        return true;
      }
      if (!sourceWorker.control.isEndpointIdle(legId) || !canMigrateLeg(legId)) {
        return false;
      }
      if (!beginLegMigration(legId)) {
        return false;
      }

      try {
        clearWorkerReapTimer(sourceWorker.workerId);
        clearWorkerReapTimer(targetWorker.workerId);
        const transportType = resolveTransportType(legId);
        const attachment = transportAttachments.get(legId) || null;
        if (!attachment) {
          return false;
        }
        const endpointState = await sourceWorker.control.exportEndpointState(legId);
        if (!endpointState) {
          return false;
        }
        const transportConfig = await buildTransportConfig(legId, attachment, endpointState.transportState);
        let ensured: WorkerEnsureEndpointResult | null = null;
        attachment.suspend();
        try {
          ensured = await targetWorker.control.acceptEndpointHandoff(
            legId,
            transportType,
            transportConfig,
            endpointState.codecName,
          );
          attachment.rebind(targetWorker.control);
          await sourceWorker.control.removeEndpoint(legId);
          legAssignments.set(legId, targetWorker.workerId);
          attachment.resume();
          applyTransportDetails(legId, ensured.transportDetails);
          publishSnapshot(ensured.snapshot);
          scheduleWorkerReap(sourceWorker.workerId);
          await removeWorkerIfEmpty(sourceWorker.workerId);
          return true;
        } catch (error) {
          let rollbackError: unknown = null;
          if (ensured) {
            try {
              await targetWorker.control.removeEndpoint(legId);
            } catch (caught) {
              rollbackError = caught;
            }
          }
          attachment.rebind(sourceWorker.control);
          attachment.resume();
          if (rollbackError) {
            const combinedError = new Error(`Failed to migrate leg ${legId} to worker ${targetWorker.workerId}`);
            (combinedError as Error & { cause?: unknown }).cause = {
              primary: error,
              rollbackError,
            };
            throw combinedError;
          }
          throw error;
        }
      } finally {
        endLegMigration(legId);
      }
    });
  }

  function canMigrateLeg(legId: string): boolean {
    const leg = legService.getLeg(legId);
    if (!leg || leg.status === LEG_STATUS_ENDED || migratingLegIds.has(legId)) {
      return false;
    }
    return transportAttachments.has(legId);
  }

  function resolveTransportType(legId: string): EndpointTransportType {
    const transportType = legService.requireLeg(legId).transportType;
    if (transportType !== "sip" && transportType !== "websocket") {
      throw daemonError("invalid_media_transport", `Transport endpoint is unavailable for leg ${legId}`);
    }
    return transportType;
  }

  async function buildTransportConfig(
    legId: string,
    attachment: TransportAttachment,
    extra?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const leg = legService.requireLeg(legId);
    const attachmentDetails = await attachment.configure({ ...(leg.signalingDetails || {}) });
    return {
      ...(extra || {}),
      ...(leg.signalingDetails || {}),
      ...attachmentDetails,
    };
  }

  function applyTransportDetails(legId: string, details: MediaTransportDetails | null | undefined): void {
    if (!details || Object.keys(details).length === 0) {
      return;
    }
    const leg = legService.requireLeg(legId);
    legService.updateSignalingDetails(legId, {
      ...(leg.signalingDetails || {}),
      ...(details || {}),
    });
  }

  async function handleRtpSourceChanged(legId: string): Promise<void> {
    try {
      await ensureTransportEndpoint(legId);
    } catch (error) {
      if (isDaemonError(error) && (error.code === "invalid_leg" || error.code === "invalid_media_transport")) {
        return;
      }
      throw error;
    }
  }

  async function handleTransportClosed(legId: string, reason: string): Promise<void> {
    await withLegLock(legId, async () => {
      await waitForLegMigrations([legId]);
      const leg = legService.getLeg(legId);
      if (!leg || leg.status === LEG_STATUS_ENDED) {
        console.error(
          `[sip-pbx:media] handleTransportClosed skipped; leg=${legId}; reason=${String(reason || "transport_closed")}; exists=${Boolean(leg)}; status=${leg?.status || "missing"}`,
        );
        return;
      }
      console.error(
        `[sip-pbx:media] handleTransportClosed; leg=${legId}; transportType=${leg.transportType}; status=${leg.status}; reason=${String(reason || "transport_closed")}`,
      );
      legService.hangupLeg(legId, reason || "transport_closed");
    });
  }

  function publishSnapshot(snapshot: LegMediaSessionSnapshot): void {
    legService.updateMediaDetails(snapshot.legId, buildLegMediaDetails(snapshot.legId, snapshot));
    publishBridgeState(snapshot.legId);
  }

  function buildLegMediaDetails(legId: string, snapshot: LegMediaSessionSnapshot | null): Record<string, unknown> {
    const details = snapshot ? buildMediaDetails(snapshot) : {};
    const bridgePeer = bridgePeerByLegId.get(legId);
    if (!bridgePeer) {
      return details;
    }
    return {
      ...details,
      bridgePeerLegId: bridgePeer.peerLegId,
      bridgeRelayDtmf: bridgePeer.relayDtmf,
      bridgeEmitDtmfEvents: bridgePeer.emitDtmfEvents,
    };
  }

  function publishBridgeState(legId: string): void {
    legService.updateBridgeState(legId, bridgePeerByLegId.get(legId) || null);
  }

  function publishLegState(legId: string): void {
    legService.updateMediaDetails(legId, buildLegMediaDetails(legId, getSnapshot(legId)));
    publishBridgeState(legId);
  }

  return {
    registerPlayback,
    unregisterPlayback,
    startRecording,
    stopRecording,
    activateGlobalRecording,
    deactivateGlobalRecording,
    finalizeRecording,
    pauseGlobalRecording,
    resumeGlobalRecording,
    getRecordingMediaId,
    sendDtmf,
    ensureTransportEndpoint,
    sendWebSocketJson,
    activateBridge,
    deactivateBridge,
    beginBridgeTermination,
    orphanBridgeAfterLegEnd,
    pruneLegIfIdle,
    waitUntilLegStable,
    removeLeg,
    getSnapshot,
    getBridgePeerInfo,
    getWorkerCount,
    shutdown,
  };
}

export class MediaService {
  private readonly registry: MapRegistry<string, MediaOperation>;
  private readonly legService: LegService;
  private readonly executionPlane: MediaExecutionPlane;
  private readonly sendSignalingDtmf: (legId: string, digits: string, method: string) => Promise<boolean>;
  private readonly sendSignalingProgress: (legId: string) => void;
  private readonly recordingsRoot: string;
  private readonly onVoiceAgentEvent: (legId: string, event: WebSocketVoiceAgentEvent) => void;
  private readonly globalCallRecordings = new Map<string, GlobalCallRecordingState>();
  private readonly mediaRetentions = new Map<string, RetentionTicket>();
  // Both halves of a bridge point at the SAME ticket; either half can release the pair.
  private readonly bridgeRetentions = new Map<string, { ticket: RetentionTicket; peerLegId: string }>();

  constructor(
    registry: MapRegistry<string, MediaOperation>,
    legService: LegService,
    options?: {
      sendSignalingDtmf?: (legId: string, digits: string, method: string) => Promise<boolean>;
      sendSignalingProgress?: (legId: string) => void;
      recordingsRoot?: string;
      onVoiceAgentEvent?: (legId: string, event: WebSocketVoiceAgentEvent) => void;
      legCoordinator?: LegCoordinator;
    },
  ) {
    this.registry = registry;
    this.legService = legService;
    this.sendSignalingDtmf = options?.sendSignalingDtmf || (async () => false);
    this.sendSignalingProgress = options?.sendSignalingProgress || (() => undefined);
    this.recordingsRoot = String(options?.recordingsRoot || process.cwd());
    this.onVoiceAgentEvent = options?.onVoiceAgentEvent || (() => undefined);
    const legCoordinator = options?.legCoordinator || new LegCoordinator();
    this.executionPlane = createMediaExecutionPlane(legService, legCoordinator, {
      onInboundDtmf: (legId, digits) => {
        void this.handleInboundDtmf(legId, digits);
      },
      onPlaybackFinished: (legId, mediaId) => {
        void this.handlePlaybackFinished(legId, mediaId);
      },
      onMediaFailure: (legId, mediaId, reason, error) => {
        void this.handleMediaFailure(legId, mediaId, reason, error);
      },
      onMediaInterrupt: (legId, mediaId, reason, details) => {
        void this.handleMediaInterrupt(legId, mediaId, reason, details);
      },
      onVoiceAgentEvent: (legId, event) => {
        this.onVoiceAgentEvent(legId, event);
      },
    });
  }

  getWorkerCount(): number {
    return this.executionPlane.getWorkerCount();
  }

  private acquireMediaRetention(legId: string, mediaId: string, kind: string): void {
    this.mediaRetentions.set(mediaId, this.legService.retainLeg(legId, `media:${kind}:${mediaId}`));
  }

  private releaseMediaRetention(mediaId: string): void {
    const ticket = this.mediaRetentions.get(mediaId);
    if (!ticket) {
      return;
    }
    this.mediaRetentions.delete(mediaId);
    ticket.release();
  }

  private acquireBridgeRetention(legAId: string, legBId: string): void {
    const ticket = this.legService.retainLegs([legAId, legBId], `bridge:${legAId}-${legBId}`);
    this.bridgeRetentions.set(legAId, { ticket, peerLegId: legBId });
    this.bridgeRetentions.set(legBId, { ticket, peerLegId: legAId });
  }

  private releaseBridgeRetention(legId: string): void {
    const entry = this.bridgeRetentions.get(legId);
    if (!entry) {
      return;
    }
    this.bridgeRetentions.delete(legId);
    // Identity-check the peer ticket: a concurrent re-bridge may have placed a
    // fresh ticket into the peer's slot, which an unconditional delete would clobber.
    const peerEntry = this.bridgeRetentions.get(entry.peerLegId);
    if (peerEntry && peerEntry.ticket === entry.ticket) {
      this.bridgeRetentions.delete(entry.peerLegId);
    }
    entry.ticket.release();
  }

  async playAudio(legId: string, input: Record<string, unknown>, context?: RequestContext | null): Promise<Record<string, unknown>> {
    this.legService.requireLeg(legId);
    const endpoint = await createReadableMediaEndpoint(input);
    const sourceRef = endpoint.sourceRef;
    await endpoint.close?.();
    if (Boolean(input.stopOtherMedia)) {
      await this.stopOtherMediaBeforeStart(legId);
    }
    const mediaId = newMediaId();
    const operation = PlayAudioOperation.create(this.registry, {
      mediaId,
      legId,
      sourceRef,
      options: { ...(input || {}) },
      onDestroy: this.handleOperationDestroy.bind(this),
    });
    if (!operation.isBackground()) {
      this.acquireMediaRetention(legId, operation.mediaId, "playAudio");
    }
    console.error(
      `[sip-pbx:media] playAudio start; leg=${legId}; media=${operation.mediaId}; sourceType=${String(input?.sourceType || OPTION_DEFAULTS.playAudio.sourceType)}; sourceRef=${sourceRef}; executionMode=${operation.executionMode}; interruptOnDtmf=${String(operation.interruptOnDtmf)}; interruptOnVoice=${String(operation.interruptOnVoice)}`,
    );

    try {
      await this.executionPlane.registerPlayback({
        legId,
        mediaId: operation.mediaId,
        kind: "playback",
        duckingFactor: operation.duckingFactor,
        interruptOnDtmf: operation.interruptOnDtmf,
        interruptOnVoice: operation.interruptOnVoice,
        voiceThreshold: operation.voiceThreshold,
        voiceDurationMs: operation.voiceDurationMs,
        sourceRef: operation.sourceRef,
        startedAt: operation.createdAt,
        input: { ...(operation.options || {}) },
      });
      this.maybeSendTransparentProgress(legId);
    } catch (error) {
      try {
        await operation.destroy("failed", { reason: "startup_failed" });
      } catch (destroyError) {
        console.error(
          `[sip-pbx:media] playback startup rollback failed; media=${operation.mediaId}; leg=${legId}; error=${destroyError instanceof Error ? destroyError.message : String(destroyError || "unknown")}`,
        );
      }
      throw error;
    }

    if (operation.isBackground()) {
      return {
        mediaId: operation.mediaId,
        legId,
        status: MEDIA_EVENT_STARTED,
        eventType: MEDIA_EVENT_STARTED,
      };
    }
    return await this.waitForBlockingMedia(operation.mediaId, context);
  }

  async playTone(legId: string, input: Record<string, unknown>, context?: RequestContext | null): Promise<Record<string, unknown>> {
    this.legService.requireLeg(legId);
    validatePlayToneInput(input);
    const repeatInfinite = Boolean(input.repeatInfinite);
    const renderedDurationMs = repeatInfinite
      ? Math.max(1000, Number(input.toneLoopWindowMs || 4000))
      : resolveTonePlaybackDurationMs(input);
    if (Boolean(input.stopOtherMedia)) {
      await this.stopOtherMediaBeforeStart(legId);
    }
    const mediaId = newMediaId();
    const operation = PlayTonesOperation.create(this.registry, {
      mediaId,
      legId,
      tone: String(input.tone || OPTION_DEFAULTS.playTone.tone),
      loopPlayback: repeatInfinite,
      durationMs: repeatInfinite ? 0 : renderedDurationMs,
      options: { ...(input || {}) },
      onDestroy: this.handleOperationDestroy.bind(this),
    });
    if (!operation.isBackground()) {
      this.acquireMediaRetention(legId, operation.mediaId, "playTone");
    }

    try {
      await this.executionPlane.registerPlayback({
        legId,
        mediaId: operation.mediaId,
        kind: "tone",
        tone: operation.tone,
        duckingFactor: operation.duckingFactor,
        interruptOnDtmf: operation.interruptOnDtmf,
        interruptOnVoice: operation.interruptOnVoice,
        voiceThreshold: operation.voiceThreshold,
        voiceDurationMs: operation.voiceDurationMs,
        sourceRef: operation.tone,
        durationMs: operation.durationMs,
        loopPlayback: operation.loopPlayback,
        startedAt: operation.createdAt,
        input: { ...(operation.options || {}) },
      });
      this.maybeSendTransparentProgress(legId);
    } catch (error) {
      try {
        await operation.destroy("failed", { reason: "startup_failed" });
      } catch (destroyError) {
        console.error(
          `[sip-pbx:media] tone startup rollback failed; media=${operation.mediaId}; leg=${legId}; error=${destroyError instanceof Error ? destroyError.message : String(destroyError || "unknown")}`,
        );
      }
      throw error;
    }

    if (operation.durationMs > 0) {
      this.scheduleFinalization(operation, operation.durationMs, "completed", {
        tone: operation.tone,
        repeatInfinite,
      });
    }

    if (operation.isBackground()) {
      return {
        mediaId: operation.mediaId,
        legId,
        status: MEDIA_EVENT_STARTED,
        eventType: MEDIA_EVENT_STARTED,
      };
    }
    return await this.waitForBlockingMedia(operation.mediaId, context);
  }

  async recordAudio(legId: string, input: Record<string, unknown>, context?: RequestContext | null): Promise<Record<string, unknown>> {
    this.legService.requireLeg(legId);
    if (Boolean(input.stopOtherMedia)) {
      await this.stopOtherMediaBeforeStart(legId);
    }
    if (this.executionPlane.getRecordingMediaId(legId)) {
      throw daemonError("recording_already_active", `Recording already active for leg ${legId}`);
    }
    const mediaId = newMediaId();
    const operation = RecordAudioOperation.create(this.registry, {
      mediaId,
      legId,
      options: {
        ...(input || {}),
        recordingsRoot: this.recordingsRoot,
      },
      onDestroy: this.handleOperationDestroy.bind(this),
    });
    if (!operation.isBackground()) {
      this.acquireMediaRetention(legId, operation.mediaId, "recordAudio");
    }

    try {
      await this.executionPlane.startRecording(legId, operation.mediaId, operation.createdAt, {
        ...(operation.options || {}),
      });
    } catch (error) {
      try {
        await operation.destroy("failed", { reason: "startup_failed" });
      } catch (destroyError) {
        console.error(
          `[sip-pbx:media] recording startup rollback failed; media=${operation.mediaId}; leg=${legId}; error=${destroyError instanceof Error ? destroyError.message : String(destroyError || "unknown")}`,
        );
      }
      throw error;
    }

    if (operation.maxDurationMs > 0) {
      this.scheduleFinalization(operation, operation.maxDurationMs, "completed", {});
    }

    if (operation.isBackground()) {
      return {
        mediaId: operation.mediaId,
        legId,
        status: MEDIA_EVENT_STARTED,
        eventType: MEDIA_EVENT_STARTED,
      };
    }
    return await this.waitForBlockingMedia(operation.mediaId, context);
  }

  async startGlobalCallRecording(legId: string, input: Record<string, unknown>): Promise<{ legId: string }> {
    this.legService.requireLeg(legId);
    if (this.globalCallRecordings.has(legId)) {
      throw daemonError("recording_already_active", `Global recording already active for leg ${legId}`);
    }
    const mediaId = newMediaId();
    const createdAt = nowMs();
    let resolveCompletion = (_result: Record<string, unknown>) => undefined;
    let rejectCompletion = (_error: unknown) => undefined;
    const completionPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const state = {
      legId,
      mediaId,
      createdAt,
      options: {
        ...(input || {}),
        recordingsRoot: this.recordingsRoot,
      },
      startupPromise: Promise.resolve(),
      completionPromise,
      resolveCompletion,
      rejectCompletion,
      finalizationPromise: null,
    } satisfies GlobalCallRecordingState;
    this.globalCallRecordings.set(legId, state);
    state.startupPromise = (async () => {
      await this.executionPlane.activateGlobalRecording(legId, mediaId, createdAt, state.options);
    })();
    try {
      await state.startupPromise;
      return { legId };
    } catch (error) {
      if (this.globalCallRecordings.get(legId) === state) {
        this.globalCallRecordings.delete(legId);
      }
      state.rejectCompletion(error);
      throw error;
    }
  }

  async waitForGlobalCallRecording(legId: string, context?: RequestContext | null): Promise<Record<string, unknown>> {
    const state = this.globalCallRecordings.get(legId) || null;
    if (!state) {
      throw daemonError("invalid_media_wait", `Leg ${legId} has no active global call recording`);
    }
    if (!context) {
      return await state.completionPromise;
    }
    let release = () => undefined;
    const cancelled = new Promise<Record<string, unknown>>((_resolve, reject) => {
      release = context.onCancel(() => {
        reject(daemonError("request_cancelled", "The request was cancelled"));
      });
    });
    try {
      return await Promise.race([state.completionPromise, cancelled]);
    } finally {
      release();
    }
  }

  async stopMedia(input: {
    stopMediaTarget: string;
    stopMediaId?: string;
    stopMediaLegId?: string;
    stopMediaReason?: string;
  }, context?: RequestContext | null): Promise<Record<string, unknown>> {
    const reason = String(input.stopMediaReason || OPTION_DEFAULTS.stopMedia.reason);
    if (input.stopMediaTarget === "legId") {
      const legId = String(input.stopMediaLegId || "").trim();
      if (!legId) {
        throw daemonError("invalid_media_target", "stopMedia legId is required");
      }
      const operations = this.listMediaOperationsByLegId(legId).filter((operation) => !operation.finalized);
      if (operations.length === 0) {
        return { legId };
      }
      await Promise.all(operations.map(async (operation) => {
        await this.finalizeOperation(operation.mediaId, "interrupted", { interruptReason: reason });
      }));
      return { legId };
    }

    const mediaId = String(input.stopMediaId || "").trim();
    if (!mediaId) {
      throw daemonError("invalid_media_target", "stopMedia mediaId is required");
    }
    const operation = this.requireMediaOperation(mediaId);
    return await this.finalizeOperation(mediaId, "interrupted", {
      interruptReason: reason,
      legId: operation.legId,
    });
  }

  async waitMedia(input: { waitMediaIds?: string[]; waitMediaTimeoutMs?: number }, context?: RequestContext | null): Promise<Record<string, unknown>> {
    const waitOperation = new WaitMediaOperation({
      mediaIds: input.waitMediaIds,
      timeoutMs: input.waitMediaTimeoutMs,
    });
    if (waitOperation.mediaIds.length === 0) {
      throw daemonError("invalid_media_wait", "At least one mediaId is required");
    }
    const operations = waitOperation.mediaIds.map((mediaId) => this.requireMediaOperation(mediaId));
    for (const operation of operations) {
      const queued = operation.shiftEvent();
      if (queued) {
        return this.mediaEventToResult(queued);
      }
    }
    // Retain the legs for the duration of the wait — mirrors blocking-op semantics.
    const uniqueLegIds = Array.from(new Set(operations.map((operation) => operation.legId).filter(Boolean)));
    const waitRetention = uniqueLegIds.length > 0
      ? this.legService.retainLegs(uniqueLegIds, `media:waitMedia:${waitOperation.mediaIds.join(",")}`)
      : null;
    try {
      const event = await this.waitForMediaEvent(waitOperation.mediaIds, waitOperation.timeoutMs, context);
      if (event) {
        return this.mediaEventToResult(event);
      }
      return {
        status: "timeout",
        eventType: MEDIA_EVENT_TIMEOUT,
      };
    } finally {
      waitRetention?.release();
    }
  }

  async sendDtmf(legId: string, digits: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.legService.requireLeg(legId);
    const emitLegEvent = input._internalEmitLegEvent !== false;
    const skipBridgeRelay = input._internalSkipBridgeRelay === true;
    const method = String(input.dtmfMethod || OPTION_DEFAULTS.sendDtmf.method);
    const mediaTransportSent = digits ? await this.executionPlane.sendDtmf(legId, digits, method) : false;
    const signalingTransportSent = digits && (!mediaTransportSent || method === "info")
      ? await this.sendSignalingDtmf(legId, digits, method)
      : false;
    if (digits) {
      if (emitLegEvent) {
        this.legService.publishDtmf(legId, digits);
      }
      await this.interruptOnDtmf(legId, digits);
      const bridgePeer = this.executionPlane.getBridgePeerInfo(legId);
      if (!skipBridgeRelay && bridgePeer && String(bridgePeer.relayDtmf || OPTION_DEFAULTS.call.relayDtmf) !== "disabled") {
        await this.relayBridgeDtmf(bridgePeer, digits, input);
      }
    }
    return {
      legId,
      digits,
      sent: digits.length,
      method: mediaTransportSent && (method === OPTION_DEFAULTS.sendDtmf.method || method === "rfc2833")
        ? "rfc2833"
        : signalingTransportSent && (method === OPTION_DEFAULTS.sendDtmf.method || method === "info")
          ? "info"
          : method,
    };
  }

  async controlRecording(legId: string, action: "pause" | "resume"): Promise<Record<string, unknown>> {
    this.legService.requireLeg(legId);
    if (!this.globalCallRecordings.has(legId)) {
      throw daemonError("invalid_media", `Leg ${legId} has no global recording`);
    }
    if (action === "pause") {
      await this.executionPlane.pauseGlobalRecording(legId);
    } else {
      await this.executionPlane.resumeGlobalRecording(legId);
    }
    return {
      legId,
      action,
    };
  }

  async reportVoiceActivity(legId: string, level: number, durationMs: number): Promise<void> {
    const targets = buildVoiceInterruptTargets(
      this.listMediaOperationsByLegId(legId).filter((operation) => !operation.finalized),
      level,
      durationMs,
    );
    await Promise.all(targets.map(async (mediaId) => {
      await this.finalizeOperation(mediaId, "interrupted", {
        interruptReason: "voice",
        voiceLevel: level,
        voiceDurationMs: durationMs,
      });
    }));
  }

  async handleTransportDtmf(legId: string, digits: string): Promise<void> {
    await this.handleInboundDtmf(legId, digits);
  }

  async ensureTransportEndpoint(legId: string): Promise<Record<string, unknown>> {
    const startedAt = nowMs();
    try {
      const details = await this.executionPlane.ensureTransportEndpoint(legId);
      console.error(
        `[sip-pbx:media] ensureTransportEndpoint done; leg=${legId}; elapsedMs=${Math.max(0, nowMs() - startedAt)}`,
      );
      return { ...(details || {}) };
    } catch (error) {
      await this.rollbackBridgeAfterTransportFailure(legId);
      throw error;
    }
  }

  async sendWebSocketJson(legId: string, payload: Record<string, unknown>): Promise<boolean> {
    return await this.executionPlane.sendWebSocketJson(legId, payload);
  }

  private maybeSendTransparentProgress(legId: string): void {
    const leg = this.legService.getLeg(legId);
    if (!leg || leg.transportType !== "sip" || leg.direction !== "inbound" || leg.status === LEG_STATUS_ANSWERED) {
      return;
    }
    this.sendSignalingProgress(legId);
  }

  async handleLegEnded(legId: string): Promise<void> {
    try {
      await this.handleLegEndedAsync(legId);
    } catch (error) {
      console.error("[sip-pbx:media]", error instanceof Error ? error.message : String(error || "leg cleanup failed"));
    }
  }

  private async handleLegEndedAsync(legId: string): Promise<void> {
    await this.executionPlane.waitUntilLegStable(legId);
    const bridgePeer = await this.executionPlane.beginBridgeTermination(legId);
    if (bridgePeer?.peerLegId) {
      if (this.legService.getLeg(bridgePeer.peerLegId)) {
        this.legService.publishInterrupt(bridgePeer.peerLegId, "bridge");
      }
      this.releaseBridgeRetention(legId);
      await this.executionPlane.orphanBridgeAfterLegEnd(legId, bridgePeer.peerLegId);
    }
    if (this.globalCallRecordings.has(legId)) {
      try {
        await this.finalizeGlobalCallRecording(legId, "interrupted", { interruptReason: "leg_ended" });
      } catch (error) {
        console.error("[sip-pbx:media]", error instanceof Error ? error.message : String(error || "global call recording finalization failed"));
      }
    }
    let activeOperations = this.listMediaOperationsByLegId(legId).filter((operation) => !operation.finalized);
    if (activeOperations.length === 0) {
      await this.executionPlane.removeLeg(legId);
      return;
    }
    await this.waitForRecordingStartup(legId, activeOperations);
    activeOperations = this.listMediaOperationsByLegId(legId).filter((operation) => !operation.finalized);
    if (activeOperations.length === 0) {
      await this.executionPlane.removeLeg(legId);
      return;
    }
    const results = await Promise.allSettled(activeOperations.map(async (operation) => {
      await this.finalizeOperation(operation.mediaId, "interrupted", { interruptReason: "leg_ended" });
    }));
    for (const result of results) {
      if (result.status === DIAL_STATUS_REJECTED) {
        const error = result.reason;
        console.error("[sip-pbx:media]", error instanceof Error ? error.message : String(error || "leg media finalization failed"));
      }
    }
    await this.executionPlane.removeLeg(legId);
  }

  private async waitForRecordingStartup(legId: string, operations: MediaOperation[]): Promise<void> {
    if (!operations.some((operation) => operation instanceof RecordAudioOperation)) {
      return;
    }
    const deadline = nowMs() + 1000;
    while (nowMs() < deadline) {
      const pendingRecording = this.listMediaOperationsByLegId(legId)
        .some((operation) => !operation.finalized && operation instanceof RecordAudioOperation);
      if (!pendingRecording || this.executionPlane.getRecordingMediaId(legId)) {
        return;
      }
      await sleep(10);
    }
  }

  async bridgeLegs(
    legAId: string,
    legBId: string,
    options?: { relayDtmf?: string; emitDtmfEvents?: boolean },
  ): Promise<{ legAId: string; legBId: string }> {
    if (this.isSameActiveBridgePair(legAId, legBId)) {
      await Promise.all([legAId, legBId].map(async (legId) => {
        await this.executionPlane.ensureTransportEndpoint(legId);
      }));
      await this.executionPlane.activateBridge(legAId, legBId, options);
      return { legAId, legBId };
    }
    await this.detachPriorBridgesForRebridge(legAId, legBId);
    const legs = [legAId, legBId].filter(Boolean);
    await Promise.all(legs.map(async (legId) => {
      const operations = this.listMediaOperationsByLegId(legId).filter((operation) => !operation.finalized);
      await Promise.all(operations.map(async (operation) => {
        await this.finalizeOperation(operation.mediaId, "interrupted", {
          interruptReason: "bridge",
        });
      }));
    }));
    await Promise.all(legs.map(async (legId) => {
      await this.executionPlane.ensureTransportEndpoint(legId);
    }));
    this.acquireBridgeRetention(legAId, legBId);
    try {
      await this.executionPlane.activateBridge(legAId, legBId, options);
    } catch (error) {
      this.releaseBridgeRetention(legAId);
      throw error;
    }
    return { legAId, legBId };
  }

  async unbridgeLeg(legId: string): Promise<{ origLegId: string; peerLegId: string | null }> {
    this.legService.requireLeg(legId);
    const bridgePeer = this.executionPlane.getBridgePeerInfo(legId);
    const peerLegId = bridgePeer?.peerLegId || null;
    await this.executionPlane.deactivateBridge([legId, peerLegId]);
    if (peerLegId) {
      this.legService.publishInterrupt(legId, "unbridge");
      if (this.legService.getLeg(peerLegId)) {
        this.legService.publishInterrupt(peerLegId, "unbridge");
      }
      this.releaseBridgeRetention(legId);
    }
    return {
      origLegId: legId,
      peerLegId,
    };
  }

  private async rollbackBridgeAfterTransportFailure(legId: string): Promise<void> {
    const bridgePeer = this.executionPlane.getBridgePeerInfo(legId);
    const peerLegId = String(bridgePeer?.peerLegId || "").trim();
    if (!peerLegId) {
      return;
    }
    console.error(
      `[sip-pbx:media] rollback bridge after transport failure; leg=${legId}; peer=${peerLegId}`,
    );
    await this.executionPlane.deactivateBridge([legId, peerLegId]);
    if (this.legService.getLeg(legId)) {
      this.legService.publishInterrupt(legId, "unbridge");
    }
    if (this.legService.getLeg(peerLegId)) {
      this.legService.publishInterrupt(peerLegId, "unbridge");
    }
    this.releaseBridgeRetention(legId);
  }

  private isSameActiveBridgePair(legAId: string, legBId: string): boolean {
    const bridgeA = this.executionPlane.getBridgePeerInfo(legAId);
    const bridgeB = this.executionPlane.getBridgePeerInfo(legBId);
    return Boolean(
      bridgeA
      && bridgeB
      && bridgeA.peerLegId === legBId
      && bridgeB.peerLegId === legAId,
    );
  }

  private collectPriorBridgeLegIdsForRebridge(legAId: string, legBId: string): string[] {
    const affected = new Set<string>();
    for (const legId of [legAId, legBId]) {
      const bridgePeer = this.executionPlane.getBridgePeerInfo(legId);
      if (!bridgePeer?.peerLegId) {
        continue;
      }
      affected.add(legId);
      affected.add(bridgePeer.peerLegId);
    }
    return Array.from(affected);
  }

  private async detachPriorBridgesForRebridge(legAId: string, legBId: string): Promise<void> {
    const affectedLegIds = this.collectPriorBridgeLegIdsForRebridge(legAId, legBId);
    if (affectedLegIds.length === 0) {
      return;
    }
    await this.executionPlane.deactivateBridge(affectedLegIds);
    for (const legId of affectedLegIds) {
      if (this.legService.getLeg(legId)) {
        this.legService.publishInterrupt(legId, "unbridge");
      }
    }
    for (const legId of affectedLegIds) {
      this.releaseBridgeRetention(legId);
    }
  }

  async closeAll(): Promise<void> {
    for (const operation of this.registry.values()) {
      this.clearMediaCompletionTimer(operation);
      try {
        await operation.destroy("interrupted", { interruptReason: "shutdown" });
      } catch (error) {
        console.error("[sip-pbx:media]", error instanceof Error ? error.message : String(error || "media shutdown failed"));
      }
    }
    for (const legId of Array.from(this.globalCallRecordings.keys())) {
      try {
        await this.finalizeGlobalCallRecording(legId, "interrupted", { interruptReason: "shutdown" });
      } catch (error) {
        console.error("[sip-pbx:media]", error instanceof Error ? error.message : String(error || "global call recording shutdown failed"));
      }
    }
    await this.executionPlane.shutdown();
  }

  hasActiveWork(): boolean {
    return this.registry.values().length > 0 || this.globalCallRecordings.size > 0;
  }

  private requireMediaOperation(mediaId: string): MediaOperation {
    return requireMediaOperation(this.registry, mediaId);
  }

  getMediaOperation(mediaId: string): MediaOperation | null {
    return this.registry.get(mediaId);
  }

  listMediaOperationsByLegId(legId: string): MediaOperation[] {
    return this.registry.values().filter((operation) => operation.legId === legId);
  }

  listMediaOperations(): MediaOperation[] {
    return this.registry.values();
  }

  private async stopOtherMediaBeforeStart(legId: string): Promise<void> {
    const operations = this.listMediaOperationsByLegId(legId).filter((operation) => !operation.finalized);
    await Promise.all(operations.map(async (operation) => {
      await this.finalizeOperation(operation.mediaId, "interrupted", {
        interruptReason: "replaced",
      });
    }));
  }

  private clearMediaCompletionTimer(operation: MediaOperation): void {
    if (!operation.completionTimer) {
      return;
    }
    clearTimeout(operation.completionTimer);
    operation.completionTimer = null;
  }

  private buildMediaEvent(operation: MediaOperation): MediaEvent {
    return {
      mediaId: operation.mediaId,
      legId: operation.legId,
      eventType: operation.status,
      createdAt: operation.finalizedAt || nowMs(),
      ...(operation.result || {}),
    };
  }

  private mediaEventToResult(event: MediaEvent): Record<string, unknown> {
    return {
      mediaId: event.mediaId,
      legId: event.legId,
      status: event.eventType,
      eventType: event.eventType,
      ...event,
    };
  }

  private publishMediaEvent(mediaId: string, event: MediaEvent): void {
    this.requireMediaOperation(mediaId).publishEvent(event);
  }

  private async finalizeMediaOperationOnce(
    mediaId: string,
    status: MediaStatus,
    materializeResult: (operation: MediaOperation) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const operation = this.requireMediaOperation(mediaId);
    if (operation.finalized) {
      return this.mediaEventToResult(this.buildMediaEvent(operation));
    }
    operation.status = status;
    operation.finalizedAt = nowMs();
    this.clearMediaCompletionTimer(operation);
    operation.result = await materializeResult(operation);
    operation.finalized = true;
    const event = this.buildMediaEvent(operation);
    this.publishMediaEvent(mediaId, event);
    return this.mediaEventToResult(event);
  }

  private async waitForAnyMediaEvent(mediaIds: string[], timeoutMs: number): Promise<MediaEvent | null> {
    const operationsToWait = mediaIds.map((mediaId) => this.requireMediaOperation(mediaId));
    for (const operation of operationsToWait) {
      const queued = operation.shiftEvent();
      if (queued) {
        return queued;
      }
    }
    const tickets = operationsToWait.map((operation) => operation.waitForEventCancellable(() => true, 0));
    for (const operation of operationsToWait) {
      const queued = operation.shiftEvent();
      if (queued) {
        tickets.forEach((ticket) => ticket.cancel());
        return queued;
      }
    }
    const waitPromises = tickets.map((ticket) => ticket.promise);
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeoutPromise = timeoutMs > 0
      ? new Promise<MediaEvent | null>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(null), timeoutMs);
        })
      : null;
    try {
      return await Promise.race(timeoutPromise ? [...waitPromises, timeoutPromise] : waitPromises);
    } finally {
      tickets.forEach((ticket) => ticket.cancel());
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private scheduleFinalization(
    operation: MediaOperation,
    delayMs: number,
    status: MediaStatus,
    result: Record<string, unknown>,
  ): void {
    this.clearMediaCompletionTimer(operation);
    operation.completionTimer = setTimeout(() => {
      console.error(
        `[sip-pbx:media] scheduleFinalization fired; media=${operation.mediaId}; leg=${operation.legId}; kind=${operation.kind}; status=${status}; delayMs=${Math.max(1, delayMs)}`,
      );
      void this.finalizeOperation(operation.mediaId, status, result);
    }, Math.max(1, delayMs));
  }

  async finalizeOperation(
    mediaId: string,
    status: MediaStatus,
    result: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const operation = this.registry.get(mediaId);
    if (!operation) {
      console.error(
        `[sip-pbx:media] finalize skipped; media=${mediaId}; status=${status}; reason=record_missing`,
      );
      return {
        mediaId,
        legId: "",
        status,
        eventType: status,
        ...(result || {}),
      };
    }
    return await operation.destroy(status, result);
  }

  private async handleOperationDestroy(
    operation: MediaOperation,
    status: MediaStatus,
    result: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return await this.finalizeMediaOperationOnce(operation.mediaId, status, async (currentOperation) => {
      let finalizedResult = { ...(result || {}) };
      if (currentOperation instanceof RecordAudioOperation) {
        await this.executionPlane.stopRecording(currentOperation.legId, currentOperation.mediaId);
        finalizedResult = await this.executionPlane.finalizeRecording(currentOperation.legId, currentOperation.mediaId, {
          ...(result || {}),
          durationMs: Math.max(1, Number(currentOperation.finalizedAt || nowMs()) - Number(currentOperation.createdAt || nowMs())),
          outputBinaryProperty: String(currentOperation.options.recordBinaryProperty || OPTION_DEFAULTS.recordAudio.binaryProperty),
        });
        await this.executionPlane.pruneLegIfIdle(currentOperation.legId);
      } else if (currentOperation instanceof PlayAudioOperation || currentOperation instanceof PlayTonesOperation) {
        const unregisterStartedAt = nowMs();
        console.error(
          `[sip-pbx:media] unregisterPlayback start; media=${currentOperation.mediaId}; leg=${currentOperation.legId}; kind=${currentOperation.kind}; status=${status}`,
        );
        await this.executionPlane.unregisterPlayback(currentOperation.legId, currentOperation.mediaId);
        console.error(
          `[sip-pbx:media] unregisterPlayback done; media=${currentOperation.mediaId}; leg=${currentOperation.legId}; kind=${currentOperation.kind}; elapsedMs=${Math.max(0, nowMs() - unregisterStartedAt)}`,
        );
      }

      if (!currentOperation.isBackground()) {
        this.releaseMediaRetention(currentOperation.mediaId);
      }
      return finalizedResult;
    });
  }

  private async waitForBlockingMedia(mediaId: string, context?: RequestContext | null): Promise<Record<string, unknown>> {
    this.requireMediaOperation(mediaId);
    if (!context) {
      return await this.waitMedia({
        waitMediaIds: [mediaId],
        waitMediaTimeoutMs: 0,
      });
    }
    let releaseCancel = () => undefined;
    const cancelled = new Promise<Record<string, unknown>>((_resolve, reject) => {
      releaseCancel = context.onCancel(() => {
        void this.finalizeOperation(mediaId, "interrupted", {
          interruptReason: "request_cancelled",
        }).catch((error) => {
          console.error(
            `[sip-pbx:media] blocking media cancellation finalization failed; media=${mediaId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
          );
        });
        reject(daemonError("request_cancelled", "The request was cancelled"));
      });
    });
    try {
      return await Promise.race([
        this.waitMedia({
          waitMediaIds: [mediaId],
          waitMediaTimeoutMs: 0,
        }),
        cancelled,
      ]);
    } finally {
      releaseCancel();
    }
  }

  private async waitForMediaEvent(
    mediaIds: string[],
    timeoutMs: number,
    context?: RequestContext | null,
  ): Promise<import("./operations/media-operation").MediaEvent | null> {
    if (!context) {
      return await this.waitForAnyMediaEvent(mediaIds, timeoutMs);
    }
    let release = () => undefined;
    const cancelled = new Promise<MediaEvent | null>((_resolve, reject) => {
      release = context.onCancel(() => {
        reject(daemonError("request_cancelled", "The request was cancelled"));
      });
    });
    try {
      return await Promise.race([
        this.waitForAnyMediaEvent(mediaIds, timeoutMs),
        cancelled,
      ]);
    } finally {
      release();
    }
  }

  private async interruptOnDtmf(legId: string, digits: string): Promise<void> {
    const targets = buildDtmfInterruptTargets(
      this.listMediaOperationsByLegId(legId).filter((operation) => !operation.finalized),
    );
    await Promise.all(targets.map(async (mediaId) => {
      await this.finalizeOperation(mediaId, "interrupted", {
        interruptReason: "dtmf",
        digit: digits.slice(0, 1) || null,
        digits,
      });
    }));
  }

  private async relayBridgeDtmf(
    bridgePeer: { peerLegId: string; relayDtmf: string; emitDtmfEvents: boolean },
    digits: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    if (!bridgePeer.peerLegId) {
      return;
    }
    const relayMethod = String(bridgePeer.relayDtmf || OPTION_DEFAULTS.call.relayDtmf) === OPTION_DEFAULTS.call.relayDtmf
      ? String(input.dtmfMethod || OPTION_DEFAULTS.sendDtmf.method)
      : String(bridgePeer.relayDtmf || OPTION_DEFAULTS.call.relayDtmf);
    await this.sendDtmf(bridgePeer.peerLegId, digits, {
      ...input,
      dtmfMethod: relayMethod,
      _internalEmitLegEvent: bridgePeer.emitDtmfEvents,
      _internalSkipBridgeRelay: true,
    });
  }

  private async handleInboundDtmf(legId: string, digits: string): Promise<void> {
    if (!digits) {
      return;
    }
    this.legService.publishDtmf(legId, digits);
    await this.interruptOnDtmf(legId, digits);
    const bridgePeer = this.executionPlane.getBridgePeerInfo(legId);
    if (bridgePeer && String(bridgePeer.relayDtmf || OPTION_DEFAULTS.call.relayDtmf) !== "disabled") {
      await this.relayBridgeDtmf(bridgePeer, digits, {
        dtmfMethod: "rfc2833",
      });
    }
  }

  private async handlePlaybackFinished(legId: string, mediaId: string): Promise<void> {
    const operation = this.registry.get(mediaId);
    if (!operation || operation.legId !== legId || operation.finalized) {
      return;
    }
    console.error(
      `[sip-pbx:media] playback finished; media=${mediaId}; leg=${legId}; kind=${operation.kind}; status=${operation.status}`,
    );
    await this.finalizeOperation(mediaId, "completed", {});
  }

  private async handleMediaFailure(
    legId: string,
    mediaId: string,
    reason: string,
    error?: string | null,
  ): Promise<void> {
    const operation = this.registry.get(mediaId);
    console.error(
      `[sip-pbx:media] media failure reported; media=${mediaId}; leg=${legId}; kind=${operation?.kind || "unknown"}; found=${Boolean(operation)}; finalized=${operation?.finalized ? "true" : "false"}; reason=${reason}; error=${error ? String(error) : ""}`,
    );
    if (!operation || operation.legId !== legId || operation.finalized) {
      return;
    }
    await this.finalizeOperation(mediaId, "failed", {
      reason,
      error: error ? String(error) : undefined,
    });
  }

  private async handleMediaInterrupt(
    legId: string,
    mediaId: string,
    reason: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const operation = this.registry.get(mediaId);
    console.error(
      `[sip-pbx:media] media interrupt reported; media=${mediaId}; leg=${legId}; kind=${operation?.kind || "unknown"}; found=${Boolean(operation)}; finalized=${operation?.finalized ? "true" : "false"}; reason=${reason}; details=${JSON.stringify(details || {})}`,
    );
    if (!operation || operation.legId !== legId || operation.finalized) {
      return;
    }
    await this.finalizeOperation(mediaId, "interrupted", {
      interruptReason: reason,
      ...(details || {}),
    });
  }

  private async finalizeGlobalCallRecording(
    legId: string,
    status: MediaStatus,
    result: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const state = this.globalCallRecordings.get(legId) || null;
    if (!state) {
      return {
        legId,
        status,
        ...(result || {}),
      };
    }
    if (state.finalizationPromise) {
      return await state.finalizationPromise;
    }
    state.finalizationPromise = (async () => {
      await state.startupPromise;
      await this.executionPlane.deactivateGlobalRecording(state.legId, state.mediaId);
      const finalized = await this.executionPlane.finalizeRecording(state.legId, state.mediaId, {
        ...(result || {}),
        durationMs: Math.max(1, nowMs() - state.createdAt),
      });
      await this.executionPlane.pruneLegIfIdle(state.legId);
      const finalResult = {
        legId: state.legId,
        status,
        ...(finalized || {}),
      };
      state.resolveCompletion(finalResult);
      return finalResult;
    })();
    try {
      return await state.finalizationPromise;
    } catch (error) {
      state.rejectCompletion(error);
      throw error;
    } finally {
      if (this.globalCallRecordings.get(legId) === state) {
        this.globalCallRecordings.delete(legId);
      }
    }
  }
}

if (!isMainThread) {
  startWorkerRuntime();
}

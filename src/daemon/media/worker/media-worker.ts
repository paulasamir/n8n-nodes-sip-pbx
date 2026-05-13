import { performance } from "perf_hooks";
import { inspect } from "util";
import { Worker, parentPort, workerData } from "worker_threads";
import { OPTION_DEFAULTS } from "../../../shared/option-defaults";
import { Bridge } from "./entities/bridge";
import { Leg, type LegMediaSessionSnapshot } from "./entities/leg";
import { Media } from "./entities/media";
import type { MediaTransport, MediaTransportDetails } from "../transports/media-transport";
import type { AudioCodec, AudioCodecName, Pcm16Converter } from "../codecs/audio-codec";
import {
  convertPcm16,
  createCodec,
  createPcm16Converter,
  estimateConvertedPcm16Bytes,
  isPcmTargetBufferTooSmallError,
  loadNativeCodecBindings,
  mapDescriptorNameToAudioCodecName,
} from "../codecs/audio-codec";
import { Mixer } from "./entities/mixer";
import { RtpTransport } from "../transports/rtp-transport";
import { WebSocketTransport } from "../transports/websocket-transport";
import {
  createReadableMediaEndpoint,
  createWritableMediaEndpoint,
  isSeekableWritableMediaEndpoint,
} from "../io/media-endpoint";
import {
  createStream,
  type BufferReleasePool,
  type MediaStream,
  type MediaStreamEncoder,
} from "../streams/media-stream";
import { createTransport } from "../transports/media-transport";

export type WorkerRuntimeTransportType = "sip" | "websocket";

export enum WorkerMessageKind {
  Command = 1,
  Result = 2,
  Event = 3,
  TransportInput = 4,
  TransportOutput = 5,
}

export enum WorkerControlOpcode {
  EnsureEndpoint = 1,
  AcceptEndpointHandoff = 2,
  RemoveEndpoint = 3,
  RegisterPlayback = 4,
  UnregisterPlayback = 5,
  StartRecording = 6,
  StopRecording = 7,
  FinalizeRecording = 8,
  PauseGlobalRecording = 9,
  ResumeGlobalRecording = 10,
  ActivateGlobalRecording = 11,
  DeactivateGlobalRecording = 12,
  ExportEndpointState = 13,
  SendDtmf = 14,
  BindLocalBridgePeer = 15,
  OrphanBridgeLeg = 16,
  UnbindLocalBridgePeer = 17,
  Shutdown = 18,
}

export enum WorkerTransportInputOpcode {
  RtpPacket = 1,
  WebSocketPayload = 2,
  TransportClosed = 3,
}

export enum WorkerEventOpcode {
  Snapshot = 1,
  VoiceActivity = 2,
  InboundDtmf = 3,
  PlaybackFinished = 4,
  MediaFailed = 5,
  MediaInterrupt = 6,
  TransportClosed = 7,
}

export enum WorkerTransportOutputOpcode {
  RtpPacket = 1,
  WebSocketJson = 2,
}

export type WorkerControlRequest =
  | {
    opcode: WorkerControlOpcode.EnsureEndpoint;
    payload: {
      legId: string;
      transportType: WorkerRuntimeTransportType;
      transportConfig?: Record<string, unknown>;
      codecName?: AudioCodecName;
    };
  }
  | {
    opcode: WorkerControlOpcode.AcceptEndpointHandoff;
    payload: {
      legId: string;
      transportType: WorkerRuntimeTransportType;
      transportConfig?: Record<string, unknown>;
      codecName: AudioCodecName;
    };
  }
  | { opcode: WorkerControlOpcode.RemoveEndpoint; payload: { legId: string } }
  | {
    opcode: WorkerControlOpcode.RegisterPlayback;
    payload: {
      legId: string;
      transportType: WorkerRuntimeTransportType;
      playback: Record<string, unknown>;
      sourceInput?: Record<string, unknown>;
    };
  }
  | { opcode: WorkerControlOpcode.UnregisterPlayback; payload: { legId: string; mediaId: string } }
  | {
    opcode: WorkerControlOpcode.StartRecording;
    payload: {
      legId: string;
      transportType: WorkerRuntimeTransportType;
      mediaId: string;
      startedAt?: number;
      input: Record<string, unknown>;
    };
  }
  | { opcode: WorkerControlOpcode.StopRecording; payload: { legId: string; mediaId: string } }
  | { opcode: WorkerControlOpcode.FinalizeRecording; payload: { legId: string; mediaId: string; result: Record<string, unknown> } }
  | { opcode: WorkerControlOpcode.PauseGlobalRecording; payload: { legId: string } }
  | { opcode: WorkerControlOpcode.ResumeGlobalRecording; payload: { legId: string } }
  | {
    opcode: WorkerControlOpcode.ActivateGlobalRecording;
    payload: {
      legId: string;
      transportType: WorkerRuntimeTransportType;
      mediaId: string;
      startedAt?: number;
      input: Record<string, unknown>;
    };
  }
  | { opcode: WorkerControlOpcode.DeactivateGlobalRecording; payload: { legId: string; mediaId: string } }
  | { opcode: WorkerControlOpcode.ExportEndpointState; payload: { legId: string } }
  | { opcode: WorkerControlOpcode.SendDtmf; payload: { legId: string; transportType: WorkerRuntimeTransportType; digits: string; method: string } }
  | { opcode: WorkerControlOpcode.BindLocalBridgePeer; payload: { sourceLegId: string; peerLegId: string } }
  | { opcode: WorkerControlOpcode.OrphanBridgeLeg; payload: { legId: string; peerLegId?: string } }
  | { opcode: WorkerControlOpcode.UnbindLocalBridgePeer; payload: { sourceLegId: string } }
  | { opcode: WorkerControlOpcode.Shutdown; payload: Record<string, never> };

export type WorkerTransportInput =
  | { opcode: WorkerTransportInputOpcode.RtpPacket; payload: { legId: string; packet: Buffer | Uint8Array } }
  | { opcode: WorkerTransportInputOpcode.WebSocketPayload; payload: { legId: string; payload: unknown } }
  | { opcode: WorkerTransportInputOpcode.TransportClosed; payload: { legId: string; reason: string } };

export type WorkerCommandMessage = {
  kind: WorkerMessageKind.Command;
  requestId: string;
  opcode: WorkerControlRequest["opcode"];
  payload: Record<string, unknown>;
};

export type WorkerResultMessage = {
  kind: WorkerMessageKind.Result;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type WorkerEventMessage =
  | { kind: WorkerMessageKind.Event; opcode: WorkerEventOpcode.Snapshot; payload: { snapshot: LegMediaSessionSnapshot } }
  | { kind: WorkerMessageKind.Event; opcode: WorkerEventOpcode.VoiceActivity; payload: { legId: string; level: number; durationMs: number } }
  | { kind: WorkerMessageKind.Event; opcode: WorkerEventOpcode.InboundDtmf; payload: { legId: string; digits: string } }
  | { kind: WorkerMessageKind.Event; opcode: WorkerEventOpcode.PlaybackFinished; payload: { legId: string; mediaId: string } }
  | { kind: WorkerMessageKind.Event; opcode: WorkerEventOpcode.MediaFailed; payload: { legId: string; mediaId: string; reason: string; error?: string } }
  | { kind: WorkerMessageKind.Event; opcode: WorkerEventOpcode.MediaInterrupt; payload: { legId: string; mediaId: string; reason: string; details?: Record<string, unknown> } }
  | { kind: WorkerMessageKind.Event; opcode: WorkerEventOpcode.TransportClosed; payload: { legId: string; reason: string } };

export type WorkerTransportInputMessage =
  | { kind: WorkerMessageKind.TransportInput; opcode: WorkerTransportInputOpcode.RtpPacket; payload: { legId: string; packet: Buffer | Uint8Array } }
  | { kind: WorkerMessageKind.TransportInput; opcode: WorkerTransportInputOpcode.WebSocketPayload; payload: { legId: string; payload: unknown } }
  | { kind: WorkerMessageKind.TransportInput; opcode: WorkerTransportInputOpcode.TransportClosed; payload: { legId: string; reason: string } };

export type WorkerTransportOutputMessage =
  | { kind: WorkerMessageKind.TransportOutput; opcode: WorkerTransportOutputOpcode.RtpPacket; payload: { legId: string; packet: Buffer | Uint8Array; bytes?: number } }
  | { kind: WorkerMessageKind.TransportOutput; opcode: WorkerTransportOutputOpcode.WebSocketJson; payload: { legId: string; payload: Record<string, unknown> } };

export type WorkerMessage =
  | WorkerCommandMessage
  | WorkerResultMessage
  | WorkerEventMessage
  | WorkerTransportInputMessage
  | WorkerTransportOutputMessage;

export type WorkerEndpointState = {
  legId: string;
  codecName: AudioCodecName;
  transportState: Record<string, unknown>;
  snapshot: LegMediaSessionSnapshot;
};

type ActivePlaybackPump = {
  media: Media;
  legId: string;
  cancelled: boolean;
  task: Promise<void>;
};

type ActiveRecordingSession = {
  media: Media;
  legId: string;
  mediaStream: MediaStream;
  encoder: MediaStreamEncoder | null;
  drainScratch: Buffer;
  convertScratch: Buffer;
  writeChain: Promise<void>;
  closing: boolean;
  draining: boolean;
  inputSampleRate: number | null;
  inputChannels: number | null;
  pcmConverters: Map<string, Pcm16Converter>;
  pendingChunks: Array<{
    pcm: Buffer;
    bytes: number;
    sampleRate: number;
    channels: number;
    releasePool?: BufferReleasePool | null;
  }>;
};

export type WorkerEnsureEndpointResult = {
  snapshot: LegMediaSessionSnapshot;
  transportDetails: MediaTransportDetails;
};

type PendingRequest = {
  opcode: WorkerControlRequest["opcode"];
  startedAt: number;
  summary: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function formatWorkerDiagnostic(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack || reason.message;
  }
  if (typeof reason === "string") {
    return reason;
  }
  return inspect(reason, { depth: 2, breakLength: Infinity });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createWorkerError(message: unknown): Error {
  return new Error(String(message || "Media worker request failed"));
}

function formatPendingRequestSummary(pending: Map<string, PendingRequest>, now = Date.now()): string {
  return Array.from(pending.entries())
    .map(([requestId, request]) => `${requestId}:${request.opcode}:${request.summary}:${Math.max(0, now - request.startedAt)}ms`)
    .join(", ");
}

function detectWebSocketPayloadEventType(payload: unknown): string {
  if (payload && typeof payload === "object" && !Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) {
    return String((payload as Record<string, unknown>).type || "").trim();
  }
  const text =
    typeof payload === "string"
      ? payload
      : Buffer.isBuffer(payload)
        ? payload.toString("utf8")
        : payload instanceof Uint8Array
          ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8")
          : payload instanceof ArrayBuffer
            ? Buffer.from(payload).toString("utf8")
            : ArrayBuffer.isView(payload)
              ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8")
              : "";
  if (!text) {
    return "";
  }
  if (text.includes("\"response.output_audio.delta\"")) {
    return "response.output_audio.delta";
  }
  if (text.includes("\"response.audio.delta\"")) {
    return "response.audio.delta";
  }
  return "";
}

function observeCleanupPromise(
  workerId: string,
  label: string,
  promise: Promise<unknown>,
): void {
  void promise.then(
    () => undefined,
    (error) => {
      console.error(`[sip-pbx:media-worker:${workerId}] ${label} failed: ${formatWorkerDiagnostic(error)}`);
    },
  );
}

function describeRequestPayload(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const legId = String(payload.legId || payload.sourceLegId || "").trim();
  if (legId) {
    parts.push(`leg=${legId}`);
  }
  const mediaId = String(payload.mediaId || "").trim();
  if (mediaId) {
    parts.push(`media=${mediaId}`);
  }
  const transportType = String(payload.transportType || "").trim();
  if (transportType) {
    parts.push(`transport=${transportType}`);
  }
  return parts.length > 0 ? parts.join("|") : "no-target";
}

export type WorkerControlPlane = {
  getEndpointCount(): number;
  getActiveMediaCount(): number;
  getSnapshot(legId: string): LegMediaSessionSnapshot | null;
  getRecordingMediaId(legId: string): string | null;
  isEndpointIdle(legId: string): boolean;
  ensureEndpoint(
    legId: string,
    transportType: WorkerRuntimeTransportType,
    transportConfig?: Record<string, unknown>,
    codecName?: AudioCodecName,
  ): Promise<WorkerEnsureEndpointResult>;
  removeEndpoint(legId: string): Promise<boolean>;
  registerPlayback(
    legId: string,
    transportType: WorkerRuntimeTransportType,
    playback: Record<string, unknown>,
  ): Promise<LegMediaSessionSnapshot>;
  unregisterPlayback(legId: string, mediaId: string): Promise<LegMediaSessionSnapshot | null>;
  startRecording(
    legId: string,
    transportType: WorkerRuntimeTransportType,
    mediaId: string,
    startedAt?: number,
    input?: Record<string, unknown>,
  ): Promise<LegMediaSessionSnapshot>;
  stopRecording(legId: string, mediaId: string): Promise<LegMediaSessionSnapshot | null>;
  finalizeRecording(legId: string, mediaId: string, result: Record<string, unknown>): Promise<Record<string, unknown>>;
  pauseGlobalRecording(legId: string): Promise<LegMediaSessionSnapshot | null>;
  resumeGlobalRecording(legId: string): Promise<LegMediaSessionSnapshot | null>;
  activateGlobalRecording(
    legId: string,
    transportType: WorkerRuntimeTransportType,
    mediaId: string,
    startedAt?: number,
    input?: Record<string, unknown>,
  ): Promise<LegMediaSessionSnapshot>;
  deactivateGlobalRecording(legId: string, mediaId: string): Promise<LegMediaSessionSnapshot | null>;
  exportEndpointState(legId: string): Promise<WorkerEndpointState | null>;
  acceptEndpointHandoff(
    legId: string,
    transportType: WorkerRuntimeTransportType,
    transportConfig: Record<string, unknown>,
    codecName: AudioCodecName,
  ): Promise<WorkerEnsureEndpointResult>;
  sendDtmf(legId: string, transportType: WorkerRuntimeTransportType, digits: string, method: string): Promise<boolean>;
  bindBridge(legAId: string, legBId: string): Promise<void>;
  unbindBridgeLeg(legId: string): Promise<void>;
  orphanBridgeLeg(legId: string, peerLegId?: string | null): Promise<void>;
  shutdown(): Promise<void>;
  deliverRtpPacket(legId: string, packet: Buffer | Uint8Array): void;
  deliverWebSocketPayload(legId: string, payload: unknown): void;
  notifyTransportClosed(legId: string, reason: string): void;
};

type CreateWorkerControlPlaneInput = {
  workerId: string;
  worker: Worker;
  onTransportOutput?: (message: WorkerTransportOutputMessage) => void;
  onVoiceActivity?: (legId: string, level: number, durationMs: number) => void;
  onInboundDtmf?: (legId: string, digits: string) => void;
  onPlaybackFinished?: (legId: string, mediaId: string) => void;
  onMediaFailure?: (legId: string, mediaId: string, reason: string, error?: string | null) => void;
  onMediaInterrupt?: (legId: string, mediaId: string, reason: string, details?: Record<string, unknown>) => void;
  onTransportClosed?: (legId: string, reason: string) => void;
};

export function createWorkerControlPlane(input: CreateWorkerControlPlaneInput): WorkerControlPlane {
  const workerId = input.workerId;
  const worker = input.worker;
  const onTransportOutput = input.onTransportOutput || (() => undefined);
  const onVoiceActivity = input.onVoiceActivity || (() => undefined);
  const onInboundDtmf = input.onInboundDtmf || (() => undefined);
  const onPlaybackFinished = input.onPlaybackFinished || (() => undefined);
  const onMediaFailure = input.onMediaFailure || (() => undefined);
  const onMediaInterrupt = input.onMediaInterrupt || (() => undefined);
  const onTransportClosed = input.onTransportClosed || (() => undefined);
  const pending = new Map<string, PendingRequest>();
  const snapshots = new Map<string, LegMediaSessionSnapshot>();
  let shutdownRequested = false;
  let requestSequence = 0;

  function resolveCommand(message: WorkerResultMessage): void {
    const pendingRequest = pending.get(message.requestId);
    if (!pendingRequest) {
      return;
    }
    pending.delete(message.requestId);
    if (message.ok) {
      pendingRequest.resolve(message.result);
      return;
    }
    pendingRequest.reject(createWorkerError(message.error));
  }

  function handleEvent(message: WorkerEventMessage): void {
    if (message.opcode === WorkerEventOpcode.Snapshot) {
      snapshots.set(message.payload.snapshot.legId, message.payload.snapshot);
      return;
    }
    if (message.opcode === WorkerEventOpcode.VoiceActivity) {
      onVoiceActivity(message.payload.legId, message.payload.level, message.payload.durationMs);
      return;
    }
    if (message.opcode === WorkerEventOpcode.InboundDtmf) {
      onInboundDtmf(message.payload.legId, message.payload.digits);
      return;
    }
    if (message.opcode === WorkerEventOpcode.PlaybackFinished) {
      onPlaybackFinished(message.payload.legId, message.payload.mediaId);
      return;
    }
    if (message.opcode === WorkerEventOpcode.MediaFailed) {
      onMediaFailure(
        message.payload.legId,
        message.payload.mediaId,
        message.payload.reason,
        message.payload.error,
      );
      return;
    }
    if (message.opcode === WorkerEventOpcode.MediaInterrupt) {
      onMediaInterrupt(
        message.payload.legId,
        message.payload.mediaId,
        message.payload.reason,
        message.payload.details,
      );
      return;
    }
    if (message.opcode === WorkerEventOpcode.TransportClosed) {
      onTransportClosed(message.payload.legId, message.payload.reason);
    }
  }

  async function handleMessage(message: WorkerMessage): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.kind === WorkerMessageKind.Result) {
      resolveCommand(message);
      return;
    }
    if (message.kind === WorkerMessageKind.TransportOutput) {
      onTransportOutput(message);
      return;
    }
    if (message.kind === WorkerMessageKind.Event) {
      handleEvent(message);
    }
  }

  async function sendCommand<TResult>(
    opcode: WorkerControlRequest["opcode"],
    payload: Record<string, unknown>,
  ): Promise<TResult> {
    const requestId = `${workerId}:${++requestSequence}`;
    const message: WorkerCommandMessage = {
      kind: WorkerMessageKind.Command,
      requestId,
      opcode,
      payload,
    };
    const summary = describeRequestPayload(payload);
    const startedAt = Date.now();
    const promise = new Promise<TResult>((resolve, reject) => {
      const request: PendingRequest = {
        opcode,
        startedAt,
        summary,
        resolve,
        reject,
      };
      if (pending.size > 0) {
        const summary = formatPendingRequestSummary(pending, startedAt);
        console.warn(`[sip-pbx:media-worker:${workerId}] queued control request ${opcode}; pending=${summary}`);
      }
      pending.set(requestId, request);
    });
    worker.postMessage(message);
    return await promise;
  }

  function rejectAll(error: Error): void {
    for (const [requestId, pendingRequest] of Array.from(pending.entries())) {
      pending.delete(requestId);
      pendingRequest.reject(error);
    }
  }

  worker.on("message", (message) => {
    void handleMessage(message as WorkerMessage);
  });
  worker.on("error", (error) => {
    if (!shutdownRequested) {
      console.error(`[sip-pbx:media-worker:${workerId}] worker error: ${formatWorkerDiagnostic(error)}; pending=${formatPendingRequestSummary(pending)}`);
    }
    rejectAll(error instanceof Error ? error : new Error(String(error || "Media worker failed")));
    void worker.terminate().catch((terminateError) => {
      console.error(
        `[sip-pbx:media-worker:${workerId}] worker terminate failed after error; error=${terminateError instanceof Error ? terminateError.message : String(terminateError || "unknown")}`,
      );
    });
  });
  worker.on("exit", (code) => {
    if (!shutdownRequested && code !== 0) {
      console.error(`[sip-pbx:media-worker:${workerId}] worker exited with code ${code}; pending=${formatPendingRequestSummary(pending)}`);
      rejectAll(new Error(`Media worker ${workerId} exited with code ${code}`));
    }
  });

  return {
    getEndpointCount(): number {
      return snapshots.size;
    },
    getActiveMediaCount(): number {
      let activeMediaCount = 0;
      for (const snapshot of snapshots.values()) {
        activeMediaCount += snapshot.playbackCount;
        if (snapshot.recordingActive) {
          activeMediaCount += 1;
        }
      }
      return activeMediaCount;
    },
    getSnapshot(legId: string): LegMediaSessionSnapshot | null {
      return snapshots.get(legId) || null;
    },
    getRecordingMediaId(legId: string): string | null {
      return snapshots.get(legId)?.activeRecordingMediaId || null;
    },
    isEndpointIdle(legId: string): boolean {
      const snapshot = snapshots.get(legId);
      return Boolean(snapshot && snapshot.playbackCount === 0 && !snapshot.recordingActive);
    },
    async ensureEndpoint(
      legId: string,
      transportType: WorkerRuntimeTransportType,
      transportConfig?: Record<string, unknown>,
      codecName?: AudioCodecName,
    ): Promise<WorkerEnsureEndpointResult> {
      const ensured = await sendCommand<WorkerEnsureEndpointResult>(WorkerControlOpcode.EnsureEndpoint, {
        legId,
        transportType,
        transportConfig: { ...(transportConfig || {}) },
        codecName,
      });
      snapshots.set(legId, ensured.snapshot);
      return ensured;
    },
    async removeEndpoint(legId: string): Promise<boolean> {
      const removed = await sendCommand<boolean>(WorkerControlOpcode.RemoveEndpoint, { legId });
      snapshots.delete(legId);
      return Boolean(removed);
    },
    async registerPlayback(
      legId: string,
      transportType: WorkerRuntimeTransportType,
      playback: Record<string, unknown>,
    ): Promise<LegMediaSessionSnapshot> {
      const snapshot = await sendCommand<LegMediaSessionSnapshot>(WorkerControlOpcode.RegisterPlayback, {
        legId,
        transportType,
        playback,
        sourceInput: playback.input && typeof playback.input === "object" ? playback.input as Record<string, unknown> : {},
      });
      snapshots.set(legId, snapshot);
      return snapshot;
    },
    async unregisterPlayback(legId: string, mediaId: string): Promise<LegMediaSessionSnapshot | null> {
      const snapshot = await sendCommand<LegMediaSessionSnapshot | null>(WorkerControlOpcode.UnregisterPlayback, { legId, mediaId });
      if (snapshot) {
        snapshots.set(legId, snapshot);
      }
      return snapshot;
    },
    async startRecording(
      legId: string,
      transportType: WorkerRuntimeTransportType,
      mediaId: string,
      startedAt?: number,
      input?: Record<string, unknown>,
    ): Promise<LegMediaSessionSnapshot> {
      const snapshot = await sendCommand<LegMediaSessionSnapshot>(WorkerControlOpcode.StartRecording, {
        legId,
        transportType,
        mediaId,
        startedAt,
        input: { ...(input || {}) },
      });
      snapshots.set(legId, snapshot);
      return snapshot;
    },
    async stopRecording(legId: string, mediaId: string): Promise<LegMediaSessionSnapshot | null> {
      const snapshot = await sendCommand<LegMediaSessionSnapshot | null>(WorkerControlOpcode.StopRecording, { legId, mediaId });
      if (snapshot) {
        snapshots.set(legId, snapshot);
      }
      return snapshot;
    },
    async finalizeRecording(legId: string, mediaId: string, result: Record<string, unknown>): Promise<Record<string, unknown>> {
      return await sendCommand<Record<string, unknown>>(WorkerControlOpcode.FinalizeRecording, {
        legId,
        mediaId,
        result,
      });
    },
    async pauseGlobalRecording(legId: string): Promise<LegMediaSessionSnapshot | null> {
      const snapshot = await sendCommand<LegMediaSessionSnapshot | null>(WorkerControlOpcode.PauseGlobalRecording, { legId });
      if (snapshot) {
        snapshots.set(legId, snapshot);
      }
      return snapshot;
    },
    async resumeGlobalRecording(legId: string): Promise<LegMediaSessionSnapshot | null> {
      const snapshot = await sendCommand<LegMediaSessionSnapshot | null>(WorkerControlOpcode.ResumeGlobalRecording, { legId });
      if (snapshot) {
        snapshots.set(legId, snapshot);
      }
      return snapshot;
    },
    async activateGlobalRecording(
      legId: string,
      transportType: WorkerRuntimeTransportType,
      mediaId: string,
      startedAt?: number,
      input?: Record<string, unknown>,
    ): Promise<LegMediaSessionSnapshot> {
      const snapshot = await sendCommand<LegMediaSessionSnapshot>(WorkerControlOpcode.ActivateGlobalRecording, {
        legId,
        transportType,
        mediaId,
        startedAt,
        input: { ...(input || {}) },
      });
      snapshots.set(legId, snapshot);
      return snapshot;
    },
    async deactivateGlobalRecording(legId: string, mediaId: string): Promise<LegMediaSessionSnapshot | null> {
      const snapshot = await sendCommand<LegMediaSessionSnapshot | null>(WorkerControlOpcode.DeactivateGlobalRecording, { legId, mediaId });
      if (snapshot) {
        snapshots.set(legId, snapshot);
      }
      return snapshot;
    },
    async exportEndpointState(legId: string): Promise<WorkerEndpointState | null> {
      return await sendCommand<WorkerEndpointState | null>(WorkerControlOpcode.ExportEndpointState, { legId });
    },
    async acceptEndpointHandoff(
      legId: string,
      transportType: WorkerRuntimeTransportType,
      transportConfig: Record<string, unknown>,
      codecName: AudioCodecName,
    ): Promise<WorkerEnsureEndpointResult> {
      const ensured = await sendCommand<WorkerEnsureEndpointResult>(WorkerControlOpcode.AcceptEndpointHandoff, {
        legId,
        transportType,
        transportConfig: { ...(transportConfig || {}) },
        codecName,
      });
      snapshots.set(legId, ensured.snapshot);
      return ensured;
    },
    async sendDtmf(legId: string, transportType: WorkerRuntimeTransportType, digits: string, method: string): Promise<boolean> {
      return await sendCommand<boolean>(WorkerControlOpcode.SendDtmf, { legId, transportType, digits, method });
    },
    async bindBridge(legAId: string, legBId: string): Promise<void> {
      await sendCommand(WorkerControlOpcode.BindLocalBridgePeer, { sourceLegId: legAId, peerLegId: legBId });
      await sendCommand(WorkerControlOpcode.BindLocalBridgePeer, { sourceLegId: legBId, peerLegId: legAId });
    },
    async unbindBridgeLeg(legId: string): Promise<void> {
      await sendCommand(WorkerControlOpcode.UnbindLocalBridgePeer, { sourceLegId: legId });
    },
    async orphanBridgeLeg(legId: string, peerLegId?: string | null): Promise<void> {
      await sendCommand(WorkerControlOpcode.OrphanBridgeLeg, {
        legId,
        peerLegId: peerLegId || undefined,
      });
    },
    async shutdown(): Promise<void> {
      shutdownRequested = true;
      await sendCommand(WorkerControlOpcode.Shutdown, {});
      snapshots.clear();
    },
    deliverRtpPacket(legId: string, packet: Buffer | Uint8Array): void {
      worker.postMessage({
        kind: WorkerMessageKind.TransportInput,
        opcode: WorkerTransportInputOpcode.RtpPacket,
        payload: { legId, packet },
      } satisfies WorkerTransportInputMessage);
    },
    deliverWebSocketPayload(legId: string, payload: unknown): void {
      worker.postMessage({
        kind: WorkerMessageKind.TransportInput,
        opcode: WorkerTransportInputOpcode.WebSocketPayload,
        payload: { legId, payload },
      } satisfies WorkerTransportInputMessage);
    },
    notifyTransportClosed(legId: string, reason: string): void {
      worker.postMessage({
        kind: WorkerMessageKind.TransportInput,
        opcode: WorkerTransportInputOpcode.TransportClosed,
        payload: {
          legId,
          reason,
        },
      } satisfies WorkerTransportInputMessage);
    },
  };
}

export class MediaWorker {
  readonly workerId: string;
  private readonly bridges = new Set<Bridge>();
  private readonly legsById = new Map<string, Leg>();
  private readonly bridgeByLegId = new Map<string, Bridge>();

  constructor(workerId: string) {
    this.workerId = workerId;
  }

  ensureLeg(input: {
    legId: string;
    transportType: "sip" | "websocket";
    codecName?: AudioCodecName;
    transport?: MediaTransport;
    codec?: AudioCodec;
    mixer?: Mixer;
    transportConfig?: Record<string, unknown>;
    onVoiceActivity?: (legId: string, level: number, durationMs: number) => void;
    onInboundPcm?: (legId: string, pcm: Buffer, bytes: number, sampleRate: number, channels: number) => void | Promise<void>;
    onInboundDtmf?: (legId: string, digits: string) => void;
    onPlaybackFinished?: (legId: string, mediaId: string) => void;
    onRecordingPcm?: (legId: string, mediaId: string, pcm: Buffer, bytes: number, sampleRate: number, channels: number, releasePool?: BufferReleasePool | null) => void;
    onRecordingInterrupt?: (legId: string, mediaId: string, reason: string, details?: Record<string, unknown>) => void;
    onTransportClosed?: (legId: string, reason: string) => void;
  }): Leg {
    const existing = this.legsById.get(input.legId);
    if (existing) {
      return existing;
    }
    const leg = new Leg(input);
    this.legsById.set(leg.legId, leg);
    const bridge = new Bridge({ legA: leg });
    this.attachBridge(bridge);
    return leg;
  }

  acceptTransferredLeg(input: {
    legId: string;
    transportType: "sip" | "websocket";
    codecName?: AudioCodecName;
    transport: MediaTransport;
    transportConfig?: Record<string, unknown>;
    onVoiceActivity?: (legId: string, level: number, durationMs: number) => void;
    onInboundPcm?: (legId: string, pcm: Buffer, bytes: number, sampleRate: number, channels: number) => void | Promise<void>;
    onInboundDtmf?: (legId: string, digits: string) => void;
    onPlaybackFinished?: (legId: string, mediaId: string) => void;
    onRecordingPcm?: (legId: string, mediaId: string, pcm: Buffer, bytes: number, sampleRate: number, channels: number, releasePool?: BufferReleasePool | null) => void;
    onRecordingInterrupt?: (legId: string, mediaId: string, reason: string, details?: Record<string, unknown>) => void;
    onTransportClosed?: (legId: string, reason: string) => void;
  }): Leg {
    return this.ensureLeg(input);
  }

  getLeg(legId: string): Leg | null {
    return this.legsById.get(String(legId || "").trim()) || null;
  }

  getSnapshot(legId: string): LegMediaSessionSnapshot | null {
    return this.legsById.get(legId)?.snapshot() || null;
  }

  removeLeg(legId: string): Leg | null {
    const leg = this.legsById.get(legId) || null;
    if (!leg) {
      return null;
    }
    const bridge = this.bridgeByLegId.get(legId) || null;
    if (bridge) {
      bridge.detachLeg(legId);
      this.bridgeByLegId.delete(legId);
      if (bridge.size() === 0) {
        this.detachBridge(bridge);
      }
    }
    this.legsById.delete(legId);
    leg.close();
    return leg;
  }

  orphanBridgeForLeg(legId: string): Bridge | null {
    const bridge = this.bridgeByLegId.get(legId) || null;
    if (!bridge) {
      return null;
    }
    bridge.detachLeg(legId);
    this.bridgeByLegId.delete(legId);
    if (bridge.size() === 0) {
      this.detachBridge(bridge);
    }
    return bridge;
  }

  attachMedia(legId: string, media: Media): void {
    const leg = this.getLeg(legId);
    if (!leg) {
      return;
    }
    leg.mixer.addMedia(media);
  }

  detachMedia(legId: string, mediaId: string): Media | null {
    const leg = this.getLeg(legId);
    if (!leg) {
      return null;
    }
    return leg.mixer.removeMedia(mediaId);
  }

  registerPlayback(
    legId: string,
    input: Parameters<Leg["registerPlayback"]>[0],
    media: Media,
  ): LegMediaSessionSnapshot | null {
    const leg = this.getLeg(legId);
    if (!leg) {
      return null;
    }
    leg.mixer.addMedia(media);
    return leg.registerPlayback(input);
  }

  appendPlaybackChunk(legId: string, mediaId: string, pcm: Buffer, bytes: number, releasePool?: BufferReleasePool | null): number {
    return this.getLeg(legId)?.appendPlaybackChunk(mediaId, pcm, bytes, releasePool) || 0;
  }

  finishPlayback(legId: string, mediaId: string): void {
    this.getLeg(legId)?.finishPlayback(mediaId);
  }

  unregisterPlayback(legId: string, mediaId: string): LegMediaSessionSnapshot | null {
    const leg = this.getLeg(legId);
    if (!leg) {
      return null;
    }
    this.detachMedia(legId, mediaId);
    return leg.unregisterPlayback(mediaId);
  }

  startRecording(
    legId: string,
    mediaId: string,
    startedAt: number | undefined,
    media: Media,
    input?: Record<string, unknown>,
  ): LegMediaSessionSnapshot | null {
    const leg = this.getLeg(legId);
    if (!leg) {
      return null;
    }
    leg.mixer.addMedia(media);
    return leg.startRecording(mediaId, startedAt, input);
  }

  activateGlobalRecording(
    legId: string,
    mediaId: string,
    startedAt: number | undefined,
    media: Media,
    input?: Record<string, unknown>,
  ): LegMediaSessionSnapshot | null {
    const leg = this.getLeg(legId);
    if (!leg) {
      return null;
    }
    leg.mixer.addMedia(media);
    return leg.activateGlobalRecording(mediaId, startedAt, input);
  }

  stopRecording(legId: string, mediaId: string): LegMediaSessionSnapshot | null {
    const leg = this.getLeg(legId);
    if (!leg) {
      return null;
    }
    this.detachMedia(legId, mediaId);
    return leg.stopRecording(mediaId);
  }

  deactivateGlobalRecording(legId: string, mediaId: string): LegMediaSessionSnapshot | null {
    const leg = this.getLeg(legId);
    if (!leg) {
      return null;
    }
    this.detachMedia(legId, mediaId);
    return leg.deactivateGlobalRecording(mediaId);
  }

  pauseGlobalRecording(legId: string): LegMediaSessionSnapshot | null {
    return this.getLeg(legId)?.pauseGlobalRecording() || null;
  }

  resumeGlobalRecording(legId: string): LegMediaSessionSnapshot | null {
    return this.getLeg(legId)?.resumeGlobalRecording() || null;
  }

  collectDtmfInterruptTargets(legId: string): string[] {
    return this.getLeg(legId)?.collectDtmfInterruptTargets() || [];
  }

  collectVoiceInterruptTargets(legId: string, level: number, durationMs: number): string[] {
    return this.getLeg(legId)?.collectVoiceInterruptTargets(level, durationMs) || [];
  }

  async sendDtmf(legId: string, digits: string, method: string): Promise<boolean> {
    const leg = this.getLeg(legId);
    if (!leg) {
      return false;
    }
    return await leg.sendDtmf(digits, method);
  }

  mergeLegs(legAId: string, legBId: string): Bridge {
    const legA = this.getLeg(legAId);
    const legB = this.getLeg(legBId);
    if (!legA || !legB) {
      throw new Error(`Cannot merge unknown legs ${legAId} and ${legBId}`);
    }
    const bridgeA = this.bridgeByLegId.get(legAId) || null;
    const bridgeB = this.bridgeByLegId.get(legBId) || null;
    if (bridgeA && bridgeA === bridgeB) {
      return bridgeA;
    }
    if (bridgeA) {
      bridgeA.detachLeg(legAId);
      this.bridgeByLegId.delete(legAId);
      if (bridgeA.size() === 0) {
        this.detachBridge(bridgeA);
      }
    }
    if (bridgeB) {
      bridgeB.detachLeg(legBId);
      this.bridgeByLegId.delete(legBId);
      if (bridgeB.size() === 0) {
        this.detachBridge(bridgeB);
      }
    }
    const merged = new Bridge({ legA, legB });
    this.attachBridge(merged);
    return merged;
  }

  splitBridgeForLeg(legId: string): void {
    const bridge = this.bridgeByLegId.get(legId) || null;
    if (!bridge || bridge.size() <= 1) {
      return;
    }
    const legs = bridge.listLegs();
    this.detachBridge(bridge);
    for (const leg of legs) {
      bridge.detachLeg(leg.legId);
      const single = new Bridge({ legA: leg });
      this.attachBridge(single);
    }
  }

  attachBridge(bridge: Bridge): void {
    this.bridges.add(bridge);
    for (const leg of bridge.listLegs()) {
      this.bridgeByLegId.set(leg.legId, bridge);
    }
  }

  detachBridge(bridge: Bridge | null): Bridge | null {
    if (bridge) {
      this.bridges.delete(bridge);
      for (const leg of bridge.listLegs()) {
        if (this.bridgeByLegId.get(leg.legId) === bridge) {
          this.bridgeByLegId.delete(leg.legId);
        }
      }
    }
    return bridge;
  }

  listBridges(): Bridge[] {
    return Array.from(this.bridges.values());
  }

  async routeInboundPcm(
    legId: string,
    pcm: Buffer,
    bytes = pcm.length,
    sampleRate?: number,
    channels?: number,
  ): Promise<boolean> {
    const bridge = this.bridgeByLegId.get(legId) || null;
    if (!bridge) {
      return false;
    }
    return await bridge.routeInboundPcm(legId, pcm, bytes, sampleRate, channels);
  }

  clear(): void {
    for (const leg of Array.from(this.legsById.values())) {
      leg.close();
    }
    this.bridges.clear();
    this.bridgeByLegId.clear();
    this.legsById.clear();
  }
}

type MediaWorkerRuntimeController = {
  handleRequest(request: WorkerControlRequest): Promise<unknown>;
  handleTransportInput(input: WorkerTransportInput): void;
  clear(): void;
};

function createMediaWorkerRuntimeController(input: {
  workerId: string;
  createTransport: (legId: string, transportType: WorkerRuntimeTransportType) => MediaTransport;
  onSnapshot?: (snapshot: LegMediaSessionSnapshot) => void;
  onVoiceActivity?: (legId: string, level: number, durationMs: number) => void;
  onInboundDtmf?: (legId: string, digits: string) => void;
  onPlaybackFinished?: (legId: string, mediaId: string) => void;
  onMediaFailure?: (legId: string, mediaId: string, reason: string, error?: string | null) => void;
  onMediaInterrupt?: (legId: string, mediaId: string, reason: string, details?: Record<string, unknown>) => void;
  onTransportClosed?: (legId: string, reason: string) => void;
}): MediaWorkerRuntimeController {
  const workerId = String(input.workerId || "").trim();
  const threadName = workerId.startsWith("worker:")
    ? `sip-pbx:mw:${workerId.slice("worker:".length)}`
    : `sip-pbx:${workerId}`;
  const bindings = loadNativeCodecBindings();
  if (bindings?.SetThreadName && threadName) {
    bindings.SetThreadName(threadName);
  }
  const runtimeWorker = new MediaWorker(input.workerId);
  const createTransportForLeg = input.createTransport;
  const onSnapshot = input.onSnapshot || (() => undefined);
  const onVoiceActivity = input.onVoiceActivity || (() => undefined);
  const onInboundDtmf = input.onInboundDtmf || (() => undefined);
  const onPlaybackFinished = input.onPlaybackFinished || (() => undefined);
  const onMediaFailure = input.onMediaFailure || (() => undefined);
  const onMediaInterrupt = input.onMediaInterrupt || (() => undefined);
  const onTransportClosed = input.onTransportClosed || (() => undefined);
  const playbackPumps = new Map<string, ActivePlaybackPump>();
  const recordingSessions = new Map<string, ActiveRecordingSession>();

  function bindLegCallbacks(transport: MediaTransport, legId: string, transportType: WorkerRuntimeTransportType, codecName?: AudioCodecName, transportConfig?: Record<string, unknown>): Leg {
    return runtimeWorker.ensureLeg({
      legId,
      transportType,
      codecName,
      transport,
      transportConfig,
      onVoiceActivity: (localLegId, level, durationMs) => {
        for (const mediaId of runtimeWorker.collectVoiceInterruptTargets(localLegId, level, durationMs)) {
          onMediaInterrupt(localLegId, mediaId, "voice", {
            voiceLevel: level,
            voiceDurationMs: durationMs,
          });
        }
        if (level > 0) {
          onVoiceActivity(localLegId, level, durationMs);
        }
      },
      onInboundPcm: (localLegId, pcm, bytes, sampleRate, channels) => {
        void runtimeWorker.routeInboundPcm(localLegId, pcm, bytes, sampleRate, channels);
      },
      onInboundDtmf: (localLegId, digits) => {
        for (const mediaId of runtimeWorker.collectDtmfInterruptTargets(localLegId)) {
          onMediaInterrupt(localLegId, mediaId, "dtmf", {
            digit: digits.slice(0, 1) || null,
            digits,
          });
        }
        onInboundDtmf(localLegId, digits);
      },
      onPlaybackFinished: (localLegId, mediaId) => {
        onPlaybackFinished(localLegId, mediaId);
      },
      onRecordingPcm: (localLegId, mediaId, pcm, bytes, sampleRate, channels, releasePool) => {
        void handleRecordingChunk(localLegId, mediaId, pcm, bytes, sampleRate, channels, releasePool);
      },
      onRecordingInterrupt: (localLegId, mediaId, reason, details) => {
        onMediaInterrupt(localLegId, mediaId, reason, details);
      },
      onTransportClosed: (localLegId, reason) => {
        onTransportClosed(localLegId, reason);
      },
    });
  }

  async function ensureLeg(legId: string, transportType: WorkerRuntimeTransportType): Promise<WorkerEnsureEndpointResult> {
    const existing = runtimeWorker.getLeg(legId);
    if (existing) {
      return {
        snapshot: existing.snapshot(),
        transportDetails: existing.transport.getDetails(),
      };
    }
    return await ensureLegWithConfig(legId, transportType, {});
  }

  async function ensureLegWithConfig(
    legId: string,
    transportType: WorkerRuntimeTransportType,
    transportConfig: Record<string, unknown>,
    explicitCodec?: AudioCodecName,
  ): Promise<WorkerEnsureEndpointResult> {
    const existing = runtimeWorker.getLeg(legId);
    const codecName = explicitCodec || (typeof transportConfig.audioCodecName === "string"
      ? mapDescriptorNameToAudioCodecName(transportConfig.audioCodecName)
      : undefined);
    const nextCodec = codecName
      ? (existing && existing.codec.codecName === codecName ? existing.codec : createCodec(codecName))
      : undefined;
    if (existing) {
      const transportDetails = await existing.configureTransport(transportConfig, nextCodec);
      return {
        snapshot: existing.snapshot(),
        transportDetails,
      };
    }
    const transport = createTransportForLeg(legId, transportType);
    const leg = bindLegCallbacks(transport, legId, transportType, codecName, transportConfig);
    const transportDetails = await leg.configureTransport(transportConfig, nextCodec || (codecName ? leg.codec : undefined));
    return {
      snapshot: leg.snapshot(),
      transportDetails,
    };
  }

  async function acceptLegHandoff(
    legId: string,
    transportType: WorkerRuntimeTransportType,
    transportConfig: Record<string, unknown>,
    codecName: AudioCodecName,
  ): Promise<WorkerEnsureEndpointResult> {
    const existing = runtimeWorker.getLeg(legId);
    const nextCodec = existing && existing.codec.codecName === codecName
      ? existing.codec
      : createCodec(codecName);
    if (existing) {
      const transportDetails = await existing.configureTransport(transportConfig, nextCodec);
      return {
        snapshot: existing.snapshot(),
        transportDetails,
      };
    }
    const transport = createTransportForLeg(legId, transportType);
    const leg = runtimeWorker.acceptTransferredLeg({
      legId,
      transportType,
      codecName,
      transport,
      transportConfig,
      onVoiceActivity: (localLegId, level, durationMs) => {
        for (const mediaId of runtimeWorker.collectVoiceInterruptTargets(localLegId, level, durationMs)) {
          onMediaInterrupt(localLegId, mediaId, "voice", {
            voiceLevel: level,
            voiceDurationMs: durationMs,
          });
        }
        if (level > 0) {
          onVoiceActivity(localLegId, level, durationMs);
        }
      },
      onInboundPcm: (localLegId, pcm, bytes, sampleRate, channels) => {
        void runtimeWorker.routeInboundPcm(localLegId, pcm, bytes, sampleRate, channels);
      },
      onInboundDtmf: (localLegId, digits) => {
        for (const mediaId of runtimeWorker.collectDtmfInterruptTargets(localLegId)) {
          onMediaInterrupt(localLegId, mediaId, "dtmf", {
            digit: digits.slice(0, 1) || null,
            digits,
          });
        }
        onInboundDtmf(localLegId, digits);
      },
      onPlaybackFinished: (localLegId, mediaId) => {
        onPlaybackFinished(localLegId, mediaId);
      },
      onRecordingPcm: (localLegId, mediaId, pcm, bytes, sampleRate, channels, releasePool) => {
        void handleRecordingChunk(localLegId, mediaId, pcm, bytes, sampleRate, channels, releasePool);
      },
      onRecordingInterrupt: (localLegId, mediaId, reason, details) => {
        onMediaInterrupt(localLegId, mediaId, reason, details);
      },
      onTransportClosed: (localLegId, reason) => {
        onTransportClosed(localLegId, reason);
      },
    });
    const transportDetails = await leg.configureTransport(transportConfig, nextCodec);
    return {
      snapshot: leg.snapshot(),
      transportDetails,
    };
  }

  function cleanupPlaybackPump(mediaId: string): ActivePlaybackPump | null {
    const pump = playbackPumps.get(mediaId) || null;
    if (!pump) {
      return null;
    }
    pump.cancelled = true;
    playbackPumps.delete(mediaId);
    return pump;
  }

  function cleanupAllPlaybackPumps(): void {
    const pumps = Array.from(playbackPumps.keys())
      .map((mediaId) => cleanupPlaybackPump(mediaId))
      .filter((pump): pump is ActivePlaybackPump => Boolean(pump));
    for (const pump of pumps) {
      observeCleanupPromise(workerId, `playback cleanup for ${pump.media.mediaId} waiting for endpoint close`, closeReadablePlaybackEndpoint(pump));
      observeCleanupPromise(workerId, `playback cleanup for ${pump.media.mediaId} waiting for pump task`, pump.task);
    }
  }

  async function closeReadablePlaybackEndpoint(pump: ActivePlaybackPump | null): Promise<void> {
    await pump?.media.getReadableEndpoint().close?.();
  }

  async function waitForPlaybackSourceStartReady(legId: string, state: ActivePlaybackPump): Promise<boolean> {
    while (!state.cancelled) {
      const leg = runtimeWorker.getLeg(legId) || null;
      if (!leg) {
        return false;
      }
      if (leg.transportType !== "sip") {
        return true;
      }
      const remoteRtpPort = Math.max(0, Number(leg.transport.getDetails().remoteRtpPort || 0) || 0);
      if (remoteRtpPort > 0) {
        return true;
      }
      await sleep(20);
    }
    return false;
  }

  async function startPlaybackPump(legId: string, media: Media): Promise<void> {
    const mediaId = media.mediaId;
    const endpoint = media.getReadableEndpoint();
    const playbackOutputChunkDurationMs = 40;
    const playbackYieldBudgetMs = 8;
    const state: ActivePlaybackPump = {
      media,
      legId,
      cancelled: false,
      task: Promise.resolve(),
    };
    const task = (async () => {
      try {
        let sawAudio = false;
        await yieldToEventLoop();
        const playbackReady = await waitForPlaybackSourceStartReady(legId, state);
        if (!playbackReady || state.cancelled) {
          return;
        }
        const source = await endpoint.open();
        const playbackFormat = runtimeWorker.getLeg(legId)?.getPlaybackFormat() || {
          sampleRate: OPTION_DEFAULTS.recordAudio.wavSampleRate,
          channels: 1,
          frameBytes: Math.max(2, Math.round((OPTION_DEFAULTS.recordAudio.wavSampleRate / 50)) * 2),
        };
        const mediaStream = createStream({
          mode: "decode",
          format: endpoint.formatHint,
        });
        const maxBufferedBytes = Math.max(4096, playbackFormat.frameBytes * 4);
        // Yield by wall-clock budget instead of chunk count to keep the worker responsive with less scheduler churn.
        let playbackYieldDeadline = performance.now() + playbackYieldBudgetMs;
        const maybeYieldPlayback = async (): Promise<void> => {
          if (performance.now() < playbackYieldDeadline) {
            return;
          }
          await yieldToEventLoop();
          playbackYieldDeadline = performance.now() + playbackYieldBudgetMs;
        };
        let firstDecodedChunkLogged = false;
        for await (const chunk of mediaStream.decode({
          source,
          formatHint: endpoint.formatHint,
          outputSampleRate: playbackFormat.sampleRate,
          outputChannels: playbackFormat.channels,
          outputChunkDurationMs: playbackOutputChunkDurationMs,
        })) {
          if (state.cancelled) {
            break;
          }
          if (!chunk.bytes) {
            continue;
          }
          if (!firstDecodedChunkLogged) {
            firstDecodedChunkLogged = true;
            console.error(
              `[sip-pbx:media-worker:${workerId}] playback decode started; leg=${legId}; media=${mediaId}; sourceRef=${String(media.operationInput.sourceRef || media.operationInput.playbackHttpUrl || media.operationInput.filePath || media.operationInput.binaryProperty || "null")}; formatHint=${String(endpoint.formatHint || "")}; sampleRate=${chunk.sampleRate}; channels=${chunk.channels}; bytes=${chunk.bytes}`,
            );
          }
          sawAudio = true;
          const bufferedBytes = runtimeWorker.appendPlaybackChunk(legId, mediaId, chunk.pcm, chunk.bytes, chunk.releasePool);
          if (state.cancelled) {
            break;
          }
          if (bufferedBytes > maxBufferedBytes) {
            await sleep(20);
            playbackYieldDeadline = performance.now() + playbackYieldBudgetMs;
          } else {
            await maybeYieldPlayback();
          }
        }
        if (!state.cancelled) {
          if (!sawAudio) {
            throw new Error("Playback source produced no audio");
          }
          runtimeWorker.finishPlayback(legId, mediaId);
        }
      } catch (error) {
        onMediaFailure(
          legId,
          mediaId,
          "source_error",
          error instanceof Error ? error.message : String(error || "Playback source failed"),
        );
      } finally {
        playbackPumps.delete(mediaId);
        await endpoint.close?.();
      }
  })();
  state.task = task;
  playbackPumps.set(mediaId, state);
  await task;
  }

  function resolveRecordingEncoderSettings(
    inputSpec: Record<string, unknown>,
    _inputSampleRate: number,
    _inputChannels: number,
  ): {
    fileFormat: string;
    wavSampleRate: number;
    wavBitDepth: number;
    compressedSampleRate: number;
    compressedBitrateKbps: number;
  } {
    const fileFormat = String(inputSpec.recordFileFormat || OPTION_DEFAULTS.recordAudio.fileFormat).trim().toLowerCase() || OPTION_DEFAULTS.recordAudio.fileFormat;
    const wavSampleRate = Number(inputSpec.recordWavSampleRate || OPTION_DEFAULTS.recordAudio.wavSampleRate);
    const wavBitDepth = Number(inputSpec.recordWavBitDepth || OPTION_DEFAULTS.recordAudio.wavBitDepth);
    const compressedSampleRate = Number(inputSpec.recordCompressedSampleRate || inputSpec.recordMp3SampleRate || OPTION_DEFAULTS.recordAudio.compressedSampleRate);
    const compressedBitrateKbps = Number(inputSpec.recordCompressedBitrate || inputSpec.recordMp3Bitrate || OPTION_DEFAULTS.recordAudio.compressedBitrateKbps);

    return {
      fileFormat,
      wavSampleRate,
      wavBitDepth,
      compressedSampleRate,
      compressedBitrateKbps,
    };
  }

  function resolveRecordingEncoderInputShape(
    inputSpec: Record<string, unknown>,
    encoderSettings: {
      fileFormat: string;
      wavSampleRate: number;
      compressedSampleRate: number;
    },
  ): { inputSampleRate: number; inputChannels: number } {
    const inputChannels = Boolean(inputSpec.recordSplitChannels) ? 2 : 1;
    const inputSampleRate = encoderSettings.fileFormat === "wav"
      ? Math.max(1, Number(encoderSettings.wavSampleRate || OPTION_DEFAULTS.recordAudio.wavSampleRate))
      : Math.max(1, Number(encoderSettings.compressedSampleRate || OPTION_DEFAULTS.recordAudio.compressedSampleRate));
    return {
      inputSampleRate,
      inputChannels,
    };
  }

  function createRecordingSession(legId: string, media: Media): ActiveRecordingSession {
    const inputSpec = media.operationInput;
    const fileFormat = String(inputSpec.recordFileFormat || OPTION_DEFAULTS.recordAudio.fileFormat).trim().toLowerCase() || OPTION_DEFAULTS.recordAudio.fileFormat;
    return {
      media,
      legId,
      mediaStream: createStream({
        mode: "encode",
        format: fileFormat,
      }),
      encoder: null,
      drainScratch: Buffer.allocUnsafe(16384),
      convertScratch: Buffer.allocUnsafe(16384),
      writeChain: Promise.resolve(),
      closing: false,
      draining: false,
      inputSampleRate: null,
      inputChannels: null,
      pcmConverters: new Map(),
      pendingChunks: [],
    };
  }

  async function flushRecordingEncoder(session: ActiveRecordingSession): Promise<boolean> {
    if (!session.encoder) {
      return false;
    }
    const encodedBytes = session.encoder.drainInto(session.drainScratch);
    if (!encodedBytes) {
      return false;
    }
    await session.media.getWritableEndpoint().writeChunk(session.drainScratch, encodedBytes);
    await yieldToEventLoop();
    return true;
  }

  async function drainRecordingEncoder(session: ActiveRecordingSession): Promise<boolean> {
    let producedAny = false;
    let drainDeadline = performance.now() + 8;
    while (await flushRecordingEncoder(session)) {
      producedAny = true;
      if (performance.now() >= drainDeadline) {
        await yieldToEventLoop();
        drainDeadline = performance.now() + 8;
      }
    }
    return producedAny;
  }

  async function writeRecordingChunk(
    session: ActiveRecordingSession,
    chunk: { pcm: Buffer; bytes: number; sampleRate: number; channels: number },
  ): Promise<void> {
    const inputSpec = session.media.operationInput;
    let pcm = chunk.pcm;
    let bytes = Math.max(0, Math.min(Number(chunk.bytes) || 0, pcm.length));
    if (!bytes) {
      return;
    }
    const sourceSampleRate = Math.max(1, Number(chunk.sampleRate || OPTION_DEFAULTS.recordAudio.wavSampleRate));
    const sourceChannels = Math.max(1, Number(chunk.channels || 1));
    let sampleRate = sourceSampleRate;
    let channels = sourceChannels;
    const encoderSettings = resolveRecordingEncoderSettings(inputSpec, sampleRate, channels);
    const encoderInput = resolveRecordingEncoderInputShape(inputSpec, encoderSettings);
    if (!session.encoder) {
      session.inputSampleRate = encoderInput.inputSampleRate;
      session.inputChannels = encoderInput.inputChannels;
      session.encoder = session.mediaStream.createEncoder({
        fileFormat: encoderSettings.fileFormat,
        wavSampleRate: encoderSettings.wavSampleRate,
        wavBitDepth: encoderSettings.wavBitDepth,
        compressedSampleRate: encoderSettings.compressedSampleRate,
        compressedBitrateKbps: encoderSettings.compressedBitrateKbps,
        inputSampleRate: encoderInput.inputSampleRate,
        inputChannels: encoderInput.inputChannels,
      });
    }
    if (session.inputSampleRate !== sampleRate || session.inputChannels !== channels) {
      const targetSampleRate = Math.max(1, Number(session.inputSampleRate || sampleRate));
      const targetChannels = Math.max(1, Number(session.inputChannels || channels));
      const converter = getRecordingPcmConverter(session, sampleRate, channels, targetSampleRate, targetChannels);
      let scratchBytes = Math.max(
        2,
        estimateConvertedPcm16Bytes(bytes, sampleRate, channels, targetSampleRate, targetChannels),
      );
      let convertedBytes = 0;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (session.convertScratch.length < scratchBytes) {
          session.convertScratch = Buffer.allocUnsafe(Math.max(scratchBytes, session.convertScratch.length * 2, 2048));
        }
        try {
          convertedBytes = convertPcm16(converter, pcm, 0, bytes, session.convertScratch, 0);
          break;
        } catch (error) {
          if (!isPcmTargetBufferTooSmallError(error) || attempt >= 2) {
            throw error;
          }
          scratchBytes = Math.max(scratchBytes * 2, session.convertScratch.length * 2, 4096);
        }
      }
      if (!convertedBytes) {
        return;
      }
      pcm = session.convertScratch;
      bytes = convertedBytes;
      sampleRate = targetSampleRate;
      channels = targetChannels;
    }
    let writeDeadline = performance.now() + 8;
    let offset = 0;
    while (offset < bytes) {
      const written = await session.encoder.encodeInto(pcm, bytes - offset, offset);
      if (written > 0) {
        offset += written;
        if (performance.now() >= writeDeadline) {
          await yieldToEventLoop();
          writeDeadline = performance.now() + 8;
        }
        continue;
      }
      const drained = await flushRecordingEncoder(session);
      if (!drained) {
        throw new Error("Recording encoder made no progress");
      }
    }
    await flushRecordingEncoder(session);
  }

  async function finalizeRecordingSession(
    session: ActiveRecordingSession,
    result: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const inputSpec = session.media.operationInput;
    if (!session.encoder) {
      const encoderSettings = resolveRecordingEncoderSettings(
        inputSpec,
        OPTION_DEFAULTS.recordAudio.wavSampleRate,
        Boolean(inputSpec.recordSplitChannels) ? 2 : 1,
      );
      const encoderInput = resolveRecordingEncoderInputShape(inputSpec, encoderSettings);
      const inputSampleRate = encoderInput.inputSampleRate;
      const inputChannels = encoderInput.inputChannels;
      session.encoder = session.mediaStream.createEncoder({
        fileFormat: encoderSettings.fileFormat,
        wavSampleRate: encoderSettings.wavSampleRate,
        wavBitDepth: encoderSettings.wavBitDepth,
        compressedSampleRate: encoderSettings.compressedSampleRate,
        compressedBitrateKbps: encoderSettings.compressedBitrateKbps,
        inputSampleRate,
        inputChannels,
      });
      const silenceSamples = Math.max(1, Math.round(inputSampleRate / 50));
      await session.encoder.encodeInto(Buffer.alloc(silenceSamples * inputChannels * 2));
      await flushRecordingEncoder(session);
    }
    const finalized = await session.encoder.finalize();
    await drainRecordingEncoder(session);
    const patches = session.encoder.takeOutputPatches();
    const finalizeInput = {
      result: { ...(result || {}) },
      mimeType: finalized.mimeType,
      binaryProperty: String(result.outputBinaryProperty || inputSpec.recordBinaryProperty || OPTION_DEFAULTS.recordAudio.binaryProperty),
    };
    const endpoint = session.media.getWritableEndpoint();
    closeRecordingPcmConverters(session);
    if (isSeekableWritableMediaEndpoint(endpoint)) {
      return await endpoint.finalizeSeekable(finalizeInput, patches);
    }
    return await endpoint.finalize(finalizeInput);
  }

  function abortRecordingSession(mediaId: string): void {
    const session = recordingSessions.get(mediaId) || null;
    if (!session) {
      return;
    }
    recordingSessions.delete(mediaId);
    session.closing = true;
    while (session.pendingChunks.length > 0) {
      const chunk = session.pendingChunks.shift()!;
      chunk.releasePool?.release(chunk.pcm);
    }
    void session.writeChain.then(() => undefined, (error) => {
      console.error(
        `[sip-pbx:media-worker:${workerId}] recording cleanup for ${mediaId} failed while waiting for write chain: ${formatWorkerDiagnostic(error)}`,
      );
    });
    try {
      session.encoder?.abort();
    } catch (error) {
      console.error(
        `[sip-pbx:media-worker:${workerId}] recording cleanup for ${mediaId} failed while aborting encoder: ${formatWorkerDiagnostic(error)}`,
      );
    }
    void session.media.getWritableEndpoint().abort().then(
      () => undefined,
      (error) => {
        console.error(
          `[sip-pbx:media-worker:${workerId}] recording cleanup for ${mediaId} failed while aborting endpoint: ${formatWorkerDiagnostic(error)}`,
        );
      },
    );
    closeRecordingPcmConverters(session);
  }

  function abortAllRecordingSessions(): void {
    for (const mediaId of Array.from(recordingSessions.keys())) {
      abortRecordingSession(mediaId);
    }
  }

  function scheduleRecordingDrain(legId: string, mediaId: string, session: ActiveRecordingSession): void {
    if (session.draining) {
      return;
    }
    session.draining = true;
    const drainTask = (async () => {
      const next = session.pendingChunks.shift() || null;
      if (!next) {
        return;
      }
      if (session.closing) {
        next.releasePool?.release(next.pcm);
        while (session.pendingChunks.length > 0) {
          const dropped = session.pendingChunks.shift()!;
          dropped.releasePool?.release(dropped.pcm);
        }
        return;
      }
      try {
        await writeRecordingChunk(session, next);
      } catch (error) {
        abortRecordingSession(mediaId);
        onMediaFailure(
          legId,
          mediaId,
          "recording_stream_error",
          error instanceof Error ? error.message : String(error || "Recording stream failed"),
        );
      } finally {
        next.releasePool?.release(next.pcm);
      }
    })();
    session.writeChain = drainTask.then(() => undefined, (error) => {
      console.error(
        `[sip-pbx:media-worker:${workerId}] recording write chain failed; leg=${legId}; media=${mediaId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    });
    void drainTask.finally(() => {
      session.draining = false;
      if (!session.closing && session.pendingChunks.length > 0 && recordingSessions.get(mediaId) === session) {
        setImmediate(() => {
          scheduleRecordingDrain(legId, mediaId, session);
        });
      }
    });
  }

  function getRecordingPcmConverter(
    session: ActiveRecordingSession,
    inputSampleRate: number,
    inputChannels: number,
    outputSampleRate: number,
    outputChannels: number,
  ): Pcm16Converter {
    const key = `${Math.max(1, inputSampleRate)}:${Math.max(1, inputChannels)}->${Math.max(1, outputSampleRate)}:${Math.max(1, outputChannels)}`;
    const existing = session.pcmConverters.get(key) || null;
    if (existing) {
      return existing;
    }
    const created = createPcm16Converter(inputSampleRate, inputChannels, outputSampleRate, outputChannels);
    session.pcmConverters.set(key, created);
    return created;
  }

  function closeRecordingPcmConverters(session: ActiveRecordingSession): void {
    for (const converter of session.pcmConverters.values()) {
      try {
        converter.close();
      } catch (error) {
        console.error(
          `[sip-pbx:media-worker:${workerId}] recording converter close failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
        );
      }
    }
    session.pcmConverters.clear();
  }

  function handleRecordingChunk(
    legId: string,
    mediaId: string,
    pcm: Buffer,
    bytes: number,
    sampleRate: number,
    channels: number,
    releasePool?: BufferReleasePool | null,
  ): Promise<void> {
    const session = recordingSessions.get(mediaId) || null;
    if (!session || session.closing || session.legId !== legId) {
      releasePool?.release(pcm);
      return;
    }
    session.pendingChunks.push({
      pcm,
      bytes,
      sampleRate,
      channels,
      releasePool,
    });
    scheduleRecordingDrain(legId, mediaId, session);
  }

  function handleTransportInput(inputMessage: WorkerTransportInput): void {
    const leg = runtimeWorker.getLeg(inputMessage.payload.legId);
    if (!leg) {
      if (inputMessage.opcode === WorkerTransportInputOpcode.WebSocketPayload) {
        console.error(
          `[sip-pbx:media-worker:${workerId}] transport input dropped; leg=${inputMessage.payload.legId}; reason=leg_missing; opcode=websocket_payload`,
        );
      }
      return;
    }
    if (inputMessage.opcode === WorkerTransportInputOpcode.RtpPacket && leg.transport instanceof RtpTransport) {
      leg.transport.handlePacket(inputMessage.payload.packet);
      return;
    }
    if (inputMessage.opcode === WorkerTransportInputOpcode.WebSocketPayload && leg.transport instanceof WebSocketTransport) {
      leg.transport.ingestExternalPayload(inputMessage.payload.payload);
      return;
    }
    if (inputMessage.opcode === WorkerTransportInputOpcode.TransportClosed) {
      if (leg.transport instanceof RtpTransport) {
        leg.transport.handleClosed(inputMessage.payload.reason);
      } else if (leg.transport instanceof WebSocketTransport) {
        leg.transport.handleClosed(inputMessage.payload.reason);
      }
    }
  }

  async function dispatch(request: WorkerControlRequest): Promise<unknown> {
    switch (request.opcode) {
      case WorkerControlOpcode.EnsureEndpoint: {
        const ensured = await ensureLegWithConfig(
          request.payload.legId,
          request.payload.transportType,
          { ...(request.payload.transportConfig || {}) },
          request.payload.codecName,
        );
        onSnapshot(ensured.snapshot);
        return ensured;
      }
      case WorkerControlOpcode.AcceptEndpointHandoff: {
        const ensured = await acceptLegHandoff(
          request.payload.legId,
          request.payload.transportType,
          { ...(request.payload.transportConfig || {}) },
          request.payload.codecName,
        );
        onSnapshot(ensured.snapshot);
        return ensured;
      }
      case WorkerControlOpcode.RemoveEndpoint: {
        for (const [mediaId, session] of Array.from(recordingSessions.entries())) {
          if (session.legId === request.payload.legId) {
            abortRecordingSession(mediaId);
          }
        }
        for (const [mediaId, pump] of Array.from(playbackPumps.entries())) {
          if (pump.legId === request.payload.legId) {
            const removed = cleanupPlaybackPump(mediaId);
            if (removed) {
              observeCleanupPromise(workerId, `playback cleanup for ${removed.media.mediaId} waiting for endpoint close`, closeReadablePlaybackEndpoint(removed));
              observeCleanupPromise(workerId, `playback cleanup for ${removed.media.mediaId} waiting for pump task`, removed.task);
            }
          }
        }
        const removed = runtimeWorker.removeLeg(request.payload.legId);
        return Boolean(removed);
      }
      case WorkerControlOpcode.RegisterPlayback: {
        await ensureLeg(request.payload.legId, request.payload.transportType);
        const playbackOptions = { ...(request.payload.sourceInput || {}) };
        const tone = String(request.payload.playback.tone || OPTION_DEFAULTS.playTone.tone);
        const loopPlayback = Boolean(request.payload.playback.loopPlayback);
        const playbackMedia = new Media({
          operation: {
            mediaId: String(request.payload.playback.mediaId || ""),
            legId: request.payload.legId,
            kind: request.payload.playback.kind === "tone" ? "tone" : "playback",
            options: request.payload.playback.kind === "playback"
              ? {
                ...playbackOptions,
                sourceRef: request.payload.playback.sourceRef == null ? null : String(request.payload.playback.sourceRef || ""),
              }
              : playbackOptions,
          },
          endpoint: request.payload.playback.kind === "playback"
            ? await createReadableMediaEndpoint({ ...(request.payload.sourceInput || {}) })
            : null,
        });
        const snapshot = runtimeWorker.registerPlayback(
          request.payload.legId,
          request.payload.playback.kind === "tone"
            ? {
              ...(request.payload.playback as Parameters<Leg["registerPlayback"]>[0]),
              tone,
              customTone: playbackOptions.customTone == null ? null : String(playbackOptions.customTone || ""),
              durationMs: Math.max(1, Number(request.payload.playback.durationMs || 0) || 1),
            }
            : request.payload.playback as Parameters<Leg["registerPlayback"]>[0],
          playbackMedia,
        );
        if (!snapshot) {
          if (playbackMedia.endpoint?.direction === "input") {
            await playbackMedia.endpoint.close?.();
          }
          throw new Error(`Unknown leg ${request.payload.legId}`);
        }
        onSnapshot(snapshot);
        if (request.payload.playback.kind !== "tone") {
          void startPlaybackPump(request.payload.legId, playbackMedia);
        }
        return snapshot;
      }
      case WorkerControlOpcode.UnregisterPlayback: {
        const startedAt = Date.now();
        console.error(
          `[sip-pbx:media-worker:${workerId}] UnregisterPlayback start; leg=${request.payload.legId}; media=${request.payload.mediaId}`,
        );
        const pump = cleanupPlaybackPump(request.payload.mediaId);
        if (pump) {
          observeCleanupPromise(workerId, `playback cleanup for ${pump.media.mediaId} waiting for endpoint close`, closeReadablePlaybackEndpoint(pump));
          observeCleanupPromise(workerId, `playback cleanup for ${pump.media.mediaId} waiting for pump task`, pump.task);
        }
        const snapshot = runtimeWorker.unregisterPlayback(request.payload.legId, request.payload.mediaId);
        console.error(
          `[sip-pbx:media-worker:${workerId}] UnregisterPlayback done; leg=${request.payload.legId}; media=${request.payload.mediaId}; elapsedMs=${Math.max(0, Date.now() - startedAt)}`,
        );
        if (!snapshot) {
          return null;
        }
        onSnapshot(snapshot);
        return snapshot;
      }
      case WorkerControlOpcode.StartRecording: {
        await ensureLeg(request.payload.legId, request.payload.transportType);
        const existing = recordingSessions.get(request.payload.mediaId) || null;
        if (existing) {
          abortRecordingSession(request.payload.mediaId);
        }
        const recordingMedia = new Media({
          operation: {
            mediaId: request.payload.mediaId,
            legId: request.payload.legId,
            kind: "recording",
            options: { ...(request.payload.input || {}) },
          },
          endpoint: createWritableMediaEndpoint(request.payload.input),
        });
        recordingSessions.set(request.payload.mediaId, createRecordingSession(request.payload.legId, recordingMedia));
        let snapshot = runtimeWorker.startRecording(
          request.payload.legId,
          request.payload.mediaId,
          request.payload.startedAt,
          recordingMedia,
          request.payload.input,
        );
        if (!snapshot) {
          await ensureLeg(request.payload.legId, request.payload.transportType);
          snapshot = runtimeWorker.startRecording(
            request.payload.legId,
            request.payload.mediaId,
            request.payload.startedAt,
            recordingMedia,
            request.payload.input,
          );
        }
        if (!snapshot) {
          bindLegCallbacks(
            createTransportForLeg(request.payload.legId, request.payload.transportType),
            request.payload.legId,
            request.payload.transportType,
          );
          snapshot = runtimeWorker.startRecording(
            request.payload.legId,
            request.payload.mediaId,
            request.payload.startedAt,
            recordingMedia,
            request.payload.input,
          );
        }
        if (!snapshot) {
          abortRecordingSession(request.payload.mediaId);
          throw new Error(`Unknown leg ${request.payload.legId}`);
        }
        onSnapshot(snapshot);
        return snapshot;
      }
      case WorkerControlOpcode.ActivateGlobalRecording: {
        await ensureLeg(request.payload.legId, request.payload.transportType);
        const existing = recordingSessions.get(request.payload.mediaId) || null;
        if (existing) {
          abortRecordingSession(request.payload.mediaId);
        }
        const recordingMedia = new Media({
          operation: {
            mediaId: request.payload.mediaId,
            legId: request.payload.legId,
            kind: "recording",
            options: { ...(request.payload.input || {}) },
          },
          endpoint: createWritableMediaEndpoint(request.payload.input),
        });
        recordingSessions.set(request.payload.mediaId, createRecordingSession(request.payload.legId, recordingMedia));
        let snapshot = runtimeWorker.activateGlobalRecording(
          request.payload.legId,
          request.payload.mediaId,
          request.payload.startedAt,
          recordingMedia,
          request.payload.input,
        );
        if (!snapshot) {
          await ensureLeg(request.payload.legId, request.payload.transportType);
          snapshot = runtimeWorker.activateGlobalRecording(
            request.payload.legId,
            request.payload.mediaId,
            request.payload.startedAt,
            recordingMedia,
            request.payload.input,
          );
        }
        if (!snapshot) {
          bindLegCallbacks(
            createTransportForLeg(request.payload.legId, request.payload.transportType),
            request.payload.legId,
            request.payload.transportType,
          );
          snapshot = runtimeWorker.activateGlobalRecording(
            request.payload.legId,
            request.payload.mediaId,
            request.payload.startedAt,
            recordingMedia,
            request.payload.input,
          );
        }
        if (!snapshot) {
          abortRecordingSession(request.payload.mediaId);
          throw new Error(`Unknown leg ${request.payload.legId}`);
        }
        onSnapshot(snapshot);
        return snapshot;
      }
      case WorkerControlOpcode.StopRecording: {
        const snapshot = runtimeWorker.stopRecording(request.payload.legId, request.payload.mediaId);
        if (!snapshot) {
          return null;
        }
        onSnapshot(snapshot);
        return snapshot;
      }
      case WorkerControlOpcode.DeactivateGlobalRecording: {
        const snapshot = runtimeWorker.deactivateGlobalRecording(request.payload.legId, request.payload.mediaId);
        if (!snapshot) {
          return null;
        }
        onSnapshot(snapshot);
        return snapshot;
      }
      case WorkerControlOpcode.FinalizeRecording: {
        const session = recordingSessions.get(request.payload.mediaId) || null;
        if (!session) {
          return { ...(request.payload.result || {}) };
        }
        session.closing = true;
        await session.writeChain;
        recordingSessions.delete(request.payload.mediaId);
        return await finalizeRecordingSession(session, request.payload.result);
      }
      case WorkerControlOpcode.PauseGlobalRecording: {
        const snapshot = runtimeWorker.pauseGlobalRecording(request.payload.legId);
        if (!snapshot) {
          return null;
        }
        onSnapshot(snapshot);
        return snapshot;
      }
      case WorkerControlOpcode.ResumeGlobalRecording: {
        const snapshot = runtimeWorker.resumeGlobalRecording(request.payload.legId);
        if (!snapshot) {
          return null;
        }
        onSnapshot(snapshot);
        return snapshot;
      }
      case WorkerControlOpcode.ExportEndpointState: {
        const leg = runtimeWorker.getLeg(request.payload.legId);
        if (!leg) {
          return null;
        }
        let transportState: Record<string, unknown> = {
          ...(leg.transport.getDetails() || {}),
        };
        if (leg.transport instanceof RtpTransport) {
          transportState = {
            ...transportState,
            ...leg.transport.getHandoffState(),
          };
        }
        return {
          legId: leg.legId,
          codecName: leg.codec.codecName,
          transportState,
          snapshot: leg.snapshot(),
        } satisfies WorkerEndpointState;
      }
      case WorkerControlOpcode.SendDtmf: {
        await ensureLeg(request.payload.legId, request.payload.transportType);
        return await runtimeWorker.sendDtmf(request.payload.legId, request.payload.digits, request.payload.method);
      }
      case WorkerControlOpcode.BindLocalBridgePeer:
        runtimeWorker.mergeLegs(request.payload.sourceLegId, request.payload.peerLegId);
        return true;
      case WorkerControlOpcode.OrphanBridgeLeg:
        runtimeWorker.orphanBridgeForLeg(request.payload.legId);
        return true;
      case WorkerControlOpcode.UnbindLocalBridgePeer:
        runtimeWorker.splitBridgeForLeg(request.payload.sourceLegId);
        return true;
      case WorkerControlOpcode.Shutdown:
        await cleanupAllPlaybackPumps();
        abortAllRecordingSessions();
        runtimeWorker.clear();
        return true;
      default:
        throw new Error(`Unsupported worker control opcode ${(request as { opcode: number }).opcode}`);
    }
  }

  return {
    handleRequest(request: WorkerControlRequest): Promise<unknown> {
      return dispatch(request);
    },
    handleTransportInput(inputMessage: WorkerTransportInput): void {
      handleTransportInput(inputMessage);
    },
    clear(): void {
      void cleanupAllPlaybackPumps();
      void abortAllRecordingSessions();
      runtimeWorker.clear();
    },
  };
}

export function startWorkerRuntime(): void {
  if (!parentPort) {
    throw new Error("Worker parent port is unavailable");
  }

  const runtimeWorkerId = String(workerData?.workerId || "media-worker");
  let shutdownRequested = false;
  process.once("uncaughtExceptionMonitor", (error, origin) => {
    console.error(`[sip-pbx:media-worker:${runtimeWorkerId}] uncaught exception during ${origin}: ${formatWorkerDiagnostic(error)}`);
  });
  process.once("unhandledRejection", (reason) => {
    console.error(`[sip-pbx:media-worker:${runtimeWorkerId}] unhandled rejection: ${formatWorkerDiagnostic(reason)}`);
  });
  process.once("exit", (code) => {
    if (!shutdownRequested && code !== 0) {
      console.error(`[sip-pbx:media-worker:${runtimeWorkerId}] process exiting with code ${code}`);
    }
  });

  const runtimeController = createMediaWorkerRuntimeController({
    workerId: runtimeWorkerId,
    createTransport: (legId, transportType) => createTransport(
      transportType,
        transportType === "sip"
            ? {
                sendPacket: async (packet, bytes) => {
                  const normalizedBytes = Math.max(0, Math.min(Number(bytes) || 0, packet.length));
                  parentPort.postMessage({
                    kind: WorkerMessageKind.TransportOutput,
                    opcode: WorkerTransportOutputOpcode.RtpPacket,
                    payload: {
                      legId,
                      packet,
                      bytes: normalizedBytes,
                    },
                  } satisfies WorkerTransportOutputMessage);
                  return true;
                },
          }
        : {
            sendJson: async (payload) => {
              parentPort.postMessage({
                kind: WorkerMessageKind.TransportOutput,
                opcode: WorkerTransportOutputOpcode.WebSocketJson,
                payload: { legId, payload },
              } satisfies WorkerTransportOutputMessage);
              return true;
            },
          },
    ),
    onSnapshot: (snapshot) => {
      parentPort.postMessage({
        kind: WorkerMessageKind.Event,
        opcode: WorkerEventOpcode.Snapshot,
        payload: { snapshot },
      } satisfies WorkerEventMessage);
    },
    onVoiceActivity: (legId, level, durationMs) => {
      parentPort.postMessage({
        kind: WorkerMessageKind.Event,
        opcode: WorkerEventOpcode.VoiceActivity,
        payload: { legId, level, durationMs },
      } satisfies WorkerEventMessage);
    },
    onInboundDtmf: (legId, digits) => {
      parentPort.postMessage({
        kind: WorkerMessageKind.Event,
        opcode: WorkerEventOpcode.InboundDtmf,
        payload: { legId, digits },
      } satisfies WorkerEventMessage);
    },
    onPlaybackFinished: (legId, mediaId) => {
      parentPort.postMessage({
        kind: WorkerMessageKind.Event,
        opcode: WorkerEventOpcode.PlaybackFinished,
        payload: { legId, mediaId },
      } satisfies WorkerEventMessage);
    },
    onMediaFailure: (legId, mediaId, reason, error) => {
      parentPort.postMessage({
        kind: WorkerMessageKind.Event,
        opcode: WorkerEventOpcode.MediaFailed,
        payload: { legId, mediaId, reason, error: error || undefined },
      } satisfies WorkerEventMessage);
    },
    onMediaInterrupt: (legId, mediaId, reason, details) => {
      parentPort.postMessage({
        kind: WorkerMessageKind.Event,
        opcode: WorkerEventOpcode.MediaInterrupt,
        payload: { legId, mediaId, reason, details },
      } satisfies WorkerEventMessage);
    },
    onTransportClosed: (legId, reason) => {
      parentPort.postMessage({
        kind: WorkerMessageKind.Event,
        opcode: WorkerEventOpcode.TransportClosed,
        payload: { legId, reason },
      } satisfies WorkerEventMessage);
    },
  });

  let commandChain = Promise.resolve();

  parentPort.on("message", (message: WorkerMessage) => {
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.kind === WorkerMessageKind.TransportInput) {
      runtimeController.handleTransportInput(message as WorkerTransportInput);
      return;
    }
    if (message.kind !== WorkerMessageKind.Command) {
      return;
    }

    const runCommand = async (): Promise<void> => {
      let ok = true;
      let result: unknown = null;
      let error: string | null = null;
      try {
        result = await runtimeController.handleRequest({
          opcode: message.opcode,
          payload: message.payload as WorkerControlRequest["payload"],
        } as WorkerControlRequest);
        if (message.opcode === WorkerControlOpcode.Shutdown) {
          shutdownRequested = true;
        }
      } catch (caught) {
        ok = false;
        error = caught instanceof Error ? caught.message : String(caught || "Worker request failed");
      }

      parentPort.postMessage({
        kind: WorkerMessageKind.Result,
        requestId: message.requestId,
        ok,
        result,
        error: error || undefined,
      } satisfies WorkerResultMessage);
    };

    const nextCommand = commandChain.then(runCommand, runCommand);
    commandChain = nextCommand.then(() => undefined, (error) => {
      console.error(
        `[sip-pbx:media-worker] command chain failed; opcode=${String(message.opcode || "unknown")}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    });
  });
}

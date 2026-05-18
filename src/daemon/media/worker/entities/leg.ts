import type { AudioCodec, AudioCodecName, NegotiatedPayloadCodec, Pcm16Converter } from "../../codecs/audio-codec";
import {
  convertPcm16,
  createCodec,
  createPcm16Converter,
  estimateConvertedPcm16Bytes,
  isPcmTargetBufferTooSmallError,
  mapDescriptorNameToAudioCodecName,
  pickPreferredAudioPayloadType,
  resolveAudioCodecForPayloadType,
} from "../../codecs/audio-codec";
import type { MediaTransport, MediaTransportDetails, MediaTransportInputEvent } from "../../transports/media-transport";
import { createTransport } from "../../transports/media-transport";
import { RtpTransport, type RtpTransportConfig } from "../../transports/rtp-transport";
import { WebSocketTransport } from "../../transports/websocket-transport";
import { OPTION_DEFAULTS } from "../../../../shared/option-defaults";
import {
  SIP_AUDIO_CODEC_ALAW,
  SIP_AUDIO_CODEC_G722,
  SIP_AUDIO_CODEC_G729,
  SIP_AUDIO_CODEC_MULAW,
  SIP_AUDIO_CODEC_OPUS,
  type SipAudioCodecFilter,
  type SipDtmfMethodFilter,
  normalizeSipAudioCodecFilters,
  normalizeSipDtmfMethodFilters,
} from "../../../../shared/sip-media-filters";
import type { BufferReleasePool } from "../../streams/media-stream";
import { Mixer } from "./mixer";
import type { Bridge } from "./bridge";

export type PlaybackMixState = {
  mediaId: string;
  priority: number;
  duckingFactor: number;
  effectiveGain: number;
  sourceRef: string | null;
};

type PlaybackRenderMixState = {
  mediaId: string;
  effectiveGain: number;
};

type PlaybackRenderSnapshot = {
  activePlaybackMediaIds: string[];
  playbackMix: PlaybackRenderMixState[];
  bridgeEffectiveGain: number;
};

export type LegMediaSessionSnapshot = {
  legId: string;
  playbackCount: number;
  recordingActive: boolean;
  activePlaybackMediaIds: string[];
  activeRecordingMediaId: string | null;
  playbackMix: PlaybackMixState[];
};

type PlaybackRegistration = {
  mediaId: string;
  kind: "playback" | "tone";
  priority: number;
  duckingFactor: number;
  interruptOnDtmf: boolean;
  interruptOnVoice: boolean;
  voiceThreshold: number;
  voiceDurationMs: number;
  voiceActiveDurationMs: number;
  sourceRef: string | null;
  startedAt: number;
};

type RecordingRegistration = {
  mediaId: string;
  paused: boolean;
  globalCallAudio: boolean;
  splitChannels: boolean;
  queueSampleRate: number;
  startedAt: number;
  interruptOnSilence: boolean;
  silenceThreshold: number;
  silenceDurationMs: number;
  silenceActiveDurationMs: number;
  silenceLastActiveAtMs: number;
  silenceInterrupted: boolean;
};

type PendingInboundAudio = {
  pcm: Buffer;
  bytes: number;
  sampleRate: number;
  channels: number;
  durationMs: number;
  level: number;
  releasePool?: BufferReleasePool | null;
};

type RecordingAudioFrame = {
  pcm: Buffer;
  bytes: number;
  sampleRate: number;
  channels: number;
  offsetBytes?: number;
  releasePool?: BufferReleasePool | null;
};

type PendingBridgePlaybackFrame = RecordingAudioFrame & {
  renderOk: boolean;
  settled: boolean;
  resolve(result: boolean): void;
};

type RetainedRecordingAudioFrame = RecordingAudioFrame & {
  durationMs: number;
};

type BridgeRenderFrame = {
  pcm: Buffer;
  bytes: number;
  touched: PendingBridgePlaybackFrame[];
  consumed: PendingBridgePlaybackFrame[];
};

type WorkerTickerHandle = {
  stop(): void;
  isActive(): boolean;
};

type RecordingQueueRole = "inbound" | "outbound";

type LegHooks = {
  onVoiceActivity?: (legId: string, level: number, durationMs: number) => void;
  onInboundPcm?: (legId: string, pcm: Buffer, bytes: number, sampleRate: number, channels: number) => void | Promise<void>;
  onInboundDtmf?: (legId: string, digits: string) => void;
  onPlaybackFinished?: (legId: string, mediaId: string) => void;
  onRecordingPcm?: (legId: string, mediaId: string, pcm: Buffer, bytes: number, sampleRate: number, channels: number, releasePool?: BufferReleasePool | null) => void;
  onRecordingInterrupt?: (legId: string, mediaId: string, reason: string, details?: Record<string, unknown>) => void;
  onTransportClosed?: (legId: string, reason: string) => void;
};

const DEFAULT_PCM_SAMPLE_RATE = 8000;
const DEFAULT_PCM_CHANNELS = 1;
const DEFAULT_PCM_FRAME_BYTES_20MS = 320;
const RECORDING_PREROLL_MS = 1000;

class RecordingFramePool {
  private readonly free = new Map<number, Buffer[]>();
  /**
   * Per-buffer retention count. Lets multiple consumers share the same pool
   * buffer without per-consumer copies; the buffer returns to the free list
   * only when the LAST consumer releases.
   */
  private readonly refCounts = new Map<Buffer, number>();
  private closed = false;

  acquire(bytes: number): Buffer {
    const size = Math.max(0, Math.floor(Number(bytes) || 0));
    if (this.closed || size <= 0) {
      return Buffer.alloc(0);
    }
    const pool = this.free.get(size) || null;
    const buffer = pool && pool.length > 0 ? pool.pop()! : Buffer.allocUnsafe(size);
    this.refCounts.set(buffer, 1);
    return buffer;
  }

  /** Add one more owner to an already-acquired buffer. */
  retain(buffer: Buffer): void {
    if (this.closed || !Buffer.isBuffer(buffer) || buffer.length <= 0) {
      return;
    }
    const current = this.refCounts.get(buffer);
    if (current === undefined) {
      // Untracked: foreign buffer or already returned to the pool. Ignore —
      // retaining a stale buffer must not corrupt the free list.
      return;
    }
    this.refCounts.set(buffer, current + 1);
  }

  release(buffer: Buffer): void {
    if (this.closed || !Buffer.isBuffer(buffer) || buffer.length <= 0) {
      return;
    }
    const current = this.refCounts.get(buffer);
    if (current === undefined) {
      // Double-release or foreign buffer — skip, the slot is already free.
      return;
    }
    if (current > 1) {
      this.refCounts.set(buffer, current - 1);
      return;
    }
    this.refCounts.delete(buffer);
    const size = buffer.length;
    let pool = this.free.get(size) || null;
    if (!pool) {
      pool = [];
      this.free.set(size, pool);
    }
    pool.push(buffer);
  }

  destroy(): void {
    this.closed = true;
    this.free.clear();
    this.refCounts.clear();
  }
}

class RecordingFrameRing {
  private readonly items: RetainedRecordingAudioFrame[] = [];
  private totalDurationMs = 0;
  private sampleRate: number | null = null;
  private channels: number | null = null;

  constructor(private readonly maxDurationMs: number) {}

  push(frame: RetainedRecordingAudioFrame): void {
    if (!frame.bytes) {
      frame.releasePool?.release(frame.pcm);
      return;
    }
    const sampleRate = Math.max(1, Number(frame.sampleRate || DEFAULT_PCM_SAMPLE_RATE));
    const channels = Math.max(1, Number(frame.channels || DEFAULT_PCM_CHANNELS));
    if (this.sampleRate !== null && this.channels !== null && (this.sampleRate !== sampleRate || this.channels !== channels)) {
      this.clear();
    }
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.items.push(frame);
    this.totalDurationMs += Math.max(1, Number(frame.durationMs || 0));
    this.trim();
  }

  snapshot(): readonly RetainedRecordingAudioFrame[] {
    return this.items;
  }

  clear(): void {
    while (this.items.length > 0) {
      const frame = this.items.shift()!;
      frame.releasePool?.release(frame.pcm);
    }
    this.totalDurationMs = 0;
    this.sampleRate = null;
    this.channels = null;
  }

  private trim(): void {
    while (this.totalDurationMs > this.maxDurationMs && this.items.length > 1) {
      const frame = this.items.shift()!;
      this.totalDurationMs -= Math.max(1, Number(frame.durationMs || 0));
      frame.releasePool?.release(frame.pcm);
    }
  }
}

function clampPcm16(value: number): number {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value;
}

function toPcm16View(buffer: Buffer, offsetBytes = 0, sampleCount?: number): Int16Array | null {
  const normalizedOffset = Math.max(0, Math.min(Number(offsetBytes || 0), buffer.length));
  if (normalizedOffset >= buffer.length || ((buffer.byteOffset + normalizedOffset) & 1) !== 0) {
    return null;
  }
  const maxSamples = Math.floor((buffer.length - normalizedOffset) / 2);
  const length = Math.max(0, Math.min(Number(sampleCount ?? maxSamples) || 0, maxSamples));
  if (length <= 0) {
    return null;
  }
  return new Int16Array(buffer.buffer, buffer.byteOffset + normalizedOffset, length);
}

function getMonoSampleCount(frame: RecordingAudioFrame | null): number {
  if (!frame?.bytes) {
    return 0;
  }
  const channels = Math.max(1, Number(frame.channels || DEFAULT_PCM_CHANNELS));
  const offsetBytes = Math.max(0, Math.min(Number(frame.offsetBytes || 0), frame.bytes));
  return Math.floor(Math.max(0, frame.bytes - offsetBytes) / (channels * 2));
}

function readMonoSample(frame: RecordingAudioFrame | null, sampleIndex: number): number {
  if (!frame?.bytes) {
    return 0;
  }
  const channels = Math.max(1, Number(frame.channels || DEFAULT_PCM_CHANNELS));
  const frameOffset = Math.max(0, Math.min(Number(frame.offsetBytes || 0), frame.bytes));
  const baseOffset = frameOffset + (sampleIndex * channels * 2);
  if (baseOffset + 1 >= frame.bytes) {
    return 0;
  }
  if (channels === 1) {
    return frame.pcm.readInt16LE(baseOffset);
  }
  let total = 0;
  let count = 0;
  for (let channel = 0; channel < channels; channel += 1) {
    const offset = baseOffset + channel * 2;
    if (offset + 1 >= frame.bytes) {
      break;
    }
    total += frame.pcm.readInt16LE(offset);
    count += 1;
  }
  return count > 0 ? Math.round(total / count) : 0;
}

function isRecordingFrameConsumed(frame: RecordingAudioFrame | null): boolean {
  return getMonoSampleCount(frame) <= 0;
}

function consumeRecordingFrameSamples(frame: RecordingAudioFrame | null, sampleCount: number): void {
  if (!frame?.bytes || sampleCount <= 0) {
    return;
  }
  const channels = Math.max(1, Number(frame.channels || DEFAULT_PCM_CHANNELS));
  const bytesToConsume = Math.max(0, sampleCount) * channels * 2;
  const nextOffset = Math.max(0, Math.min(frame.bytes, Number(frame.offsetBytes || 0) + bytesToConsume));
  frame.offsetBytes = nextOffset;
}

function resolveRecordingQueueSampleRate(input?: Record<string, unknown>): number {
  const fileFormat = String(input?.recordFileFormat || OPTION_DEFAULTS.recordAudio.fileFormat).trim().toLowerCase() || OPTION_DEFAULTS.recordAudio.fileFormat;
  if (fileFormat === "wav") {
    return Math.max(1, Number(input?.recordWavSampleRate || OPTION_DEFAULTS.recordAudio.wavSampleRate));
  }
  return Math.max(
    1,
    Number(input?.recordCompressedSampleRate || input?.recordMp3SampleRate || OPTION_DEFAULTS.recordAudio.compressedSampleRate),
  );
}

function normalizeDuckingFactor(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  return Math.max(0, numeric);
}

function buildPlaybackMix(ordered: PlaybackRegistration[]): PlaybackMixState[] {
  const rawGains = buildRawPlaybackGains(ordered);
  const mixScale = 1 / Math.max(1, ...rawGains);
  return ordered.map((playback, index) => ({
    mediaId: playback.mediaId,
    priority: playback.priority,
    duckingFactor: playback.duckingFactor,
    effectiveGain: (rawGains[index] || 0) * mixScale,
    sourceRef: playback.sourceRef,
  }));
}

function buildPlaybackRenderMix(ordered: PlaybackRegistration[]): PlaybackRenderMixState[] {
  const rawGains = buildRawPlaybackGains(ordered);
  const mixScale = 1 / Math.max(1, ...rawGains);
  return ordered.map((playback, index) => ({
    mediaId: playback.mediaId,
    effectiveGain: (rawGains[index] || 0) * mixScale,
  }));
}

function buildBridgeRenderGain(ordered: PlaybackRegistration[]): number {
  const rawGains = buildRawPlaybackGains(ordered);
  let gain = 1;
  for (const playback of ordered) {
    if (playback.duckingFactor <= 1) {
      gain *= playback.duckingFactor;
    }
  }
  const mixScale = 1 / Math.max(1, ...rawGains);
  return gain * mixScale;
}

function buildRawPlaybackGains(ordered: PlaybackRegistration[]): number[] {
  return ordered.map((playback, index) => {
    let gain = playback.duckingFactor > 1 ? playback.duckingFactor : 1;
    for (let higherIndex = 0; higherIndex < index; higherIndex += 1) {
      const higherDuckingFactor = ordered[higherIndex].duckingFactor;
      if (higherDuckingFactor <= 1) {
        gain *= higherDuckingFactor;
      }
    }
    return gain;
  });
}

function emitLegEvent<TArgs extends unknown[]>(
  callback: ((...args: TArgs) => void) | undefined,
  ...args: TArgs
): void {
  if (!callback) {
    return;
  }
  callback(...args);
}

function scheduleWorkerTick(callback: () => void, delayMs: number): NodeJS.Timeout {
  return setTimeout(callback, Math.max(0, delayMs));
}

function getMonotonicTickMs(): number {
  const hrtime = process?.hrtime?.bigint;
  if (typeof hrtime === "function") {
    return Number(hrtime() / 1000000n);
  }
  return Date.now();
}

function normalizePayloadCodecs(value: unknown): Record<number, NegotiatedPayloadCodec> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const output: Record<number, NegotiatedPayloadCodec> = {};
  for (const [rawPayloadType, entry] of Object.entries(value as Record<string, unknown>)) {
    const payloadType = Number(rawPayloadType);
    if (!Number.isInteger(payloadType) || payloadType < 0 || !entry || typeof entry !== "object") {
      continue;
    }
    output[payloadType] = { ...(entry as Record<string, unknown>) } as NegotiatedPayloadCodec;
  }
  return output;
}

function buildRtpTransportConfig(details: Record<string, unknown>): RtpTransportConfig {
  return {
    localRtpBindIp: String(details.localRtpBindIp || details.bindIp || "").trim() || undefined,
    localRtpAdvertisedIp: String(details.localRtpAdvertisedIp || details.advertisedIp || "").trim() || undefined,
    localRtpHost: String(details.localRtpHost || "").trim() || undefined,
    localRtpPort: Number.isFinite(Number(details.localRtpPort)) ? Number(details.localRtpPort) : undefined,
    remoteRtpHost: String(details.remoteRtpHost || "").trim() || undefined,
    remoteRtpPort: Number.isFinite(Number(details.remoteRtpPort)) ? Number(details.remoteRtpPort) : undefined,
    audioPayloadType: Number.isInteger(Number(details.audioPayloadType)) ? Number(details.audioPayloadType) : undefined,
    dtmfPayloadType: details.dtmfPayloadType == null
      ? null
      : (Number.isInteger(Number(details.dtmfPayloadType)) ? Number(details.dtmfPayloadType) : null),
    payloadTypes: Array.isArray(details.payloadTypes)
      ? details.payloadTypes.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0)
      : undefined,
    payloadCodecs: normalizePayloadCodecs(details.payloadCodecs),
    allowedAudioCodecs: normalizeSipAudioCodecFilters(details.allowedAudioCodecs),
    allowedDtmfMethods: normalizeSipDtmfMethodFilters(details.allowedDtmfMethods),
    currentSequenceNumber: Number.isInteger(Number(details.currentSequenceNumber))
      ? Number(details.currentSequenceNumber)
      : undefined,
    currentTimestamp: Number.isInteger(Number(details.currentTimestamp))
      ? Number(details.currentTimestamp)
      : undefined,
    currentSsrc: Number.isInteger(Number(details.currentSsrc))
      ? Number(details.currentSsrc)
      : undefined,
  };
}

function resolveCodecNameForTransport(
  transportType: "sip" | "websocket",
  config: Record<string, unknown>,
  fallback: AudioCodecName,
): AudioCodecName {
  if (transportType === "websocket") {
    return fallback;
  }
  const explicit = String(config.audioCodecName || "").trim().toLowerCase();
  if (explicit) {
    return mapDescriptorNameToAudioCodecName(explicit);
  }
  const allowedAudioCodecs = normalizeSipAudioCodecFilters(config.allowedAudioCodecs);
  const payloadCodecs = normalizePayloadCodecs(config.payloadCodecs);
  const audioPayloadType = Number(config.audioPayloadType);
  if (Number.isInteger(audioPayloadType) && audioPayloadType >= 0) {
    const descriptor = resolveAudioCodecForPayloadType(audioPayloadType, payloadCodecs);
    if (descriptor && isAllowedAudioCodecDescriptor(descriptor.name, allowedAudioCodecs)) {
      return mapDescriptorNameToAudioCodecName(descriptor.name);
    }
  }
  const payloadTypes = Array.isArray(config.payloadTypes)
    ? config.payloadTypes.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0)
    : [];
  const allowedPayloadTypes = payloadTypes.filter((payloadType) => {
    const descriptor = resolveAudioCodecForPayloadType(payloadType, payloadCodecs);
    return descriptor ? isAllowedAudioCodecDescriptor(descriptor.name, allowedAudioCodecs) : false;
  });
  if (allowedPayloadTypes.length > 0) {
    const preferredPayloadType = pickPreferredAudioPayloadType(allowedPayloadTypes, payloadCodecs);
    const descriptor = resolveAudioCodecForPayloadType(preferredPayloadType, payloadCodecs);
    if (descriptor) {
      return mapDescriptorNameToAudioCodecName(descriptor.name);
    }
  }
  return fallback;
}

function isAllowedAudioCodecDescriptor(descriptorName: string, allowedAudioCodecs: readonly SipAudioCodecFilter[]): boolean {
  if (!allowedAudioCodecs.length) {
    return true;
  }
  const codecName = String(descriptorName || "").trim().toLowerCase();
  return (
    (codecName === "pcma" && allowedAudioCodecs.includes(SIP_AUDIO_CODEC_ALAW))
    || (codecName === "pcmu" && allowedAudioCodecs.includes(SIP_AUDIO_CODEC_MULAW))
    || (codecName === "g722" && allowedAudioCodecs.includes(SIP_AUDIO_CODEC_G722))
    || (codecName === "g729" && allowedAudioCodecs.includes(SIP_AUDIO_CODEC_G729))
    || (codecName === "opus" && allowedAudioCodecs.includes(SIP_AUDIO_CODEC_OPUS))
  );
}

function createRepeatingWorkerTicker(
  callback: () => boolean | Promise<boolean>,
  delayMs: number,
  label: string,
  options?: { immediate?: boolean },
): WorkerTickerHandle {
  let timer: NodeJS.Timeout | null = null;
  let active = true;
  let nextDeadlineMs = getMonotonicTickMs() + (options?.immediate === false ? Math.max(0, delayMs) : 0);

  const clearCurrentTimer = (): void => {
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    timer = null;
  };

  const scheduleNext = (): void => {
    if (!active) {
      return;
    }
    const delay = Math.max(0, nextDeadlineMs - getMonotonicTickMs());
    timer = scheduleWorkerTick(() => {
      void tick();
    }, delay);
  };

  const tick = async (): Promise<void> => {
    clearCurrentTimer();
    if (!active) {
      return;
    }
    let shouldContinue = false;
    try {
      shouldContinue = await callback();
    } catch (error) {
      console.error(
        `[sip-pbx:media-worker] repeating worker ticker failed for ${label}:`,
        error instanceof Error ? error.stack || error.message : String(error || "unknown_error"),
      );
      shouldContinue = false;
    }
    if (shouldContinue) {
      nextDeadlineMs = Math.max(nextDeadlineMs + delayMs, getMonotonicTickMs() + 1);
      scheduleNext();
      return;
    }
    active = false;
  };

  if (options?.immediate === false) {
    scheduleNext();
  } else {
    void tick();
  }

  return {
    stop() {
      active = false;
      clearCurrentTimer();
    },
    isActive() {
      return active;
    },
  };
}

class FrameQueue<T> {
  private readonly items: T[] = [];
  private head = 0;

  push(value: T): void {
    this.items.push(value);
  }

  shift(): T | undefined {
    if (this.head >= this.items.length) {
      return undefined;
    }
    const value = this.items[this.head];
    this.head += 1;
    if (this.head >= this.items.length) {
      this.items.length = 0;
      this.head = 0;
    } else if (this.head > 64 && this.head * 2 >= this.items.length) {
      this.items.splice(0, this.head);
      this.head = 0;
    }
    return value;
  }

  clear(): void {
    this.items.length = 0;
    this.head = 0;
  }

  peek(): T | undefined {
    if (this.head >= this.items.length) {
      return undefined;
    }
    return this.items[this.head];
  }

  snapshot(): readonly T[] {
    return this.items.slice(this.head);
  }

  get length(): number {
    return this.items.length - this.head;
  }
}

export class Leg {
  readonly legId: string;
  readonly transportType: "sip" | "websocket";
  readonly transport: MediaTransport;
  readonly mixer: Mixer;
  bridge: Bridge | null = null;
  private _codec: AudioCodec;
  private playbackSampleRate = DEFAULT_PCM_SAMPLE_RATE;
  private playbackChannels = DEFAULT_PCM_CHANNELS;
  private playbackFrameBytes = DEFAULT_PCM_FRAME_BYTES_20MS;

  private readonly onVoiceActivity?: (legId: string, level: number, durationMs: number) => void;
  private readonly onInboundPcm?: (legId: string, pcm: Buffer, bytes: number, sampleRate: number, channels: number) => void | Promise<void>;
  private readonly onInboundDtmf?: (legId: string, digits: string) => void;
  private readonly onPlaybackFinished?: (legId: string, mediaId: string) => void;
  private readonly onRecordingPcm?: (legId: string, mediaId: string, pcm: Buffer, bytes: number, sampleRate: number, channels: number, releasePool?: BufferReleasePool | null) => void;
  private readonly onRecordingInterrupt?: (legId: string, mediaId: string, reason: string, details?: Record<string, unknown>) => void;
  private readonly onTransportClosed?: (legId: string, reason: string) => void;
  private readonly playbacks = new Map<string, PlaybackRegistration>();
  private mediaRecording: RecordingRegistration | null = null;
  private globalRecording: RecordingRegistration | null = null;
  private readonly pendingInboundAudio = new FrameQueue<PendingInboundAudio>();
  private readonly pendingBridgePlayback = new FrameQueue<PendingBridgePlaybackFrame>();
  private readonly pendingRecordingInbound = new FrameQueue<RecordingAudioFrame>();
  private readonly pendingRecordingOutbound = new FrameQueue<RecordingAudioFrame>();
  private pendingRecordingInboundSamples = 0;
  private pendingRecordingOutboundSamples = 0;
  private readonly recordingFramePool = new RecordingFramePool();
  private readonly recordingPreRollInbound = new RecordingFrameRing(RECORDING_PREROLL_MS);
  private readonly bridgePcmConverters = new Map<string, Pcm16Converter>();
  private readonly recordingPcmConverters = new Map<string, Pcm16Converter>();
  private bridgePcmScratch = Buffer.allocUnsafe(DEFAULT_PCM_FRAME_BYTES_20MS);
  private bridgePlaybackScratch = Buffer.allocUnsafe(DEFAULT_PCM_FRAME_BYTES_20MS);
  private playbackScratch = Buffer.allocUnsafe(DEFAULT_PCM_FRAME_BYTES_20MS);
  private playbackTicker: WorkerTickerHandle | null = null;
  private captureTicker: WorkerTickerHandle | null = null;
  private recordingTicker: WorkerTickerHandle | null = null;
  private recordingClosing = false;
  private playbackMarkerPending = false;
  private playbackRenderSnapshot: PlaybackRenderSnapshot | null = null;
  private playbackRenderSnapshotDirty = true;
  private readonly unsubscribe: () => void;

  constructor(input: {
    legId: string;
    transportType: "sip" | "websocket";
    codecName?: AudioCodecName;
    transport?: MediaTransport;
    codec?: AudioCodec;
    mixer?: Mixer;
    transportConfig?: Record<string, unknown>;
  } & LegHooks) {
    this.legId = String(input.legId || "").trim();
    this.transportType = input.transportType;
    this.transport = input.transport || createTransport(input.transportType);
    this._codec = input.codec || createCodec(input.codecName || "g711");
    this.mixer = input.mixer || new Mixer();
    this.onVoiceActivity = input.onVoiceActivity;
    this.onInboundPcm = input.onInboundPcm;
    this.onInboundDtmf = input.onInboundDtmf;
    this.onPlaybackFinished = input.onPlaybackFinished;
    this.onRecordingPcm = input.onRecordingPcm;
    this.onRecordingInterrupt = input.onRecordingInterrupt;
    this.onTransportClosed = input.onTransportClosed;
    // SIP transport: hand it our recording pool so inbound RTP decodes
    // straight into a pool buffer and we can skip the defensive copy out of
    // decodeScratch in handleTransportEvent. The transport drops the pool ref
    // on close.
    if (this.transport instanceof RtpTransport) {
      this.transport.setDecodeBufferPool(this.recordingFramePool);
    }
    this.unsubscribe = this.transport.subscribe((event) => {
      this.handleTransportEvent(event);
    });
    this.refreshPlaybackFormat();
  }

  get codec(): AudioCodec {
    return this._codec;
  }

  async configureTransport(config: Record<string, unknown>, codec?: AudioCodec): Promise<MediaTransportDetails> {
    const resolvedCodecName = codec?.codecName || resolveCodecNameForTransport(this.transportType, config, this._codec.codecName);
    const nextCodec = codec || (resolvedCodecName === this._codec.codecName ? this._codec : createCodec(resolvedCodecName));
    if (nextCodec !== this._codec) {
      this._codec.close();
      this._codec = nextCodec;
    }
    if (this.transportType === "sip" && this.transport instanceof RtpTransport) {
      const details = await this.transport.configure(buildRtpTransportConfig(config), this._codec);
      this.refreshPlaybackFormat(details);
      return details;
    }
    if (this.transportType === "websocket" && this.transport instanceof WebSocketTransport) {
      const details = await this.transport.configure({ ...(config || {}) });
      this.refreshPlaybackFormat(details);
      return details;
    }
    const details = await this.transport.configure({ ...(config || {}) });
    this.refreshPlaybackFormat(details);
    return details;
  }

  registerPlayback(input: {
    mediaId: string;
    kind: "playback" | "tone";
    priority?: number;
    duckingFactor?: number;
    interruptOnDtmf?: boolean;
    interruptOnVoice?: boolean;
    voiceThreshold?: number;
    voiceDurationMs?: number;
    sourceRef?: string | null;
    pcm?: Buffer;
    tone?: string;
    customTone?: string | null;
    durationMs?: number;
    loopPlayback?: boolean;
    startedAt?: number;
  }): LegMediaSessionSnapshot {
    this.playbacks.set(input.mediaId, {
      mediaId: input.mediaId,
      kind: input.kind,
      priority: Number(input.priority || 0),
      duckingFactor: normalizeDuckingFactor(input.duckingFactor),
      interruptOnDtmf: Boolean(input.interruptOnDtmf),
      interruptOnVoice: Boolean(input.interruptOnVoice),
      voiceThreshold: Number(input.voiceThreshold || 0),
      voiceDurationMs: Number(input.voiceDurationMs || 0),
      voiceActiveDurationMs: 0,
      sourceRef: input.sourceRef == null ? null : String(input.sourceRef || ""),
      startedAt: Number(input.startedAt || Date.now()),
    });
    if (input.kind === "tone") {
      this.mixer.setToneSource(input.mediaId, {
        tone: String(input.tone || OPTION_DEFAULTS.playTone.tone),
        customTone: input.customTone == null ? null : String(input.customTone || ""),
        durationMs: Math.max(1, Number(input.durationMs || 0) || 1),
        loop: Boolean(input.loopPlayback),
        sampleRate: this.playbackSampleRate,
      });
    } else if (input.pcm?.length) {
      this.mixer.setSource(input.mediaId, input.pcm, Boolean(input.loopPlayback));
    }
    this.playbackRenderSnapshotDirty = true;
    this.playbackMarkerPending = true;
    if (input.kind === "tone" || Boolean(input.pcm?.length)) {
      this.ensurePlaybackLoop();
    }
    return this.snapshot();
  }

  appendPlaybackChunk(mediaId: string, pcm: Buffer, bytes: number, releasePool?: BufferReleasePool | null): number {
    const buffered = this.mixer.appendChunk(mediaId, pcm, bytes, releasePool);
    this.ensurePlaybackLoop();
    return buffered;
  }

  finishPlayback(mediaId: string): void {
    this.mixer.finishSource(mediaId);
    this.ensurePlaybackLoop();
  }

  unregisterPlayback(mediaId: string): LegMediaSessionSnapshot {
    this.playbacks.delete(mediaId);
    this.mixer.removeSource(mediaId);
    this.playbackRenderSnapshotDirty = true;
    return this.snapshot();
  }

  startRecording(mediaId: string, startedAt?: number, input?: Record<string, unknown>): LegMediaSessionSnapshot {
    this.mediaRecording = {
      mediaId,
      paused: false,
      globalCallAudio: false,
      splitChannels: false,
      queueSampleRate: resolveRecordingQueueSampleRate(input),
      startedAt: Number(startedAt || Date.now()),
      interruptOnSilence: Boolean(input?.interruptOnSilence),
      silenceThreshold: Math.max(0, Number(input?.silenceThreshold || 0)),
      silenceDurationMs: Math.max(0, Number(input?.silenceDurationMs || 0)),
      silenceActiveDurationMs: 0,
      silenceLastActiveAtMs: getMonotonicTickMs(),
      silenceInterrupted: false,
    };
    const inboundPreRoll = Array.from(this.recordingPreRollInbound.snapshot());
    for (const frame of inboundPreRoll) {
      this.emitRetainedRecordingFrame(mediaId, frame);
    }
    if (this.mediaRecording.interruptOnSilence) {
      this.ensureRecordingLoop();
    }
    return this.snapshot();
  }

  activateGlobalRecording(mediaId: string, startedAt?: number, input?: Record<string, unknown>): LegMediaSessionSnapshot {
    this.recordingClosing = false;
    this.clearRecordingQueues();
    this.closeRecordingPcmConverters();
    this.globalRecording = {
      mediaId,
      paused: false,
      globalCallAudio: true,
      splitChannels: Boolean(input?.recordSplitChannels),
      queueSampleRate: resolveRecordingQueueSampleRate(input),
      startedAt: Number(startedAt || Date.now()),
      interruptOnSilence: Boolean(input?.interruptOnSilence),
      silenceThreshold: Math.max(0, Number(input?.silenceThreshold || 0)),
      silenceDurationMs: Math.max(0, Number(input?.silenceDurationMs || 0)),
      silenceActiveDurationMs: 0,
      silenceLastActiveAtMs: getMonotonicTickMs(),
      silenceInterrupted: false,
    };
    this.ensureRecordingLoop();
    return this.snapshot();
  }

  stopRecording(mediaId: string): LegMediaSessionSnapshot {
    if (this.mediaRecording?.mediaId === mediaId) {
      this.mediaRecording = null;
    }
    return this.snapshot();
  }

  deactivateGlobalRecording(mediaId: string): LegMediaSessionSnapshot {
    if (this.globalRecording?.mediaId === mediaId) {
      this.recordingClosing = true;
      this.flushRecordingQueues();
      this.recordingTicker?.stop();
      this.recordingTicker = null;
      this.clearRecordingQueues();
      this.globalRecording = null;
      this.recordingClosing = false;
      this.closeRecordingPcmConverters();
    }
    return this.snapshot();
  }

  pauseGlobalRecording(): LegMediaSessionSnapshot {
    if (this.globalRecording) {
      this.recordingClosing = true;
      this.flushRecordingQueues();
      this.globalRecording.paused = true;
      this.clearRecordingQueues();
      this.recordingClosing = false;
      this.closeRecordingPcmConverters();
    }
    return this.snapshot();
  }

  resumeGlobalRecording(): LegMediaSessionSnapshot {
    if (this.globalRecording) {
      this.globalRecording.paused = false;
      if (this.globalRecording.interruptOnSilence || this.globalRecording.globalCallAudio) {
        this.ensureRecordingLoop();
      }
    }
    return this.snapshot();
  }

  getRecordingMediaId(): string | null {
    return this.mediaRecording?.mediaId || null;
  }

  collectDtmfInterruptTargets(): string[] {
    return Array.from(this.playbacks.values())
      .filter((playback) => playback.interruptOnDtmf)
      .map((playback) => playback.mediaId);
  }

  collectVoiceInterruptTargets(level: number, durationMs: number): string[] {
    const targets: string[] = [];
    for (const playback of this.playbacks.values()) {
      if (!playback.interruptOnVoice) {
        continue;
      }
      if (level >= Math.max(0, playback.voiceThreshold)) {
        playback.voiceActiveDurationMs += Math.max(0, Number(durationMs || 0));
      } else {
        playback.voiceActiveDurationMs = 0;
      }
      if (playback.voiceActiveDurationMs < Math.max(0, playback.voiceDurationMs)) {
        continue;
      }
      playback.voiceActiveDurationMs = 0;
      targets.push(playback.mediaId);
    }
    return targets;
  }

  async sendDtmf(digits: string, method: string): Promise<boolean> {
    return await this.transport.sendDtmf(digits, method);
  }

  async sendBridgePcm(
    pcm: Buffer,
    bytes = pcm.length,
    sourceSampleRate = this.playbackSampleRate,
    sourceChannels = this.playbackChannels,
  ): Promise<boolean> {
    const normalizedBytes = Math.max(0, Math.min(Number(bytes) || 0, pcm.length));
    if (!normalizedBytes) {
      return false;
    }
    let bridgePcm = pcm;
    let bridgeBytes = normalizedBytes;
    const targetSampleRate = this.playbackSampleRate;
    const targetChannels = this.playbackChannels;
    if (sourceSampleRate !== targetSampleRate || sourceChannels !== targetChannels) {
      const converter = this.getBridgePcmConverter(sourceSampleRate, sourceChannels, targetSampleRate, targetChannels);
      let scratchBytes = Math.max(
        2,
        estimateConvertedPcm16Bytes(normalizedBytes, sourceSampleRate, sourceChannels, targetSampleRate, targetChannels),
      );
      let convertedBytes = 0;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (this.bridgePcmScratch.length < scratchBytes) {
          this.bridgePcmScratch = Buffer.allocUnsafe(Math.max(scratchBytes, this.bridgePcmScratch.length * 2, 2048));
        }
        try {
          convertedBytes = convertPcm16(converter, pcm, 0, normalizedBytes, this.bridgePcmScratch, 0);
          break;
        } catch (error) {
          if (!isPcmTargetBufferTooSmallError(error) || attempt >= 2) {
            throw error;
          }
          scratchBytes = Math.max(scratchBytes * 2, this.bridgePcmScratch.length * 2, 4096);
        }
      }
      if (!convertedBytes) {
        return false;
      }
      bridgePcm = this.bridgePcmScratch;
      bridgeBytes = convertedBytes;
    }
    const owned = this.recordingFramePool.acquire(bridgeBytes);
    if (!owned.length) {
      return false;
    }
    bridgePcm.copy(owned, 0, 0, bridgeBytes);
    return await new Promise<boolean>((resolve) => {
      this.pendingBridgePlayback.push({
        pcm: owned,
        bytes: bridgeBytes,
        sampleRate: targetSampleRate,
        channels: targetChannels,
        offsetBytes: 0,
        releasePool: this.recordingFramePool,
        renderOk: true,
        settled: false,
        resolve,
      });
      this.ensurePlaybackLoop();
    });
  }

  isIdle(): boolean {
    return this.playbacks.size === 0 && !this.mediaRecording && !this.globalRecording;
  }

  snapshot(): LegMediaSessionSnapshot {
    const ordered = Array.from(this.playbacks.values()).sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }
      return right.startedAt - left.startedAt;
    });
    return {
      legId: this.legId,
      playbackCount: ordered.length,
      recordingActive: Boolean(this.mediaRecording || this.globalRecording),
      activePlaybackMediaIds: ordered.map((playback) => playback.mediaId),
      activeRecordingMediaId: this.mediaRecording?.mediaId || null,
      playbackMix: buildPlaybackMix(ordered),
    };
  }

  close(): void {
    this.playbackTicker?.stop();
    this.playbackTicker = null;
    this.captureTicker?.stop();
    this.captureTicker = null;
    this.recordingTicker?.stop();
    this.recordingTicker = null;
    while (this.pendingInboundAudio.length > 0) {
      const frame = this.pendingInboundAudio.shift() || null;
      frame?.releasePool?.release(frame.pcm);
    }
    while (this.pendingBridgePlayback.length > 0) {
      const frame = this.pendingBridgePlayback.shift() || null;
      if (frame) {
        this.settlePendingBridgePlayback(frame, false);
      }
    }
    this.clearRecordingQueues();
    this.recordingPreRollInbound.clear();
    this.playbacks.clear();
    this.mediaRecording = null;
    this.globalRecording = null;
    this.playbackRenderSnapshot = null;
    this.playbackRenderSnapshotDirty = true;
    this.playbackMarkerPending = false;
    this.mixer.clear();
    this.recordingFramePool.destroy();
    for (const converter of this.bridgePcmConverters.values()) {
      converter.close();
    }
    this.bridgePcmConverters.clear();
    this.closeRecordingPcmConverters();
    this.unsubscribe();
    this.transport.close();
    this._codec.close();
  }

  private handleTransportEvent(event: MediaTransportInputEvent): void {
    if (event.type === "dtmf") {
      if (event.digits) {
        emitLegEvent(this.onInboundDtmf, this.legId, event.digits);
      }
      return;
    }
    if (event.type === "interrupt") {
      if (event.reason === "media_voice") {
        emitLegEvent(this.onVoiceActivity, this.legId, 1, 100);
      }
      return;
    }
    if (event.type === "transport") {
      emitLegEvent(this.onTransportClosed, this.legId, event.reason);
      return;
    }
    if (!event.pcm.length) {
      return;
    }
    const bytes = Math.max(0, Math.min(Number(event.bytes ?? event.pcm.length) || 0, event.pcm.length));
    if (!bytes) {
      return;
    }
    const sampleRate = Number(event.sampleRate || DEFAULT_PCM_SAMPLE_RATE);
    const channels = Number(event.channels || DEFAULT_PCM_CHANNELS);
    const durationMs = Number(event.durationMs || 20);
    const level = Number(event.level || 0);
    // Fast path: if the transport handed us a pool-owned buffer (set up via
    // RtpTransport.setDecodeBufferPool with our recordingFramePool, or by the
    // WebSocket transport), use it directly. Otherwise (legacy SIP path where
    // event.pcm points at the transport's decodeScratch about to be reused),
    // make one defensive copy into a pool buffer.
    const inboundFrame = event.releasePool
      ? {
          pcm: event.pcm,
          bytes,
          sampleRate,
          channels,
          durationMs,
          level,
          releasePool: event.releasePool,
        }
      : (() => {
          const owned = this.recordingFramePool.acquire(bytes);
          if (!owned.length) {
            return null;
          }
          event.pcm.copy(owned, 0, 0, bytes);
          return {
            pcm: owned,
            bytes,
            sampleRate,
            channels,
            durationMs,
            level,
            releasePool: this.recordingFramePool as BufferReleasePool,
          };
        })();
    if (!inboundFrame) {
      return;
    }
    this.retainPreRollFrame({
      pcm: inboundFrame.pcm,
      bytes: inboundFrame.bytes,
      sampleRate: inboundFrame.sampleRate,
      channels: inboundFrame.channels,
      durationMs: inboundFrame.durationMs,
      // Carry the pool ref so shareRecordingFrame can retain instead of copy.
      releasePool: inboundFrame.releasePool,
    });
    if (this.mediaRecording && !this.mediaRecording.paused) {
      this.maybeInterruptRecordingOnSilence(this.mediaRecording, {
        pcm: inboundFrame.pcm,
        bytes: inboundFrame.bytes,
        sampleRate: inboundFrame.sampleRate,
        channels: inboundFrame.channels,
        durationMs: inboundFrame.durationMs,
        level: inboundFrame.level,
      });
      this.emitRetainedRecordingFrame(this.mediaRecording.mediaId, {
        pcm: inboundFrame.pcm,
        bytes: inboundFrame.bytes,
        sampleRate: inboundFrame.sampleRate,
        channels: inboundFrame.channels,
        durationMs: inboundFrame.durationMs,
        releasePool: inboundFrame.releasePool,
      });
    }
    this.pendingInboundAudio.push(inboundFrame);
    this.ensureCaptureLoop();
    setImmediate(() => {
      if (this.pendingInboundAudio.length > 0) {
        this.ensureCaptureLoop();
      }
    });
  }

  private ensurePlaybackLoop(): void {
    if (this.playbackTicker?.isActive()) {
      return;
    }
    this.playbackTicker = createRepeatingWorkerTicker(async () => {
      const snapshot = this.getPlaybackRenderSnapshot();
      const frameBytes = this.playbackFrameBytes;
      let outboundFrame = this.mixer.mixFrame(snapshot, frameBytes, this.ensurePlaybackScratch(frameBytes));
      let outboundBytes = outboundFrame ? frameBytes : 0;
      const bridgeFrame = outboundFrame
        ? this.mixPendingBridgePlaybackIntoPlaybackFrame(outboundFrame, frameBytes, snapshot.bridgeEffectiveGain)
        : this.takePendingBridgePlaybackFrame(frameBytes);
      if (bridgeFrame && !outboundFrame) {
        outboundFrame = bridgeFrame.pcm;
        outboundBytes = bridgeFrame.bytes;
      }
      if (outboundFrame && outboundBytes > 0) {
        this.enqueueRecordingOutbound({
          pcm: outboundFrame,
          bytes: outboundBytes,
          sampleRate: this.playbackSampleRate,
          channels: this.playbackChannels,
        });
        let sendOk = false;
        try {
          sendOk = await this.transport.sendPlaybackPcm(outboundFrame, this.playbackMarkerPending, outboundBytes);
        } catch (error) {
          if (bridgeFrame) {
            this.finalizeBridgeRenderFrame(bridgeFrame, false);
          }
          throw error;
        }
        if (bridgeFrame) {
          this.finalizeBridgeRenderFrame(bridgeFrame, sendOk);
        }
        this.playbackMarkerPending = false;
      } else if (bridgeFrame) {
        this.finalizeBridgeRenderFrame(bridgeFrame, false);
      }
      for (const mediaId of this.mixer.takeFinishedSources(snapshot)) {
        emitLegEvent(this.onPlaybackFinished, this.legId, mediaId);
      }
      return Boolean(
        this.pendingBridgePlayback.length > 0
        || (snapshot.activePlaybackMediaIds.length && this.mixer.hasRemainingAudio(snapshot)),
      );
    }, 20, this.legId);
  }

  getPlaybackFormat(): { sampleRate: number; channels: number; frameBytes: number } {
    return {
      sampleRate: this.playbackSampleRate,
      channels: this.playbackChannels,
      frameBytes: this.playbackFrameBytes,
    };
  }

  private ensurePlaybackScratch(frameBytes: number): Buffer {
    if (this.playbackScratch.length < frameBytes) {
      this.playbackScratch = Buffer.allocUnsafe(frameBytes);
    }
    return this.playbackScratch;
  }

  private ensureBridgePlaybackScratch(frameBytes: number): Buffer {
    if (this.bridgePlaybackScratch.length < frameBytes) {
      this.bridgePlaybackScratch = Buffer.allocUnsafe(frameBytes);
    }
    return this.bridgePlaybackScratch;
  }

  private getPlaybackRenderSnapshot(): PlaybackRenderSnapshot {
    if (!this.playbackRenderSnapshotDirty && this.playbackRenderSnapshot) {
      return this.playbackRenderSnapshot;
    }
    const ordered = Array.from(this.playbacks.values()).sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }
      return right.startedAt - left.startedAt;
    });
    this.playbackRenderSnapshot = {
      activePlaybackMediaIds: ordered.map((playback) => playback.mediaId),
      playbackMix: buildPlaybackRenderMix(ordered),
      bridgeEffectiveGain: buildBridgeRenderGain(ordered),
    };
    this.playbackRenderSnapshotDirty = false;
    return this.playbackRenderSnapshot;
  }

  private refreshPlaybackFormat(details?: MediaTransportDetails | null): void {
    let sampleRate = DEFAULT_PCM_SAMPLE_RATE;
    let channels = DEFAULT_PCM_CHANNELS;
    const resolvedDetails = details || this.transport.getDetails();
    if (this.transportType === "sip" && this.transport instanceof RtpTransport) {
      const audioPayloadType = Number(resolvedDetails.audioPayloadType);
      const payloadCodecs = resolvedDetails.payloadCodecs && typeof resolvedDetails.payloadCodecs === "object"
        ? resolvedDetails.payloadCodecs as Record<number, NegotiatedPayloadCodec>
        : {};
      const descriptor = resolveAudioCodecForPayloadType(audioPayloadType, payloadCodecs);
      if (descriptor) {
        sampleRate = Math.max(1, Number(descriptor.pcmSampleRate || DEFAULT_PCM_SAMPLE_RATE));
        channels = Math.max(1, Number(descriptor.channels || DEFAULT_PCM_CHANNELS));
      }
    }
    if (this.transportType === "websocket" && this.transport instanceof WebSocketTransport) {
      sampleRate = Math.max(1, Number(resolvedDetails.websocketAudioInputSampleRate || DEFAULT_PCM_SAMPLE_RATE));
      channels = 1;
    }
    const sampleRateChanged = sampleRate !== this.playbackSampleRate;
    this.playbackSampleRate = sampleRate;
    this.playbackChannels = channels;
    this.playbackFrameBytes = Math.max(2, Math.round((sampleRate / 50) * channels) * 2);
    if (this.playbackScratch.length < this.playbackFrameBytes) {
      this.playbackScratch = Buffer.allocUnsafe(this.playbackFrameBytes);
    }
    if (sampleRateChanged) {
      this.mixer.reconfigureToneSources(sampleRate);
    }
  }

  private takePendingBridgePlaybackFrame(frameBytes: number): BridgeRenderFrame | null {
    if (frameBytes <= 0) {
      return null;
    }
    const head = this.pendingBridgePlayback.peek() || null;
    if (!head) {
      return null;
    }
    const headOffset = Math.max(0, Math.min(Number(head.offsetBytes || 0), Number(head.bytes || 0)));
    const headRemaining = Math.max(0, Number(head.bytes || 0) - headOffset);
    if (headRemaining > 0 && (headRemaining >= frameBytes || this.pendingBridgePlayback.length === 1)) {
      const directBytes = Math.min(frameBytes, headRemaining);
      const directPcm = head.pcm.subarray(headOffset, headOffset + directBytes);
      head.offsetBytes = headOffset + directBytes;
      const consumed: PendingBridgePlaybackFrame[] = [];
      if (Number(head.offsetBytes || 0) >= Number(head.bytes || 0)) {
        const exhausted = this.pendingBridgePlayback.shift() || null;
        if (exhausted) {
          consumed.push(exhausted);
        }
      }
      return {
        pcm: directPcm,
        bytes: directBytes,
        touched: [head],
        consumed,
      };
    }
    const output = this.ensureBridgePlaybackScratch(frameBytes);
    let bytesWritten = 0;
    const touched: PendingBridgePlaybackFrame[] = [];
    const consumed: PendingBridgePlaybackFrame[] = [];
    let lastTouched: PendingBridgePlaybackFrame | null = null;
    while (bytesWritten < frameBytes) {
      const current = this.pendingBridgePlayback.peek() || null;
      if (!current) {
        break;
      }
      if (current !== lastTouched) {
        touched.push(current);
        lastTouched = current;
      }
      const offsetBytes = Math.max(0, Math.min(Number(current.offsetBytes || 0), Number(current.bytes || 0)));
      const remainingCurrent = Math.max(0, Number(current.bytes || 0) - offsetBytes);
      if (remainingCurrent <= 0) {
        const exhausted = this.pendingBridgePlayback.shift() || null;
        if (exhausted) {
          consumed.push(exhausted);
        }
        continue;
      }
      const copyBytes = Math.min(frameBytes - bytesWritten, remainingCurrent);
      current.pcm.copy(output, bytesWritten, offsetBytes, offsetBytes + copyBytes);
      bytesWritten += copyBytes;
      current.offsetBytes = offsetBytes + copyBytes;
      if (Number(current.offsetBytes || 0) >= Number(current.bytes || 0)) {
        const exhausted = this.pendingBridgePlayback.shift() || null;
        if (exhausted) {
          consumed.push(exhausted);
        }
      }
    }
    if (bytesWritten <= 0) {
      return null;
    }
    return {
      pcm: output,
      bytes: bytesWritten,
      touched,
      consumed,
    };
  }

  private mixPendingBridgePlaybackIntoPlaybackFrame(target: Buffer, frameBytes: number, gain: number): BridgeRenderFrame | null {
    if (frameBytes <= 0 || this.pendingBridgePlayback.length <= 0) {
      return null;
    }
    let bytesMixed = 0;
    const touched: PendingBridgePlaybackFrame[] = [];
    const consumed: PendingBridgePlaybackFrame[] = [];
    let lastTouched: PendingBridgePlaybackFrame | null = null;
    while (bytesMixed < frameBytes) {
      const current = this.pendingBridgePlayback.peek() || null;
      if (!current) {
        break;
      }
      if (current !== lastTouched) {
        touched.push(current);
        lastTouched = current;
      }
      const offsetBytes = Math.max(0, Math.min(Number(current.offsetBytes || 0), Number(current.bytes || 0)));
      const remainingCurrent = Math.max(0, Number(current.bytes || 0) - offsetBytes);
      if (remainingCurrent <= 0) {
        const exhausted = this.pendingBridgePlayback.shift() || null;
        if (exhausted) {
          consumed.push(exhausted);
        }
        continue;
      }
      const copyBytes = Math.min(frameBytes - bytesMixed, remainingCurrent);
      this.mixBridgeFrameIntoPlaybackFrame(target, current.pcm, copyBytes, offsetBytes, bytesMixed, gain);
      bytesMixed += copyBytes;
      current.offsetBytes = offsetBytes + copyBytes;
      if (Number(current.offsetBytes || 0) >= Number(current.bytes || 0)) {
        const exhausted = this.pendingBridgePlayback.shift() || null;
        if (exhausted) {
          consumed.push(exhausted);
        }
      }
    }
    if (bytesMixed <= 0) {
      return null;
    }
    return {
      pcm: target,
      bytes: Math.max(0, Math.min(bytesMixed, frameBytes, target.length)),
      touched,
      consumed,
    };
  }

  private finalizeBridgeRenderFrame(frame: BridgeRenderFrame, sendOk: boolean): void {
    for (const item of frame.touched) {
      item.renderOk = item.renderOk && sendOk;
    }
    for (const item of frame.consumed) {
      this.settlePendingBridgePlayback(item, item.renderOk);
    }
  }

  private settlePendingBridgePlayback(frame: PendingBridgePlaybackFrame, result: boolean): void {
    if (frame.settled) {
      return;
    }
    frame.settled = true;
    frame.releasePool?.release(frame.pcm);
    frame.resolve(result);
  }

  private mixBridgeFrameIntoPlaybackFrame(
    target: Buffer,
    bridgePcm: Buffer,
    bridgeBytes: number,
    bridgeOffsetBytes = 0,
    targetOffsetBytes = 0,
    gain = 1,
  ): void {
    const normalizedGain = Number.isFinite(gain) ? Math.max(0, gain) : 1;
    const normalizedBridgeOffset = Math.max(0, Math.min(Number(bridgeOffsetBytes || 0), bridgePcm.length));
    const normalizedTargetOffset = Math.max(0, Math.min(Number(targetOffsetBytes || 0), target.length));
    const bytesToMix = Math.max(
      0,
      Math.min(
        Number(bridgeBytes || 0),
        target.length - normalizedTargetOffset,
        bridgePcm.length - normalizedBridgeOffset,
      ),
    );
    const mixBytes = bytesToMix - (bytesToMix % 2);
    if (mixBytes <= 0) {
      return;
    }
    if (normalizedGain === 0) {
      return;
    }
    const sampleCount = mixBytes >> 1;
    const targetView = toPcm16View(target, normalizedTargetOffset, sampleCount);
    const sourceView = toPcm16View(bridgePcm, normalizedBridgeOffset, sampleCount);
    if (targetView && sourceView) {
      if (normalizedGain === 1) {
        for (let index = 0; index < sampleCount; index += 1) {
          const mixed = targetView[index] + sourceView[index];
          targetView[index] = mixed < -32768 ? -32768
            : mixed > 32767 ? 32767
            : mixed | 0;
        }
        return;
      }
      // Hot path (50 mix ops/sec/leg): keep the inner loop body inline so V8
      // doesn't dispatch into clampPcm16 per sample.
      for (let index = 0; index < sampleCount; index += 1) {
        const mixed = targetView[index] + sourceView[index] * normalizedGain;
        targetView[index] = mixed < -32768 ? -32768
          : mixed > 32767 ? 32767
          : mixed | 0;
      }
      return;
    }
    for (let offset = 0; offset < mixBytes; offset += 2) {
      const targetReadOffset = normalizedTargetOffset + offset;
      const sourceReadOffset = normalizedBridgeOffset + offset;
      const mixed = target.readInt16LE(targetReadOffset) + bridgePcm.readInt16LE(sourceReadOffset) * normalizedGain;
      target.writeInt16LE(mixed < -32768 ? -32768 : mixed > 32767 ? 32767 : mixed | 0, targetReadOffset);
    }
  }

  private ensureCaptureLoop(): void {
    if (this.captureTicker?.isActive()) {
      return;
    }
    this.captureTicker = createRepeatingWorkerTicker(async () => {
      for (;;) {
        const frame = this.pendingInboundAudio.shift();
        if (!frame) {
          break;
        }
        try {
          emitLegEvent(this.onVoiceActivity, this.legId, frame.level, frame.durationMs);
          if (this.onInboundPcm) {
            await this.onInboundPcm(this.legId, frame.pcm, frame.bytes, frame.sampleRate, frame.channels);
          }
          if (this.globalRecording && !this.globalRecording.paused) {
            this.maybeInterruptRecordingOnSilence(this.globalRecording, frame);
            this.enqueueRecordingInbound(frame);
          }
        } finally {
          frame.releasePool?.release(frame.pcm);
        }
      }
      return this.pendingInboundAudio.length > 0;
    }, 20, this.legId);
  }

  private enqueueRecordingInbound(frame: RecordingAudioFrame): void {
    this.enqueueRecordingFrame(this.pendingRecordingInbound, frame, "inbound");
  }

  private enqueueRecordingOutbound(frame: RecordingAudioFrame): void {
    this.enqueueRecordingFrame(this.pendingRecordingOutbound, frame, "outbound");
  }

  private enqueueRecordingFrame(queue: FrameQueue<RecordingAudioFrame>, frame: RecordingAudioFrame, role: RecordingQueueRole): void {
    if (!this.globalRecording || this.globalRecording.paused || this.recordingClosing || !frame.bytes) {
      return;
    }
    const owned = this.normalizeGlobalRecordingFrame(frame, role);
    if (!owned) {
      return;
    }
    queue.push(owned);
    this.adjustRecordingQueueSamples(role, getMonoSampleCount(owned));
    this.ensureRecordingLoop();
  }

  private ensureRecordingLoop(): void {
    if (this.recordingClosing || this.recordingTicker?.isActive()) {
      return;
    }
    this.recordingTicker = createRepeatingWorkerTicker(() => {
      const mediaRecording = this.mediaRecording;
      const globalRecording = this.globalRecording;
      const hasMediaSilenceWatch = Boolean(
        mediaRecording && !mediaRecording.paused && mediaRecording.interruptOnSilence && !mediaRecording.silenceInterrupted,
      );
      const hasGlobalRecording = Boolean(globalRecording && !globalRecording.paused);
      if (!hasMediaSilenceWatch && !hasGlobalRecording) {
        this.clearRecordingQueues();
        return false;
      }
      if (hasMediaSilenceWatch && mediaRecording) {
        this.maybeInterruptRecordingOnSilenceTimeout(mediaRecording);
      }
      if (hasGlobalRecording && globalRecording) {
        this.maybeInterruptRecordingOnSilenceTimeout(globalRecording);
        this.flushRecordingQueues(undefined, 1);
      }
      return (
        Boolean(mediaRecording && !mediaRecording.paused && mediaRecording.interruptOnSilence && !mediaRecording.silenceInterrupted)
        || this.pendingRecordingInbound.length > 0
        || this.pendingRecordingOutbound.length > 0
        || Boolean(globalRecording && !globalRecording.paused && globalRecording.interruptOnSilence && !globalRecording.silenceInterrupted)
      );
    }, 20, this.legId, { immediate: false });
  }

  private copyRecordingFrame(frame: RecordingAudioFrame): RecordingAudioFrame | null {
    const frameOffset = Math.max(0, Math.min(Number(frame.offsetBytes || 0), Math.max(0, Number(frame.bytes) || 0)));
    const bytes = Math.max(0, Math.min((Number(frame.bytes) || 0) - frameOffset, frame.pcm.length - frameOffset));
    if (!bytes) {
      return null;
    }
    const owned = this.recordingFramePool.acquire(bytes);
    if (!owned.length) {
      return null;
    }
    frame.pcm.copy(owned, 0, frameOffset, frameOffset + bytes);
    return {
      pcm: owned,
      bytes,
      sampleRate: Number(frame.sampleRate || DEFAULT_PCM_SAMPLE_RATE),
      channels: Math.max(1, Number(frame.channels || DEFAULT_PCM_CHANNELS)),
      offsetBytes: 0,
      releasePool: this.recordingFramePool,
    };
  }

  /**
   * Fan out an inbound recording frame to additional consumers without
   * copying. When the source buffer is owned by our refcounted
   * recordingFramePool and starts at offset 0, we just retain the same buffer
   * and return a fresh frame metadata pointing at it. Falls back to
   * copyRecordingFrame when sharing isn't viable (partial-frame offsets,
   * foreign pools, etc).
   */
  private shareRecordingFrame(frame: RecordingAudioFrame): RecordingAudioFrame | null {
    const frameOffset = Math.max(0, Math.min(Number(frame.offsetBytes || 0), Math.max(0, Number(frame.bytes) || 0)));
    if (frameOffset > 0) {
      return this.copyRecordingFrame(frame);
    }
    const bytes = Math.max(0, Math.min(Number(frame.bytes) || 0, frame.pcm.length));
    if (!bytes || frame.releasePool !== this.recordingFramePool) {
      return this.copyRecordingFrame(frame);
    }
    this.recordingFramePool.retain(frame.pcm);
    return {
      pcm: frame.pcm,
      bytes,
      sampleRate: Number(frame.sampleRate || DEFAULT_PCM_SAMPLE_RATE),
      channels: Math.max(1, Number(frame.channels || DEFAULT_PCM_CHANNELS)),
      offsetBytes: 0,
      releasePool: this.recordingFramePool,
    };
  }

  private transferRecordingFrame(frame: RecordingAudioFrame): RecordingAudioFrame | null {
    const frameOffset = Math.max(0, Math.min(Number(frame.offsetBytes || 0), Math.max(0, Number(frame.bytes) || 0)));
    const bytes = Math.max(0, Math.min((Number(frame.bytes) || 0) - frameOffset, frame.pcm.length - frameOffset));
    const releasePool = frame.releasePool || null;
    if (!releasePool || !bytes || frameOffset !== 0) {
      return null;
    }
    // Pool buffers may be over-allocated (e.g. RtpTransport decoded into a
    // 2 KB scratch but only used 320 B). Consumers respect `bytes`, so we can
    // hand the buffer off without trimming it down to exact size.
    frame.releasePool = null;
    frame.offsetBytes = 0;
    frame.bytes = bytes;
    return frame;
  }

  private normalizeGlobalRecordingFrame(frame: RecordingAudioFrame, role: RecordingQueueRole): RecordingAudioFrame | null {
    const recording = this.globalRecording;
    if (!recording) {
      return null;
    }
    const inputSampleRate = Math.max(1, Number(frame.sampleRate || DEFAULT_PCM_SAMPLE_RATE));
    const inputChannels = Math.max(1, Number(frame.channels || DEFAULT_PCM_CHANNELS));
    const targetSampleRate = Math.max(1, Number(recording.queueSampleRate || DEFAULT_PCM_SAMPLE_RATE));
    const targetChannels = 1;
    const inputOffset = Math.max(0, Math.min(Number(frame.offsetBytes || 0), Math.max(0, Number(frame.bytes) || 0)));
    const inputBytes = Math.max(0, Math.min((Number(frame.bytes) || 0) - inputOffset, frame.pcm.length - inputOffset));
    if (!inputBytes) {
      return null;
    }
    if (inputSampleRate === targetSampleRate && inputChannels === targetChannels) {
      return this.transferRecordingFrame(frame) || this.copyRecordingFrame({
        ...frame,
        bytes: inputOffset + inputBytes,
        offsetBytes: inputOffset,
      });
    }
    const converter = this.getRecordingPcmConverter(role, inputSampleRate, inputChannels, targetSampleRate, targetChannels);
    let scratchBytes = Math.max(
      2,
      estimateConvertedPcm16Bytes(inputBytes, inputSampleRate, inputChannels, targetSampleRate, targetChannels),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const owned = this.recordingFramePool.acquire(scratchBytes);
      if (!owned.length) {
        return null;
      }
      try {
        const convertedBytes = convertPcm16(converter, frame.pcm, inputOffset, inputBytes, owned, 0);
        if (!convertedBytes) {
          this.recordingFramePool.release(owned);
          return null;
        }
        return {
          pcm: owned,
          bytes: convertedBytes,
          sampleRate: targetSampleRate,
          channels: targetChannels,
          offsetBytes: 0,
          releasePool: this.recordingFramePool,
        };
      } catch (error) {
        this.recordingFramePool.release(owned);
        if (!isPcmTargetBufferTooSmallError(error) || attempt >= 2) {
          throw error;
        }
        scratchBytes = Math.max(scratchBytes * 2, 4096);
      }
    }
    return null;
  }

  private retainPreRollFrame(frame: RecordingAudioFrame & { durationMs: number }): void {
    // Pre-roll ring is read-only — sharing the same pool buffer is safe.
    const owned = this.shareRecordingFrame(frame);
    if (!owned) {
      return;
    }
    this.recordingPreRollInbound.push({
      ...owned,
      durationMs: Math.max(1, Number(frame.durationMs || 0)),
    });
  }

  private emitRetainedRecordingFrame(mediaId: string, frame: RetainedRecordingAudioFrame): void {
    // Recording emitters forward PCM to the recording encoder via the
    // onRecordingPcm callback. Encoders consume read-only, so we can share
    // the source buffer instead of copying.
    const owned = this.shareRecordingFrame(frame);
    if (!owned) {
      return;
    }
    if (this.onRecordingPcm) {
      emitLegEvent(
        this.onRecordingPcm,
        this.legId,
        mediaId,
        owned.pcm,
        owned.bytes,
        owned.sampleRate,
        owned.channels,
        owned.releasePool,
      );
      return;
    }
    owned.releasePool?.release(owned.pcm);
  }

  private maybeInterruptRecordingOnSilence(recording: RecordingRegistration, frame: PendingInboundAudio): void {
    if (!recording || recording.paused || !recording.interruptOnSilence || recording.silenceInterrupted) {
      return;
    }
    if (frame.level > recording.silenceThreshold) {
      recording.silenceLastActiveAtMs = getMonotonicTickMs();
      recording.silenceActiveDurationMs = 0;
      return;
    }
    const now = getMonotonicTickMs();
    recording.silenceActiveDurationMs = Math.max(0, now - recording.silenceLastActiveAtMs);
    if (recording.silenceActiveDurationMs >= Math.max(0, recording.silenceDurationMs)) {
      recording.silenceInterrupted = true;
      emitLegEvent(this.onRecordingInterrupt, this.legId, recording.mediaId, "media_silence", {
        silenceLevel: frame.level,
        silenceDurationMs: recording.silenceActiveDurationMs,
        silenceThreshold: recording.silenceThreshold,
      });
    }
  }

  private maybeInterruptRecordingOnSilenceTimeout(recording: RecordingRegistration): void {
    if (!recording || recording.paused || !recording.interruptOnSilence || recording.silenceInterrupted) {
      return;
    }
    const now = getMonotonicTickMs();
    recording.silenceActiveDurationMs = Math.max(0, now - recording.silenceLastActiveAtMs);
    if (recording.silenceActiveDurationMs < Math.max(0, recording.silenceDurationMs)) {
      return;
    }
    recording.silenceInterrupted = true;
    emitLegEvent(this.onRecordingInterrupt, this.legId, recording.mediaId, "media_silence", {
      silenceLevel: 0,
      silenceDurationMs: recording.silenceActiveDurationMs,
      silenceThreshold: recording.silenceThreshold,
    });
  }

  private flushRecordingQueues(splitChannelsOverride?: boolean, maxFrames = Number.POSITIVE_INFINITY): void {
    const splitChannels = typeof splitChannelsOverride === "boolean"
      ? splitChannelsOverride
      : Boolean(this.globalRecording?.splitChannels);
    if (!this.globalRecording && !this.recordingClosing) {
      return;
    }
    const frameLimit = Math.max(1, Math.floor(Number(maxFrames) || 1));
    let emittedFrames = 0;
    for (;;) {
      this.releaseConsumedRecordingHead(this.pendingRecordingInbound, "inbound");
      this.releaseConsumedRecordingHead(this.pendingRecordingOutbound, "outbound");
      const inbound = this.pendingRecordingInbound.peek() || null;
      const outbound = this.pendingRecordingOutbound.peek() || null;
      if (!inbound && !outbound) {
        break;
      }
      const sampleRate = Number(inbound?.sampleRate || outbound?.sampleRate || DEFAULT_PCM_SAMPLE_RATE);
      const frameTargetSamples = Math.max(1, Math.round(sampleRate / 50));
      const inboundSamples = this.pendingRecordingInboundSamples;
      const outboundSamples = this.pendingRecordingOutboundSamples;
      // For split-channel recording we used to wait until BOTH sides had
      // samples queued. That broke real-time sync as soon as one side went
      // silent (e.g. SIP↔WS bridge where the WS peer only emits audio when
      // speaking): the active side accumulated multi-second backlogs that
      // we then stitched against fresh frames from the silent side once it
      // resumed. Now we always emit one full target frame per tick — the
      // writer's slow path zero-pads whichever side is short, keeping both
      // channels aligned at real time even when one is silent.
      const sampleCount = splitChannels
        ? frameTargetSamples
        : inboundSamples > 0 && outboundSamples > 0
          ? Math.min(frameTargetSamples, inboundSamples, outboundSamples)
          : Math.min(frameTargetSamples, Math.max(inboundSamples, outboundSamples));
      if (sampleCount <= 0) {
        continue;
      }
      if (!splitChannels && (inboundSamples <= 0 || outboundSamples <= 0)) {
        const role: RecordingQueueRole = inboundSamples > 0 ? "inbound" : "outbound";
        const directFrame = this.pullRecordingMonoChunk(
          role === "inbound" ? this.pendingRecordingInbound : this.pendingRecordingOutbound,
          role,
          sampleCount,
          sampleRate,
        );
        if (directFrame) {
          if (this.onRecordingPcm) {
            emitLegEvent(
              this.onRecordingPcm,
              this.legId,
              this.globalRecording?.mediaId || "",
              directFrame.pcm,
              directFrame.bytes,
              directFrame.sampleRate,
              directFrame.channels,
              directFrame.releasePool,
            );
          } else {
            directFrame.releasePool?.release(directFrame.pcm);
          }
          emittedFrames += 1;
          if (emittedFrames >= frameLimit) {
            break;
          }
          continue;
        }
      }
      const frameBytes = sampleCount * (splitChannels ? 4 : 2);
      const output = this.recordingFramePool.acquire(frameBytes);
      if (!output.length) {
        continue;
      }
      let bytesWritten = 0;
      if (splitChannels) {
        this.writeSplitRecordingFrame(output, sampleCount);
        bytesWritten = frameBytes;
      } else {
        this.writeMonoMixedRecordingFrame(output, sampleCount, sampleRate);
        bytesWritten = frameBytes;
      }
      if (this.onRecordingPcm) {
        emitLegEvent(
          this.onRecordingPcm,
          this.legId,
          this.globalRecording?.mediaId || "",
          output,
          bytesWritten,
          sampleRate,
          splitChannels ? 2 : 1,
          this.recordingFramePool,
        );
      } else {
        this.recordingFramePool.release(output);
      }
      emittedFrames += 1;
      if (emittedFrames >= frameLimit) {
        break;
      }
    }
  }

  private clearRecordingQueues(): void {
    while (this.pendingRecordingInbound.length > 0) {
      const inbound = this.pendingRecordingInbound.shift() || null;
      inbound?.releasePool?.release(inbound.pcm);
    }
    this.pendingRecordingInboundSamples = 0;
    while (this.pendingRecordingOutbound.length > 0) {
      const outbound = this.pendingRecordingOutbound.shift() || null;
      outbound?.releasePool?.release(outbound.pcm);
    }
    this.pendingRecordingOutboundSamples = 0;
  }

  private closeRecordingPcmConverters(): void {
    for (const converter of this.recordingPcmConverters.values()) {
      try {
        converter.close();
      } catch (error) {
        console.error(
          `[sip-pbx:media-worker] leg recording converter close failed; leg=${this.legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
        );
      }
    }
    this.recordingPcmConverters.clear();
  }

  private getBridgePcmConverter(
    inputSampleRate: number,
    inputChannels: number,
    outputSampleRate: number,
    outputChannels: number,
  ): Pcm16Converter {
    const key = `${Math.max(1, inputSampleRate)}:${Math.max(1, inputChannels)}->${Math.max(1, outputSampleRate)}:${Math.max(1, outputChannels)}`;
    const existing = this.bridgePcmConverters.get(key) || null;
    if (existing) {
      return existing;
    }
    const created = createPcm16Converter(inputSampleRate, inputChannels, outputSampleRate, outputChannels);
    this.bridgePcmConverters.set(key, created);
    return created;
  }

  private getRecordingPcmConverter(
    role: RecordingQueueRole,
    inputSampleRate: number,
    inputChannels: number,
    outputSampleRate: number,
    outputChannels: number,
  ): Pcm16Converter {
    const key = `${role}:${Math.max(1, inputSampleRate)}:${Math.max(1, inputChannels)}->${Math.max(1, outputSampleRate)}:${Math.max(1, outputChannels)}`;
    const existing = this.recordingPcmConverters.get(key) || null;
    if (existing) {
      return existing;
    }
    const created = createPcm16Converter(inputSampleRate, inputChannels, outputSampleRate, outputChannels);
    this.recordingPcmConverters.set(key, created);
    return created;
  }

  private adjustRecordingQueueSamples(role: RecordingQueueRole, deltaSamples: number): void {
    if (!deltaSamples) {
      return;
    }
    if (role === "inbound") {
      this.pendingRecordingInboundSamples = Math.max(0, this.pendingRecordingInboundSamples + deltaSamples);
      return;
    }
    this.pendingRecordingOutboundSamples = Math.max(0, this.pendingRecordingOutboundSamples + deltaSamples);
  }

  private releaseConsumedRecordingHead(queue: FrameQueue<RecordingAudioFrame>, role: RecordingQueueRole): void {
    while (queue.peek() && isRecordingFrameConsumed(queue.peek() || null)) {
      const exhausted = queue.shift() || null;
      exhausted?.releasePool?.release(exhausted.pcm);
    }
    if (!queue.peek()) {
      this.setRecordingQueueSamples(role, 0);
    }
  }

  private setRecordingQueueSamples(role: RecordingQueueRole, samples: number): void {
    if (role === "inbound") {
      this.pendingRecordingInboundSamples = Math.max(0, samples);
      return;
    }
    this.pendingRecordingOutboundSamples = Math.max(0, samples);
  }

  private pullRecordingSample(queue: FrameQueue<RecordingAudioFrame>, role: RecordingQueueRole): number {
    for (;;) {
      const frame = queue.peek() || null;
      if (!frame) {
        this.setRecordingQueueSamples(role, 0);
        return 0;
      }
      if (isRecordingFrameConsumed(frame)) {
        const exhausted = queue.shift() || null;
        exhausted?.releasePool?.release(exhausted.pcm);
        if (!queue.peek()) {
          this.setRecordingQueueSamples(role, 0);
        }
        continue;
      }
      const sample = readMonoSample(frame, 0);
      consumeRecordingFrameSamples(frame, 1);
      this.adjustRecordingQueueSamples(role, -1);
      if (isRecordingFrameConsumed(frame)) {
        const exhausted = queue.shift() || null;
        exhausted?.releasePool?.release(exhausted.pcm);
      }
      return sample;
    }
  }

  private pullRecordingMonoChunk(
    queue: FrameQueue<RecordingAudioFrame>,
    role: RecordingQueueRole,
    sampleCount: number,
    sampleRate: number,
  ): RecordingAudioFrame | null {
    const bytesNeeded = Math.max(0, sampleCount) * 2;
    if (!bytesNeeded) {
      return null;
    }
    const head = queue.peek() || null;
    if (!head) {
      this.setRecordingQueueSamples(role, 0);
      return null;
    }
    const headOffset = Math.max(0, Math.min(Number(head.offsetBytes || 0), Math.max(0, Number(head.bytes) || 0)));
    const headBytes = Math.max(0, Math.min((Number(head.bytes) || 0) - headOffset, head.pcm.length - headOffset));
    if (headBytes >= bytesNeeded && headOffset === 0 && bytesNeeded === headBytes && head.releasePool) {
      const detached = queue.shift() || null;
      if (!detached) {
        this.setRecordingQueueSamples(role, 0);
        return null;
      }
      this.adjustRecordingQueueSamples(role, -sampleCount);
      detached.offsetBytes = 0;
      detached.bytes = bytesNeeded;
      const nextHead = queue.peek() || null;
      if (!nextHead) {
        this.setRecordingQueueSamples(role, 0);
      }
      return detached;
    }
    const output = this.recordingFramePool.acquire(bytesNeeded);
    if (!output.length) {
      return null;
    }
    let bytesWritten = 0;
    while (bytesWritten < bytesNeeded) {
      this.releaseConsumedRecordingHead(queue, role);
      const frame = queue.peek() || null;
      if (!frame) {
        break;
      }
      const frameOffset = Math.max(0, Math.min(Number(frame.offsetBytes || 0), Math.max(0, Number(frame.bytes) || 0)));
      const frameBytes = Math.max(0, Math.min((Number(frame.bytes) || 0) - frameOffset, frame.pcm.length - frameOffset));
      if (!frameBytes) {
        continue;
      }
      const copyBytes = Math.min(frameBytes, bytesNeeded - bytesWritten);
      frame.pcm.copy(output, bytesWritten, frameOffset, frameOffset + copyBytes);
      bytesWritten += copyBytes;
      const consumedSamples = Math.floor(copyBytes / 2);
      consumeRecordingFrameSamples(frame, consumedSamples);
      this.adjustRecordingQueueSamples(role, -consumedSamples);
      if (isRecordingFrameConsumed(frame)) {
        const exhausted = queue.shift() || null;
        exhausted?.releasePool?.release(exhausted.pcm);
      }
    }
    if (bytesWritten !== bytesNeeded) {
      this.recordingFramePool.release(output);
      return null;
    }
    return {
      pcm: output,
      bytes: bytesWritten,
      sampleRate,
      channels: 1,
      offsetBytes: 0,
      releasePool: this.recordingFramePool,
    };
  }

  private writeSplitRecordingFrame(output: Buffer, sampleCount: number): void {
    const inbound = this.pendingRecordingInbound.peek() || null;
    const outbound = this.pendingRecordingOutbound.peek() || null;
    const inboundReady = this.canFastInterleaveRecordingFrame(inbound, sampleCount);
    const outboundReady = this.canFastInterleaveRecordingFrame(outbound, sampleCount);
    if (inboundReady && outboundReady) {
      const outputView = toPcm16View(output, 0, sampleCount * 2);
      const inboundView = toPcm16View(inbound!.pcm, Number(inbound!.offsetBytes || 0), sampleCount);
      const outboundView = toPcm16View(outbound!.pcm, Number(outbound!.offsetBytes || 0), sampleCount);
      if (outputView && inboundView && outboundView) {
        for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
          const targetOffset = sampleIndex * 2;
          outputView[targetOffset] = inboundView[sampleIndex];
          outputView[targetOffset + 1] = outboundView[sampleIndex];
        }
        consumeRecordingFrameSamples(inbound, sampleCount);
        consumeRecordingFrameSamples(outbound, sampleCount);
        this.adjustRecordingQueueSamples("inbound", -sampleCount);
        this.adjustRecordingQueueSamples("outbound", -sampleCount);
        if (isRecordingFrameConsumed(inbound)) {
          const exhausted = this.pendingRecordingInbound.shift() || null;
          exhausted?.releasePool?.release(exhausted.pcm);
        }
        if (isRecordingFrameConsumed(outbound)) {
          const exhausted = this.pendingRecordingOutbound.shift() || null;
          exhausted?.releasePool?.release(exhausted.pcm);
        }
        return;
      }
    }
    // Slow path: queues are misaligned or output view is unavailable. Drain
    // up to `sampleCount` mono samples from each side via typed arrays and
    // interleave; missing samples are left as zeros (caller's buffer is reset
    // below).
    const outputView = toPcm16View(output, 0, sampleCount * 2);
    if (!outputView) {
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        output.writeInt16LE(this.pullRecordingSample(this.pendingRecordingInbound, "inbound"), sampleIndex * 4);
        output.writeInt16LE(this.pullRecordingSample(this.pendingRecordingOutbound, "outbound"), sampleIndex * 4 + 2);
      }
      return;
    }
    const inboundView = this.scratchMonoView(sampleCount, "inbound");
    const outboundView = this.scratchMonoView(sampleCount, "outbound");
    const inboundCount = this.drainRecordingMonoSamplesInto(this.pendingRecordingInbound, "inbound", inboundView, sampleCount);
    const outboundCount = this.drainRecordingMonoSamplesInto(this.pendingRecordingOutbound, "outbound", outboundView, sampleCount);
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const targetOffset = sampleIndex * 2;
      outputView[targetOffset] = sampleIndex < inboundCount ? inboundView[sampleIndex] : 0;
      outputView[targetOffset + 1] = sampleIndex < outboundCount ? outboundView[sampleIndex] : 0;
    }
  }

  /**
   * Drain up to `sampleCount` mono samples from `queue` into `targetView`.
   * Returns the number of samples actually written; the rest of `targetView`
   * (up to `sampleCount`) is left untouched. Each frame is consumed in bulk
   * via `Buffer.copy` (single memcpy per source frame) rather than per-sample
   * `readInt16LE` calls — that is what made the previous slow path hot.
   */
  private drainRecordingMonoSamplesInto(
    queue: FrameQueue<RecordingAudioFrame>,
    role: RecordingQueueRole,
    targetView: Int16Array,
    sampleCount: number,
  ): number {
    let drained = 0;
    while (drained < sampleCount) {
      const frame = queue.peek() || null;
      if (!frame) {
        this.setRecordingQueueSamples(role, 0);
        break;
      }
      const channels = Math.max(1, Number(frame.channels || DEFAULT_PCM_CHANNELS));
      const frameOffset = Math.max(0, Math.min(Number(frame.offsetBytes || 0), Math.max(0, Number(frame.bytes) || 0)));
      const availableBytes = Math.max(0, (Number(frame.bytes) || 0) - frameOffset);
      const availableSamples = Math.floor(availableBytes / (channels * 2));
      if (availableSamples <= 0) {
        const exhausted = queue.shift() || null;
        exhausted?.releasePool?.release(exhausted.pcm);
        continue;
      }
      const take = Math.min(availableSamples, sampleCount - drained);
      if (channels === 1) {
        const sourceView = toPcm16View(frame.pcm, frameOffset, take);
        if (sourceView) {
          targetView.set(sourceView, drained);
        } else {
          for (let index = 0; index < take; index += 1) {
            targetView[drained + index] = frame.pcm.readInt16LE(frameOffset + index * 2);
          }
        }
      } else {
        // Multi-channel frames: downmix to mono by averaging channels.
        for (let index = 0; index < take; index += 1) {
          const baseOffset = frameOffset + index * channels * 2;
          let total = 0;
          for (let channel = 0; channel < channels; channel += 1) {
            total += frame.pcm.readInt16LE(baseOffset + channel * 2);
          }
          targetView[drained + index] = (total / channels) | 0;
        }
      }
      consumeRecordingFrameSamples(frame, take);
      this.adjustRecordingQueueSamples(role, -take);
      drained += take;
      if (isRecordingFrameConsumed(frame)) {
        const exhausted = queue.shift() || null;
        exhausted?.releasePool?.release(exhausted.pcm);
      }
    }
    return drained;
  }

  /**
   * Drain mono samples from inbound + outbound queues, sum-mix into `output`
   * via Int16Array views, and clamp. Used when at least one queue is not
   * frame-aligned for the fast Buffer.copy path in mixed-mono recording.
   */
  private writeMonoMixedRecordingFrame(output: Buffer, sampleCount: number, _sampleRate: number): void {
    const outputView = toPcm16View(output, 0, sampleCount);
    if (!outputView) {
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        const mixed = this.pullRecordingSample(this.pendingRecordingInbound, "inbound")
          + this.pullRecordingSample(this.pendingRecordingOutbound, "outbound");
        output.writeInt16LE(mixed < -32768 ? -32768 : mixed > 32767 ? 32767 : mixed | 0, sampleIndex * 2);
      }
      return;
    }
    const inboundView = this.scratchMonoView(sampleCount, "inbound");
    const outboundView = this.scratchMonoView(sampleCount, "outbound");
    const inboundCount = this.drainRecordingMonoSamplesInto(this.pendingRecordingInbound, "inbound", inboundView, sampleCount);
    const outboundCount = this.drainRecordingMonoSamplesInto(this.pendingRecordingOutbound, "outbound", outboundView, sampleCount);
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const left = sampleIndex < inboundCount ? inboundView[sampleIndex] : 0;
      const right = sampleIndex < outboundCount ? outboundView[sampleIndex] : 0;
      const mixed = left + right;
      outputView[sampleIndex] = mixed < -32768 ? -32768
        : mixed > 32767 ? 32767
        : mixed | 0;
    }
  }

  /**
   * Reuse one Int16Array per role across recording frames. The arrays grow
   * geometrically and are never freed for the lifetime of the leg.
   */
  private scratchMonoView(sampleCount: number, role: RecordingQueueRole): Int16Array {
    const cache = role === "inbound" ? "_inboundMonoScratch" : "_outboundMonoScratch";
    const current = (this as unknown as Record<string, Int16Array | undefined>)[cache];
    if (current && current.length >= sampleCount) {
      return current.subarray(0, sampleCount);
    }
    const grown = new Int16Array(Math.max(sampleCount, (current?.length || 0) * 2, 320));
    (this as unknown as Record<string, Int16Array>)[cache] = grown;
    return grown.subarray(0, sampleCount);
  }

  private canFastInterleaveRecordingFrame(frame: RecordingAudioFrame | null, sampleCount: number): boolean {
    if (!frame?.bytes) {
      return false;
    }
    if (Math.max(1, Number(frame.channels || DEFAULT_PCM_CHANNELS)) !== 1) {
      return false;
    }
    const offsetBytes = Math.max(0, Math.min(Number(frame.offsetBytes || 0), Math.max(0, Number(frame.bytes) || 0)));
    const frameBytes = Math.max(0, Math.min((Number(frame.bytes) || 0) - offsetBytes, frame.pcm.length - offsetBytes));
    return frameBytes >= sampleCount * 2;
  }
}

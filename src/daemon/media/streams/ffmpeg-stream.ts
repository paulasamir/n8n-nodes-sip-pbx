import * as path from "path";
import { OPTION_DEFAULTS } from "../../../shared/option-defaults";
import { daemonError } from "../../core/daemon-error";
import type {
  OwnedPcmChunk,
  MediaStream,
  MediaStreamDecodeInput,
  MediaStreamEncoder,
  MediaStreamEncodeInput,
  MediaStreamMode,
} from "./media-stream";

const SUPPORTED_DECODE_FORMATS = new Set(["wav", "mp3", "opus", "ogg", "flac", "m4a", "aac", "webm"]);
const SUPPORTED_ENCODE_FORMATS = new Set(["wav", "mp3", "opus", "ogg"]);
const STREAM_STALL_TIMEOUT_MS = 15000;

type NativeMediaStreamDecoder = {
  readFrom(buffer: Buffer, offset?: number, length?: number): number;
  writeInto(buffer: Buffer, offset?: number, length?: number): number;
  closeInput(): void;
  getSourceInfo(): { sampleRate?: number | null; channels?: number | null; detectedFormat?: string | null };
  close(): void;
};

type NativeMediaStreamEncoder = {
  readFrom(buffer: Buffer, offset?: number, length?: number): number;
  writeInto(buffer: Buffer, offset?: number, length?: number): number;
  takeOutputPatches(): Array<{ offset: number; data: Buffer }>;
  closeInput(): void;
  close(): void;
};

const EXPECTED_FFAUDIO_ABI_VERSION = 3;

type NativeFfAudioModule = {
  ffaudioAbiVersion: number;
  MediaStream: new (options?: Record<string, unknown>) => NativeMediaStreamDecoder & NativeMediaStreamEncoder;
};

class FrameBufferPool {
  private readonly free: Buffer[] = [];
  private closed = false;

  constructor(private readonly frameBytes: number, capacity: number) {
    const normalizedCapacity = Math.max(1, Math.floor(Number(capacity) || 1));
    for (let index = 0; index < normalizedCapacity; index += 1) {
      this.free.push(Buffer.allocUnsafe(this.frameBytes));
    }
  }

  acquire(): Buffer {
    if (this.closed) {
      return Buffer.alloc(0);
    }
    return this.free.pop() || Buffer.allocUnsafe(this.frameBytes);
  }

  release(buffer: Buffer): void {
    if (this.closed || !Buffer.isBuffer(buffer) || buffer.length !== this.frameBytes) {
      return;
    }
    this.free.push(buffer);
  }

  destroy(): void {
    this.closed = true;
    this.free.length = 0;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(daemonError("media_stream_stalled", errorMessage));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type StreamingEncodeSessionInput = {
  fileFormat: string;
  wavSampleRate?: number;
  wavBitDepth?: number;
  compressedSampleRate?: number;
  compressedBitrateKbps?: number;
  inputSampleRate: number;
  inputChannels: number;
};

type StreamingEncodeSessionFinalized = {
  mimeType: string;
};

type StreamingEncodeSession = {
  encodeInto(pcm: Buffer, bytes?: number, offset?: number): Promise<number>;
  drainInto(target: Buffer): number;
  finalize(): Promise<StreamingEncodeSessionFinalized>;
  takeOutputPatches(): Array<{ offset: number; data: Buffer }>;
  abort(): void;
};

let cachedModule: NativeFfAudioModule | null | undefined;

function getPackageRoot(): string {
  return path.join(__dirname, "..", "..", "..", "..");
}

function getNativeFfAudio(): NativeFfAudioModule {
  if (cachedModule !== undefined) {
    if (!cachedModule) {
      throw daemonError("media_backend_unavailable", "Native FFmpeg backend is unavailable");
    }
    return cachedModule;
  }
  try {
    const { loadBundledNativeAddon } = require("../../../../scripts/install-native.js") as {
      loadBundledNativeAddon: (dir: string) => Partial<NativeFfAudioModule>;
    };
    const loaded = loadBundledNativeAddon(getPackageRoot()) as Partial<NativeFfAudioModule>;
    if (Number(loaded.ffaudioAbiVersion || 0) !== EXPECTED_FFAUDIO_ABI_VERSION) {
      cachedModule = null;
      throw daemonError("media_backend_unavailable", "Native FFmpeg backend ABI mismatch");
    }
    if (typeof loaded.MediaStream !== "function") {
      cachedModule = null;
      throw daemonError("media_backend_unavailable", "Native FFmpeg backend is unavailable");
    }
    cachedModule = loaded as NativeFfAudioModule;
    return cachedModule;
  } catch (error) {
    cachedModule = null;
    if (error instanceof Error && error.message.includes("ABI mismatch")) {
      throw error;
    }
  }
  throw daemonError("media_backend_unavailable", "Native FFmpeg backend is unavailable");
}

export function guessContainerFormat(value: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  const withoutQuery = normalized.split(/[?#]/, 1)[0] || normalized;
  if (
    withoutQuery.endsWith(".wav") ||
    normalized === "wav" ||
    normalized === "audio/wav" ||
    normalized === "audio/x-wav"
  ) return "wav";
  if (
    withoutQuery.endsWith(".mp3") ||
    normalized === "mp3" ||
    normalized === "audio/mp3" ||
    normalized === "audio/mpeg"
  ) return "mp3";
  if (
    withoutQuery.endsWith(".opus") ||
    normalized === "opus" ||
    normalized === "audio/opus"
  ) return "opus";
  if (
    withoutQuery.endsWith(".ogg") ||
    normalized === "ogg" ||
    normalized === "audio/ogg"
  ) return "ogg";
  if (
    withoutQuery.endsWith(".flac") ||
    normalized === "flac" ||
    normalized === "audio/flac"
  ) return "flac";
  if (
    withoutQuery.endsWith(".m4a") ||
    normalized === "m4a" ||
    normalized === "audio/mp4"
  ) return "m4a";
  if (
    withoutQuery.endsWith(".aac") ||
    normalized === "aac" ||
    normalized === "audio/aac"
  ) return "aac";
  if (
    withoutQuery.endsWith(".webm") ||
    normalized === "webm" ||
    normalized === "audio/webm"
  ) return "webm";
  return "";
}

export function resolveMediaMimeType(fileFormat: string): string {
  switch (String(fileFormat || "").trim().toLowerCase()) {
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "opus":
      return "audio/opus";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "m4a":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "webm":
      return "audio/webm";
    default:
      return "application/octet-stream";
  }
}

function createNativeDecoder(native: NativeFfAudioModule, options: Record<string, unknown>): NativeMediaStreamDecoder {
  return new native.MediaStream({
    ...options,
    mode: "decode",
  });
}

function createNativeEncoder(native: NativeFfAudioModule, options: Record<string, unknown>): NativeMediaStreamEncoder {
  return new native.MediaStream({
    ...options,
    mode: "encode",
  });
}

async function* decodeAudioStreamToPcm(input: MediaStreamDecodeInput): AsyncGenerator<OwnedPcmChunk> {
  const native = getNativeFfAudio();
  const targetSampleRate = Math.max(1, Number(input.outputSampleRate || OPTION_DEFAULTS.recordAudio.wavSampleRate));
  const targetChannels = Math.max(1, Number(input.outputChannels || 1));
  const chunkDurationMs = Math.max(20, Number(input.outputChunkDurationMs || 40));
  const chunkBytes = Math.max(2, Math.round(targetSampleRate * (chunkDurationMs / 1000)) * targetChannels * 2);
  const chunkPool = new FrameBufferPool(chunkBytes, Math.max(4, Math.ceil(Math.max(65536, chunkBytes * 4) / chunkBytes)));
  const inputBuffer = Buffer.allocUnsafe(Math.max(65536, chunkBytes));
  const decoder = createNativeDecoder(native, {
    containerFormat: guessContainerFormat(String(input.formatHint || "")),
    outputSampleRate: targetSampleRate,
    outputChannels: targetChannels,
    inputQueueLimitBytes: Math.max(65536, chunkBytes * 4),
  });
  const source = input.source;
  const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const decodeYieldBudgetMs = 8;
  let decodeYieldDeadline = performance.now() + decodeYieldBudgetMs;
  const maybeYieldToEventLoop = async (): Promise<void> => {
    if (performance.now() < decodeYieldDeadline) {
      return;
    }
    await yieldToEventLoop();
    decodeYieldDeadline = performance.now() + decodeYieldBudgetMs;
  };
  let sourceInfo: { sampleRate?: number | null; channels?: number | null; detectedFormat?: string | null } = {};
  let sawAudio = false;
  let sourceEnded = false;
  let sourceProgressAt = performance.now();
  let drainProgressAt = performance.now();
  const bumpSourceProgress = (): void => {
    sourceProgressAt = performance.now();
  };
  const bumpDrainProgress = (): void => {
    drainProgressAt = performance.now();
  };
  const readSourceChunk = async (): Promise<number> => {
    const bytes = await withTimeout(
      Promise.resolve(source.readInto(inputBuffer)),
      STREAM_STALL_TIMEOUT_MS,
      "FFmpeg decoder made no progress while waiting for source input",
    );
    if (!bytes) {
      return 0;
    }
    return bytes;
  };
  const drainDecoderOutput = async (): Promise<OwnedPcmChunk[]> => {
    const produced: OwnedPcmChunk[] = [];
    const drainStartedAt = performance.now();
    let drainIteration = 0;
    for (;;) {
      if (produced.length > 0 && (produced.length >= 1 || performance.now() - drainStartedAt >= 4)) {
        await maybeYieldToEventLoop();
        break;
      }
      const frameBuffer = chunkPool.acquire();
      if (!frameBuffer.length) {
        break;
      }
      let handedOff = false;
      try {
        drainIteration += 1;
        let bytesRead = 0;
        try {
          bytesRead = Number(decoder.writeInto(frameBuffer, 0, frameBuffer.length) || 0);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error || "");
          if (/two consecutive MPEG audio frames|Invalid data found when processing input/i.test(message)) {
            break;
          }
          throw error;
        }
        if (!bytesRead) {
          break;
        }
        sourceInfo = decoder.getSourceInfo() || sourceInfo;
        sawAudio = true;
        handedOff = true;
        produced.push({
          pcm: frameBuffer,
          bytes: bytesRead,
          sampleRate: Number(sourceInfo.sampleRate || targetSampleRate),
          channels: Number(sourceInfo.channels || targetChannels),
          detectedFormat: sourceInfo.detectedFormat ? String(sourceInfo.detectedFormat) : null,
          releasePool: chunkPool,
        });
        bumpDrainProgress();
        await maybeYieldToEventLoop();
      } finally {
        if (!handedOff) {
          chunkPool.release(frameBuffer);
        }
      }
    }
    return produced;
  };
  try {
    while (!sourceEnded) {
      const nextChunk = await readSourceChunk();
      if (!nextChunk) {
        sourceEnded = true;
        break;
      }
      bumpSourceProgress();
      let offset = 0;
      let chunkMadeProgress = false;
      while (offset < nextChunk) {
        const written = Number(
          decoder.readFrom(
            inputBuffer,
            offset,
            nextChunk - offset,
          ) || 0,
        );
        if (written <= 0) {
          const drained = await drainDecoderOutput();
          if (drained.length > 0) {
            for (const chunk of drained) {
              yield chunk;
            }
            chunkMadeProgress = true;
            continue;
          }
          if (performance.now() - sourceProgressAt > STREAM_STALL_TIMEOUT_MS) {
            throw daemonError("media_stream_stalled", "FFmpeg decoder made no progress while consuming source input");
          }
          await maybeYieldToEventLoop();
          continue;
        }
        offset += written;
        chunkMadeProgress = true;
        bumpSourceProgress();
      }
      const drained = await drainDecoderOutput();
      if (drained.length > 0) {
        for (const chunk of drained) {
          yield chunk;
        }
        chunkMadeProgress = true;
      }
      if (!chunkMadeProgress && performance.now() - drainProgressAt > STREAM_STALL_TIMEOUT_MS) {
        throw daemonError("media_stream_stalled", "FFmpeg decoder made no progress while draining output");
      }
    }
    try {
      decoder.closeInput();
    } catch (error) {
      console.error(
        `[sip-pbx:media] FFmpeg decoder closeInput failed while draining; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    }
    for (;;) {
      const drained = await drainDecoderOutput();
      if (drained.length === 0) {
        break;
      }
      for (const chunk of drained) {
        yield chunk;
      }
    }
    if (!sawAudio) {
      throw new Error("Playback source produced no audio");
    }
  } finally {
    try {
      await source.close?.();
    } catch (error) {
      console.error(
        `[sip-pbx:media] playback source close failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    }
    chunkPool.destroy();
    try {
      decoder.closeInput();
    } catch (error) {
      console.error(
        `[sip-pbx:media] FFmpeg decoder closeInput failed during cleanup; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    }
    try {
      decoder.close();
    } catch (error) {
      console.error(
        `[sip-pbx:media] FFmpeg decoder close failed during cleanup; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    }
  }
}

export function generateSilencePcm(durationMs: number, sampleRate: number, channels: number): Buffer {
  const duration = Math.max(0, Number(durationMs || 0));
  const rate = Math.max(1, Number(sampleRate || OPTION_DEFAULTS.recordAudio.wavSampleRate));
  const channelCount = Math.max(1, Number(channels || 1));
  const sampleCount = Math.max(0, Math.round((duration / 1000) * rate));
  return Buffer.alloc(sampleCount * channelCount * 2);
}

export function estimatePcmDurationMs(bytes: number, sampleRate: number, channels: number): number {
  const rate = Math.max(1, Number(sampleRate || OPTION_DEFAULTS.recordAudio.wavSampleRate));
  const channelCount = Math.max(1, Number(channels || 1));
  const sampleCount = Math.floor(Math.max(0, Number(bytes || 0)) / (channelCount * 2));
  return Math.max(0, Math.round((sampleCount / rate) * 1000));
}

function createStreamingEncodeSession(input: StreamingEncodeSessionInput): StreamingEncodeSession {
  const fileFormat = String(input.fileFormat || OPTION_DEFAULTS.recordAudio.fileFormat).trim().toLowerCase();
  const native = getNativeFfAudio();
  let codecName = "pcm_s16le";
  let containerFormat: string = OPTION_DEFAULTS.recordAudio.fileFormat;
  let outputSampleRate = Number(input.wavSampleRate || input.inputSampleRate || OPTION_DEFAULTS.recordAudio.wavSampleRate);
  if (fileFormat === "wav") {
    if (Number(input.wavBitDepth || OPTION_DEFAULTS.recordAudio.wavBitDepth) !== OPTION_DEFAULTS.recordAudio.wavBitDepth) {
      throw daemonError("unsupported_media_format", "Only 16-bit WAV recording is supported");
    }
  } else if (fileFormat === "mp3") {
    codecName = "libmp3lame";
    containerFormat = "mp3";
    outputSampleRate = Number(input.compressedSampleRate || OPTION_DEFAULTS.recordAudio.compressedSampleRate);
  } else if (fileFormat === "opus") {
    codecName = "libopus";
    containerFormat = "opus";
    outputSampleRate = Number(input.compressedSampleRate || OPTION_DEFAULTS.recordAudio.compressedSampleRate);
  } else if (fileFormat === "ogg") {
    codecName = "libopus";
    containerFormat = "ogg";
    outputSampleRate = Number(input.compressedSampleRate || OPTION_DEFAULTS.recordAudio.compressedSampleRate);
  } else {
    throw daemonError("unsupported_media_format", `Unsupported recording format ${fileFormat}`);
  }

  const encoder = createNativeEncoder(native, {
    codecName,
    containerFormat,
    inputSampleRate: Math.max(1, Number(input.inputSampleRate || OPTION_DEFAULTS.recordAudio.wavSampleRate)),
    inputChannels: Math.max(1, Number(input.inputChannels || 1)),
    outputSampleRate,
    outputChannels: Math.max(1, Number(input.inputChannels || 1)),
    bitrate: Math.max(8000, Number(input.compressedBitrateKbps || OPTION_DEFAULTS.recordAudio.compressedBitrateKbps) * 1000),
    inputQueueLimitBytes: 65536,
  });

  let finalized = false;
  const drainInto = (target: Buffer): number => {
    if (!Buffer.isBuffer(target) || !target.length) {
      return 0;
    }
    const written = Number(encoder.writeInto(target, 0, target.length) || 0);
    return written;
  };

  return {
    async encodeInto(pcm: Buffer, bytes = pcm.length, offset = 0): Promise<number> {
      const normalizedOffset = Math.max(0, Math.min(Number(offset) || 0, pcm.length));
      const normalizedBytes = Math.max(0, Math.min(Number(bytes) || 0, pcm.length - normalizedOffset));
      if (finalized || !normalizedBytes) {
        return 0;
      }
      let writtenTotal = 0;
      let loops = 0;
      while (writtenTotal < normalizedBytes) {
        if (finalized) {
          return writtenTotal;
        }
        loops += 1;
        const written = Number(encoder.readFrom(pcm, normalizedOffset + writtenTotal, normalizedBytes - writtenTotal) || 0);
        if (written > 0) {
          writtenTotal += written;
          continue;
        }
        return writtenTotal;
      }
      return writtenTotal;
    },
    drainInto(target: Buffer): number {
      return drainInto(target);
    },
    async finalize(): Promise<StreamingEncodeSessionFinalized> {
      if (finalized) {
        return {
          mimeType: resolveMediaMimeType(fileFormat),
        };
      }
      finalized = true;
      encoder.closeInput();
      return {
        mimeType: resolveMediaMimeType(fileFormat),
      };
    },
    takeOutputPatches(): Array<{ offset: number; data: Buffer }> {
      return encoder.takeOutputPatches();
    },
    abort(): void {
      finalized = true;
      encoder.close();
    },
  };
}

export class FfmpegStream implements MediaStream {
  readonly implementationName = "ffmpeg";

  decode(input: MediaStreamDecodeInput): AsyncIterable<OwnedPcmChunk> {
    return decodeAudioStreamToPcm({
      source: input.source,
      formatHint: input.formatHint,
      outputSampleRate: input.outputSampleRate,
      outputChannels: input.outputChannels,
      outputChunkDurationMs: input.outputChunkDurationMs,
    });
  }

  createEncoder(input: MediaStreamEncodeInput): MediaStreamEncoder {
    const session = createStreamingEncodeSession({
      fileFormat: input.fileFormat,
      wavSampleRate: input.wavSampleRate,
      wavBitDepth: input.wavBitDepth,
      compressedSampleRate: input.compressedSampleRate,
      compressedBitrateKbps: input.compressedBitrateKbps,
      inputSampleRate: input.inputSampleRate,
      inputChannels: input.inputChannels,
    });
    return {
      encodeInto(pcm: Buffer, bytes?: number, offset?: number): Promise<number> {
        return session.encodeInto(pcm, bytes, offset);
      },
      drainInto(target: Buffer): number {
        return session.drainInto(target);
      },
      async finalize(): Promise<{ mimeType: string }> {
        return await session.finalize();
      },
      takeOutputPatches(): Array<{ offset: number; data: Buffer }> {
        return session.takeOutputPatches();
      },
      abort(): void {
        session.abort();
      },
    };
  }
}

export function supportsFfmpegStreamFormat(mode: MediaStreamMode, format: string): boolean {
  if (mode === "decode") {
    return !format || SUPPORTED_DECODE_FORMATS.has(format);
  }
  return SUPPORTED_ENCODE_FORMATS.has(format);
}

export function createFfmpegStream(): MediaStream {
  return new FfmpegStream();
}

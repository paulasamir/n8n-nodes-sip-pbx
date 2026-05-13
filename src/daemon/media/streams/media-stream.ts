import { daemonError } from "../../core/daemon-error";
import type { ReadableMediaSource } from "../io/media-endpoint";
import {
  createFfmpegStream,
  guessContainerFormat,
  resolveMediaMimeType,
  supportsFfmpegStreamFormat,
} from "./ffmpeg-stream";

export type OwnedPcmChunk = {
  pcm: Buffer;
  bytes: number;
  sampleRate: number;
  channels: number;
  detectedFormat: string | null;
  releasePool: BufferReleasePool | null;
};

export type BufferReleasePool = {
  release(buffer: Buffer): void;
};

export type MediaStreamMode = "decode" | "encode";

export type MediaStreamDecodeInput = {
  source: ReadableMediaSource;
  formatHint?: string;
  outputSampleRate?: number;
  outputChannels?: number;
  outputChunkDurationMs?: number;
};

export type MediaStreamEncodeInput = {
  fileFormat: string;
  wavSampleRate?: number;
  wavBitDepth?: number;
  compressedSampleRate?: number;
  compressedBitrateKbps?: number;
  inputSampleRate: number;
  inputChannels: number;
};

export type MediaStreamFinalized = {
  mimeType: string;
  patches: Array<{ offset: number; data: Buffer }>;
};

export interface MediaStreamEncoder {
  encodeInto(pcm: Buffer, bytes?: number, offset?: number): Promise<number>;
  drainInto(target: Buffer): number;
  finalize(): Promise<{ mimeType: string }>;
  takeOutputPatches(): Array<{ offset: number; data: Buffer }>;
  abort(): void;
}

export interface MediaStream {
  readonly implementationName: string;
  decode(input: MediaStreamDecodeInput): AsyncIterable<OwnedPcmChunk>;
  createEncoder(input: MediaStreamEncodeInput): MediaStreamEncoder;
}

export type CreateMediaStreamInput = {
  mode: MediaStreamMode;
  format?: string | null;
};

type MediaStreamFactory = {
  supports: (mode: MediaStreamMode, format: string) => boolean;
  create: () => MediaStream;
};

const streamFactories: MediaStreamFactory[] = [
  {
    supports: supportsFfmpegStreamFormat,
    create: createFfmpegStream,
  },
];

function normalizeMediaFormat(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

export function createStream(input: CreateMediaStreamInput): MediaStream {
  const mode = input.mode;
  const format = normalizeMediaFormat(input.format);
  for (const factory of streamFactories) {
    if (factory.supports(mode, format)) {
      return factory.create();
    }
  }
  const requestedFormat = format || "autodetect";
  throw daemonError(
    "unsupported_media_format",
    `No media stream implementation supports ${mode} format ${requestedFormat}`,
  );
}

export const guessMediaContainer = guessContainerFormat;
export const resolveMediaStreamMimeType = resolveMediaMimeType;

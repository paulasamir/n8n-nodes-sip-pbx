import { daemonError } from "../../core/daemon-error";
import { OPTION_DEFAULTS } from "../../../shared/option-defaults";
import { createBinaryInputEndpoint, BinaryOutputEndpoint } from "./binary-endpoint";
import { createFileInputEndpoint, FileOutputEndpoint } from "./file-endpoint";
import { createHttpInputEndpoint, HttpOutputEndpoint } from "./http-endpoint";

export type MediaOutputPatch = {
  offset: number;
  data: Buffer;
};

export type MediaEndpointKind = "binary" | "file" | "http";

export type WritableMediaEndpointFinalizeInput = {
  result: Record<string, unknown>;
  mimeType?: string;
  binaryProperty?: string;
};

export interface MediaEndpoint {
  readonly endpointType: MediaEndpointKind;
}

export interface ReadableMediaSource {
  readInto(target: Buffer): number | Promise<number>;
  close?(): void | Promise<void>;
}

export interface ReadableMediaEndpoint extends MediaEndpoint {
  readonly direction: "input";
  readonly formatHint: string;
  readonly sourceRef: string | null;
  open(): ReadableMediaSource | Promise<ReadableMediaSource>;
  close?(): void | Promise<void>;
}

export interface WritableMediaEndpoint extends MediaEndpoint {
  readonly direction: "output";
  writeChunk(chunk: Buffer, bytes?: number, offset?: number): Promise<void>;
  finalize(input: WritableMediaEndpointFinalizeInput): Promise<Record<string, unknown>>;
  abort(): Promise<void>;
}

export interface SeekableWritableMediaEndpoint extends WritableMediaEndpoint {
  finalizeSeekable(
    input: WritableMediaEndpointFinalizeInput,
    patches: MediaOutputPatch[],
  ): Promise<Record<string, unknown>>;
}

export function isSeekableWritableMediaEndpoint(endpoint: WritableMediaEndpoint): endpoint is SeekableWritableMediaEndpoint {
  return typeof (endpoint as SeekableWritableMediaEndpoint).finalizeSeekable === "function";
}

type ReadableEndpointBuilder = (input: Record<string, unknown>) => ReadableMediaEndpoint | Promise<ReadableMediaEndpoint>;
type WritableEndpointBuilder = (input: Record<string, unknown>) => WritableMediaEndpoint;

const readableBuilders = new Map<string, ReadableEndpointBuilder>([
  ["binary", (input) => createBinaryInputEndpoint(input)],
  ["file", (input) => createFileInputEndpoint(input)],
  ["http", (input) => createHttpInputEndpoint(input)],
]);

const writableBuilders = new Map<string, WritableEndpointBuilder>([
  ["binary", (input) => new BinaryOutputEndpoint(input)],
  ["file", (input) => new FileOutputEndpoint(input)],
  ["http", (input) => new HttpOutputEndpoint(input)],
]);

export async function createReadableMediaEndpoint(input: Record<string, unknown>): Promise<ReadableMediaEndpoint> {
  const sourceType = String(input.sourceType || OPTION_DEFAULTS.playAudio.sourceType).trim().toLowerCase();
  const builder = readableBuilders.get(sourceType) || null;
  if (!builder) {
    throw daemonError("invalid_media_source", `Unsupported media source type ${sourceType}`);
  }
  return await builder(input);
}

export function createWritableMediaEndpoint(input: Record<string, unknown>): WritableMediaEndpoint {
  const outputType = String(input.recordOutputType || OPTION_DEFAULTS.recordAudio.outputType).trim().toLowerCase();
  const builder = writableBuilders.get(outputType) || null;
  if (!builder) {
    throw daemonError("invalid_media_output", `Unsupported media output type ${outputType}`);
  }
  return builder(input);
}

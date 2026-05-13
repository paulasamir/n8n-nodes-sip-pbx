import { daemonError } from "../../core/daemon-error";
import { OPTION_DEFAULTS } from "../../../shared/option-defaults";
import { guessMediaContainer } from "../streams/media-stream";
import type {
  MediaOutputPatch,
  ReadableMediaEndpoint,
  ReadableMediaSource,
  SeekableWritableMediaEndpoint,
  WritableMediaEndpointFinalizeInput,
} from "./media-endpoint";

function applyPatches(buffer: Buffer, patches: MediaOutputPatch[]): Buffer {
  for (const patch of patches) {
    if (!patch || !Buffer.isBuffer(patch.data) || !patch.data.length) {
      continue;
    }
    patch.data.copy(buffer, Math.max(0, Number(patch.offset) || 0));
  }
  return buffer;
}

export function createBinaryInputEndpoint(input: Record<string, unknown>): ReadableMediaEndpoint {
  const base64 = String(input.binaryDataBase64 || input.dataBase64 || "").trim();
  if (!base64) {
    throw daemonError("invalid_media_source", "Playback binary data is required");
  }
  const fileName = String(input.binaryFileName || input.fileName || "").trim();
  const mimeType = String(input.binaryMimeType || "").trim();
  const payload = Buffer.from(base64.replace(/\s+/g, ""), "base64");
  let currentSource: ReadableMediaSource | null = null;
  return {
    endpointType: "binary",
    direction: "input",
    formatHint: guessMediaContainer(fileName || mimeType),
    sourceRef: fileName || mimeType || OPTION_DEFAULTS.playAudio.sourceType,
    open() {
      let closed = false;
      let offset = 0;
      const source: ReadableMediaSource = {
        readInto(target: Buffer): number {
          if (closed || offset >= payload.length) {
            return 0;
          }
          if (!Buffer.isBuffer(target) || !target.length) {
            return 0;
          }
          const bytes = Math.min(payload.length - offset, target.length);
          if (bytes <= 0) {
            return 0;
          }
          payload.copy(target, 0, offset, offset + bytes);
          offset += bytes;
          return bytes;
        },
        close(): void {
          closed = true;
          offset = payload.length;
        },
      };
      currentSource = source;
      return source;
    },
    close() {
      currentSource?.close?.();
      currentSource = null;
    },
  };
}

export class BinaryOutputEndpoint implements SeekableWritableMediaEndpoint {
  readonly endpointType = "binary" as const;
  readonly direction = "output" as const;
  private readonly binaryProperty: string;
  private readonly chunks: Buffer[] = [];
  private bytesProduced = 0;

  constructor(input: Record<string, unknown>) {
    this.binaryProperty = String(input.recordBinaryProperty || input.binaryProperty || OPTION_DEFAULTS.recordAudio.binaryProperty).trim() || OPTION_DEFAULTS.recordAudio.binaryProperty;
  }

  async writeChunk(chunk: Buffer, bytes = chunk.length, offset = 0): Promise<void> {
    if (!Buffer.isBuffer(chunk)) {
      return;
    }
    const normalizedOffset = Math.max(0, Math.min(Number(offset) || 0, chunk.length));
    const normalizedBytes = Math.max(0, Math.min(Number(bytes) || 0, chunk.length - normalizedOffset));
    if (!normalizedBytes) {
      return;
    }
    this.bytesProduced += normalizedBytes;
    const owned = Buffer.allocUnsafe(normalizedBytes);
    chunk.copy(owned, 0, normalizedOffset, normalizedOffset + normalizedBytes);
    this.chunks.push(owned);
  }

  async finalize(input: WritableMediaEndpointFinalizeInput): Promise<Record<string, unknown>> {
    return await this.finalizeSeekable(input, []);
  }

  async finalizeSeekable(
    input: WritableMediaEndpointFinalizeInput,
    patches: MediaOutputPatch[],
  ): Promise<Record<string, unknown>> {
    const output = applyPatches(this.materialize(), patches);
    this.chunks.length = 0;
    return {
      ...(input.result || {}),
      bytesProduced: output.length,
      outputBinaryBase64: output.toString("base64"),
      outputBinaryProperty: input.binaryProperty || this.binaryProperty,
      outputBinaryMimeType: String(input.mimeType || "application/octet-stream"),
    };
  }

  async abort(): Promise<void> {
    this.chunks.length = 0;
  }

  private materialize(): Buffer {
    if (this.chunks.length === 0) {
      return Buffer.alloc(0);
    }
    if (this.chunks.length === 1) {
      return this.chunks[0]!;
    }
    return Buffer.concat(this.chunks, this.bytesProduced);
  }
}

import * as fs from "fs";
import * as path from "path";
import { daemonError } from "../../core/daemon-error";
import { guessMediaContainer } from "../streams/media-stream";
import { safeClose, safeDestroy } from "./safe-cleanup";
import type {
  MediaOutputPatch,
  ReadableMediaEndpoint,
  ReadableMediaSource,
  SeekableWritableMediaEndpoint,
  WritableMediaEndpointFinalizeInput,
} from "./media-endpoint";

async function writeChunkWithBackpressure(stream: NodeJS.WritableStream, chunk: Buffer, bytes = chunk.length, offset = 0): Promise<void> {
  const normalizedOffset = Math.max(0, Math.min(Number(offset) || 0, chunk.length));
  const normalizedBytes = Math.max(0, Math.min(Number(bytes) || 0, chunk.length - normalizedOffset));
  if (!normalizedBytes) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off("error", onError);
      stream.off("drain", onDrain);
    };
    stream.on("error", onError);
    const ok = stream.write(normalizedOffset === 0 && normalizedBytes >= chunk.length
      ? chunk
      : chunk.subarray(normalizedOffset, normalizedOffset + normalizedBytes));
    if (ok) {
      cleanup();
      resolve();
      return;
    }
    stream.on("drain", onDrain);
  });
}

async function closeWritable(stream: NodeJS.WritableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off("error", onError);
      stream.off("finish", onFinish);
      stream.off("close", onFinish);
    };
    stream.once("error", onError);
    stream.once("finish", onFinish);
    stream.once("close", onFinish);
    stream.end();
  });
}

export function createFileInputEndpoint(input: Record<string, unknown>): ReadableMediaEndpoint {
  const filePath = String(input.filePath || "").trim();
  if (!filePath) {
    throw daemonError("invalid_media_source", "Playback file path is required");
  }
  const formatHint = guessMediaContainer(filePath);
  const sourceRef = filePath;
  let fd: number | null = null;
  let currentSource: ReadableMediaSource | null = null;
  return {
    endpointType: "file",
    direction: "input",
    formatHint,
    sourceRef,
    open() {
      fd = fs.openSync(filePath, "r");
      let closed = false;
      const source: ReadableMediaSource = {
        readInto(target: Buffer): number {
          if (closed || fd === null) {
            return 0;
          }
          if (!Buffer.isBuffer(target) || !target.length) {
            return 0;
          }
          const bytesRead = fs.readSync(fd, target, 0, target.length, null);
          if (bytesRead <= 0) {
            return 0;
          }
          return bytesRead;
        },
        close(): void {
          closed = true;
          if (fd !== null) {
            safeClose("file playback fd", `path=${filePath}`, () => fs.closeSync(fd as number));
            fd = null;
          }
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

function hasTemplatePlaceholderSyntax(filePath: string): boolean {
  return /\{\{[^{}]+\}\}/.test(filePath) || /\{[^{}]+\}/.test(filePath);
}

function sanitizePathComponent(component: string): string {
  if (component === "." || component === "..") {
    return component;
  }
  return component.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "_";
}

function sanitizeRecordFilePath(filePath: string, recordingsRoot?: string): string {
  const raw = String(filePath || "").trim();
  const root = path.parse(raw).root;
  const tail = root ? raw.slice(root.length) : raw;
  const sanitizedTail = tail
    .split(/[\\/]+/)
    .filter((component, index) => index === 0 || component.length > 0)
    .map((component) => sanitizePathComponent(component))
    .join(path.sep);
  const sanitized = root ? path.join(root, sanitizedTail) : sanitizedTail;
  if (path.isAbsolute(sanitized)) {
    return sanitized;
  }
  return path.join(String(recordingsRoot || process.cwd()), sanitized);
}

export class FileOutputEndpoint implements SeekableWritableMediaEndpoint {
  readonly endpointType = "file" as const;
  readonly direction = "output" as const;
  readonly filePath: string;
  private readonly fileStream: fs.WriteStream;
  private bytesProduced = 0;

  constructor(input: Record<string, unknown>) {
    const inputFilePath = String(input.recordFilePath || input.filePath || "").trim();
    if (!inputFilePath) {
      throw daemonError("invalid_request", "Record file path is required");
    }
    if (hasTemplatePlaceholderSyntax(inputFilePath)) {
      throw daemonError("invalid_request", "Record file path must be a final path, not a template");
    }
    this.filePath = sanitizeRecordFilePath(inputFilePath, String(input.recordingsRoot || ""));
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.fileStream = fs.createWriteStream(this.filePath);
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
    await writeChunkWithBackpressure(this.fileStream, chunk, normalizedBytes, normalizedOffset);
  }

  async finalize(input: WritableMediaEndpointFinalizeInput): Promise<Record<string, unknown>> {
    return await this.finalizeSeekable(input, []);
  }

  async finalizeSeekable(
    input: WritableMediaEndpointFinalizeInput,
    patches: MediaOutputPatch[],
  ): Promise<Record<string, unknown>> {
    await closeWritable(this.fileStream);
    if (patches.length) {
      const fd = fs.openSync(this.filePath, "r+");
      try {
        for (const patch of patches) {
          if (!patch || !Buffer.isBuffer(patch.data) || !patch.data.length) {
            continue;
          }
          fs.writeSync(fd, patch.data, 0, patch.data.length, Math.max(0, Number(patch.offset) || 0));
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    return {
      ...(input.result || {}),
      bytesProduced: this.bytesProduced,
      filePath: this.filePath,
    };
  }

  async abort(): Promise<void> {
    safeDestroy("file recording stream", `path=${this.filePath}`, this.fileStream);
  }
}

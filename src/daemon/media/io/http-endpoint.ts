import * as http from "http";
import * as https from "https";
import type { ClientRequest } from "http";
import { daemonError } from "../../core/daemon-error";
import { guessMediaContainer } from "../streams/media-stream";
import { safeClose, safeDestroy } from "./safe-cleanup";
import type {
  ReadableMediaEndpoint,
  ReadableMediaSource,
  WritableMediaEndpoint,
  WritableMediaEndpointFinalizeInput,
} from "./media-endpoint";

type HttpHeaders = Array<[string, string]>;
const HTTP_IO_TIMEOUT_MS = 15000;
const HTTP_MAX_REDIRECTS = 5;

function hasHeader(headers: HttpHeaders, name: string): boolean {
  const lower = String(name || "").toLowerCase();
  return headers.some(([entryName]) => entryName.toLowerCase() === lower);
}

function buildHttpHeaders(headerEntries: unknown[]): HttpHeaders {
  const headers: HttpHeaders = [];
  for (const entry of headerEntries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const name = String((entry as Record<string, unknown>).name || "").trim();
    if (!name) {
      continue;
    }
    headers.push([name, String((entry as Record<string, unknown>).value ?? "")]);
  }
  return headers;
}

function toNodeRequestHeaders(headers: HttpHeaders): http.OutgoingHttpHeaders {
  const output: http.OutgoingHttpHeaders = {};
  for (const [name, value] of headers) {
    const existing = output[name];
    if (existing == null) {
      output[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      output[name] = [String(existing), value];
    }
  }
  return output;
}

async function writeChunkWithBackpressure(stream: NodeJS.WritableStream, chunk: Buffer, bytes = chunk.length, offset = 0): Promise<void> {
  const normalizedOffset = Math.max(0, Math.min(Number(offset) || 0, chunk.length));
  const normalizedBytes = Math.max(0, Math.min(Number(bytes) || 0, chunk.length - normalizedOffset));
  if (!normalizedBytes) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(daemonError("media_http_error", "HTTP recording upload stalled"));
    }, HTTP_IO_TIMEOUT_MS);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
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
    const timeout = setTimeout(() => {
      cleanup();
      reject(daemonError("media_http_error", "HTTP recording upload stalled while closing"));
    }, HTTP_IO_TIMEOUT_MS);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
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

export function createHttpInputEndpoint(input: Record<string, unknown>): ReadableMediaEndpoint {
  const url = String(input.playbackHttpUrl || input.url || "").trim();
  if (!url) {
    throw daemonError("invalid_media_source", "Playback HTTP URL is required");
  }
  const method = String(input.playbackHttpMethod || input.method || "GET").toUpperCase();
  const headers = buildHttpHeaders(Array.isArray(input.playbackHttpHeaders) ? input.playbackHttpHeaders : []);
  let formatHint = guessMediaContainer(url);
  let currentSource: ReadableMediaSource | null = null;
  let currentRequest: ClientRequest | null = null;
  let currentResponse: http.IncomingMessage | null = null;
  let closed = false;
  return {
    endpointType: "http",
    direction: "input",
    get formatHint() {
      return formatHint;
    },
    sourceRef: url,
    async open() {
      if (closed) {
        throw daemonError("media_http_error", "HTTP playback source has already been closed");
      }
      console.error(`[sip-pbx:media-worker] http playback open start; url=${url}; method=${method}`);
      const openResponse = async (requestUrl: URL, redirectCount: number): Promise<http.IncomingMessage> => {
        if (redirectCount > HTTP_MAX_REDIRECTS) {
          throw daemonError("media_http_error", "HTTP playback source redirected too many times");
        }
        const transport = requestUrl.protocol === "https:" ? https : http;
        return await new Promise<http.IncomingMessage>((resolve, reject) => {
          const request = transport.request(requestUrl, {
            method,
            headers: toNodeRequestHeaders(headers),
          });
          currentRequest = request;
          const timeout = setTimeout(() => {
            cleanup();
            safeDestroy("http playback request", `request=${requestUrl.toString()}`, request);
            reject(daemonError("media_http_error", "HTTP playback source timed out before response"));
          }, HTTP_IO_TIMEOUT_MS);
          const cleanup = (): void => {
            clearTimeout(timeout);
            request.off("error", onError);
            request.off("response", onResponse);
          };
          const fail = (error: Error): void => {
            cleanup();
            safeDestroy("http playback request", `request=${requestUrl.toString()}`, request);
            reject(error);
          };
          const onError = (error: Error): void => {
            fail(error instanceof Error ? error : new Error(String(error || "HTTP playback source failed")));
          };
          const onResponse = (response: http.IncomingMessage): void => {
            const statusCode = Number(response.statusCode || 0);
            const location = String(response.headers.location || "").trim();
            if (statusCode >= 300 && statusCode < 400 && location) {
              response.resume();
              cleanup();
              void openResponse(new URL(location, requestUrl), redirectCount + 1).then(resolve, reject);
              return;
            }
            cleanup();
            resolve(response);
          };
          request.once("error", onError);
          request.once("response", onResponse);
          request.end();
        });
      };
      const response = await openResponse(new URL(url), 0);
      if (closed) {
        safeDestroy("http playback response", `url=${url}`, response);
        throw daemonError("media_http_error", "HTTP playback source has already been closed");
      }
      currentResponse = response;
      console.error(
        `[sip-pbx:media-worker] http playback response received; url=${url}; status=${response.statusCode}; contentType=${String(response.headers["content-type"] || "")}`,
      );
      if (Number(response.statusCode || 0) < 200 || Number(response.statusCode || 0) >= 300) {
        safeDestroy("http playback response", `url=${url}`, response);
        throw daemonError("media_http_error", `HTTP playback source failed with status ${response.statusCode}`);
      }
      const contentType = String(response.headers["content-type"] || "").trim();
      const hintedFormat = guessMediaContainer(contentType.split(";", 1)[0] || contentType);
      if (hintedFormat) {
        formatHint = hintedFormat;
      }
      let responseEnded = false;
      let responseError: Error | null = null;
      let loggedFirstRead = false;
      let currentChunk: Buffer | null = null;
      let currentOffset = 0;
      let readWaiter: (() => void) | null = null;
      let listenersAttached = false;
      const signalRead = (): void => {
        const waiter = readWaiter;
        readWaiter = null;
        if (waiter) {
          waiter();
        }
      };
      const attachSourceListeners = (): void => {
        if (listenersAttached) {
          return;
        }
        listenersAttached = true;
        response.once("end", onEnd);
        response.once("error", onError);
        response.once("aborted", onAborted);
      };
      const waitForRead = (): Promise<void> => {
        return new Promise<void>((resolve) => {
          if (closed || responseError || responseEnded || Number(response.readableLength || 0) > 0) {
            resolve();
            return;
          }
          const finish = (): void => {
            cleanup();
            resolve();
          };
          const cleanup = (): void => {
            if (readWaiter === finish) {
              readWaiter = null;
            }
            response.off("readable", finish);
            response.off("end", finish);
            response.off("error", finish);
            response.off("aborted", finish);
          };
          readWaiter = finish;
          response.once("readable", finish);
          response.once("end", finish);
          response.once("error", finish);
          response.once("aborted", finish);
        });
      };
      const onEnd = (): void => {
        responseEnded = true;
        signalRead();
      };
      const onError = (error: Error): void => {
        if (closed) {
          return;
        }
        responseError = error instanceof Error ? error : new Error(String(error || "HTTP playback source failed"));
        signalRead();
      };
      const onAborted = (): void => {
        if (closed) {
          return;
        }
        responseError = daemonError("media_http_error", "HTTP playback source aborted");
        signalRead();
      };
      const source: ReadableMediaSource = {
        async readInto(target: Buffer): Promise<number> {
          if (closed) {
            return 0;
          }
          attachSourceListeners();
          if (!Buffer.isBuffer(target) || !target.length) {
            return 0;
          }
          let written = 0;
          while (written < target.length) {
            if (responseError) {
              if (written > 0) {
                break;
              }
              throw responseError;
            }
            if (currentChunk && currentOffset < currentChunk.length) {
              const remainingChunk = currentChunk.length - currentOffset;
              const bytesToCopy = Math.min(remainingChunk, target.length - written);
              currentChunk.copy(target, written, currentOffset, currentOffset + bytesToCopy);
              written += bytesToCopy;
              currentOffset += bytesToCopy;
              if (currentOffset >= currentChunk.length) {
                currentChunk = null;
                currentOffset = 0;
              }
              continue;
            }
            const next = response.read() as Buffer | null;
            if (next && next.length) {
              if (!loggedFirstRead) {
                loggedFirstRead = true;
                console.error(`[sip-pbx:media-worker] http playback first chunk received; url=${url}; bytes=${next.length}`);
              }
              currentChunk = next;
              currentOffset = 0;
              continue;
            }
            if (responseEnded) {
              break;
            }
            if (closed) {
              break;
            }
            await waitForRead();
            if (closed) {
              break;
            }
          }
          return written;
        },
        async close(): Promise<void> {
          closed = true;
          if (listenersAttached) {
            response.off("end", onEnd);
            response.off("error", onError);
            response.off("aborted", onAborted);
          }
          safeDestroy("http playback response", `url=${url}`, response);
          safeDestroy("http playback request", `url=${url}`, currentRequest);
          currentResponse = null;
          currentRequest = null;
        },
      };
      currentSource = source;
      return source;
    },
    async close(): Promise<void> {
      closed = true;
      safeDestroy("http playback response", `url=${url}`, currentResponse);
      safeDestroy("http playback request", `url=${url}`, currentRequest);
      currentResponse = null;
      currentRequest = null;
      await currentSource?.close?.();
      currentSource = null;
    },
  };
}

export class HttpOutputEndpoint implements WritableMediaEndpoint {
  readonly endpointType = "http" as const;
  readonly direction = "output" as const;
  private readonly request: ClientRequest;
  private readonly result: Promise<void>;
  private bytesProduced = 0;

  constructor(input: Record<string, unknown>) {
    const url = String(input.recordHttpUrl || input.url || "").trim();
    if (!url) {
      throw daemonError("invalid_media_output", "Record HTTP URL is required");
    }
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const headers = buildHttpHeaders(Array.isArray(input.recordHttpHeaders) ? input.recordHttpHeaders : []);
    const request = transport.request(parsed, {
      method: String(input.recordHttpMethod || input.method || "PUT").toUpperCase(),
      headers: toNodeRequestHeaders(headers),
    });
    this.request = request;
    this.result = new Promise<void>((resolve, reject) => {
      request.once("response", (response) => {
        const statusCode = Number(response.statusCode || 0);
        console.error(`[sip-pbx:media-worker] http recording response received; url=${url}; status=${statusCode}`);
        response.resume();
        response.once("end", () => {
          if (statusCode >= 200 && statusCode < 300) {
            console.error(`[sip-pbx:media-worker] http recording response ended; url=${url}; status=${statusCode}`);
            resolve();
            return;
          }
          reject(daemonError("media_http_error", `HTTP recording upload failed with status ${statusCode}`));
        });
      });
      request.once("error", (error) => {
        console.error(`[sip-pbx:media-worker] http recording request error; url=${url}; error=${error instanceof Error ? error.message : String(error || "unknown")}`);
        reject(error instanceof Error ? error : new Error(String(error || "HTTP recording upload failed")));
      });
    });
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
    await writeChunkWithBackpressure(this.request, chunk, normalizedBytes, normalizedOffset);
  }

  async finalize(input: WritableMediaEndpointFinalizeInput): Promise<Record<string, unknown>> {
    await closeWritable(this.request);
    await this.result;
    return {
      ...(input.result || {}),
      bytesProduced: this.bytesProduced,
    };
  }

  async abort(): Promise<void> {
    safeDestroy("http recording request", `url=${this.request.getHeader("host") || "recording"}`, this.request);
  }
}

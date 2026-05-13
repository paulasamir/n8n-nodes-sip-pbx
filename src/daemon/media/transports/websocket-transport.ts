import WebSocket from "ws";
import { OPTION_DEFAULTS } from "../../../shared/option-defaults";
import type { BufferReleasePool } from "../streams/media-stream";
import type { WorkerTransportOutputMessage } from "../worker/media-worker";
import { TransportAttachment, type MediaTransport, type MediaTransportDetails, type MediaTransportInputEvent } from "./media-transport";
import {
  createWebSocketTransportProfile,
  extractWebSocketEventType,
  formatWebSocketErrorReason,
  type NormalizedWebSocketMediaTransportAction,
  type WebSocketTransportAction,
  type WebSocketVoiceAgentEvent,
  type WebSocketTransportProfile,
} from "./websocket-profiles";

const WORKER_MESSAGE_KIND_TRANSPORT_INPUT = 4;
const WORKER_TRANSPORT_INPUT_OPCODE_WEBSOCKET_PAYLOAD = 2;
const WORKER_TRANSPORT_OUTPUT_OPCODE_WEBSOCKET_JSON = 2;
const OPENAI_REALTIME_INBOUND_BATCH_FRAMES = 2;

type JsonParseSuccess = {
  ok: true;
  value: unknown;
};

type JsonParseFailure = {
  ok: false;
};

function isDeferredWebSocketSession(config: Record<string, unknown>): boolean {
  return String(config.websocketStartMode || "").trim() === "deferred"
    && config.websocketSessionActivated !== true;
}

class InboundAudioBufferPool implements BufferReleasePool {
  private readonly free = new Map<number, Buffer[]>();

  acquire(bytes: number): Buffer {
    const size = Math.max(0, Math.floor(Number(bytes) || 0));
    if (size <= 0) {
      return Buffer.alloc(0);
    }
    const pool = this.free.get(size) || null;
    if (pool && pool.length > 0) {
      return pool.pop()!;
    }
    return Buffer.allocUnsafe(size);
  }

  release(buffer: Buffer): void {
    if (!Buffer.isBuffer(buffer) || buffer.length <= 0) {
      return;
    }
    const size = buffer.length;
    let pool = this.free.get(size) || null;
    if (!pool) {
      pool = [];
      this.free.set(size, pool);
    }
    pool.push(buffer);
  }
}

function toBufferView(value: Buffer | Uint8Array | ArrayBufferLike): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.from(value);
}

function okJson(value: unknown): JsonParseSuccess {
  return { ok: true, value };
}

function failJson(): JsonParseFailure {
  return { ok: false };
}

function parseJsonText(text: string): JsonParseSuccess | JsonParseFailure {
  const source = String(text || "");
  let index = 0;

  const skipWhitespace = (): void => {
    while (index < source.length) {
      const ch = source[index];
      if (ch !== " " && ch !== "\n" && ch !== "\r" && ch !== "\t") {
        break;
      }
      index += 1;
    }
  };

  const parseLiteral = (literal: string, value: unknown): JsonParseSuccess | JsonParseFailure => {
    if (source.slice(index, index + literal.length) !== literal) {
      return failJson();
    }
    index += literal.length;
    return okJson(value);
  };

  const parseString = (): JsonParseSuccess | JsonParseFailure => {
    if (source[index] !== "\"") {
      return failJson();
    }
    index += 1;
    let output = "";
    while (index < source.length) {
      const ch = source[index]!;
      index += 1;
      if (ch === "\"") {
        return okJson(output);
      }
      if (ch === "\\") {
        if (index >= source.length) {
          return failJson();
        }
        const escape = source[index]!;
        index += 1;
        switch (escape) {
          case "\"":
          case "\\":
          case "/":
            output += escape;
            break;
          case "b":
            output += "\b";
            break;
          case "f":
            output += "\f";
            break;
          case "n":
            output += "\n";
            break;
          case "r":
            output += "\r";
            break;
          case "t":
            output += "\t";
            break;
          case "u": {
            const hex = source.slice(index, index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              return failJson();
            }
            output += String.fromCharCode(Number.parseInt(hex, 16));
            index += 4;
            break;
          }
          default:
            return failJson();
        }
        continue;
      }
      if (ch < " ") {
        return failJson();
      }
      output += ch;
    }
    return failJson();
  };

  const isDigit = (ch: string | undefined): boolean => Boolean(ch && ch >= "0" && ch <= "9");

  const parseNumber = (): JsonParseSuccess | JsonParseFailure => {
    const start = index;
    if (source[index] === "-") {
      index += 1;
    }
    const first = source[index];
    if (first === "0") {
      index += 1;
    } else if (first && first >= "1" && first <= "9") {
      index += 1;
      while (isDigit(source[index])) {
        index += 1;
      }
    } else {
      return failJson();
    }
    if (source[index] === ".") {
      index += 1;
      if (!isDigit(source[index])) {
        return failJson();
      }
      while (isDigit(source[index])) {
        index += 1;
      }
    }
    const exponent = source[index];
    if (exponent === "e" || exponent === "E") {
      index += 1;
      if (source[index] === "+" || source[index] === "-") {
        index += 1;
      }
      if (!isDigit(source[index])) {
        return failJson();
      }
      while (isDigit(source[index])) {
        index += 1;
      }
    }
    const parsed = Number(source.slice(start, index));
    return Number.isFinite(parsed) ? okJson(parsed) : failJson();
  };

  const parseValue = (): JsonParseSuccess | JsonParseFailure => {
    skipWhitespace();
    const ch = source[index];
    if (!ch) {
      return failJson();
    }
    if (ch === "\"") {
      return parseString();
    }
    if (ch === "{") {
      index += 1;
      skipWhitespace();
      const record: Record<string, unknown> = {};
      if (source[index] === "}") {
        index += 1;
        return okJson(record);
      }
      while (index < source.length) {
        const keyResult = parseString();
        if (!keyResult.ok || typeof keyResult.value !== "string") {
          return failJson();
        }
        skipWhitespace();
        if (source[index] !== ":") {
          return failJson();
        }
        index += 1;
        const valueResult = parseValue();
        if (!valueResult.ok) {
          return failJson();
        }
        record[keyResult.value] = valueResult.value;
        skipWhitespace();
        if (source[index] === "}") {
          index += 1;
          return okJson(record);
        }
        if (source[index] !== ",") {
          return failJson();
        }
        index += 1;
        skipWhitespace();
      }
      return failJson();
    }
    if (ch === "[") {
      index += 1;
      skipWhitespace();
      const values: unknown[] = [];
      if (source[index] === "]") {
        index += 1;
        return okJson(values);
      }
      while (index < source.length) {
        const valueResult = parseValue();
        if (!valueResult.ok) {
          return failJson();
        }
        values.push(valueResult.value);
        skipWhitespace();
        if (source[index] === "]") {
          index += 1;
          return okJson(values);
        }
        if (source[index] !== ",") {
          return failJson();
        }
        index += 1;
        skipWhitespace();
      }
      return failJson();
    }
    if (ch === "t") {
      return parseLiteral("true", true);
    }
    if (ch === "f") {
      return parseLiteral("false", false);
    }
    if (ch === "n") {
      return parseLiteral("null", null);
    }
    return parseNumber();
  };

  const result = parseValue();
  if (!result.ok) {
    return result;
  }
  skipWhitespace();
  return index === source.length ? result : failJson();
}

function parseJsonTextOrRaw(text: string): unknown {
  const parsed = parseJsonText(String(text || ""));
  if (!parsed.ok) {
    return text;
  }
  return parsed.value;
}

function tryParseUnknownJsonPayload(payload: unknown): unknown {
  if (typeof payload === "string") {
    return parseJsonTextOrRaw(payload);
  }
  if (Buffer.isBuffer(payload)) {
    return parseJsonTextOrRaw(payload.toString("utf8"));
  }
  if (payload instanceof Uint8Array) {
    return parseJsonTextOrRaw(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8"));
  }
  if (payload instanceof ArrayBuffer) {
    return parseJsonTextOrRaw(Buffer.from(payload).toString("utf8"));
  }
  if (ArrayBuffer.isView(payload)) {
    return parseJsonTextOrRaw(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8"));
  }
  return payload;
}

function normalizeRawBinaryPayload(payload: WebSocket.RawData): string | Buffer | unknown {
  if (typeof payload === "string") {
    return payload;
  }
  if (Buffer.isBuffer(payload)) {
    return payload;
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload);
  }
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return Buffer.alloc(0);
    }
    if (payload.length === 1) {
      return toBufferView(payload[0] as Buffer | Uint8Array | ArrayBufferLike);
    }
    return Buffer.concat(payload.map((chunk) => toBufferView(chunk as Buffer | Uint8Array | ArrayBufferLike)));
  }
  return payload;
}

export { createWebSocketTransportProfile } from "./websocket-profiles";

function encodeJsonValue(value: unknown, seen = new WeakSet<object>()): string {
  if (value == null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => encodeJsonValue(entry, seen)).join(",")}]`;
  }
  if (value instanceof Date) {
    return JSON.stringify(Number.isNaN(value.getTime()) ? null : value.toISOString());
  }
  if (ArrayBuffer.isView(value)) {
    return encodeJsonValue(Array.from(Buffer.from(value.buffer, value.byteOffset, value.byteLength)), seen);
  }
  if (value instanceof ArrayBuffer) {
    return encodeJsonValue(Array.from(Buffer.from(value)), seen);
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return JSON.stringify("[Circular]");
    }
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => {
        const type = typeof entryValue;
        return type !== "undefined" && type !== "function" && type !== "symbol";
      })
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${encodeJsonValue(entryValue, seen)}`);
    seen.delete(value);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function sendWebSocketMessage(socket: WebSocket, message: string | Record<string, unknown>): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(typeof message === "string" ? message : encodeJsonValue(message));
  return true;
}

export function sendWebSocketJson(socket: WebSocket, payload: Record<string, unknown>): boolean {
  return sendWebSocketMessage(socket, payload || {});
}

export function createWebSocketTransportAttachment(input: {
  legId: string;
  onVoiceAgentEvent?: (legId: string, event: WebSocketVoiceAgentEvent) => void;
}): TransportAttachment {
  return new (class extends TransportAttachment {
    private readonly onVoiceAgentEvent = input.onVoiceAgentEvent || (() => undefined);
    private socket: WebSocket | null = null;
    private connectingSocket: WebSocket | null = null;
    private connectPromise: Promise<void> | null = null;
    private config: Record<string, unknown> = {};
    private socketUrl = "";
    private opened = false;
    private closing = false;
    private closeNotified = false;
    constructor() {
      super(input.legId, "websocket");
    }

    async configure(config: Record<string, unknown>): Promise<Record<string, unknown>> {
      const nextConfig = { ...(config || {}) };
      const nextUrl = String(nextConfig.websocketUrl || this.socketUrl || "").trim();
      const shouldReconnect = Boolean(
        nextUrl
        && this.socketUrl
        && nextUrl !== this.socketUrl
        && (this.socket || this.connectPromise),
      );
      this.config = nextConfig;
      if (shouldReconnect) {
        await this.closeSocketOnly();
      }
      this.socketUrl = nextUrl;
      if (this.socketUrl && !isDeferredWebSocketSession(this.config)) {
        await this.ensureSocket();
      }
      return this.getDetails();
    }

    async handleWorkerOutput(message: WorkerTransportOutputMessage): Promise<boolean> {
      if (message.opcode !== WORKER_TRANSPORT_OUTPUT_OPCODE_WEBSOCKET_JSON) {
        return false;
      }
      if (isDeferredWebSocketSession(this.config)) {
        return false;
      }
      await this.ensureSocket();
      const socket = this.socket;
      if (!socket || !this.opened) {
        return false;
      }
      const payload = message.payload.payload || {};
      const eventType = String(payload.type || "").trim();
      if (eventType === "session.update" || eventType === "response.create") {
        console.error(
          `[sip-pbx:media-worker] websocket attachment send; leg=${this.legId}; url=${this.socketUrl || "null"}; type=${eventType}`,
        );
      }
      return sendWebSocketJson(socket, payload);
    }

    async close(): Promise<void> {
      this.suspend();
      this.closing = true;
      console.error(`[sip-pbx:media-worker] websocket attachment close start; leg=${this.legId}; url=${this.socketUrl || "null"}`);
      await this.closeSocketOnly();
      console.error(`[sip-pbx:media-worker] websocket attachment close done; leg=${this.legId}; url=${this.socketUrl || "null"}`);
    }

    async sendControlJson(payload: Record<string, unknown>): Promise<boolean> {
      if (isDeferredWebSocketSession(this.config)) {
        return false;
      }
      await this.ensureSocket();
      const socket = this.socket;
      if (!socket || !this.opened) {
        return false;
      }
      return sendWebSocketJson(socket, payload);
    }

    private getDetails(): Record<string, unknown> {
      const profile = createWebSocketTransportProfile(this.config);
      return {
        websocketUrl: this.socketUrl,
        transportProfile: String(this.config.transportProfile || "generic"),
        websocketConnected: this.opened,
        websocketAudioInputSampleRate: profile.inputSampleRate,
        websocketAudioOutputSampleRate: profile.outputSampleRate,
      };
    }

    private async ensureSocket(): Promise<void> {
      if (this.socket && this.opened) {
        return;
      }
      if (this.connectPromise) {
        await this.connectPromise;
        return;
      }
      if (!this.socketUrl) {
        return;
      }
      const headers = this.config.websocketHeadersJson && typeof this.config.websocketHeadersJson === "object"
        ? { ...(this.config.websocketHeadersJson as Record<string, unknown>) }
        : {};
      const profile = createWebSocketTransportProfile(this.config);
      const initialMessages = [
        ...profile.buildInitialMessages(),
        ...(Array.isArray(this.config.websocketInitialMessagesJson)
          ? [...this.config.websocketInitialMessagesJson]
          : []),
      ];
      this.connectPromise = new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(this.socketUrl, { headers: headers as Record<string, string> });
        this.connectingSocket = socket;
        let handshakeState: "pending" | "ready" | "failed" = "pending";
        const failReady = (reason: string) => {
          if (handshakeState !== "pending") {
            return;
          }
          handshakeState = "failed";
          this.socket = null;
          this.opened = false;
          this.connectingSocket = null;
          try {
            socket.close();
          } catch (error) {
            console.error(
              `[sip-pbx:media-worker] websocket handshake socket close failed; leg=${this.legId}; url=${this.socketUrl || "null"}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
            );
          }
          reject(new Error(reason || "websocket_ready_failed"));
        };
        socket.once("open", () => {
          if (handshakeState !== "pending") {
            return;
          }
          this.socket = socket;
          this.opened = true;
          this.connectingSocket = null;
          const markReady = () => {
            if (handshakeState !== "pending") {
              return;
            }
            handshakeState = "ready";
            resolve();
          };
          socket.on("message", (payload) => {
            const normalizedPayload = normalizeRawBinaryPayload(payload);
            const parsedPayload =
              typeof normalizedPayload === "string"
                ? parseJsonTextOrRaw(normalizedPayload)
                : Buffer.isBuffer(normalizedPayload)
                  ? parseJsonTextOrRaw(normalizedPayload.toString("utf8"))
                  : normalizedPayload;
            const eventType = extractWebSocketEventType(parsedPayload);
            if (eventType === "error") {
              const errorReason = formatWebSocketErrorReason(parsedPayload);
              const shouldIgnoreError = handshakeState === "ready" && profile.shouldIgnoreWebSocketErrorReason?.(errorReason) === true;
              console.error(
                `[sip-pbx:media-worker] websocket attachment event; leg=${this.legId}; url=${this.socketUrl || "null"}; type=${eventType}; error=${errorReason}${shouldIgnoreError ? "; ignored=true" : ""}`,
              );
              if (shouldIgnoreError) {
                return;
              }
              if (handshakeState === "pending") {
                failReady(errorReason);
                return;
              }
              if (!this.closing && !this.closeNotified) {
                this.closeNotified = true;
                this.deliverTransportClosed(errorReason);
              }
            }
            if (profile.isReadyEvent?.(parsedPayload)) {
              markReady();
            }
            for (const controlEvent of profile.handleVoiceAgentEvent?.(parsedPayload) || []) {
              try {
                this.onVoiceAgentEvent(this.legId, controlEvent);
              } catch (error) {
                console.error(
                  `[sip-pbx:media-worker] websocket voice-agent event callback failed; leg=${this.legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
                );
              }
            }
            this.queueTransportInput({
              kind: WORKER_MESSAGE_KIND_TRANSPORT_INPUT,
              opcode: WORKER_TRANSPORT_INPUT_OPCODE_WEBSOCKET_PAYLOAD,
              payload: {
                legId: this.legId,
                payload: parsedPayload && typeof parsedPayload === "object"
                  ? parsedPayload
                  : normalizedPayload,
              },
            });
          });
          socket.on("close", (code, bufferReason) => {
            this.socket = null;
            this.opened = false;
            const normalizedReason = Buffer.isBuffer(bufferReason) ? bufferReason.toString("utf8") : String(bufferReason || "");
            console.error(
              `[sip-pbx:media-worker] websocket attachment socket close; leg=${this.legId}; url=${this.socketUrl || "null"}; code=${Number(code) || 0}; reason=${normalizedReason || "none"}; closing=${this.closing}`,
            );
            if (!this.closing && !this.closeNotified) {
              this.closeNotified = true;
              this.deliverTransportClosed(normalizedReason || "websocket_closed");
            }
          });
          socket.on("error", (error) => {
            this.socket = null;
            this.opened = false;
            console.error(
              `[sip-pbx:media-worker] websocket attachment socket error; leg=${this.legId}; url=${this.socketUrl || "null"}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
            );
            if (!this.closing && !this.closeNotified) {
              this.closeNotified = true;
              this.deliverTransportClosed("websocket_error");
            }
          });
          for (const message of initialMessages) {
            if (!sendWebSocketMessage(socket, message)) {
              console.error(
                `[sip-pbx:media-worker] websocket initial message send skipped; leg=${this.legId}; url=${this.socketUrl || "null"}; readyState=${socket.readyState}`,
              );
            }
          }
          if (!profile.isReadyEvent) {
            markReady();
          }
        });
        socket.once("error", (error) => {
          if (handshakeState !== "pending") {
            return;
          }
          handshakeState = "failed";
          this.connectingSocket = null;
          reject(error instanceof Error ? error : new Error(String(error || "websocket_connect_failed")));
        });
        socket.once("unexpected-response", (_request, response) => {
          if (handshakeState !== "pending") {
            return;
          }
          handshakeState = "failed";
          this.connectingSocket = null;
          try {
            response.resume();
          } catch (error) {
            console.error(
              `[sip-pbx:media-worker] websocket unexpected-response drain failed; leg=${this.legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
            );
          }
          reject(new Error(`websocket_unexpected_response_${Number(response.statusCode || 0) || "unknown"}`));
        });
        socket.once("close", () => {
          if (handshakeState !== "pending") {
            return;
          }
          handshakeState = "failed";
          this.connectingSocket = null;
          reject(new Error("websocket_closed"));
        });
      }).finally(() => {
        this.connectPromise = null;
      });
      await this.connectPromise;
    }

    private async closeSocketOnly(): Promise<void> {
      this.connectPromise = null;
      this.opened = false;
      const socket = this.socket || this.connectingSocket;
      this.socket = null;
      this.connectingSocket = null;
      if (!socket) {
        return;
      }
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        try {
          socket.close();
        } catch (error) {
          console.error(
            `[sip-pbx:media-worker] websocket socket close failed immediately; leg=${this.legId}; url=${this.socketUrl || "null"}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
          );
          resolve();
        }
      });
    }
  })();
}

export class WebSocketTransport implements MediaTransport {
  readonly transportType = "websocket" as const;
  private readonly listeners = new Set<(event: MediaTransportInputEvent) => void>();
  private readonly externalSendJsonFn: ((payload: Record<string, unknown>) => Promise<boolean>) | null;
  private readonly closeFn: (() => void) | null;
  private readonly createProfile: (config: Record<string, unknown>) => WebSocketTransportProfile;
  private config: Record<string, unknown>;
  private profile: WebSocketTransportProfile;
  private socket: WebSocket | null = null;
  private socketUrl = "";
  private opened = false;
  private connectPromise: Promise<void> | null = null;
  private connectingSocket: WebSocket | null = null;
  private readonly pendingInboundAudioChunks: Buffer[] = [];
  private pendingInboundAudioOffset = 0;
  private pendingInboundAudioBytes = 0;
  private pendingInboundAudioFlush = false;
  private pendingInboundAudioTimer: NodeJS.Timeout | null = null;
  private pendingInboundAudioSampleRate = 0;
  private pendingInboundAudioChannels = 0;
  private pendingInboundAudioEventType = "audio";
  private readonly inboundAudioBufferPool = new InboundAudioBufferPool();

  constructor(input?: {
    sendJson?: (payload: Record<string, unknown>) => Promise<boolean> | boolean | void;
    close?: () => void;
    config?: Record<string, unknown>;
    createProfile?: (config: Record<string, unknown>) => WebSocketTransportProfile;
  }) {
    this.externalSendJsonFn = input?.sendJson
      ? async (payload) => Boolean(await input.sendJson?.(payload))
      : null;
    this.closeFn = input?.close || null;
    this.createProfile = input?.createProfile || createWebSocketTransportProfile;
    this.config = { ...(input?.config || {}) };
    this.profile = this.createProfile(this.config);
  }

  subscribe(listener: (event: MediaTransportInputEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

    async configure(config: Record<string, unknown>): Promise<MediaTransportDetails> {
      this.config = { ...(config || {}) };
      this.profile = this.createProfile(this.config);
      this.resetInboundAudioPlayout();
      this.socketUrl = String(this.config.websocketUrl || this.socketUrl || "");
      if (this.externalSendJsonFn) {
        this.opened = Boolean(this.config.websocketConnected);
        return this.getDetails();
      }
      if (!isDeferredWebSocketSession(this.config)) {
        await this.ensureSocket();
      }
      return this.getDetails();
  }

  getDetails(): MediaTransportDetails {
    return {
      websocketUrl: this.socketUrl || String(this.config.websocketUrl || ""),
      transportProfile: String(this.config.transportProfile || "generic"),
      websocketConnected: this.opened,
      websocketAudioInputSampleRate: this.profile.inputSampleRate,
      websocketAudioOutputSampleRate: this.profile.outputSampleRate,
    };
  }

  handlePayload(payload: unknown): void {
    if (this.shouldSmoothInboundAudio() && this.profile.shouldResetInboundAudioOnEvent?.(payload)) {
      this.resetInboundAudioPlayout();
    }
    for (const action of this.profile.handleEvent(payload)) {
      const normalized = this.normalizeAction(action);
      if (normalized.type === "audio" && this.shouldSmoothInboundAudio()) {
        this.enqueueInboundAudio(normalized);
        continue;
      }
      this.dispatchAudioOrEvent(normalized);
    }
    if (this.shouldSmoothInboundAudio() && this.profile.shouldFlushInboundAudioOnEvent?.(payload)) {
      this.pendingInboundAudioFlush = true;
      this.ensureInboundAudioDrain();
    }
  }

  ingestExternalPayload(payload: unknown): void {
    this.handlePayload(tryParseUnknownJsonPayload(payload));
  }

  handleClosed(reason: string): void {
    this.opened = false;
    this.resetInboundAudioPlayout();
    this.dispatch({ type: "transport", state: "closed", reason: String(reason || "websocket_closed") });
  }

  async sendPlaybackPcm(pcm: Buffer, _marker = false, _bytes = pcm.length): Promise<boolean> {
    if (isDeferredWebSocketSession(this.config)) {
      return false;
    }
    const bytes = Math.max(0, Math.min(Number(_bytes) || 0, pcm.length));
    if (!bytes) {
      return false;
    }
    await this.ensureSocket();
    const pcmBase64 = pcm.subarray(0, bytes).toString("base64");
    let sent = false;
    for (const payload of this.profile.buildAudioAppendMessages(pcmBase64)) {
      sent = (await this.sendJson(payload)) || sent;
    }
    return sent;
  }

  async sendDtmf(_digits: string, _method: string): Promise<boolean> {
    return false;
  }

  close(): void {
    this.resetInboundAudioPlayout();
    this.listeners.clear();
    this.connectPromise = null;
    this.opened = false;
    this.connectingSocket = null;
    if (this.socket) {
      try {
        this.socket.close();
      } catch (error) {
        console.error(
          `[sip-pbx:media] websocket transport close failed; url=${this.socketUrl || "null"}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
        );
      }
      this.socket = null;
    }
    try {
      this.closeFn?.();
    } catch (error) {
      console.error(
        `[sip-pbx:media] websocket transport closeFn failed; url=${this.socketUrl || "null"}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    }
  }

  private dispatch(action: NormalizedWebSocketMediaTransportAction): void {
    // Hot path (50 audio frames/sec/leg). Iterate Set directly to skip a
    // per-frame Array allocation; listeners only mutate at subscribe/close,
    // which can't run concurrently with dispatch.
    for (const listener of this.listeners) {
      try {
        listener(action);
      } catch (error) {
        console.error(
          `[sip-pbx:media-worker] websocket transport listener failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
        );
      }
    }
  }

  private normalizeAction(action: WebSocketTransportAction): NormalizedWebSocketMediaTransportAction {
    if (action.type === "interrupt") {
      return action;
    }
    return {
      type: "audio",
      pcm: Buffer.from(action.audioBase64, "base64"),
      sampleRate: action.sampleRate,
      channels: action.channels,
      eventType: action.eventType,
    };
  }

  private shouldSmoothInboundAudio(): boolean {
    return Boolean(this.profile.smoothInboundAudio);
  }

  private dispatchAudioOrEvent(action: NormalizedWebSocketMediaTransportAction): void {
    this.dispatch(action);
  }

  private enqueueInboundAudio(action: Extract<NormalizedWebSocketMediaTransportAction, { type: "audio" }>): void {
    const sampleRate = Math.max(1, Number(action.sampleRate || this.profile.outputSampleRate || 8000));
    const channels = Math.max(1, Number(action.channels || 1));
    if (
      this.pendingInboundAudioBytes > 0
      && (this.pendingInboundAudioSampleRate !== sampleRate || this.pendingInboundAudioChannels !== channels)
    ) {
      this.resetInboundAudioPlayout();
    }
    this.pendingInboundAudioSampleRate = sampleRate;
    this.pendingInboundAudioChannels = channels;
    this.pendingInboundAudioEventType = String(action.eventType || "audio");
    this.pendingInboundAudioChunks.push(action.pcm);
    this.pendingInboundAudioBytes += action.pcm.length;
    this.ensureInboundAudioDrain();
  }

  private ensureInboundAudioDrain(): void {
    if (this.pendingInboundAudioTimer) {
      return;
    }
    const frameBytes = this.getInboundAudioFrameBytes();
    if (!frameBytes) {
      return;
    }
    if (!this.pendingInboundAudioFlush && this.pendingInboundAudioBytes < frameBytes) {
      return;
    }
    const batchBytes = this.getInboundAudioBatchBytes(frameBytes);
    if (!this.pendingInboundAudioFlush && this.pendingInboundAudioBytes < batchBytes) {
      this.scheduleInboundAudioDrain(this.getInboundAudioFrameDurationMs(frameBytes));
      return;
    }
    this.scheduleInboundAudioDrain(0);
  }

  private scheduleInboundAudioDrain(delayMs: number): void {
    if (this.pendingInboundAudioTimer) {
      return;
    }
    this.pendingInboundAudioTimer = setTimeout(() => {
      this.pendingInboundAudioTimer = null;
      this.drainInboundAudioFrame();
    }, Math.max(0, delayMs));
    this.pendingInboundAudioTimer.unref?.();
  }

  private drainInboundAudioFrame(): void {
    const frameBytes = this.getInboundAudioFrameBytes();
    if (!frameBytes) {
      this.resetInboundAudioPlayout();
      return;
    }
    if (!this.pendingInboundAudioFlush && this.pendingInboundAudioBytes < frameBytes) {
      return;
    }
    if (this.pendingInboundAudioBytes <= 0) {
      this.pendingInboundAudioFlush = false;
      return;
    }
    const batchBytes = this.getInboundAudioBatchBytes(frameBytes);
    const fullFrameBytes = Math.floor(this.pendingInboundAudioBytes / frameBytes) * frameBytes;
    let outputBytes = 0;
    if (fullFrameBytes >= batchBytes) {
      outputBytes = batchBytes;
    } else if (fullFrameBytes >= frameBytes) {
      outputBytes = fullFrameBytes;
    } else if (this.pendingInboundAudioFlush) {
      outputBytes = this.pendingInboundAudioBytes;
    } else {
      return;
    }
    const dispatchBytes = Math.max(frameBytes, outputBytes);
    const frame = this.inboundAudioBufferPool.acquire(dispatchBytes);
    let written = 0;
    while (written < outputBytes && this.pendingInboundAudioBytes > 0) {
      const chunk = this.pendingInboundAudioChunks[0] || null;
      if (!chunk?.length) {
        this.pendingInboundAudioChunks.shift();
        this.pendingInboundAudioOffset = 0;
        continue;
      }
      const available = Math.max(0, chunk.length - this.pendingInboundAudioOffset);
      if (!available) {
        this.pendingInboundAudioChunks.shift();
        this.pendingInboundAudioOffset = 0;
        continue;
      }
      const copied = Math.min(outputBytes - written, available);
      chunk.copy(frame, written, this.pendingInboundAudioOffset, this.pendingInboundAudioOffset + copied);
      written += copied;
      this.pendingInboundAudioOffset += copied;
      this.pendingInboundAudioBytes -= copied;
      if (this.pendingInboundAudioOffset >= chunk.length) {
        this.pendingInboundAudioChunks.shift();
        this.pendingInboundAudioOffset = 0;
      }
    }
    if (written < dispatchBytes) {
      frame.fill(0, written, dispatchBytes);
    }
    const durationMs = this.getInboundAudioFrameDurationMs(dispatchBytes);
    this.dispatchAudioOrEvent({
      type: "audio",
      pcm: frame,
      bytes: dispatchBytes,
      sampleRate: this.pendingInboundAudioSampleRate,
      channels: this.pendingInboundAudioChannels,
      durationMs,
      eventType: this.pendingInboundAudioEventType,
      releasePool: this.inboundAudioBufferPool,
    });
    if (this.pendingInboundAudioBytes > 0 && (this.pendingInboundAudioBytes >= frameBytes || this.pendingInboundAudioFlush)) {
      this.scheduleInboundAudioDrain(durationMs);
      return;
    }
    if (this.pendingInboundAudioBytes <= 0) {
      this.pendingInboundAudioFlush = false;
    }
  }

  private getInboundAudioFrameBytes(): number {
    if (this.pendingInboundAudioSampleRate <= 0 || this.pendingInboundAudioChannels <= 0) {
      return 0;
    }
    return Math.max(
      2,
      Math.round((this.pendingInboundAudioSampleRate / 50) * this.pendingInboundAudioChannels * 2),
    );
  }

  private getInboundAudioBatchBytes(frameBytes: number): number {
    return Math.max(frameBytes, frameBytes * OPENAI_REALTIME_INBOUND_BATCH_FRAMES);
  }

  private getInboundAudioFrameDurationMs(bytes: number): number {
    return Math.max(
      1,
      Math.round((bytes / (2 * this.pendingInboundAudioChannels * this.pendingInboundAudioSampleRate)) * 1000),
    );
  }

  private resetInboundAudioPlayout(): void {
    if (this.pendingInboundAudioTimer) {
      clearTimeout(this.pendingInboundAudioTimer);
      this.pendingInboundAudioTimer = null;
    }
    this.pendingInboundAudioChunks.length = 0;
    this.pendingInboundAudioOffset = 0;
    this.pendingInboundAudioBytes = 0;
    this.pendingInboundAudioFlush = false;
    this.pendingInboundAudioSampleRate = 0;
    this.pendingInboundAudioChannels = 0;
    this.pendingInboundAudioEventType = "audio";
  }

  private async ensureSocket(): Promise<void> {
    if (this.externalSendJsonFn) {
      return;
    }
    if (this.socket && this.opened) {
      return;
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    const url = String(this.config.websocketUrl || "").trim();
    if (!url) {
      throw new Error("WebSocket URL is required");
    }
    const headers = this.config.websocketHeadersJson && typeof this.config.websocketHeadersJson === "object"
      ? { ...(this.config.websocketHeadersJson as Record<string, unknown>) }
      : {};
        const initialMessages = [
      ...this.profile.buildInitialMessages(),
      ...(Array.isArray(this.config.websocketInitialMessagesJson)
        ? [...this.config.websocketInitialMessagesJson]
        : []),
    ];
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { headers: headers as Record<string, string> });
      this.connectingSocket = socket;
      let handshakeState: "pending" | "ready" | "failed" = "pending";
      const failReady = (reason: string) => {
        if (handshakeState !== "pending") {
          return;
        }
        handshakeState = "failed";
        this.socket = null;
        this.opened = false;
        this.connectingSocket = null;
        try {
          socket.close();
        } catch (error) {
          console.error(
            `[sip-pbx:media] websocket transport handshake socket close failed; url=${url}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
          );
        }
        reject(new Error(reason || "websocket_ready_failed"));
      };
      socket.once("open", () => {
        if (handshakeState !== "pending") {
          return;
        }
        this.socket = socket;
        this.socketUrl = url;
        this.opened = true;
        this.connectingSocket = null;
        socket.on("message", (payload) => {
          const normalizedPayload = this.normalizeIncomingPayload(payload);
          const eventType = extractWebSocketEventType(normalizedPayload);
          if (eventType === "error") {
            const errorReason = formatWebSocketErrorReason(normalizedPayload);
            if (handshakeState === "pending") {
              failReady(errorReason);
              return;
            }
            this.dispatch({ type: "transport", state: "closed", reason: errorReason });
            return;
          }
          this.handlePayload(normalizedPayload);
        });
        socket.on("close", () => {
          if (this.socket === socket) {
            this.opened = false;
            this.socket = null;
            this.dispatch({ type: "transport", state: "closed", reason: "websocket_closed" });
          }
        });
        socket.on("error", () => {
          if (this.socket === socket) {
            this.opened = false;
            this.socket = null;
            this.dispatch({ type: "transport", state: "closed", reason: "websocket_error" });
          }
        });
        for (const message of initialMessages) {
          if (!sendWebSocketMessage(socket, message)) {
            console.error(
              `[sip-pbx:media] websocket transport initial message send skipped; url=${url}; readyState=${socket.readyState}`,
            );
          }
        }
        handshakeState = "ready";
        resolve();
      });
      socket.once("error", (error) => {
        if (handshakeState !== "pending") {
          return;
        }
        handshakeState = "failed";
        this.connectingSocket = null;
        try {
          socket.close();
        } catch (error) {
          console.error(
            `[sip-pbx:media] websocket transport close failed after open error; url=${url}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
          );
        }
        reject(error instanceof Error ? error : new Error(String(error || "websocket_connect_failed")));
      });
      socket.once("unexpected-response", (_request, response) => {
        if (handshakeState !== "pending") {
          return;
        }
        handshakeState = "failed";
        this.connectingSocket = null;
        try {
          response.resume();
        } catch (error) {
          console.error(
            `[sip-pbx:media] websocket transport unexpected-response drain failed; url=${url}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
          );
        }
        try {
          socket.close();
        } catch (error) {
          console.error(
            `[sip-pbx:media] websocket transport close failed after unexpected response; url=${url}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
          );
        }
        reject(new Error(`websocket_unexpected_response_${Number(response.statusCode || 0) || "unknown"}`));
      });
      socket.once("close", () => {
        if (handshakeState !== "pending") {
          return;
        }
        handshakeState = "failed";
        this.connectingSocket = null;
        reject(new Error("websocket_closed"));
      });
    }).finally(() => {
      this.connectPromise = null;
    });
    await this.connectPromise;
  }

  private async sendJson(payload: Record<string, unknown>): Promise<boolean> {
    if (this.externalSendJsonFn) {
      return await this.externalSendJsonFn(payload);
    }
    const socket = this.socket;
    if (!socket || !this.opened) {
      return false;
    }
    return sendWebSocketJson(socket, payload);
  }

  private normalizeIncomingPayload(payload: WebSocket.RawData): unknown {
    const normalized = normalizeRawBinaryPayload(payload);
    if (typeof normalized === "string") {
      return parseJsonTextOrRaw(normalized);
    }
    if (Buffer.isBuffer(normalized)) {
      return parseJsonTextOrRaw(normalized.toString("utf8"));
    }
    return normalized;
  }
}

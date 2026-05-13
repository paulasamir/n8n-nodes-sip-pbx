import type { BufferReleasePool } from "../../streams/media-stream";
import { createGeminiLiveWebSocketTransportProfile } from "./gemini-live";
import { createGenericWebSocketTransportProfile } from "./generic";
import { createOpenAiRealtimeWebSocketTransportProfile } from "./openai-realtime";

export type NormalizedWebSocketMediaTransportAction =
  | { type: "audio"; pcm: Buffer; bytes?: number; sampleRate: number; channels: number; durationMs?: number; level?: number; eventType: string; releasePool?: BufferReleasePool | null }
  | { type: "interrupt"; reason: string; eventType: string }
  | { type: "transport"; state: "closed"; reason: string };

export type WebSocketTransportAction =
  | { type: "audio"; audioBase64: string; sampleRate: number; channels: number; eventType: string }
  | { type: "interrupt"; reason: string; eventType: string };

export type WebSocketVoiceAgentToolDescriptor = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type WebSocketVoiceAgentEvent =
  | {
      type: "tool_call";
      eventType: string;
      voiceAgentRequestId: string;
      toolName: string;
      argumentsJson: string;
    }
  | {
      type: "user_transcript";
      eventType: string;
      text: string;
    }
  | {
      type: "assistant_transcript";
      eventType: string;
      text: string;
    };

export type WebSocketTransportProfile = {
  name: string;
  syntheticDialTarget: string | null;
  inputSampleRate: number;
  outputSampleRate: number;
  smoothInboundAudio?: boolean;
  resolveWebSocketUrl(config: Record<string, unknown>): string;
  resolveWebSocketHeaders(config: Record<string, unknown>): Record<string, string>;
  buildInitialMessages(): Array<Record<string, unknown>>;
  buildAudioAppendMessages(pcmBase64: string): Array<Record<string, unknown>>;
  buildVoiceAgentSessionMessages?(input: {
    memoryText?: string;
    tools?: WebSocketVoiceAgentToolDescriptor[];
  }): Array<Record<string, unknown>>;
  buildVoiceAgentToolResultMessages?(input: {
    voiceAgentRequestId: string;
    outputText: string;
    isError?: boolean;
  }): Array<Record<string, unknown>>;
  isReadyEvent?(event: unknown): boolean;
  shouldResetInboundAudioOnEvent?(event: unknown): boolean;
  shouldFlushInboundAudioOnEvent?(event: unknown): boolean;
  shouldIgnoreWebSocketErrorReason?(reason: string): boolean;
  handleEvent(event: unknown): WebSocketTransportAction[];
  handleVoiceAgentEvent?(event: unknown): WebSocketVoiceAgentEvent[];
};

export function extractWebSocketEventType(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "";
  }
  return String((event as Record<string, unknown>).type || "").trim();
}

export function formatWebSocketErrorReason(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "websocket_event_error";
  }
  const payload = event as Record<string, unknown>;
  const nested = payload.error && typeof payload.error === "object"
    ? payload.error as Record<string, unknown>
    : null;
  const type = String((nested?.type || payload.type || "")).trim();
  const code = String((nested?.code || payload.code || "")).trim();
  const message = String((nested?.message || payload.message || "")).trim();
  const param = String((nested?.param || payload.param || "")).trim();
  const parts = [
    type && type !== "error" ? type : "",
    code,
    message,
    param ? `param=${param}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(".") : "websocket_event_error";
}

const WEBSOCKET_TRANSPORT_PROFILE_FACTORIES: Record<string, (config: Record<string, unknown>) => WebSocketTransportProfile> = {
  gemini_live: createGeminiLiveWebSocketTransportProfile,
  generic: createGenericWebSocketTransportProfile,
  openai_realtime: createOpenAiRealtimeWebSocketTransportProfile,
};

export function createWebSocketTransportProfile(config: Record<string, unknown>): WebSocketTransportProfile {
  const profileName = String(config.transportProfile || "").trim();
  if (profileName === "openai_realtime") {
    return createOpenAiRealtimeWebSocketTransportProfile(config);
  }
  return (WEBSOCKET_TRANSPORT_PROFILE_FACTORIES[profileName] || createGenericWebSocketTransportProfile)(config);
}

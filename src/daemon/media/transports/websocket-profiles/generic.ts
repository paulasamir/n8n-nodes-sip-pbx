import { OPTION_DEFAULTS } from "../../../../shared/option-defaults";
import type { WebSocketTransportProfile } from "./index";

function normalizeWebSocketStringList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return fallback.slice();
}

export function createGenericWebSocketTransportProfile(config: Record<string, unknown>): WebSocketTransportProfile {
  const inputEventType = String(config.websocketAudioInputEventType || OPTION_DEFAULTS.dial.websocketAudioInputEventType).trim()
    || OPTION_DEFAULTS.dial.websocketAudioInputEventType;
  const inputField = String(config.websocketAudioInputField || OPTION_DEFAULTS.dial.websocketAudioInputField).trim()
    || OPTION_DEFAULTS.dial.websocketAudioInputField;
  const inputSampleRate = Math.max(
    1,
    Number(config.websocketAudioInputSampleRate || OPTION_DEFAULTS.dial.websocketAudioSampleRate)
      || OPTION_DEFAULTS.dial.websocketAudioSampleRate,
  );
  const outputEventTypes = normalizeWebSocketStringList(
    config.websocketAudioOutputEventTypes,
    [OPTION_DEFAULTS.dial.websocketAudioOutputEventTypesCsv],
  );
  const outputField = String(config.websocketAudioOutputField || OPTION_DEFAULTS.dial.websocketAudioOutputField).trim()
    || OPTION_DEFAULTS.dial.websocketAudioOutputField;
  const outputSampleRate = Math.max(
    1,
    Number(config.websocketAudioOutputSampleRate || OPTION_DEFAULTS.dial.websocketAudioSampleRate)
      || OPTION_DEFAULTS.dial.websocketAudioSampleRate,
  );
  return {
    name: "generic",
    syntheticDialTarget: null,
    inputSampleRate,
    outputSampleRate,
    resolveWebSocketUrl(profileConfig) {
      return String(profileConfig.websocketUrl || "").trim();
    },
    resolveWebSocketHeaders() {
      return {};
    },
    buildInitialMessages() {
      return [];
    },
    buildAudioAppendMessages(pcmBase64: string) {
      return [{ type: inputEventType, [inputField]: pcmBase64 }];
    },
    handleEvent(event: unknown) {
      if (!event || typeof event !== "object") {
        return [];
      }
      const payload = event as Record<string, unknown>;
      const eventType = String(payload.type || payload.event || "").trim();
      if (!eventType) {
        return [];
      }
      if (outputEventTypes.includes(eventType)) {
        const audio = payload[outputField];
        if (audio) {
          return [{
            type: "audio" as const,
            audioBase64: String(audio),
            sampleRate: outputSampleRate,
            channels: 1,
            eventType,
          }];
        }
      }
      return [];
    },
  };
}

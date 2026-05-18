import { OPTION_DEFAULTS } from "../../../../shared/option-defaults";
import type { WebSocketTransportProfile, WebSocketVoiceAgentToolDescriptor } from "./index";

type JsonParseSuccess = {
  ok: true;
  value: unknown;
};

type JsonParseFailure = {
  ok: false;
};

function sanitizeGeminiFunctionParameters(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeGeminiFunctionParameters(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(record)) {
    if (key === "additionalProperties" || key === "$schema") {
      continue;
    }
    sanitized[key] = sanitizeGeminiFunctionParameters(entryValue);
  }
  return sanitized;
}

function normalizeGeminiToolResponsePayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value };
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

function parseJsonTextOrNull(text: string): unknown {
  const parsed = parseJsonText(String(text || "{}"));
  if (!parsed.ok) {
    return null;
  }
  return parsed.value;
}

function buildGeminiSystemInstruction(baseInstructions: string, memoryText: string): string {
  const normalizedBase = String(baseInstructions || "").trim();
  const normalizedMemory = String(memoryText || "").trim();
  if (!normalizedMemory) {
    return normalizedBase;
  }
  return [normalizedBase, `Memory context:\n${normalizedMemory}`].filter(Boolean).join("\n\n");
}

function buildGeminiToolDeclarations(tools: WebSocketVoiceAgentToolDescriptor[]): Array<Record<string, unknown>> {
  if (tools.length === 0) {
    return [];
  }
  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: sanitizeGeminiFunctionParameters(tool.parameters),
    })),
  }];
}

function normalizeGeminiModel(value: unknown): string {
  const model = String(value || OPTION_DEFAULTS.dial.geminiLiveModel).trim() || OPTION_DEFAULTS.dial.geminiLiveModel;
  return `models/${model}`;
}

function extractGeminiAudioMimeSampleRate(mimeType: string, fallback: number): number {
  const match = /rate\s*=\s*(\d+)/i.exec(mimeType);
  return match ? Math.max(1, Number(match[1] || fallback) || fallback) : fallback;
}

export function createGeminiLiveWebSocketTransportProfile(config: Record<string, unknown>): WebSocketTransportProfile {
  const inputSampleRate = Math.max(
    1,
    Number(config.websocketAudioInputSampleRate || OPTION_DEFAULTS.dial.geminiLiveInputSampleRate)
      || OPTION_DEFAULTS.dial.geminiLiveInputSampleRate,
  );
  const outputSampleRate = Math.max(
    1,
    Number(config.websocketAudioOutputSampleRate || OPTION_DEFAULTS.dial.geminiLiveOutputSampleRate)
      || OPTION_DEFAULTS.dial.geminiLiveOutputSampleRate,
  );
  return {
    name: "gemini_live",
    syntheticDialTarget: "gemini_live",
    inputSampleRate,
    outputSampleRate,
    smoothInboundAudio: true,
    resolveWebSocketUrl(profileConfig) {
      const apiVersion = String(profileConfig.geminiLiveApiVersion || OPTION_DEFAULTS.dial.geminiLiveApiVersion).trim()
        || OPTION_DEFAULTS.dial.geminiLiveApiVersion;
      return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${apiVersion}.GenerativeService.BidiGenerateContent`;
    },
    resolveWebSocketHeaders(profileConfig) {
      const headers: Record<string, string> = {};
      const apiKey = String(profileConfig.geminiApiKey || "").trim();
      if (apiKey) {
        headers["x-goog-api-key"] = apiKey;
      }
      return headers;
    },
    buildInitialMessages() {
      const voice = String(config.geminiLiveVoice || OPTION_DEFAULTS.dial.geminiLiveVoice).trim()
        || OPTION_DEFAULTS.dial.geminiLiveVoice;
      const setup: Record<string, unknown> = {
        model: normalizeGeminiModel(config.geminiLiveModel),
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: voice,
              },
            },
          },
        },
      };
      const instructions = buildGeminiSystemInstruction(
        String(config.geminiLiveInstructions || "").trim(),
        String(config.voiceAgentMemoryText || "").trim(),
      );
      if (instructions) {
        setup.systemInstruction = {
          parts: [{ text: instructions }],
        };
      }
      const voiceAgentTools = Array.isArray(config.voiceAgentToolsJson)
        ? (config.voiceAgentToolsJson as unknown[])
            .filter((tool) => tool && typeof tool === "object")
            .map((tool) => tool as WebSocketVoiceAgentToolDescriptor)
        : [];
      if (voiceAgentTools.length > 0) {
        setup.tools = buildGeminiToolDeclarations(voiceAgentTools);
      }
      if (
        voiceAgentTools.length > 0
        || String(config.voiceAgentMemoryText || "").trim()
        || config.voiceAgentEnabled === true
      ) {
        setup.inputAudioTranscription = {};
        setup.outputAudioTranscription = {};
      }
      return [{ setup }];
    },
    buildVoiceAgentToolResultMessages(input) {
      let responsePayload: Record<string, unknown>;
      if (input.isError) {
        responsePayload = { error: String(input.outputText || "tool_error") };
      } else {
        const parsedPayload = parseJsonTextOrNull(String(input.outputText || ""));
        responsePayload = parsedPayload !== null
          ? normalizeGeminiToolResponsePayload(parsedPayload)
          : { result: String(input.outputText || "") };
      }
      return [{
        toolResponse: {
          functionResponses: [{
            id: input.voiceAgentRequestId,
            response: responsePayload,
          }],
        },
      }];
    },
    buildAudioAppendMessages(pcmBase64: string) {
      return [{
        realtimeInput: {
          audio: {
            mimeType: `audio/pcm;rate=${inputSampleRate}`,
            data: pcmBase64,
          },
        },
      }];
    },
    isReadyEvent(event: unknown) {
      return Boolean(event && typeof event === "object" && "setupComplete" in (event as Record<string, unknown>));
    },
    shouldResetInboundAudioOnEvent(event: unknown) {
      if (!event || typeof event !== "object") {
        return false;
      }
      const serverContent = (event as Record<string, unknown>).serverContent;
      return Boolean(serverContent && typeof serverContent === "object" && (serverContent as Record<string, unknown>).interrupted);
    },
    shouldFlushInboundAudioOnEvent(event: unknown) {
      if (!event || typeof event !== "object") {
        return false;
      }
      const serverContent = (event as Record<string, unknown>).serverContent;
      return Boolean(
        serverContent
        && typeof serverContent === "object"
        && (((serverContent as Record<string, unknown>).turnComplete) || ((serverContent as Record<string, unknown>).generationComplete)),
      );
    },
    handleEvent(event: unknown) {
      if (!event || typeof event !== "object") {
        return [];
      }
      const payload = event as Record<string, unknown>;
      const serverContent = payload.serverContent;
      if (!serverContent || typeof serverContent !== "object") {
        return [];
      }
      const content = serverContent as Record<string, unknown>;
      if (content.interrupted) {
        return [{ type: "interrupt" as const, reason: "media_voice", eventType: "serverContent.interrupted" }];
      }
      const modelTurn = content.modelTurn;
      if (!modelTurn || typeof modelTurn !== "object") {
        return [];
      }
      const parts = Array.isArray((modelTurn as Record<string, unknown>).parts)
        ? (modelTurn as Record<string, unknown>).parts as Array<Record<string, unknown>>
        : [];
      const actions = [];
      for (const part of parts) {
        const inlineData = part?.inlineData;
        if (!inlineData || typeof inlineData !== "object") {
          continue;
        }
        const data = String((inlineData as Record<string, unknown>).data || "").trim();
        const mimeType = String((inlineData as Record<string, unknown>).mimeType || "").trim();
        if (!data || !/^audio\/pcm/i.test(mimeType)) {
          continue;
        }
        actions.push({
          type: "audio" as const,
          audioBase64: data,
          sampleRate: extractGeminiAudioMimeSampleRate(mimeType, outputSampleRate),
          channels: 1,
          eventType: "serverContent.modelTurn.inlineData",
        });
      }
      return actions;
    },
    handleVoiceAgentEvent(event: unknown) {
      if (!event || typeof event !== "object") {
        return [];
      }
      const payload = event as Record<string, unknown>;
      const toolCall = payload.toolCall && typeof payload.toolCall === "object"
        ? payload.toolCall as Record<string, unknown>
        : null;
      if (toolCall && Array.isArray(toolCall.functionCalls)) {
        return toolCall.functionCalls
          .filter((entry) => entry && typeof entry === "object")
          .map((entry) => {
            const call = entry as Record<string, unknown>;
            const voiceAgentRequestId = String(call.id || "").trim();
            const toolName = String(call.name || "").trim();
            const args = call.args && typeof call.args === "object" && !Array.isArray(call.args)
              ? call.args
              : {};
            if (!voiceAgentRequestId || !toolName) {
              return null;
            }
            return {
              type: "tool_call" as const,
              eventType: "toolCall.functionCalls",
              voiceAgentRequestId,
              toolName,
              argumentsJson: JSON.stringify(args),
            };
          })
          .filter(Boolean);
      }
      const serverContent = payload.serverContent && typeof payload.serverContent === "object"
        ? payload.serverContent as Record<string, unknown>
        : null;
      const inputTranscription = serverContent?.inputTranscription;
      if (inputTranscription && typeof inputTranscription === "object") {
        const text = String((inputTranscription as Record<string, unknown>).text || "").trim();
        if (text) {
          return [{ type: "user_transcript" as const, eventType: "serverContent.inputTranscription", text }];
        }
      }
      const outputTranscription = serverContent?.outputTranscription;
      if (outputTranscription && typeof outputTranscription === "object") {
        const text = String((outputTranscription as Record<string, unknown>).text || "").trim();
        if (text) {
          return [{ type: "assistant_transcript" as const, eventType: "serverContent.outputTranscription", text }];
        }
      }
      return [];
    },
  };
}

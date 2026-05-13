import { OPTION_DEFAULTS } from "../../../../shared/option-defaults";
import type { WebSocketTransportProfile, WebSocketVoiceAgentToolDescriptor } from "./index";

function buildRealtimeInstructions(baseInstructions: string, memoryText: string): string {
  const normalizedBase = String(baseInstructions || "").trim();
  const normalizedMemory = String(memoryText || "").trim();
  if (!normalizedMemory) {
    return normalizedBase;
  }
  return [normalizedBase, `Memory context:\n${normalizedMemory}`].filter(Boolean).join("\n\n");
}

function buildRealtimeTools(tools: WebSocketVoiceAgentToolDescriptor[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function enableInputAudioTranscription(session: Record<string, unknown>, model: string): void {
  const audio = session.audio && typeof session.audio === "object"
    ? session.audio as Record<string, unknown>
    : {};
  const input = audio.input && typeof audio.input === "object"
    ? audio.input as Record<string, unknown>
    : {};
  input.transcription = {
    model,
  };
  audio.input = input;
  session.audio = audio;
}

function extractAssistantTranscriptFromResponseDone(payload: Record<string, unknown>): string {
  const response = payload.response && typeof payload.response === "object"
    ? payload.response as Record<string, unknown>
    : null;
  const output = Array.isArray(response?.output) ? response.output as Array<Record<string, unknown>> : [];
  const parts: string[] = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content as Array<Record<string, unknown>> : [];
    for (const entry of content) {
      const transcript = String(entry?.transcript || entry?.text || "").trim();
      if (transcript) {
        parts.push(transcript);
      }
    }
  }
  return parts.join("\n").trim();
}

export function createOpenAiRealtimeWebSocketTransportProfile(config: Record<string, unknown>): WebSocketTransportProfile {
  const inputSampleRate = Math.max(
    1,
    Number(config.websocketAudioInputSampleRate || OPTION_DEFAULTS.dial.openaiRealtimeInputSampleRate)
      || OPTION_DEFAULTS.dial.openaiRealtimeInputSampleRate,
  );
  const outputSampleRate = Math.max(
    1,
    Number(config.websocketAudioOutputSampleRate || OPTION_DEFAULTS.dial.openaiRealtimeOutputSampleRate)
      || OPTION_DEFAULTS.dial.openaiRealtimeOutputSampleRate,
  );
  return {
    name: "openai_realtime",
    syntheticDialTarget: "openai_realtime",
    inputSampleRate,
    outputSampleRate,
    smoothInboundAudio: true,
    resolveWebSocketUrl(profileConfig) {
      const model = String(profileConfig.openaiRealtimeModel || OPTION_DEFAULTS.dial.openaiRealtimeModel).trim()
        || OPTION_DEFAULTS.dial.openaiRealtimeModel;
      const baseUrl = "wss://api.openai.com/v1/realtime";
      return model ? `${baseUrl}?model=${encodeURIComponent(model)}` : baseUrl;
    },
    resolveWebSocketHeaders(profileConfig) {
      const headers: Record<string, string> = {};
      const apiKey = String(profileConfig.openaiApiKey || "").trim();
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }
      return headers;
    },
    buildInitialMessages() {
      const model = String(config.openaiRealtimeModel || OPTION_DEFAULTS.dial.openaiRealtimeModel).trim()
        || OPTION_DEFAULTS.dial.openaiRealtimeModel;
      const voice = String(config.openaiRealtimeVoice || OPTION_DEFAULTS.dial.openaiRealtimeVoice).trim()
        || OPTION_DEFAULTS.dial.openaiRealtimeVoice;
      const inputTranscriptionModel = String(
        config.openaiRealtimeInputTranscriptionModel || OPTION_DEFAULTS.dial.openaiRealtimeInputTranscriptionModel,
      ).trim() || OPTION_DEFAULTS.dial.openaiRealtimeInputTranscriptionModel;
      const session: Record<string, unknown> = {
        type: "realtime",
        model,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: inputSampleRate,
            },
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: {
              type: "audio/pcm",
              rate: outputSampleRate,
            },
            voice,
          },
        },
      };
      const instructions = buildRealtimeInstructions(
        String(config.openaiRealtimeInstructions || "").trim(),
        String(config.voiceAgentMemoryText || "").trim(),
      );
      if (instructions) {
        session.instructions = instructions;
      }
      const voiceAgentTools = Array.isArray(config.voiceAgentToolsJson)
        ? (config.voiceAgentToolsJson as unknown[])
            .filter((tool) => tool && typeof tool === "object")
            .map((tool) => tool as WebSocketVoiceAgentToolDescriptor)
        : [];
      if (voiceAgentTools.length > 0) {
        session.tools = buildRealtimeTools(voiceAgentTools);
      }
      if (config.voiceAgentNeedsInputTranscription === true) {
        enableInputAudioTranscription(session, inputTranscriptionModel);
      }
      const promptId = String(config.openaiRealtimePromptId || "").trim();
      if (promptId) {
        const prompt: Record<string, unknown> = { id: promptId };
        const promptVersion = String(config.openaiRealtimePromptVersion || "").trim();
        if (promptVersion) {
          prompt.version = promptVersion;
        }
        const promptVariables = config.openaiRealtimePromptVariablesJson && typeof config.openaiRealtimePromptVariablesJson === "object"
          ? { ...(config.openaiRealtimePromptVariablesJson as Record<string, unknown>) }
          : {};
        if (Object.keys(promptVariables).length > 0) {
          prompt.variables = promptVariables;
        }
        session.prompt = prompt;
      }
      return [{ type: "session.update", session }];
    },
    buildVoiceAgentSessionMessages(input) {
      const session: Record<string, unknown> = {};
      const inputTranscriptionModel = String(
        config.openaiRealtimeInputTranscriptionModel || OPTION_DEFAULTS.dial.openaiRealtimeInputTranscriptionModel,
      ).trim() || OPTION_DEFAULTS.dial.openaiRealtimeInputTranscriptionModel;
      const instructions = buildRealtimeInstructions(
        String(config.openaiRealtimeInstructions || "").trim(),
        String(input.memoryText || "").trim(),
      );
      if (instructions) {
        session.instructions = instructions;
      }
      const tools = Array.isArray(input.tools) ? input.tools : [];
      if (tools.length > 0) {
        session.tools = buildRealtimeTools(tools);
      }
      if (config.voiceAgentNeedsInputTranscription === true) {
        enableInputAudioTranscription(session, inputTranscriptionModel);
      }
      if (Object.keys(session).length === 0) {
        return [];
      }
      // OpenAI Realtime now rejects session.update payloads that omit the
      // top-level discriminator. The initial message in buildInitialMessages
      // already sets type=realtime; subsequent updates from
      // attachVoiceAgent (memory/tools wiring) must carry it too.
      session.type = "realtime";
      return [{ type: "session.update", session }];
    },
    buildVoiceAgentToolResultMessages(input) {
      const outputText = String(input.outputText || "");
      return [
        {
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: input.voiceAgentRequestId,
            output: input.isError ? JSON.stringify({ error: outputText || "tool_error" }) : outputText,
          },
        },
        { type: "response.create" },
      ];
    },
    buildAudioAppendMessages(pcmBase64: string) {
      return [{ type: "input_audio_buffer.append", audio: pcmBase64 }];
    },
    isReadyEvent(event: unknown) {
      if (!event || typeof event !== "object") {
        return false;
      }
      const payload = event as Record<string, unknown>;
      const eventType = String(payload.type || "").trim();
      return eventType === "session.updated";
    },
    shouldResetInboundAudioOnEvent(event: unknown) {
      if (!event || typeof event !== "object") {
        return false;
      }
      const eventType = String((event as Record<string, unknown>).type || "").trim();
      return eventType === "input_audio_buffer.speech_started" || eventType === "response.cancelled";
    },
    shouldFlushInboundAudioOnEvent(event: unknown) {
      return Boolean(event && typeof event === "object" && String((event as Record<string, unknown>).type || "").trim() === "response.done");
    },
    shouldIgnoreWebSocketErrorReason(reason: string) {
      return String(reason || "").includes("response_cancel_not_active");
    },
    handleEvent(event: unknown) {
      if (!event || typeof event !== "object") {
        return [];
      }
      const payload = event as Record<string, unknown>;
      const eventType = String(payload.type || "").trim();
      if (!eventType) {
        return [];
      }
      if ((eventType === "response.output_audio.delta" || eventType === "response.audio.delta") && payload.delta) {
        return [{
          type: "audio" as const,
          audioBase64: String(payload.delta),
          sampleRate: outputSampleRate,
          channels: 1,
          eventType,
        }];
      }
      if (eventType === "input_audio_buffer.speech_started") {
        return [{ type: "interrupt" as const, reason: "voice", eventType }];
      }
      if (eventType === "input_audio_buffer.speech_stopped") {
        return [{ type: "interrupt" as const, reason: "silence", eventType }];
      }
      return [];
    },
    handleVoiceAgentEvent(event: unknown) {
      if (!event || typeof event !== "object") {
        return [];
      }
      const payload = event as Record<string, unknown>;
      const eventType = String(payload.type || "").trim();
      if (!eventType) {
        return [];
      }
      const payloadItem = payload.item && typeof payload.item === "object"
        ? payload.item as Record<string, unknown>
        : null;
      const events = [];
      if (eventType === "response.function_call_arguments.done") {
        const voiceAgentRequestId = String(payload.call_id || payload.item_id || "").trim();
        const toolName = String(payload.name || "").trim();
        const argumentsJson = String(payload.arguments || "{}");
        if (voiceAgentRequestId && toolName) {
          return [...events, { type: "tool_call" as const, eventType, voiceAgentRequestId, toolName, argumentsJson }];
        }
      }
      if (eventType === "conversation.item.input_audio_transcription.completed") {
        const text = String(payload.transcript || "").trim();
        if (text) {
          return [...events, { type: "user_transcript" as const, eventType, text }];
        }
      }
      if (eventType === "response.done") {
        const text = extractAssistantTranscriptFromResponseDone(payload);
        if (text) {
          return [...events, { type: "assistant_transcript" as const, eventType, text }];
        }
      }
      if (eventType === "response.audio_transcript.done" || eventType === "response.output_text.done") {
        const text = String(payload.transcript || payload.text || "").trim();
        if (text) {
          return [...events, { type: "assistant_transcript" as const, eventType, text }];
        }
      }
      return events;
    },
  };
}

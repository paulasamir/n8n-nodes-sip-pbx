import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { readOptions } from "../shared/input-normalization";
import { readCredentialsParameter } from "../shared/credential-loading";
import {
  buildOptionsCollectionProperty,
  type UiProperty,
  WEBSOCKET_PROMPT_VARIABLES_JSON_HINT,
} from "../ui/description-fragments";
import type { WebSocketDialProfileDescriptor } from "./index";

function extendShow(show: Record<string, unknown>): Record<string, unknown> {
  return { ...show, transportProfile: ["openai_realtime"] };
}

function hasOption(options: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(options, name);
}

function readStringOption(options: Record<string, unknown>, name: string): string {
  return String(options[name] || "").trim();
}

function readJsonOption<T = unknown>(options: Record<string, unknown>, name: string, fallback: T): T {
  const raw = options[name];
  if (raw == null || raw === "") {
    return fallback;
  }
  const validateType = (value: unknown): T => {
    if (Array.isArray(fallback)) {
      if (!Array.isArray(value)) {
        throw new Error(`Parameter ${name} must be a JSON array`);
      }
      return value as T;
    }
    if (fallback && typeof fallback === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Parameter ${name} must be a JSON object`);
      }
    }
    return value as T;
  };
  if (typeof raw === "object") {
    return validateType(raw);
  }
  try {
    return validateType(JSON.parse(String(raw)));
  } catch (error) {
    throw new Error(`Parameter ${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildOpenAiRealtimePrimaryProperties(_show: Record<string, unknown>): UiProperty[] {
  const profileShow = extendShow(_show);
  return [
    {
      displayName: "OpenAI API",
      name: "openAiApi",
      type: "credentials",
      default: OPTION_DEFAULTS.common.string,
      displayOptions: { show: profileShow },
    },
  ];
}

function buildOpenAiRealtimeOptionCollections(_show: Record<string, unknown>): UiProperty[] {
  const profileShow = extendShow(_show);
  return [
    buildOptionsCollectionProperty({ show: profileShow }, [
      {
        displayName: "OpenAI Realtime Model",
        name: "openaiRealtimeModel",
        type: "options",
        default: OPTION_DEFAULTS.dial.openaiRealtimeModel,
        typeOptions: { loadOptionsMethod: "getOpenAiRealtimeModels" },
      },
      { displayName: "OpenAI Realtime Voice", name: "openaiRealtimeVoice", type: "string", default: OPTION_DEFAULTS.dial.openaiRealtimeVoice },
      {
        displayName: "OpenAI Input Transcription Model",
        name: "openaiRealtimeInputTranscriptionModel",
        type: "options",
        default: OPTION_DEFAULTS.dial.openaiRealtimeInputTranscriptionModel,
        typeOptions: { loadOptionsMethod: "getOpenAiRealtimeInputTranscriptionModels" },
      },
      { displayName: "OpenAI Instructions", name: "openaiRealtimeInstructions", type: "string", typeOptions: { rows: 4 }, default: OPTION_DEFAULTS.dial.openaiRealtimeInstructions },
      { displayName: "OpenAI Prompt ID", name: "openaiRealtimePromptId", type: "string", default: OPTION_DEFAULTS.dial.openaiRealtimePromptId },
      { displayName: "OpenAI Prompt Version", name: "openaiRealtimePromptVersion", type: "string", default: OPTION_DEFAULTS.dial.openaiRealtimePromptVersion },
      { displayName: "OpenAI Prompt Variables JSON", name: "openaiRealtimePromptVariablesJson", type: "json", default: OPTION_DEFAULTS.dial.openaiRealtimePromptVariablesJson, description: WEBSOCKET_PROMPT_VARIABLES_JSON_HINT },
    ]),
  ];
}

export const openAiRealtimeWebSocketDialProfile: WebSocketDialProfileDescriptor = {
  profileId: "openai_realtime",
  profileOption: { name: "OpenAI Realtime", value: "openai_realtime" },
  buildPrimaryProperties(show) {
    return buildOpenAiRealtimePrimaryProperties(show);
  },
  buildOptionCollections(show) {
    return buildOpenAiRealtimeOptionCollections(show);
  },
  buildCredentials(show) {
    return [
      {
        name: "openAiApi",
        required: true,
        displayOptions: { show: extendShow(show) },
      },
    ];
  },
  async applyInput({ input, index, node }) {
    const credentials = await readCredentialsParameter(node, "openAiApi", index);
    input.openaiApiKey = String(credentials?.apiKey || "").trim();
    const options = readOptions(node, index);
    for (const fieldName of [
      "openaiRealtimeModel",
      "openaiRealtimeVoice",
      "openaiRealtimeInputTranscriptionModel",
      "openaiRealtimeInstructions",
      "openaiRealtimePromptId",
      "openaiRealtimePromptVersion",
    ]) {
      if (hasOption(options, fieldName)) {
        const value = readStringOption(options, fieldName);
        if (value) {
          input[fieldName] = value;
        }
      }
    }
    if (hasOption(options, "openaiRealtimePromptVariablesJson")) {
      input.openaiRealtimePromptVariablesJson = readJsonOption(options, "openaiRealtimePromptVariablesJson", {});
    }
  },
};

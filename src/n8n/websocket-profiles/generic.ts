import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { normalizeStringList } from "../../shared/string-utils";
import {
  readCollectionOptions,
  readStringParameter,
} from "../shared/input-normalization";
import {
  buildAddOptionsCollectionProperty,
  type UiProperty,
  WEBSOCKET_HEADERS_JSON_HINT,
  WEBSOCKET_INITIAL_MESSAGES_JSON_HINT,
  WEBSOCKET_URL_HINT,
} from "../ui/description-fragments";
import type { WebSocketDialProfileDescriptor } from "./index";

function extendShow(show: Record<string, unknown>): Record<string, unknown> {
  return { ...show, transportProfile: ["generic"] };
}

function buildGenericPrimaryProperties(show: Record<string, unknown>): UiProperty[] {
  const profileShow = extendShow(show);
  return [
    {
      displayName: "WebSocket URL",
      name: "websocketUrl",
      type: "string",
      default: "",
      required: true,
      description: WEBSOCKET_URL_HINT,
      displayOptions: { show: profileShow },
    },
  ];
}

function buildGenericOptionCollections(show: Record<string, unknown>): UiProperty[] {
  const profileShow = extendShow(show);
  return [
    buildAddOptionsCollectionProperty("dialOptions", profileShow, [
      {
        displayName: "Generic WebSocket Headers JSON",
        name: "websocketHeadersJson",
        type: "json",
        default: "{}",
        description: WEBSOCKET_HEADERS_JSON_HINT,
      },
      {
        displayName: "Generic WebSocket Initial Messages JSON",
        name: "websocketInitialMessagesJson",
        type: "json",
        default: "[]",
        description: WEBSOCKET_INITIAL_MESSAGES_JSON_HINT,
      },
      {
        displayName: "Generic Outgoing Audio Event Type",
        name: "websocketAudioInputEventType",
        type: "string",
        default: OPTION_DEFAULTS.dial.websocketAudioInputEventType,
      },
      {
        displayName: "Generic Outgoing Audio Field",
        name: "websocketAudioInputField",
        type: "string",
        default: OPTION_DEFAULTS.dial.websocketAudioInputField,
      },
      {
        displayName: "Generic Outgoing Audio Sample Rate",
        name: "websocketAudioInputSampleRate",
        type: "number",
        default: OPTION_DEFAULTS.dial.websocketAudioSampleRate,
      },
      {
        displayName: "Generic Incoming Audio Event Types",
        name: "websocketAudioOutputEventTypes",
        type: "string",
        default: OPTION_DEFAULTS.dial.websocketAudioOutputEventTypesCsv,
      },
      {
        displayName: "Generic Incoming Audio Field",
        name: "websocketAudioOutputField",
        type: "string",
        default: OPTION_DEFAULTS.dial.websocketAudioOutputField,
      },
      {
        displayName: "Generic Incoming Audio Sample Rate",
        name: "websocketAudioOutputSampleRate",
        type: "number",
        default: OPTION_DEFAULTS.dial.websocketAudioSampleRate,
      },
    ]),
  ];
}

export const genericWebSocketDialProfile: WebSocketDialProfileDescriptor = {
  profileId: "generic",
  profileOption: { name: "Generic", value: "generic" },
  buildPrimaryProperties(show) {
    return buildGenericPrimaryProperties(show);
  },
  buildOptionCollections(show) {
    return buildGenericOptionCollections(show);
  },
  buildCredentials() {
    return [];
  },
  applyInput({ input, index, node }) {
    input.websocketUrl = readStringParameter(node, "websocketUrl", index, "");
    const options = readCollectionOptions(node, "dialOptions", index);
    if (Object.prototype.hasOwnProperty.call(options, "websocketHeadersJson")) {
      input.websocketHeadersJson = options.websocketHeadersJson;
    }
    if (Object.prototype.hasOwnProperty.call(options, "websocketInitialMessagesJson")) {
      input.websocketInitialMessagesJson = options.websocketInitialMessagesJson;
    }
    if (Object.prototype.hasOwnProperty.call(options, "websocketAudioInputEventType")) {
      const value = String(options.websocketAudioInputEventType || "").trim();
      if (value) {
        input.websocketAudioInputEventType = value;
      }
    }
    if (Object.prototype.hasOwnProperty.call(options, "websocketAudioInputField")) {
      const value = String(options.websocketAudioInputField || "").trim();
      if (value) {
        input.websocketAudioInputField = value;
      }
    }
    if (Object.prototype.hasOwnProperty.call(options, "websocketAudioInputSampleRate")) {
      const numeric = Number(options.websocketAudioInputSampleRate);
      if (Number.isFinite(numeric)) {
        input.websocketAudioInputSampleRate = numeric;
      }
    }
    if (Object.prototype.hasOwnProperty.call(options, "websocketAudioOutputEventTypes")) {
      input.websocketAudioOutputEventTypes = normalizeStringList(options.websocketAudioOutputEventTypes);
    }
    if (Object.prototype.hasOwnProperty.call(options, "websocketAudioOutputField")) {
      const value = String(options.websocketAudioOutputField || "").trim();
      if (value) {
        input.websocketAudioOutputField = value;
      }
    }
    if (Object.prototype.hasOwnProperty.call(options, "websocketAudioOutputSampleRate")) {
      const numeric = Number(options.websocketAudioOutputSampleRate);
      if (Number.isFinite(numeric)) {
        input.websocketAudioOutputSampleRate = numeric;
      }
    }
  },
};

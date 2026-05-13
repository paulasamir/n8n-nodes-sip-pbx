import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { readCollectionOptions } from "../shared/input-normalization";
import { readCredentialsParameter } from "../shared/credential-loading";
import { buildAddOptionsCollectionProperty, type UiProperty } from "../ui/description-fragments";
import type { WebSocketDialProfileDescriptor } from "./index";

function extendShow(show: Record<string, unknown>): Record<string, unknown> {
  return { ...show, transportProfile: ["gemini_live"] };
}

function hasOption(options: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(options, name);
}

function readStringOption(options: Record<string, unknown>, name: string): string {
  return String(options[name] || "").trim();
}

function buildGeminiLivePrimaryProperties(_show: Record<string, unknown>): UiProperty[] {
  const profileShow = extendShow(_show);
  return [
    {
      displayName: "Gemini API",
      name: "googlePalmApi",
      type: "credentials",
      default: "",
      displayOptions: { show: profileShow },
    },
  ];
}

function buildGeminiLiveOptionCollections(_show: Record<string, unknown>): UiProperty[] {
  const profileShow = extendShow(_show);
  return [
    buildAddOptionsCollectionProperty("dialOptions", profileShow, [
      {
        displayName: "Gemini Live Model",
        name: "geminiLiveModel",
        type: "options",
        default: OPTION_DEFAULTS.dial.geminiLiveModel,
        typeOptions: { loadOptionsMethod: "getGeminiLiveModels" },
      },
      { displayName: "Gemini Live Voice", name: "geminiLiveVoice", type: "string", default: OPTION_DEFAULTS.dial.geminiLiveVoice },
      { displayName: "Gemini Live API Version", name: "geminiLiveApiVersion", type: "string", default: OPTION_DEFAULTS.dial.geminiLiveApiVersion },
      { displayName: "Gemini Live Instructions", name: "geminiLiveInstructions", type: "string", typeOptions: { rows: 4 }, default: "" },
    ]),
  ];
}

export const geminiLiveWebSocketDialProfile: WebSocketDialProfileDescriptor = {
  profileId: "gemini_live",
  profileOption: { name: "Gemini Live", value: "gemini_live" },
  buildPrimaryProperties(show) {
    return buildGeminiLivePrimaryProperties(show);
  },
  buildOptionCollections(show) {
    return buildGeminiLiveOptionCollections(show);
  },
  buildCredentials(show) {
    return [
      {
        name: "googlePalmApi",
        required: true,
        displayOptions: { show: extendShow(show) },
      },
    ];
  },
  async applyInput({ input, index, node }) {
    const credentials = await readCredentialsParameter(node, "googlePalmApi", index);
    input.geminiApiKey = String(credentials?.apiKey || "").trim();
    const options = readCollectionOptions(node, "dialOptions", index);
    for (const fieldName of [
      "geminiLiveModel",
      "geminiLiveVoice",
      "geminiLiveApiVersion",
      "geminiLiveInstructions",
    ]) {
      if (hasOption(options, fieldName)) {
        const value = readStringOption(options, fieldName);
        if (value) {
          input[fieldName] = value;
        }
      }
    }
  },
};

import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import type { NodeParameterReader } from "../shared/input-normalization";
import { readStringParameter } from "../shared/input-normalization";
import type { UiOption, UiProperty } from "../ui/description-fragments";
import { geminiLiveWebSocketDialProfile } from "./gemini-live";
import { genericWebSocketDialProfile } from "./generic";
import { openAiRealtimeWebSocketDialProfile } from "./openai-realtime";

export type WebSocketDialProfileInputContext = {
  input: Record<string, unknown>;
  index: number;
  node: NodeParameterReader;
};

export type WebSocketDialProfileCredential = {
  name: string;
  required: boolean;
  displayOptions: {
    show: Record<string, unknown>;
  };
};

export type WebSocketDialProfileDescriptor = {
  profileId: string;
  profileOption: UiOption;
  buildPrimaryProperties(show: Record<string, unknown>): UiProperty[];
  buildOptionCollections(show: Record<string, unknown>): UiProperty[];
  buildCredentials(show: Record<string, unknown>): WebSocketDialProfileCredential[];
  applyInput(context: WebSocketDialProfileInputContext): Promise<void> | void;
};

const WEBSOCKET_DIAL_PROFILE_REGISTRY: WebSocketDialProfileDescriptor[] = [
  openAiRealtimeWebSocketDialProfile,
  geminiLiveWebSocketDialProfile,
  genericWebSocketDialProfile,
];

export function buildWebSocketDialTransportProfileProperty(show: Record<string, unknown>): UiProperty {
  return {
    displayName: "Transport Profile",
    name: "transportProfile",
    type: "options",
    default: "",
    required: true,
    displayOptions: { show },
    options: WEBSOCKET_DIAL_PROFILE_REGISTRY.map((profile) => profile.profileOption),
  };
}

export function buildWebSocketDialProfileProperties(show: Record<string, unknown>): UiProperty[] {
  return WEBSOCKET_DIAL_PROFILE_REGISTRY.flatMap((profile) => [
    ...profile.buildPrimaryProperties(show),
    ...profile.buildOptionCollections(show),
  ]);
}

export function buildWebSocketDialProfilePrimaryProperties(show: Record<string, unknown>): UiProperty[] {
  return WEBSOCKET_DIAL_PROFILE_REGISTRY.flatMap((profile) => profile.buildPrimaryProperties(show));
}

export function buildWebSocketDialProfileOptionCollections(show: Record<string, unknown>): UiProperty[] {
  return WEBSOCKET_DIAL_PROFILE_REGISTRY.flatMap((profile) => profile.buildOptionCollections(show));
}

export function buildWebSocketDialProfileCredentials(show: Record<string, unknown>): WebSocketDialProfileCredential[] {
  return WEBSOCKET_DIAL_PROFILE_REGISTRY.flatMap((profile) => profile.buildCredentials(show));
}

export async function applyWebSocketDialProfileInput(node: NodeParameterReader, index: number, input: Record<string, unknown>): Promise<void> {
  const transportProfile = readStringParameter(node, "transportProfile", index, "");
  input.transportProfile = transportProfile;
  const profile = WEBSOCKET_DIAL_PROFILE_REGISTRY.find((entry) => entry.profileId === transportProfile);
  if (!profile) {
    throw new Error(`Unsupported websocket transportProfile: ${transportProfile}`);
  }
  await profile.applyInput({ input, index, node });
}

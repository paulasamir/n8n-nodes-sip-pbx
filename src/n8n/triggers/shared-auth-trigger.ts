import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { readFixedCollectionItems, readNumberParameter, readOptions, readStringParameter } from "../shared/input-normalization";

type SharedAuthMode = "static" | "digest-first" | "raw";

type SharedAuthTriggerConfigInput =
  | {
      kind: "extensions";
      authModeName: string;
      staticCredentialsName: string;
      authTimeoutDefault: number;
      continueTraversalDefault: boolean;
    }
  | {
      kind: "trunk";
      authModeName: string;
      staticUsernameName: string;
      staticPasswordName: string;
      authTimeoutDefault: number;
      continueTraversalDefault: boolean;
    };

export type SharedAuthTriggerConfig = {
  authMode: SharedAuthMode;
  authorizationUsernamePrefix: string;
  continueTraversalOnAuthReject: boolean;
  authTimeoutSeconds?: number;
  staticCredentials?: Array<{ username: string; password: string; extension: string }>;
};

function normalizeAuthMode(value: unknown, fallback: SharedAuthMode): SharedAuthMode {
  const mode = String(value || "").trim();
  if (mode === "static" || mode === "digest-first" || mode === "raw") {
    return mode;
  }
  return fallback;
}

function optionalNumber(value: unknown, fallback: number): number {
  if (value == null || value === "") {
    return fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function readSharedAuthTriggerConfig(node: any, index: number, input: SharedAuthTriggerConfigInput): SharedAuthTriggerConfig {
  const authMode = normalizeAuthMode(
    readStringParameter(
      node,
      input.authModeName,
      index,
      input.kind === "extensions" ? OPTION_DEFAULTS.trigger.extensions.authMode : OPTION_DEFAULTS.trigger.trunk.authMode,
    ),
    input.kind === "extensions" ? OPTION_DEFAULTS.trigger.extensions.authMode : OPTION_DEFAULTS.trigger.trunk.authMode,
  );
  const options = readOptions(node, index);
  const config: SharedAuthTriggerConfig = {
    authMode,
    authorizationUsernamePrefix: input.kind === "extensions" && authMode !== "raw"
      ? String(options.authorizationUsernamePrefix || "").trim()
      : "",
    continueTraversalOnAuthReject: options.continueTraversalOnAuthReject === true,
  };
  if (authMode === "static") {
    if (input.kind === "extensions") {
      config.staticCredentials = readFixedCollectionItems(node, input.staticCredentialsName, index).map((entry) => ({
        username: String(entry.username || "").trim(),
        password: String(entry.password || "").trim(),
        extension: String(entry.extension || "").trim(),
      }));
    } else {
      config.staticCredentials = [{
        username: readStringParameter(node, input.staticUsernameName, index, OPTION_DEFAULTS.common.string),
        password: readStringParameter(node, input.staticPasswordName, index, OPTION_DEFAULTS.common.string),
        extension: OPTION_DEFAULTS.common.string,
      }];
    }
    return config;
  }
  config.authTimeoutSeconds = optionalNumber(
    options.authTimeoutSeconds,
    input.authTimeoutDefault,
  );
  return config;
}

import {
  buildHeadersCollectionProperty,
  QUEUE_EXTENSIONS_HINT,
  REF_HINT,
  buildAddOptionsCollectionProperty,
  buildSipListenerOptionEntries,
  buildStaticCredentialsCollectionProperty,
  type UiProperty,
} from "./description-fragments";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import {
  TRUNK_CONNECTION_MODE_DYNAMIC,
  TRUNK_CONNECTION_MODE_FIXED,
  type TrunkConnectionMode,
} from "../../shared/trunk-trigger";

const EXTENSIONS_USERNAME_PREFIX_HINT =
  "The trigger is applicable only when SIP Authorization username starts with this prefix. The prefix is for trigger matching and stripped only for Static credential username lookup. Public auth.username and raw stay unchanged.";
const AI_TOOL_TIMEOUT_HINT =
  "If Respond To AI Tool does not arrive in time, this trigger returns timeout.";
const RECORD_TIMEOUT_HINT =
  "If Respond to recording does not arrive in time, this trigger discards the pending record request.";
const AUTH_TIMEOUT_HINT =
  "If Respond To Auth does not arrive in time, this trigger assumes not_applicable.";

function buildRecordResponseTimeoutOption(defaultSeconds: number): UiProperty {
  return {
    displayName: "Respond to recording timeout (Seconds)",
    name: "recordResponseTimeoutSeconds",
    type: "number",
    default: defaultSeconds,
    description: RECORD_TIMEOUT_HINT,
  };
}

function buildAuthTimeoutOption(defaultSeconds: number): UiProperty {
  return {
    displayName: "Auth Timeout (Seconds)",
    name: "authTimeoutSeconds",
    type: "number",
    default: defaultSeconds,
    description: AUTH_TIMEOUT_HINT,
  };
}

function buildUsernamePrefixOption(): UiProperty {
  return {
    displayName: "Username Prefix",
    name: "authorizationUsernamePrefix",
    type: "string",
    default: "",
    description: EXTENSIONS_USERNAME_PREFIX_HINT,
  };
}

function buildContinueTraversalOnAuthRejectProperty(defaultValue: boolean): UiProperty {
  return {
    displayName: "Continue On Auth Reject",
    name: "continueTraversalOnAuthReject",
    type: "boolean",
    default: defaultValue,
    description: "When enabled, this trigger does not stop auth traversal on auth reject results such as wrong password or workflow deny. The daemon keeps the last reject and returns it only if no later trigger allows or challenges the same request.",
  };
}

function buildAuthModeProperty(name: string, show: Record<string, unknown>, defaultValue: "static" | "digest-first" | "raw"): UiProperty {
  return {
    displayName: "Auth Mode",
    name,
    type: "options",
    default: defaultValue,
    displayOptions: { show },
    options: [
      { name: "Static", value: "static" },
      { name: "Digest First", value: "digest-first" },
      { name: "Raw", value: "raw" },
    ],
  };
}

function buildTrunkStaticCredentialProperties(show: Record<string, unknown>): UiProperty[] {
  return [
    {
      displayName: "Username",
      name: "trunkStaticUsername",
      type: "string",
      default: "",
      required: true,
      displayOptions: { show },
    },
    {
      displayName: "Password",
      name: "trunkStaticPassword",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      displayOptions: { show },
    },
  ];
}

function buildTrunkOptions(
  connectionMode: TrunkConnectionMode,
  useRegistration: boolean,
  recording: boolean,
  authMode: "static" | "digest-first" | "raw",
): UiProperty[] {
  const entries: UiProperty[] = [];
  if (connectionMode === TRUNK_CONNECTION_MODE_FIXED && useRegistration) {
    entries.push({
      displayName: "Registration Expires (Seconds)",
      name: "registrationExpires",
      type: "number",
      default: OPTION_DEFAULTS.sip.registrationExpiresSeconds,
    });
    entries.push(buildHeadersCollectionProperty("REGISTER Headers", "registerHeaders", {}));
  } else if (connectionMode === TRUNK_CONNECTION_MODE_DYNAMIC) {
    if (authMode !== "static") {
      entries.push(buildAuthTimeoutOption(OPTION_DEFAULTS.trigger.trunk.authTimeoutSeconds));
    }
    entries.push(...buildSipListenerOptionEntries("trunk"));
    entries.push(buildContinueTraversalOnAuthRejectProperty(OPTION_DEFAULTS.trigger.trunk.continueTraversalOnAuthReject));
  }
  if (recording) {
    entries.push(buildRecordResponseTimeoutOption(OPTION_DEFAULTS.trigger.trunk.recordResponseTimeoutSeconds));
  }
  return entries;
}

function buildExtensionsOptions(authMode: "static" | "digest-first" | "raw", recording: boolean): UiProperty[] {
  const entries: UiProperty[] = [];
  if (authMode !== "static") {
    entries.push(buildAuthTimeoutOption(OPTION_DEFAULTS.trigger.extensions.authTimeoutSeconds));
  }
  if (recording) {
    entries.push(buildRecordResponseTimeoutOption(OPTION_DEFAULTS.trigger.extensions.recordResponseTimeoutSeconds));
  }
  entries.push(...buildSipListenerOptionEntries("extensions"));
  if (authMode !== "raw") {
    entries.push(buildUsernamePrefixOption());
  }
  entries.push(buildContinueTraversalOnAuthRejectProperty(OPTION_DEFAULTS.trigger.extensions.continueTraversalOnAuthReject));
  return entries;
}

export function buildTriggerNodeProperties(): UiProperty[] {
  const trunkVariants: Array<[TrunkConnectionMode, boolean, boolean, "static" | "digest-first" | "raw"]> = [
    [TRUNK_CONNECTION_MODE_FIXED, false, false, "raw"],
    [TRUNK_CONNECTION_MODE_FIXED, false, true, "raw"],
    [TRUNK_CONNECTION_MODE_FIXED, true, false, "raw"],
    [TRUNK_CONNECTION_MODE_FIXED, true, true, "raw"],
    [TRUNK_CONNECTION_MODE_DYNAMIC, false, false, "static"],
    [TRUNK_CONNECTION_MODE_DYNAMIC, false, false, "digest-first"],
    [TRUNK_CONNECTION_MODE_DYNAMIC, false, false, "raw"],
    [TRUNK_CONNECTION_MODE_DYNAMIC, false, true, "static"],
    [TRUNK_CONNECTION_MODE_DYNAMIC, false, true, "digest-first"],
    [TRUNK_CONNECTION_MODE_DYNAMIC, false, true, "raw"],
  ];
  const trunkOptionsProperties = trunkVariants.map(([connectionMode, useRegistration, recording, authMode]) => {
    const show: Record<string, string[] | boolean[]> = {
      triggerOn: ["trunk"],
      trunkConnectionMode: [connectionMode],
      enableCallRecording: [recording],
    };
    if (connectionMode === TRUNK_CONNECTION_MODE_FIXED) {
      show.trunkUseRegistration = [useRegistration];
    } else {
      show.authMode = [authMode];
    }
    return buildAddOptionsCollectionProperty(
      "trunkOptions",
      show,
      buildTrunkOptions(connectionMode, useRegistration, recording, authMode),
    );
  });

  const extensionsVariants: Array<["static" | "digest-first" | "raw", boolean]> = [
    ["static", false],
    ["static", true],
    ["digest-first", false],
    ["digest-first", true],
    ["raw", false],
    ["raw", true],
  ];
  const extensionsOptionsProperties = extensionsVariants.map(([authMode, recording]) =>
    buildAddOptionsCollectionProperty(
      "extensionsOptions",
      { triggerOn: ["extensions"], authMode: [authMode], extensionsEnableCallRecording: [recording] },
      buildExtensionsOptions(authMode, recording),
    ),
  );

  return [
    {
      displayName: "Trigger On",
      name: "triggerOn",
      type: "options",
      noDataExpression: true,
      required: true,
      default: "",
      options: [
        { name: "Trunk Event", value: "trunk", action: "On trunk event", description: "Receive calls and SIP requests from an external trunk" },
        { name: "Extension Event", value: "extensions", action: "On extension event", description: "Handle internal endpoint registrations and incoming calls from registered extensions" },
        { name: "Queue Event", value: "queue", action: "On queue event", description: "Handle queue lifecycle and dispatch decisions" },
        { name: "AI Tool Call", value: "aiTool", action: "On AI tool call", description: "Handle AI tool calls routed from a live voice-agent session" },
      ],
    },
    {
      displayName: "AI Tool Ref",
      name: "ref",
      type: "string",
      default: "",
      required: true,
      description: REF_HINT,
      displayOptions: { show: { triggerOn: ["aiTool"] } },
    },
    buildAddOptionsCollectionProperty("aiToolOptions", { triggerOn: ["aiTool"] }, [
      {
        displayName: "Respond Timeout (Seconds)",
        name: "aiToolResponseTimeoutSeconds",
        type: "number",
        default: OPTION_DEFAULTS.trigger.aiTool.responseTimeoutSeconds,
        description: AI_TOOL_TIMEOUT_HINT,
      },
    ]),
    {
      displayName: "Trunk Ref",
      name: "ref",
      type: "string",
      default: "",
      required: true,
      description: REF_HINT,
      displayOptions: { show: { triggerOn: ["trunk"] } },
    },
    {
      displayName: "Connection mode",
      name: "trunkConnectionMode",
      type: "options",
      default: OPTION_DEFAULTS.trigger.trunk.connectionMode,
      required: true,
      displayOptions: { show: { triggerOn: ["trunk"] } },
      options: [
        { name: "Fixed Address", value: TRUNK_CONNECTION_MODE_FIXED },
        { name: "Dynamic Address", value: TRUNK_CONNECTION_MODE_DYNAMIC },
      ],
    },
    {
      displayName: "SIP Connection",
      name: "sipPbxExternal",
      type: "credentials",
      default: "",
      displayOptions: { show: { triggerOn: ["trunk"], trunkConnectionMode: [TRUNK_CONNECTION_MODE_FIXED] } },
    },
    {
      displayName: "Use registration",
      name: "trunkUseRegistration",
      type: "boolean",
      default: OPTION_DEFAULTS.trigger.trunk.useRegistration,
      displayOptions: { show: { triggerOn: ["trunk"], trunkConnectionMode: [TRUNK_CONNECTION_MODE_FIXED] } },
    },
    buildAuthModeProperty(
      "authMode",
      { triggerOn: ["trunk"], trunkConnectionMode: [TRUNK_CONNECTION_MODE_DYNAMIC] },
      OPTION_DEFAULTS.trigger.trunk.authMode,
    ),
    ...buildTrunkStaticCredentialProperties({
      triggerOn: ["trunk"],
      trunkConnectionMode: [TRUNK_CONNECTION_MODE_DYNAMIC],
      authMode: ["static"],
    }),
    { displayName: "Global Call Recording", name: "enableCallRecording", type: "boolean", default: OPTION_DEFAULTS.trigger.trunk.enableCallRecording, displayOptions: { show: { triggerOn: ["trunk"] } } },
    ...trunkOptionsProperties,

    {
      displayName: "Extensions Ref",
      name: "ref",
      type: "string",
      default: "",
      required: true,
      description: REF_HINT,
      displayOptions: { show: { triggerOn: ["extensions"] } },
    },
    buildAuthModeProperty("authMode", { triggerOn: ["extensions"] }, OPTION_DEFAULTS.trigger.extensions.authMode),
    buildStaticCredentialsCollectionProperty("staticCredentials", { triggerOn: ["extensions"], authMode: ["static"] }),
    { displayName: "Global Call Recording", name: "extensionsEnableCallRecording", type: "boolean", default: OPTION_DEFAULTS.trigger.extensions.enableCallRecording, displayOptions: { show: { triggerOn: ["extensions"] } } },
    ...extensionsOptionsProperties,

    {
      displayName: "Queue Ref",
      name: "ref",
      type: "string",
      default: "",
      required: true,
      description: REF_HINT,
      displayOptions: { show: { triggerOn: ["queue"] } },
    },
    { displayName: "Extensions", name: "queueExtensions", type: "string", default: "", required: true, description: "Comma-separated extension numbers for queue operators. Example: 101,102,103", displayOptions: { show: { triggerOn: ["queue"] } } },
  ];
}

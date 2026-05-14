import { OPTION_DEFAULTS } from "../../shared/option-defaults";

export type UiOption = {
  name: string;
  value: string | number | boolean;
  description?: string;
  action?: string;
  [key: string]: unknown;
};

export type UiProperty = {
  displayName: string;
  name: string;
  type: string;
  default: unknown;
  description?: string;
  hint?: string;
  options?: unknown[];
  displayOptions?: Record<string, unknown>;
  typeOptions?: Record<string, unknown>;
  required?: boolean;
  noDataExpression?: boolean;
  placeholder?: string;
  credentialTypes?: string[];
  [key: string]: unknown;
};

const RECORDING_FILE_PATH_TEMPLATE_VARIABLES = [
  "kind",
  "ref",
  "legId",
  "callId",
  "from",
  "caller",
  "to",
  "calledNumber",
  "calledName",
  "callerName",
  "extension",
] as const;

const PLAY_TONE_PRESET_HINT = OPTION_DEFAULTS.playTone.presets
  .map((preset) => `${preset.displayName}: ${preset.customTone}`)
  .join(" | ");

export const PLAY_TONE_CUSTOM_HINT = `Syntax: <freqs>/<durationMs>,... Use + to mix frequencies and 0 for silence. Presets: ${PLAY_TONE_PRESET_HINT}.`;
export const RECORDING_FILE_PATH_TEMPLATE_HINT = `Supports ${RECORDING_FILE_PATH_TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(", ")}. Example: {{kind}}/{{ref}}/{{legId}}-{{callId}}.wav. Use JavaScript in the workflow if you need date or time formatting. Relative paths resolve under ~/.n8n/sip-pbx/recordings.`;
export const REF_HINT = "Stable user-defined public name for this trigger group. This value is the public identifier used in runtime state, outputs, and trigger takeover rules, so it should be deliberate and stable. Do not leave it generic. Examples: trunk_main, extensions_sales, queue_support.";
export const BINARY_PROPERTY_HINT = "n8n item.binary property name. Example: data";
export const QUEUE_EXTENSIONS_HINT = "Comma-separated extension numbers. Example: 101,102,103";
export const SIP_SERVER_HINT = "Hostname or IP of the remote SIP server, without the sip: prefix. Example: pbx.example.com";
export const PROXY_SERVER_HINT = "Optional outbound SIP proxy hostname or IP. Example: sip-proxy.example.com";
export const PUBLIC_DOMAIN_HINT = "Optional public SIP host advertised in Contact/Via for NAT setups. Example: sip.example.com";
export const PLAYBACK_FILE_PATH_HINT = "Absolute or relative file path on the n8n host. Example: /var/lib/n8n/audio/welcome.wav";
export const RECORD_FILE_PATH_HINT = "Final absolute or relative output file path on the n8n host. Template variables are not allowed. Example: recordings/call-123.wav";
export const DUCKING_FACTOR_HINT = "1 leaves the mix unchanged. 0..1 attenuates lower-priority playback while this playback stays at gain 1. Values above 1 boost this playback and scale the concurrent mix to max gain 1.";
export const PLAYBACK_HTTP_URL_HINT = "HTTP or HTTPS source URL. Example: https://example.com/audio/welcome.wav";
export const RECORD_HTTP_URL_HINT = "HTTP or HTTPS destination URL. Example: https://api.example.com/upload/call.wav";
export const WEBSOCKET_URL_HINT = "WebSocket URL. Example: wss://example.com/realtime";
export const WEBSOCKET_HEADERS_JSON_HINT = "JSON object with outgoing headers. Example: {\"Authorization\":\"Bearer ...\"}";
export const WEBSOCKET_INITIAL_MESSAGES_JSON_HINT = "JSON array of messages sent immediately after connect. Example: [{\"type\":\"session.start\"}]";
export const WEBSOCKET_PROMPT_VARIABLES_JSON_HINT = "JSON object with prompt variables. Example: {\"customer_name\":\"Alice\"}";

export function buildHeadersCollectionProperty(displayName: string, name: string, show: Record<string, unknown>): UiProperty {
  const property: UiProperty = {
    displayName,
    name,
    type: "fixedCollection",
    typeOptions: { multipleValues: true },
    default: {},
    options: [
      {
        name: "item",
        displayName: "Header",
        values: [
          { displayName: "Name", name: "name", type: "string", default: "", required: true },
          { displayName: "Value", name: "value", type: "string", default: "" },
        ],
      },
    ],
  };
  if (Object.keys(show).length > 0) {
    property.displayOptions = { show };
  }
  return property;
}

export function buildSipDialOptionEntries(): UiProperty[] {
  return [
    {
      displayName: "Call Strategy",
      name: "callStrategy",
      type: "options",
      default: OPTION_DEFAULTS.dial.strategy,
      options: [
        { name: "All In Parallel", value: "parallel" },
        { name: "Sequential", value: "sequential" },
      ],
    },
    {
      displayName: "Sequential Attempt Timeout (Seconds)",
      name: "sequentialAttemptTimeoutSeconds",
      type: "number",
      default: OPTION_DEFAULTS.dial.sequentialAttemptTimeoutSeconds,
      displayOptions: { show: { callStrategy: ["sequential"] } },
    },
    {
      displayName: "Sequential Gap (Seconds)",
      name: "sequentialGapSeconds",
      type: "number",
      default: OPTION_DEFAULTS.dial.sequentialGapSeconds,
      displayOptions: { show: { callStrategy: ["sequential"] } },
    },
    { displayName: "Caller Number", name: "callerNumber", type: "string", default: "" },
    { displayName: "Caller Name", name: "callerName", type: "string", default: "" },
    buildHeadersCollectionProperty("Custom SIP Headers", "customSipHeaders", {}),
  ];
}

export function buildExtensionDialOptionEntries(input?: { includeOnlyFreeEndpoints?: boolean }): UiProperty[] {
  const includeOnlyFreeEndpoints = input?.includeOnlyFreeEndpoints !== false;
  const options = buildSipDialOptionEntries();
  if (!includeOnlyFreeEndpoints) {
    return options;
  }
  return [
    ...options,
    {
      displayName: "Only Free Endpoints",
      name: "extensionListOnlyFreeEndpoints",
      type: "boolean",
      default: OPTION_DEFAULTS.dial.extensionListOnlyFreeEndpoints,
      description: "When enabled, the dial targets only endpoints that are registered and not already in a live call. When disabled, it targets all matching registered endpoints.",
    },
  ];
}

export function buildAddOptionsCollectionProperty(
  name: string,
  show: Record<string, unknown>,
  options: UiProperty[],
): UiProperty {
  return {
    displayName: "Options",
    name,
    type: "collection",
    placeholder: "Add Option",
    default: {},
    displayOptions: { show },
    options,
  };
}

export function buildSipListenerOptionEntries(scope: "trunk" | "extensions"): UiProperty[] {
  const sharedOptions = [
    {
      displayName: "Local Bind Port",
      name: "localBindPort",
      type: "number",
      default: OPTION_DEFAULTS.trigger.extensions.localBindPort,
    },
    {
      displayName: "TLS Bind Port",
      name: "tlsBindPort",
      type: "number",
      default: OPTION_DEFAULTS.trigger.extensions.tlsBindPort,
    },
    {
      displayName: "Local Bind IP",
      name: "localBindIp",
      type: "string",
      default: "",
    },
    {
      displayName: "Advertised IP",
      name: "advertisedIp",
      type: "string",
      default: "",
    },
    {
      displayName: "Realm",
      name: "realm",
      type: "string",
      default: "",
    },
  ];
  if (scope === "extensions") {
    return [
      {
        displayName: "Transport",
        name: "transports",
        type: "multiOptions",
        default: [...OPTION_DEFAULTS.trigger.extensions.transports],
        options: [
          { name: "UDP", value: OPTION_DEFAULTS.sip.transport },
        ],
      },
      ...sharedOptions,
    ];
  }
  return [
    {
      displayName: "Transport",
      name: "transport",
      type: "options",
      default: OPTION_DEFAULTS.sip.transport,
      options: [
        { name: "UDP", value: OPTION_DEFAULTS.sip.transport },
      ],
    },
    ...sharedOptions,
  ];
}

export function buildIdOption(displayName: string, name: "legId" | "dialId" | "mediaId" | "requestId"): UiProperty {
  return {
    displayName,
    name,
    type: "string",
    default: "",
  };
}

export function buildStaticCredentialsCollectionProperty(name: string, show: Record<string, unknown>): UiProperty {
  return {
    displayName: "Static Credentials",
    name,
    type: "fixedCollection",
    typeOptions: { multipleValues: true },
    default: {},
    displayOptions: { show },
    options: [
      {
        name: "item",
        displayName: "Credential",
        values: [
          { displayName: "Username", name: "username", type: "string", default: "", required: true },
          { displayName: "Password", name: "password", type: "string", typeOptions: { password: true }, default: "", required: true },
          { displayName: "Extension", name: "extension", type: "string", default: "", required: true },
        ],
      },
    ],
  };
}

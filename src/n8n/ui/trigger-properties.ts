import {
  buildHeadersCollectionProperty,
  QUEUE_EXTENSIONS_HINT,
  REF_HINT,
  buildAddOptionsCollectionProperty,
  buildStaticCredentialsCollectionProperty,
  type UiProperty,
} from "./description-fragments";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";

const EXTENSIONS_USERNAME_PREFIX_HINT =
  "The trigger is applicable only when SIP Authorization username starts with this prefix. The prefix is for trigger matching and stripped only for Static credential username lookup. Public auth.username and raw stay unchanged.";
const AI_TOOL_TIMEOUT_HINT =
  "If Respond To AI Tool does not arrive in time, this trigger returns timeout.";
const RECORD_TIMEOUT_HINT =
  "If Respond To Record does not arrive in time, this trigger discards the pending record request.";
const AUTH_TIMEOUT_HINT =
  "If Respond To Auth does not arrive in time, this trigger assumes not_applicable.";

function buildContinueTraversalOnAuthRejectProperty(): UiProperty {
  return {
    displayName: "Continue On Auth Reject",
    name: "continueTraversalOnAuthReject",
    type: "boolean",
    default: OPTION_DEFAULTS.trigger.extensions.continueTraversalOnAuthReject,
    description: "When enabled, this trigger does not stop extensions auth traversal on auth reject results such as wrong password or workflow deny. The daemon keeps the last reject and returns it only if no later trigger allows or challenges the same request.",
  };
}

export function buildTriggerNodeProperties(): UiProperty[] {
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
      displayName: "Credential for SIP Connection",
      name: "sipPbxExternal",
      type: "credentials",
      default: "",
      displayOptions: { show: { triggerOn: ["trunk"] } },
    },

    { displayName: "Register On Start", name: "registerOnStart", type: "boolean", default: OPTION_DEFAULTS.trigger.trunk.registerOnStart, displayOptions: { show: { triggerOn: ["trunk"] } } },
    { displayName: "Global Call Recording", name: "enableCallRecording", type: "boolean", default: OPTION_DEFAULTS.trigger.trunk.enableCallRecording, displayOptions: { show: { triggerOn: ["trunk"] } } },
    buildAddOptionsCollectionProperty("trunkOptions", { triggerOn: ["trunk"], registerOnStart: [true], enableCallRecording: [false] }, [
      {
        displayName: "Registration Expires (Seconds)",
        name: "registrationExpires",
        type: "number",
        default: OPTION_DEFAULTS.sip.registrationExpiresSeconds,
      },
      buildHeadersCollectionProperty("REGISTER Headers", "registerHeaders", {}),
    ]),
    buildAddOptionsCollectionProperty("trunkOptions", { triggerOn: ["trunk"], registerOnStart: [false], enableCallRecording: [true] }, [
      {
        displayName: "Respond To Record Timeout (Seconds)",
        name: "recordResponseTimeoutSeconds",
        type: "number",
        default: OPTION_DEFAULTS.trigger.trunk.recordResponseTimeoutSeconds,
        description: RECORD_TIMEOUT_HINT,
      },
    ]),
    buildAddOptionsCollectionProperty("trunkOptions", { triggerOn: ["trunk"], registerOnStart: [true], enableCallRecording: [true] }, [
      {
        displayName: "Registration Expires (Seconds)",
        name: "registrationExpires",
        type: "number",
        default: OPTION_DEFAULTS.sip.registrationExpiresSeconds,
      },
      buildHeadersCollectionProperty("REGISTER Headers", "registerHeaders", {}),
      {
        displayName: "Respond To Record Timeout (Seconds)",
        name: "recordResponseTimeoutSeconds",
        type: "number",
        default: OPTION_DEFAULTS.trigger.trunk.recordResponseTimeoutSeconds,
        description: RECORD_TIMEOUT_HINT,
      },
    ]),

    {
      displayName: "Extensions Ref",
      name: "ref",
      type: "string",
      default: "",
      required: true,
      description: REF_HINT,
      displayOptions: { show: { triggerOn: ["extensions"] } },
    },
    {
      displayName: "Auth Mode",
      name: "authMode",
      type: "options",
      default: OPTION_DEFAULTS.trigger.extensions.authMode,
      displayOptions: { show: { triggerOn: ["extensions"] } },
      options: [
        { name: "Static", value: "static" },
        { name: "Digest First", value: "digest-first" },
        { name: "Raw", value: "raw" },
      ],
    },
    buildStaticCredentialsCollectionProperty("staticCredentials", { triggerOn: ["extensions"], authMode: ["static"] }),
    { displayName: "Global Call Recording", name: "extensionsEnableCallRecording", type: "boolean", default: OPTION_DEFAULTS.trigger.extensions.enableCallRecording, displayOptions: { show: { triggerOn: ["extensions"] } } },
    buildAddOptionsCollectionProperty("extensionsOptions", { triggerOn: ["extensions"], authMode: ["static"], extensionsEnableCallRecording: [false] }, [
      {
        displayName: "Transport",
        name: "extensionTransports",
        type: "multiOptions",
        default: [...OPTION_DEFAULTS.trigger.extensions.transports],
        options: [
          { name: "UDP", value: OPTION_DEFAULTS.sip.transport },
        ],
      },
      {
        displayName: "Local Bind Port",
        name: "extensionsLocalBindPort",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.localBindPort,
      },
      {
        displayName: "TLS Bind Port",
        name: "extensionsTlsBindPort",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.tlsBindPort,
      },
      {
        displayName: "Local Bind IP",
        name: "extensionsLocalBindIp",
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
      {
        displayName: "Username Prefix",
        name: "authorizationUsernamePrefix",
        type: "string",
        default: "",
        description: EXTENSIONS_USERNAME_PREFIX_HINT,
      },
      buildContinueTraversalOnAuthRejectProperty(),
    ]),
    buildAddOptionsCollectionProperty("extensionsOptions", { triggerOn: ["extensions"], authMode: ["static"], extensionsEnableCallRecording: [true] }, [
      {
        displayName: "Respond To Record Timeout (Seconds)",
        name: "recordResponseTimeoutSeconds",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.recordResponseTimeoutSeconds,
        description: RECORD_TIMEOUT_HINT,
      },
      {
        displayName: "Transport",
        name: "extensionTransports",
        type: "multiOptions",
        default: [...OPTION_DEFAULTS.trigger.extensions.transports],
        options: [
          { name: "UDP", value: OPTION_DEFAULTS.sip.transport },
        ],
      },
      {
        displayName: "Local Bind Port",
        name: "extensionsLocalBindPort",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.localBindPort,
      },
      {
        displayName: "TLS Bind Port",
        name: "extensionsTlsBindPort",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.tlsBindPort,
      },
      {
        displayName: "Local Bind IP",
        name: "extensionsLocalBindIp",
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
      {
        displayName: "Username Prefix",
        name: "authorizationUsernamePrefix",
        type: "string",
        default: "",
        description: EXTENSIONS_USERNAME_PREFIX_HINT,
      },
      buildContinueTraversalOnAuthRejectProperty(),
    ]),
    buildAddOptionsCollectionProperty("extensionsOptions", { triggerOn: ["extensions"], authMode: ["digest-first"], extensionsEnableCallRecording: [false] }, [
      {
        displayName: "Auth Timeout (Seconds)",
        name: "authTimeoutSeconds",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.authTimeoutSeconds,
        description: AUTH_TIMEOUT_HINT,
      },
      {
        displayName: "Transport",
        name: "extensionTransports",
        type: "multiOptions",
        default: [...OPTION_DEFAULTS.trigger.extensions.transports],
        options: [
          { name: "UDP", value: OPTION_DEFAULTS.sip.transport },
        ],
      },
      {
        displayName: "Local Bind Port",
        name: "extensionsLocalBindPort",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.localBindPort,
      },
      {
        displayName: "TLS Bind Port",
        name: "extensionsTlsBindPort",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.tlsBindPort,
      },
      {
        displayName: "Local Bind IP",
        name: "extensionsLocalBindIp",
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
      {
        displayName: "Username Prefix",
        name: "authorizationUsernamePrefix",
        type: "string",
        default: "",
        description: EXTENSIONS_USERNAME_PREFIX_HINT,
      },
      buildContinueTraversalOnAuthRejectProperty(),
    ]),
    buildAddOptionsCollectionProperty("extensionsOptions", { triggerOn: ["extensions"], authMode: ["digest-first"], extensionsEnableCallRecording: [true] }, [
      {
        displayName: "Auth Timeout (Seconds)",
        name: "authTimeoutSeconds",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.authTimeoutSeconds,
        description: AUTH_TIMEOUT_HINT,
      },
      {
        displayName: "Respond To Record Timeout (Seconds)",
        name: "recordResponseTimeoutSeconds",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.recordResponseTimeoutSeconds,
        description: RECORD_TIMEOUT_HINT,
      },
      {
        displayName: "Transport",
        name: "extensionTransports",
        type: "multiOptions",
        default: [...OPTION_DEFAULTS.trigger.extensions.transports],
        options: [
          { name: "UDP", value: OPTION_DEFAULTS.sip.transport },
        ],
      },
      {
        displayName: "Local Bind Port",
        name: "extensionsLocalBindPort",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.localBindPort,
      },
      {
        displayName: "TLS Bind Port",
        name: "extensionsTlsBindPort",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.tlsBindPort,
      },
      {
        displayName: "Local Bind IP",
        name: "extensionsLocalBindIp",
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
      {
        displayName: "Username Prefix",
        name: "authorizationUsernamePrefix",
        type: "string",
        default: "",
        description: EXTENSIONS_USERNAME_PREFIX_HINT,
      },
      buildContinueTraversalOnAuthRejectProperty(),
    ]),
    buildAddOptionsCollectionProperty("extensionsOptions", { triggerOn: ["extensions"], authMode: ["raw"], extensionsEnableCallRecording: [false] }, [
      {
        displayName: "Auth Timeout (Seconds)",
        name: "authTimeoutSeconds",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.authTimeoutSeconds,
        description: AUTH_TIMEOUT_HINT,
      },
      {
        displayName: "Transport",
        name: "extensionTransports",
        type: "multiOptions",
        default: [...OPTION_DEFAULTS.trigger.extensions.transports],
        options: [
          { name: "UDP", value: OPTION_DEFAULTS.sip.transport },
        ],
      },
      {
        displayName: "Local Bind Port",
        name: "extensionsLocalBindPort",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.localBindPort,
      },
      {
        displayName: "TLS Bind Port",
        name: "extensionsTlsBindPort",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.tlsBindPort,
      },
      {
        displayName: "Local Bind IP",
        name: "extensionsLocalBindIp",
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
      buildContinueTraversalOnAuthRejectProperty(),
    ]),
    buildAddOptionsCollectionProperty("extensionsOptions", { triggerOn: ["extensions"], authMode: ["raw"], extensionsEnableCallRecording: [true] }, [
      {
        displayName: "Auth Timeout (Seconds)",
        name: "authTimeoutSeconds",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.authTimeoutSeconds,
        description: AUTH_TIMEOUT_HINT,
      },
      {
        displayName: "Respond To Record Timeout (Seconds)",
        name: "recordResponseTimeoutSeconds",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.recordResponseTimeoutSeconds,
        description: RECORD_TIMEOUT_HINT,
      },
      {
        displayName: "Transport",
        name: "extensionTransports",
        type: "multiOptions",
        default: [...OPTION_DEFAULTS.trigger.extensions.transports],
        options: [
          { name: "UDP", value: OPTION_DEFAULTS.sip.transport },
        ],
      },
      {
        displayName: "Local Bind Port",
        name: "extensionsLocalBindPort",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.localBindPort,
      },
      {
        displayName: "TLS Bind Port",
        name: "extensionsTlsBindPort",
        type: "number",
        default: OPTION_DEFAULTS.trigger.extensions.tlsBindPort,
      },
      {
        displayName: "Local Bind IP",
        name: "extensionsLocalBindIp",
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
      buildContinueTraversalOnAuthRejectProperty(),
    ]),

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

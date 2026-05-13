import {
  PROXY_SERVER_HINT,
  PUBLIC_DOMAIN_HINT,
  SIP_SERVER_HINT,
  type UiProperty,
} from "../ui/description-fragments";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";

export class SipPbxExternal {
  name = "sipPbxExternal";
  displayName = "SIP Connection";
  documentationUrl = "https://github.com/siptg/n8n-nodes-sip-pbx/blob/main/docs/credentials/sip-connection.md";
  properties: UiProperty[] = [
    { displayName: "SIP Server", name: "sipServer", type: "string", default: "", required: true, description: SIP_SERVER_HINT },
    { displayName: "Proxy Server", name: "proxyServer", type: "string", default: "", description: PROXY_SERVER_HINT },
    { displayName: "Realm", name: "realm", type: "string", default: "" },
    { displayName: "Port", name: "port", type: "number", default: OPTION_DEFAULTS.sip.port, required: true },
    {
      displayName: "Transport",
      name: "transport",
      type: "options",
      default: OPTION_DEFAULTS.sip.transport,
      required: true,
      options: [
        { name: "UDP", value: OPTION_DEFAULTS.sip.transport },
        // { name: "TCP", value: "tcp" },
        // { name: "TLS", value: "tls" },
      ],
    },
    { displayName: "Username", name: "username", type: "string", default: "" },
    { displayName: "Password", name: "password", type: "string", typeOptions: { password: true }, default: "" },
    { displayName: "Local Bind IP", name: "localBindIp", type: "string", default: "" },
    { displayName: "Local Bind Port", name: "localBindPort", type: "number", default: 0 },
    { displayName: "Use STUN", name: "useStun", type: "boolean", default: true },
    { displayName: "STUN Server", name: "stunServer", type: "string", default: "" },
    { displayName: "STUN Port", name: "stunPort", type: "number", default: OPTION_DEFAULTS.sip.stunPort },
    { displayName: "Public Domain", name: "publicDomain", type: "string", default: "", description: PUBLIC_DOMAIN_HINT },
  ];
}

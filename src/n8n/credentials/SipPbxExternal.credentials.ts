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
  documentationUrl = "https://github.com/siptg/n8n-nodes-sip-pbx/wiki/SIP-Connection-Credential";
  properties: UiProperty[] = [
    { displayName: "SIP Server", name: "sipServer", type: "string", default: OPTION_DEFAULTS.common.string, required: true, description: SIP_SERVER_HINT },
    { displayName: "Proxy Server", name: "proxyServer", type: "string", default: OPTION_DEFAULTS.common.string, description: PROXY_SERVER_HINT },
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
    { displayName: "Username", name: "username", type: "string", default: OPTION_DEFAULTS.common.string },
    { displayName: "Password", name: "password", type: "string", typeOptions: { password: true }, default: OPTION_DEFAULTS.common.string },
    { displayName: "Local Bind IP", name: "localBindIp", type: "string", default: OPTION_DEFAULTS.common.string },
    { displayName: "Local Bind Port", name: "localBindPort", type: "number", default: OPTION_DEFAULTS.sip.localBindPort },
    { displayName: "Public Domain", name: "publicDomain", type: "string", default: OPTION_DEFAULTS.common.string, description: PUBLIC_DOMAIN_HINT },
  ];
}

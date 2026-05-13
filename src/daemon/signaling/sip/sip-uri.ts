export type SipUri = {
  scheme: string;
  user: string;
  host: string;
  port: number | null;
  parameters: Record<string, string>;
};

export type SipNameAddress = {
  displayName: string;
  uri: string;
  parameters: Record<string, string>;
};

export function parseSipUri(value: string): SipUri | null {
  const raw = String(value || "").trim();
  const match = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):(?:([^@;>]+)@)?([^;>:]+|\[[^\]]+\])(?::(\d+))?(.*)$/);
  if (!match) {
    return null;
  }
  const [, scheme, user = "", host, portText, tail = ""] = match;
  return {
    scheme: scheme.toLowerCase(),
    user: decodeURIComponent(user || ""),
    host: host.replace(/^\[|\]$/g, ""),
    port: portText ? Number(portText) : null,
    parameters: parseSipParameters(tail),
  };
}

export function parseSipNameAddress(value: string): SipNameAddress {
  const raw = String(value || "").trim();
  const angleMatch = raw.match(/^\s*(?:"([^"]*)"\s*|([^<"]+?)\s*)?<([^>]+)>(.*)$/);
  if (angleMatch) {
    const [, quotedName = "", bareName = "", uri = "", tail = ""] = angleMatch;
    return {
      displayName: String(quotedName || bareName || "").trim().replace(/^"|"$/g, ""),
      uri: String(uri || "").trim(),
      parameters: parseSipParameters(tail),
    };
  }
  const semicolonIndex = raw.indexOf(";");
  const uri = semicolonIndex >= 0 ? raw.slice(0, semicolonIndex) : raw;
  const tail = semicolonIndex >= 0 ? raw.slice(semicolonIndex) : "";
  return {
    displayName: "",
    uri: uri.trim(),
    parameters: parseSipParameters(tail),
  };
}

export function parseSipParameters(value: string): Record<string, string> {
  const parameters: Record<string, string> = {};
  const tail = String(value || "").trim();
  if (!tail) {
    return parameters;
  }
  for (const part of tail.split(";")) {
    const item = part.trim();
    if (!item) {
      continue;
    }
    const separator = item.indexOf("=");
    if (separator < 0) {
      parameters[item.toLowerCase()] = "";
      continue;
    }
    parameters[item.slice(0, separator).trim().toLowerCase()] = item.slice(separator + 1).trim().replace(/^"|"$/g, "");
  }
  return parameters;
}

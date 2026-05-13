import { parseSipParameters } from "./sip-uri";

export type SipMessage = {
  startLine: string;
  method?: string;
  requestUri?: string;
  statusCode?: number;
  reasonPhrase?: string;
  headers: Record<string, string[]>;
  body: string;
};

export type SipHeaderEntry = {
  name: string;
  value: string;
};

export function parseSipMessage(rawMessage: Buffer | string): SipMessage | null {
  const text = Buffer.isBuffer(rawMessage) ? rawMessage.toString("utf8") : String(rawMessage || "");
  const [headerText, body = ""] = splitHeaderAndBody(text);
  const lines = headerText
    .split(/\r\n|\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }
  const startLine = lines.shift() || "";
  const headers: Record<string, string[]> = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!headers[name]) {
      headers[name] = [];
    }
    headers[name].push(value);
  }
  const responseMatch = startLine.match(/^SIP\/2\.0\s+(\d{3})\s*(.*)$/i);
  if (responseMatch) {
    return {
      startLine,
      statusCode: Number(responseMatch[1]),
      reasonPhrase: String(responseMatch[2] || "").trim(),
      headers,
      body,
    };
  }
  const requestMatch = startLine.match(/^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/i);
  if (!requestMatch) {
    return null;
  }
  return {
    startLine,
    method: requestMatch[1].toUpperCase(),
    requestUri: requestMatch[2],
    headers,
    body,
  };
}

export function getSipHeader(message: SipMessage, name: string): string {
  return (message.headers[String(name || "").toLowerCase()] || [])[0] || "";
}

export function formatSipRequest(input: {
  method: string;
  requestUri: string;
  headers: Record<string, string | number | undefined>;
  extraHeaders?: SipHeaderEntry[];
  body?: string;
}): string {
  return formatSipWire(`${input.method} ${input.requestUri} SIP/2.0`, input.headers, input.body || "", input.extraHeaders);
}

export function formatSipResponse(input: {
  statusCode: number;
  reasonPhrase: string;
  headers: Record<string, string | number | undefined>;
  extraHeaders?: SipHeaderEntry[];
  body?: string;
}): string {
  return formatSipWire(`SIP/2.0 ${input.statusCode} ${input.reasonPhrase}`, input.headers, input.body || "", input.extraHeaders);
}

export function parseCseq(value: string): { sequence: number; method: string } {
  const match = String(value || "").trim().match(/^(\d+)\s+([A-Z]+)$/i);
  if (!match) {
    return { sequence: 0, method: "" };
  }
  return {
    sequence: Number(match[1]),
    method: match[2].toUpperCase(),
  };
}

export function parseContactHeader(value: string): { uri: string; parameters: Record<string, string> } {
  const raw = String(value || "").trim();
  const angleMatch = raw.match(/<([^>]+)>(.*)$/);
  if (angleMatch) {
    return {
      uri: String(angleMatch[1] || "").trim(),
      parameters: parseSipParameters(angleMatch[2] || ""),
    };
  }
  const separator = raw.indexOf(";");
  return {
    uri: separator >= 0 ? raw.slice(0, separator).trim() : raw,
    parameters: separator >= 0 ? parseSipParameters(raw.slice(separator)) : {},
  };
}

function splitHeaderAndBody(text: string): [string, string] {
  const separator = text.indexOf("\r\n\r\n");
  if (separator >= 0) {
    return [text.slice(0, separator), text.slice(separator + 4)];
  }
  const fallbackSeparator = text.indexOf("\n\n");
  if (fallbackSeparator >= 0) {
    return [text.slice(0, fallbackSeparator), text.slice(fallbackSeparator + 2)];
  }
  return [text, ""];
}

function formatSipWire(
  startLine: string,
  headers: Record<string, string | number | undefined>,
  body: string,
  extraHeaders?: SipHeaderEntry[],
): string {
  const lines = [startLine];
  for (const [name, value] of Object.entries(headers || {})) {
    if (value == null || value === "") {
      continue;
    }
    lines.push(`${name}: ${String(value)}`);
  }
  for (const entry of extraHeaders || []) {
    const name = String(entry?.name || "").trim();
    if (!name) {
      continue;
    }
    lines.push(`${name}: ${String(entry.value == null ? "" : entry.value)}`);
  }
  lines.push(`Content-Length: ${Buffer.byteLength(body || "", "utf8")}`);
  return `${lines.join("\r\n")}\r\n\r\n${body || ""}`;
}

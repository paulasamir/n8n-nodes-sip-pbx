export type SipPayloadCodecInfo = {
  codec?: string | null;
  clockRate?: number | null;
  channels?: number;
  fmtp?: string | null;
};

export type ParsedSipSdp = {
  remoteRtpHost: string;
  remoteRtpPort: number;
  payloadTypes: number[];
  dtmfPayloadTypes: number[];
  payloadCodecs: Record<number, SipPayloadCodecInfo>;
};

function normalizeCodecKey(value: string): string {
  return String(value || "").trim().toLowerCase();
}

export function parseSipSdp(body: string): ParsedSipSdp {
  const info: ParsedSipSdp = {
    remoteRtpHost: "",
    remoteRtpPort: 0,
    payloadTypes: [],
    dtmfPayloadTypes: [],
    payloadCodecs: {},
  };
  const dtmfPayloadTypes = new Set<number>();
  for (const line of String(body || "").split(/\r?\n/)) {
    if (line.startsWith("c=IN IP4 ")) {
      info.remoteRtpHost = line.substring(9).trim();
      continue;
    }
    if (line.startsWith("m=audio ")) {
      const parts = line.split(/\s+/);
      info.remoteRtpPort = Number(parts[1] || 0);
      for (const part of parts.slice(3)) {
        const payloadType = Number(part);
        if (Number.isInteger(payloadType) && payloadType >= 0) {
          info.payloadTypes.push(payloadType);
        }
      }
      continue;
    }
    if (line.startsWith("a=rtpmap:")) {
      const match = line.match(/^a=rtpmap:(\d+)\s+([^\/]+)(?:\/(\d+)(?:\/(\d+))?)?/i);
      if (!match) {
        continue;
      }
      const payloadType = Number(match[1]);
      if (!Number.isInteger(payloadType)) {
        continue;
      }
      const codec = normalizeCodecKey(match[2] || "");
      const clockRate = Number(match[3] || 0);
      const channels = Number(match[4] || 1);
      info.payloadCodecs[payloadType] = {
        codec,
        clockRate: Number.isFinite(clockRate) && clockRate > 0 ? clockRate : null,
        channels: Number.isFinite(channels) && channels > 0 ? channels : 1,
      };
      if (codec === "telephone-event") {
        dtmfPayloadTypes.add(payloadType);
      }
      continue;
    }
    if (line.startsWith("a=fmtp:")) {
      const match = line.match(/^a=fmtp:(\d+)\s+(.+)$/i);
      if (!match) {
        continue;
      }
      const payloadType = Number(match[1]);
      if (!Number.isInteger(payloadType)) {
        continue;
      }
      info.payloadCodecs[payloadType] = info.payloadCodecs[payloadType] || {
        codec: "",
        clockRate: null,
        channels: 1,
      };
      info.payloadCodecs[payloadType].fmtp = String(match[2] || "").trim() || null;
    }
  }
  info.dtmfPayloadTypes = Array.from(dtmfPayloadTypes);
  return info;
}

export function buildLocalSipSdp(input: {
  connectionIp: string;
  audioLines?: string[];
}): string {
  const connectionIp = String(input.connectionIp || "").trim();
  const audioLines = Array.isArray(input.audioLines)
    ? input.audioLines.map((line) => String(line || "").trim()).filter(Boolean)
    : [];
  if (!connectionIp || audioLines.length === 0) {
    return "";
  }
  const lines = [
    "v=0",
    `o=- ${Date.now()} ${Date.now()} IN IP4 ${connectionIp}`,
    "s=n8n-sip-pbx",
    `c=IN IP4 ${connectionIp}`,
    "t=0 0",
    ...audioLines,
  ];
  return lines.join("\r\n");
}

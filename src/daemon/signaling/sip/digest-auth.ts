import { createHash, randomBytes } from "crypto";

export type SipDigestAuthorization = {
  scheme: string;
  params: Record<string, string>;
};

export function parseSipAuthorization(value: string): SipDigestAuthorization | null {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const separator = raw.indexOf(" ");
  if (separator < 0) {
    return null;
  }
  const scheme = raw.slice(0, separator).trim();
  const rest = raw.slice(separator + 1).trim();
  const params: Record<string, string> = {};
  const pattern = /([a-zA-Z0-9._-]+)=("([^"]*)"|([^,]+))(?:,\s*|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rest))) {
    params[String(match[1] || "").trim().toLowerCase()] = String(match[3] || match[4] || "").trim();
  }
  return {
    scheme,
    params,
  };
}

export function buildSipDigestChallenge(realm: string, nonce?: string, options?: { stale?: boolean }): string {
  const resolvedNonce = nonce || randomBytes(16).toString("hex");
  const stale = options?.stale ? ", stale=true" : "";
  return `Digest realm="${realm}", nonce="${resolvedNonce}", algorithm=MD5, qop="auth"${stale}`;
}

export function parseSipDigestChallenge(value: string): SipDigestAuthorization | null {
  return parseSipAuthorization(value);
}

export function buildSipDigestAuthorization(input: {
  challenge: SipDigestAuthorization | null;
  method: string;
  requestUri: string;
  username: string;
  password: string;
  nc?: string;
  cnonce?: string;
}): string | null {
  const challenge = input.challenge;
  if (!challenge || String(challenge.scheme || "").toLowerCase() !== "digest") {
    return null;
  }
  const realm = String(challenge.params.realm || "").trim();
  const nonce = String(challenge.params.nonce || "").trim();
  if (!realm || !nonce) {
    return null;
  }
  const algorithm = String(challenge.params.algorithm || "MD5").trim() || "MD5";
  if (algorithm.toUpperCase() !== "MD5") {
    return null;
  }
  const qopRaw = String(challenge.params.qop || "").trim();
  const qopChoices = qopRaw
    .split(",")
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  const qop = qopChoices.includes("auth") ? "auth" : (qopChoices[0] || "");
  const nc = String(input.nc || "00000001");
  const cnonce = String(input.cnonce || randomBytes(8).toString("hex"));
  const ha1 = md5(`${input.username}:${realm}:${input.password}`);
  const ha2 = md5(`${String(input.method || "").toUpperCase()}:${input.requestUri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  const params = [
    `username="${input.username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${input.requestUri}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`,
  ];
  if (qop) {
    params.push(`qop=${qop}`);
    params.push(`nc=${nc}`);
    params.push(`cnonce="${cnonce}"`);
  }
  const opaque = String(challenge.params.opaque || "").trim();
  if (opaque) {
    params.push(`opaque="${opaque}"`);
  }
  return `Digest ${params.join(", ")}`;
}

export function verifySipDigestAuthorization(input: {
  authorization: SipDigestAuthorization | null;
  method: string;
  requestUri: string;
  username: string;
  realm: string;
  password: string;
}): boolean {
  const authorization = input.authorization;
  if (!authorization || authorization.scheme.toLowerCase() !== "digest") {
    return false;
  }
  const params = authorization.params;
  if (String(params.username || "") !== input.username) {
    return false;
  }
  if (String(params.realm || "") !== input.realm) {
    return false;
  }
  const ha1 = md5(`${input.username}:${input.realm}:${input.password}`);
  const ha2 = md5(`${String(input.method || "").toUpperCase()}:${input.requestUri}`);
  const response = String(params.response || "");
  const nonce = String(params.nonce || "");
  if (!response || !nonce) {
    return false;
  }
  const qop = String(params.qop || "");
  if (qop) {
    const nc = String(params.nc || "");
    const cnonce = String(params.cnonce || "");
    return response === md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  }
  return response === md5(`${ha1}:${nonce}:${ha2}`);
}

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

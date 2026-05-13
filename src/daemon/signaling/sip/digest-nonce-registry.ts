import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { SipDigestAuthorization } from "./digest-auth";

export const DEFAULT_SIP_DIGEST_NONCE_TTL_MS = 5 * 60 * 1000;

type SipDigestNonceValidationResult =
  | { ok: true; stale: false }
  | { ok: false; stale: boolean };

const NONCE_VERSION = 1;
const NONCE_ID_BYTES = 8;
const NONCE_EXPIRY_BYTES = 6;
const NONCE_TAG_BYTES = 16;
const NONCE_PAYLOAD_BYTES = 1 + NONCE_EXPIRY_BYTES + NONCE_ID_BYTES;
const NONCE_TOTAL_BYTES = NONCE_PAYLOAD_BYTES + NONCE_TAG_BYTES;

function normalizeNonce(value: unknown): string {
  return String(value || "").trim();
}

function toBase64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function isValidBase64Url(value: string): boolean {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    return false;
  }
  return normalized.length % 4 !== 1;
}

function fromBase64Url(value: string): Buffer | null {
  const normalized = String(value || "").trim();
  if (!isValidBase64Url(normalized)) {
    return null;
  }
  return Buffer.from(normalized, "base64url");
}

export class SipDigestNonceRegistry {
  private readonly secret = randomBytes(32);

  issue(scope: string, realm: string, ttlMs = DEFAULT_SIP_DIGEST_NONCE_TTL_MS): string {
    const normalizedScope = String(scope || "").trim();
    const normalizedRealm = String(realm || "").trim();
    const expiresAtMs = Date.now() + Math.max(1, Math.floor(Number(ttlMs || DEFAULT_SIP_DIGEST_NONCE_TTL_MS)));
    const payload = Buffer.allocUnsafe(NONCE_PAYLOAD_BYTES);
    payload.writeUInt8(NONCE_VERSION, 0);
    payload.writeUIntBE(expiresAtMs, 1, NONCE_EXPIRY_BYTES);
    randomBytes(NONCE_ID_BYTES).copy(payload, 1 + NONCE_EXPIRY_BYTES);
    const tag = this.signPayload(payload, normalizedScope, normalizedRealm);
    return toBase64Url(Buffer.concat([payload, tag]));
  }

  validate(scope: string, realm: string, authorization: SipDigestAuthorization | null): SipDigestNonceValidationResult {
    if (!authorization || String(authorization.scheme || "").toLowerCase() !== "digest") {
      return { ok: false, stale: false };
    }
    const nonce = normalizeNonce(authorization.params?.nonce);
    if (!nonce) {
      return { ok: false, stale: false };
    }
    const parsed = this.parseSignedNonce(nonce, String(scope || "").trim(), String(realm || "").trim());
    if (!parsed) {
      return { ok: false, stale: false };
    }
    if (parsed.expiresAtMs <= Date.now()) {
      return { ok: false, stale: true };
    }
    const qop = String(authorization.params?.qop || "").trim().toLowerCase();
    if (qop !== "auth") {
      return { ok: false, stale: false };
    }
    if (!String(authorization.params?.nc || "").trim() || !String(authorization.params?.cnonce || "").trim()) {
      return { ok: false, stale: false };
    }
    return { ok: true, stale: false };
  }

  private signPayload(payload: Buffer, scope: string, realm: string): Buffer {
    return createHmac("sha256", this.secret)
      .update(payload)
      .update("\0")
      .update(scope)
      .update("\0")
      .update(realm)
      .digest()
      .subarray(0, NONCE_TAG_BYTES);
  }

  private parseSignedNonce(
    nonce: string,
    scope: string,
    realm: string,
  ): { expiresAtMs: number } | null {
    const serialized = fromBase64Url(nonce);
    if (!serialized || serialized.length !== NONCE_TOTAL_BYTES) {
      return null;
    }
    const payload = serialized.subarray(0, NONCE_PAYLOAD_BYTES);
    const providedTag = serialized.subarray(NONCE_PAYLOAD_BYTES);
    if (payload.readUInt8(0) !== NONCE_VERSION) {
      return null;
    }
    const expectedTag = this.signPayload(payload, scope, realm);
    if (providedTag.length !== expectedTag.length || !timingSafeEqual(providedTag, expectedTag)) {
      return null;
    }
    return {
      expiresAtMs: payload.readUIntBE(1, NONCE_EXPIRY_BYTES),
    };
  }
}

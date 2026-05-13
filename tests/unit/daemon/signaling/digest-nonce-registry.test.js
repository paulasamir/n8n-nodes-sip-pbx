"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("SipDigestNonceRegistry accepts issued nonces and marks expired nonces stale", async () => {
  const { SipDigestNonceRegistry } = require("../../../../build-src/daemon/signaling/sip/digest-nonce-registry.js");
  const registry = new SipDigestNonceRegistry();
  const nonce = registry.issue("extensions:alpha", "office.test", 5);
  const authorization = {
    scheme: "Digest",
    params: {
      username: "401",
      realm: "office.test",
      nonce,
      qop: "auth",
      nc: "00000001",
      cnonce: "clientcnonce",
    },
  };

  assert.deepStrictEqual(
    registry.validate("extensions:alpha", "office.test", authorization),
    { ok: true, stale: false },
  );

  const staleNonce = registry.issue("extensions:alpha", "office.test", 1);
  const staleAuthorization = {
    scheme: "Digest",
    params: {
      username: "401",
      realm: "office.test",
      nonce: staleNonce,
      qop: "auth",
      nc: "00000001",
      cnonce: "clientcnonce",
    },
  };
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepStrictEqual(
    registry.validate("extensions:alpha", "office.test", staleAuthorization),
    { ok: false, stale: true },
  );
});

test("SipDigestNonceRegistry keeps expired stateless nonce recognizable across later issues", async () => {
  const { SipDigestNonceRegistry } = require("../../../../build-src/daemon/signaling/sip/digest-nonce-registry.js");
  const registry = new SipDigestNonceRegistry();
  const staleNonce = registry.issue("extensions:alpha", "office.test", 1);
  const staleAuthorization = {
    scheme: "Digest",
    params: {
      username: "401",
      realm: "office.test",
      nonce: staleNonce,
      qop: "auth",
      nc: "00000001",
      cnonce: "clientcnonce",
    },
  };
  await new Promise((resolve) => setTimeout(resolve, 5));
  registry.issue("extensions:alpha", "office.test", 300000);
  assert.deepStrictEqual(
    registry.validate("extensions:alpha", "office.test", staleAuthorization),
    { ok: false, stale: true },
  );
});

test("SipDigestNonceRegistry issues compact stateless nonce values", async () => {
  const { SipDigestNonceRegistry } = require("../../../../build-src/daemon/signaling/sip/digest-nonce-registry.js");
  const registry = new SipDigestNonceRegistry();
  const nonce = registry.issue("extensions:alpha", "office.test", 300000);

  assert.match(nonce, /^[A-Za-z0-9_-]+$/);
  assert.ok(nonce.length <= 44, `Expected compact nonce length <= 44, got ${nonce.length}`);
});

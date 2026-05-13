"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("InteractiveAuthRequestRegistry stores, removes, and sweeps expired requests", async () => {
  const { InteractiveAuthRequestRegistry } = require("../../../../build-src/daemon/extensions-auth/interactive-auth-request-registry.js");
  const registry = new InteractiveAuthRequestRegistry();
  const now = Date.now();
  const request = {
    authRequestId: "auth-1",
    triggerKey: "trigger-1",
    ref: "extensions",
    timeout: 1000,
    requestContext: {
      requestType: "register",
      method: "REGISTER",
    },
    expiresAt: now + 1000,
  };

  registry.storeRequest(request);
  assert.deepStrictEqual(registry.getRequest("auth-1"), request);

  const expiredRequest = {
    ...request,
    authRequestId: "auth-2",
    expiresAt: now - 1,
  };
  registry.storeRequest(expiredRequest);

  const expired = registry.sweepExpired(now);
  assert.deepStrictEqual(expired.map((entry) => entry.authRequestId), ["auth-2"]);
  assert.equal(registry.getRequest("auth-2"), null);

  assert.deepStrictEqual(registry.removeRequest("auth-1"), request);
  assert.equal(registry.getRequest("auth-1"), null);
});

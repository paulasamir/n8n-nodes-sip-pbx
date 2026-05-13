"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("LegWaitService returns event from any waited leg and includes source legId", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { LegWaitService } = require("../../../../build-src/daemon/legs/leg-wait-service.js");
  const { Leg } = require("../../../../build-src/daemon/legs/types.js");

  const registry = new MapRegistry();
  const service = new LegWaitService(registry);
  const legA = Leg.create(registry, {
    legId: "leg-multi-a",
    direction: "inbound",
    transportType: "sip",
  });
  legA.retain("test");
  const legB = Leg.create(registry, {
    legId: "leg-multi-b",
    direction: "inbound",
    transportType: "sip",
  });
  legB.retain("test");

  const waitPromise = service.waitForEvent(["leg-multi-a", "leg-multi-b"], {
    timeoutMs: 250,
    rules: [{ pattern: "123", label: "Sales" }],
  });

  setTimeout(() => {
    legB.publishEvent({ eventType: "dtmf", digits: "123", createdAt: Date.now() });
  }, 25);

  const result = await waitPromise;
  assert.strictEqual(result.output, "matched");
  assert.strictEqual(result.legId, "leg-multi-b");
  assert.strictEqual(result.matchedLabel, "Sales");
});

test("LegWaitService aborts with request_cancelled when request context is cancelled", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { LegWaitService } = require("../../../../build-src/daemon/legs/leg-wait-service.js");
  const { Leg } = require("../../../../build-src/daemon/legs/types.js");
  const { RequestContext } = require("../../../../build-src/daemon/core/request-context.js");

  const registry = new MapRegistry();
  const service = new LegWaitService(registry);
  const leg = Leg.create(registry, {
    legId: "leg-cancelled",
    direction: "inbound",
    transportType: "sip",
  });
  leg.retain("test");
  const context = new RequestContext();

  const waitPromise = service.waitForEvent(leg.legId, {
    timeoutMs: 1000,
    rules: [{ pattern: "123", label: "Sales" }],
  }, context);

  setTimeout(() => {
    context.cancel();
  }, 25);

  await assert.rejects(
    waitPromise,
    (error) => error && error.code === "request_cancelled",
  );
});

test("LegWaitService drops unmatched non-prefix digits immediately when multi-digit fallback is disabled", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { LegWaitService } = require("../../../../build-src/daemon/legs/leg-wait-service.js");
  const { Leg } = require("../../../../build-src/daemon/legs/types.js");

  const registry = new MapRegistry();
  const service = new LegWaitService(registry);
  const leg = Leg.create(registry, {
    legId: "leg-unmatched-digits",
    direction: "inbound",
    transportType: "sip",
  });
  leg.retain("test");

  const waitPromise = service.waitForEvent(leg.legId, {
    timeoutMs: 100,
    interdigitTimeoutMs: 20,
    rules: [{ pattern: "1", label: "One" }],
  });

  setTimeout(() => {
    leg.publishEvent({ eventType: "dtmf", digits: "5", createdAt: Date.now() });
  }, 5);
  setTimeout(() => {
    leg.publishEvent({ eventType: "dtmf", digits: "1", createdAt: Date.now() });
  }, 10);

  const result = await waitPromise;
  assert.strictEqual(result.output, "matched");
  assert.strictEqual(result.matchedLabel, "One");
  assert.strictEqual(result.digits, "1");
});

test("LegWaitService still applies interdigit timeout to unmatched digits when multi-digit fallback is enabled", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { LegWaitService } = require("../../../../build-src/daemon/legs/leg-wait-service.js");
  const { Leg } = require("../../../../build-src/daemon/legs/types.js");

  const registry = new MapRegistry();
  const service = new LegWaitService(registry);
  const leg = Leg.create(registry, {
    legId: "leg-multidigit-fallback",
    direction: "inbound",
    transportType: "sip",
  });
  leg.retain("test");

  const waitPromise = service.waitForEvent(leg.legId, {
    timeoutMs: 100,
    interdigitTimeoutMs: 20,
    rules: [{ pattern: "1", label: "One" }],
    waitDtmfFallbackEnabled: true,
    waitDtmfMultiDigitFallbackEnabled: true,
  });

  setTimeout(() => {
    leg.publishEvent({ eventType: "dtmf", digits: "5", createdAt: Date.now() });
  }, 5);

  const result = await waitPromise;
  assert.strictEqual(result.output, "dtmfFallback");
  assert.strictEqual(result.digits, "5");
});

test("LegWaitService finalizes a shorter exact rule after interdigit timeout when a longer rule shares its prefix", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { LegWaitService } = require("../../../../build-src/daemon/legs/leg-wait-service.js");
  const { Leg } = require("../../../../build-src/daemon/legs/types.js");

  const registry = new MapRegistry();
  const service = new LegWaitService(registry);
  const leg = Leg.create(registry, {
    legId: "leg-shared-prefix",
    direction: "inbound",
    transportType: "sip",
  });
  leg.retain("test");

  const waitPromise = service.waitForEvent(leg.legId, {
    timeoutMs: 100,
    interdigitTimeoutMs: 20,
    rules: [
      { pattern: "12", label: "Two Digits" },
      { pattern: "123", label: "Three Digits" },
    ],
  });

  setTimeout(() => {
    leg.publishEvent({ eventType: "dtmf", digits: "1", createdAt: Date.now() });
  }, 5);
  setTimeout(() => {
    leg.publishEvent({ eventType: "dtmf", digits: "2", createdAt: Date.now() });
  }, 10);

  const result = await waitPromise;
  assert.strictEqual(result.output, "matched");
  assert.strictEqual(result.matchedLabel, "Two Digits");
  assert.strictEqual(result.digits, "12");
});

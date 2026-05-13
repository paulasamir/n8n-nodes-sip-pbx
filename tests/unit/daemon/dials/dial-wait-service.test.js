"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("DialWaitService skips disabled queued ringing/progress events and returns answered", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { DialWaitService } = require("../../../../build-src/daemon/dials/dial-wait-service.js");
  const { Dial } = require("../../../../build-src/daemon/dials/types.js");

  const registry = new MapRegistry();
  const service = new DialWaitService(registry);
  const dial = Dial.create(registry, {
    dialId: "dial-queued-filter",
    strategy: "parallel",
    mode: "trunk",
    targets: ["200"],
  });
  dial.retain("test");
  dial.addAttemptLeg("leg-1");
  dial.publishEvent({ eventType: "ringing", legId: "leg-1", createdAt: Date.now() });
  dial.publishEvent({ eventType: "progress", legId: "leg-1", createdAt: Date.now() });
  dial.publishEvent({ eventType: "answered", legId: "leg-1", createdAt: Date.now() });

  const result = await service.waitForEvent(dial.dialId, {
    timeoutMs: 100,
    waitEventOutputs: [],
  });

  assert.strictEqual(result.eventType, "answered");
  assert.strictEqual(result.legId, "leg-1");
  assert.strictEqual(result.stillDialingLegCount, 1);
});

test("DialWaitService ignores disabled live ringing event and keeps waiting for answered", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { DialWaitService } = require("../../../../build-src/daemon/dials/dial-wait-service.js");
  const { Dial } = require("../../../../build-src/daemon/dials/types.js");

  const registry = new MapRegistry();
  const service = new DialWaitService(registry);
  const dial = Dial.create(registry, {
    dialId: "dial-live-filter",
    strategy: "parallel",
    mode: "trunk",
    targets: ["200"],
  });
  dial.retain("test");
  dial.addAttemptLeg("leg-2");

  const waitPromise = service.waitForEvent(dial.dialId, {
    timeoutMs: 250,
    waitEventOutputs: [],
  });

  dial.publishEvent({ eventType: "ringing", legId: "leg-2", createdAt: Date.now() });
  setTimeout(() => {
    dial.publishEvent({ eventType: "answered", legId: "leg-2", createdAt: Date.now() });
  }, 25);

  const result = await waitPromise;
  assert.strictEqual(result.eventType, "answered");
  assert.strictEqual(result.legId, "leg-2");
  assert.strictEqual(result.stillDialingLegCount, 1);
});

test("DialWaitService returns event from any waited dial and includes source dialId", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { DialWaitService } = require("../../../../build-src/daemon/dials/dial-wait-service.js");
  const { Dial } = require("../../../../build-src/daemon/dials/types.js");

  const registry = new MapRegistry();
  const service = new DialWaitService(registry);
  const dialA = Dial.create(registry, {
    dialId: "dial-multi-a",
    strategy: "parallel",
    mode: "trunk",
    targets: ["200"],
  });
  dialA.retain("test");
  dialA.addAttemptLeg("leg-a");

  const dialB = Dial.create(registry, {
    dialId: "dial-multi-b",
    strategy: "parallel",
    mode: "trunk",
    targets: ["201"],
  });
  dialB.retain("test");
  dialB.addAttemptLeg("leg-b");

  const waitPromise = service.waitForEvent(["dial-multi-a", "dial-multi-b"], {
    timeoutMs: 250,
    waitEventOutputs: [],
  });

  setTimeout(() => {
    dialB.publishEvent({ eventType: "answered", legId: "leg-b", createdAt: Date.now() });
  }, 25);

  const result = await waitPromise;
  assert.strictEqual(result.eventType, "answered");
  assert.strictEqual(result.dialId, "dial-multi-b");
  assert.strictEqual(result.legId, "leg-b");
  assert.strictEqual(result.stillDialingLegCount, 1);
});

test("DialWaitService aborts with request_cancelled when request context is cancelled", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { DialWaitService } = require("../../../../build-src/daemon/dials/dial-wait-service.js");
  const { Dial } = require("../../../../build-src/daemon/dials/types.js");
  const { RequestContext } = require("../../../../build-src/daemon/core/request-context.js");

  const registry = new MapRegistry();
  const service = new DialWaitService(registry);
  const dial = Dial.create(registry, {
    dialId: "dial-cancelled",
    strategy: "parallel",
    mode: "trunk",
    targets: ["200"],
  });
  dial.retain("test");
  const context = new RequestContext();

  const waitPromise = service.waitForEvent(dial.dialId, {
    timeoutMs: 1000,
    waitEventOutputs: [],
  }, context);

  setTimeout(() => {
    context.cancel();
  }, 25);

  await assert.rejects(
    waitPromise,
    (error) => error && error.code === "request_cancelled",
  );
});

test("DialWaitService does not lose terminal event published between initial scan and waiter registration", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { DialWaitService } = require("../../../../build-src/daemon/dials/dial-wait-service.js");
  const { Dial } = require("../../../../build-src/daemon/dials/types.js");

  const registry = new MapRegistry();
  const service = new DialWaitService(registry);
  const dial = Dial.create(registry, {
    dialId: "dial-racy-terminal",
    strategy: "parallel",
    mode: "websocket",
    targets: [""],
  });
  dial.retain("test");
  dial.addAttemptLeg("leg-racy");

  const originalWaitForCancellable = dial.waitForEventCancellable.bind(dial);
  let injected = false;
  dial.waitForEventCancellable = ((predicate, timeoutMs) => {
    if (!injected) {
      injected = true;
      dial.publishEvent({
        eventType: "failed",
        reason: "websocket_error",
        createdAt: Date.now(),
      });
    }
    return originalWaitForCancellable(predicate, timeoutMs);
  });

  const result = await service.waitForEvent(dial.dialId, {
    timeoutMs: 100,
    waitEventOutputs: [],
  });

  assert.strictEqual(result.eventType, "failed");
  assert.strictEqual(result.reason, "websocket_error");
  assert.strictEqual(result.dialId, dial.dialId);
});

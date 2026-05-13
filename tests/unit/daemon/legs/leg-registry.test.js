"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("LegRegistry stores leg instances and leg owns event queue and waiter set", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { Leg } = require("../../../../build-src/daemon/legs/types.js");
  const registry = new MapRegistry();
  const leg = Leg.create(registry, {
    legId: "leg-1",
    direction: "inbound",
    transportType: "sip",
    signalingDetails: {},
    mediaDetails: {},
    triggerMetadata: {},
    onDestroy: async () => undefined,
  });

  const stored = leg;
  assert.equal(stored, leg);

  const waited = leg.waitForEvent((event) => event.eventType === "dtmf", 50);
  leg.publishEvent({ eventType: "dtmf", digits: "5", createdAt: 1 });
  assert.deepStrictEqual(await waited, { eventType: "dtmf", digits: "5", createdAt: 1 });

  assert.equal(registry.get("leg-1"), leg);
  await leg.destroy("test");
  assert.equal(registry.get("leg-1"), null);
});

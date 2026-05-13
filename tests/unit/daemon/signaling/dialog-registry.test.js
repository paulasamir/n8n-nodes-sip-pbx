"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("DialogRegistry indexes dialogs by legId and callId", async () => {
  const { DialogRegistry } = require("../../../../build-src/daemon/signaling/calls/dialog-registry.js");
  const registry = new DialogRegistry();
  const record = {
    legId: "leg-1",
    callId: "call-1",
    direction: "inbound",
  };

  registry.upsert(record);
  assert.deepStrictEqual(registry.getByLegId("leg-1"), record);
  assert.deepStrictEqual(registry.getByCallId("call-1"), record);

  registry.removeByLegId("leg-1");
  assert.equal(registry.getByLegId("leg-1"), null);
  assert.equal(registry.getByCallId("call-1"), null);
});

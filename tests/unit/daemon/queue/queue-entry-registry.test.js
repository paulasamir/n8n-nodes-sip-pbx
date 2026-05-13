"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("QueueEntryRegistry keeps leg ownership and front placement order", async () => {
  const { QueueEntryRegistry } = require("../../../../build-src/daemon/queue/queue-entry-registry.js");
  const registry = new QueueEntryRegistry();
  const first = {
    queueEntryId: "queue-1",
    ref: "support",
    legId: "leg-1",
    status: "waiting",
    createdAt: 1,
    updatedAt: 1,
  };
  const second = {
    queueEntryId: "queue-2",
    ref: "support",
    legId: "leg-2",
    status: "waiting",
    createdAt: 2,
    updatedAt: 2,
  };

  registry.create(first, "back");
  registry.create(second, "front");

  assert.deepStrictEqual(
    registry.listByRef("support").map((entry) => entry.queueEntryId),
    ["queue-2", "queue-1"],
  );
  assert.deepStrictEqual(registry.getByLegId("leg-1"), first);

  assert.deepStrictEqual(registry.removeEntry("queue-1"), first);
  assert.equal(registry.getByLegId("leg-1"), null);
});

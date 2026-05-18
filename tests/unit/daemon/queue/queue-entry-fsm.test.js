"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { QueueEntry } = require("../../../../build-src/daemon/queue/types.js");

function makeTicket() {
  return {
    tag: "test",
    released: false,
    release() {
      this.released = true;
    },
  };
}

function makeEntry(overrides = {}) {
  const retention = overrides.retention || makeTicket();
  return new QueueEntry({
    queueEntryId: overrides.queueEntryId || "qe-1",
    ref: overrides.ref || "queue:main",
    legId: overrides.legId || "leg-1",
    workflowScopeKey: overrides.workflowScopeKey ?? "wf-test",
    trunkRef: overrides.trunkRef ?? "trunk-test",
    retryAttempts: overrides.retryAttempts ?? 3,
    retryPauseMs: overrides.retryPauseMs ?? 30000,
    queueDialConfig: overrides.queueDialConfig || {
      callStrategy: "parallel",
      callerNumber: "",
      callerName: "",
      customSipHeaders: [],
      extensionOnlyFreeEndpoints: true,
      sequentialAttemptTimeoutSeconds: 30,
      sequentialGapSeconds: 1,
    },
    retention,
  });
}

test("new QueueEntry starts in mode=live, state=idle with retention held", () => {
  const ticket = makeTicket();
  const entry = makeEntry({ retention: ticket, workflowScopeKey: "wf-42" });
  assert.strictEqual(entry.mode, "live");
  assert.strictEqual(entry.state, "idle");
  assert.strictEqual(entry.workflowScopeKey, "wf-42",
    "workflowScopeKey captured at construction time");
  assert.strictEqual(entry.dispatchedDialId, null);
  assert.deepStrictEqual(entry.reservedExtensions, []);
  assert.strictEqual(entry.placedPublished, false);
  assert.strictEqual(entry.retryNotBeforeAt, 0);
  assert.strictEqual(entry.retention, ticket);
  assert.strictEqual(ticket.released, false);
  assert.strictEqual(entry.isEnded(), false);
  assert.strictEqual(entry.isDispatching(), false);
});

test("toDispatching records dialId and reservedExtensions; preserves mode and retention", () => {
  const ticket = makeTicket();
  const entry = makeEntry({ retention: ticket });

  entry.toDispatching("dial-42", ["101", "102", "103"]);
  assert.strictEqual(entry.state, "dispatching");
  assert.strictEqual(entry.mode, "live", "mode unchanged");
  assert.strictEqual(entry.dispatchedDialId, "dial-42");
  assert.deepStrictEqual(entry.reservedExtensions, ["101", "102", "103"]);
  assert.strictEqual(entry.retention, ticket, "retention preserved during dispatch");
  assert.strictEqual(ticket.released, false);
  assert.strictEqual(entry.isDispatching(), true);
});

test("toDispatching defensively copies reservedExtensions (caller may mutate the input)", () => {
  const entry = makeEntry();
  const input = ["a", "b"];
  entry.toDispatching("dial-x", input);
  input.push("c");
  assert.deepStrictEqual(entry.reservedExtensions, ["a", "b"],
    "entry.reservedExtensions must not be the same reference as the caller's array");
});

test("toIdle resets dispatch fields without touching mode/retention", () => {
  const ticket = makeTicket();
  const entry = makeEntry({ retention: ticket });
  entry.toDispatching("dial-99", ["100"]);

  entry.toIdle();
  assert.strictEqual(entry.state, "idle");
  assert.strictEqual(entry.mode, "live");
  assert.strictEqual(entry.dispatchedDialId, null);
  assert.deepStrictEqual(entry.reservedExtensions, []);
  assert.strictEqual(entry.retention, ticket);
  assert.strictEqual(ticket.released, false);
});

test("toCallback switches mode to callback and releases retention", () => {
  const ticket = makeTicket();
  const entry = makeEntry({ retention: ticket });
  entry.toDispatching("dial-old", ["200"]);

  entry.toCallback();
  assert.strictEqual(entry.mode, "callback");
  assert.strictEqual(entry.state, "idle", "state resets to idle on callback");
  assert.strictEqual(entry.dispatchedDialId, null);
  assert.deepStrictEqual(entry.reservedExtensions, []);
  assert.strictEqual(entry.retention, null, "retention dropped");
  assert.strictEqual(ticket.released, true, "ticket released");
});

test("toCallback when retention was already released is safe (no double-release)", () => {
  const ticket = makeTicket();
  const entry = makeEntry({ retention: ticket });
  entry.retention.release();
  entry.retention = null;
  // toCallback should not crash even when retention is already null.
  assert.doesNotThrow(() => entry.toCallback());
  assert.strictEqual(entry.mode, "callback");
});

test("toEnded sets state=ended and releases retention idempotently", () => {
  const ticket = makeTicket();
  const entry = makeEntry({ retention: ticket });
  entry.toDispatching("dial-going-away", ["300"]);

  entry.toEnded();
  assert.strictEqual(entry.state, "ended");
  assert.strictEqual(entry.dispatchedDialId, null);
  assert.deepStrictEqual(entry.reservedExtensions, []);
  assert.strictEqual(entry.retention, null);
  assert.strictEqual(ticket.released, true);
  assert.strictEqual(entry.isEnded(), true);
});

test("toEnded called twice is idempotent: ticket not double-released, state stable", () => {
  const ticket = makeTicket();
  let releaseCalls = 0;
  ticket.release = () => {
    releaseCalls += 1;
    ticket.released = true;
  };
  const entry = makeEntry({ retention: ticket });

  entry.toEnded();
  entry.toEnded();
  assert.strictEqual(releaseCalls, 1, "release() not called twice");
  assert.strictEqual(entry.state, "ended");
  assert.strictEqual(entry.retention, null);
});

test("callback flow: toCallback then toDispatching keeps mode=callback", () => {
  const entry = makeEntry();
  entry.toCallback();
  entry.toDispatching("callback-dial", ["500"]);

  assert.strictEqual(entry.mode, "callback", "callback mode survives a new dispatch");
  assert.strictEqual(entry.state, "dispatching");
  assert.strictEqual(entry.dispatchedDialId, "callback-dial");
});

test("callbackEnabled is a pure flag, off by default, settable both ways", () => {
  const entry = makeEntry();
  assert.strictEqual(entry.callbackEnabled, false, "default off");
  entry.callbackEnabled = true;
  assert.strictEqual(entry.callbackEnabled, true);
  entry.callbackEnabled = false;
  assert.strictEqual(entry.callbackEnabled, false);
});

test("toRejoined swaps legId+retention, resets dispatch state, preserves callbackEnabled", () => {
  const oldTicket = makeTicket();
  const newTicket = makeTicket();
  const entry = makeEntry({ retention: oldTicket });
  entry.callbackEnabled = true;
  entry.toCallback();
  entry.placedPublished = true;

  entry.toRejoined("leg-2", newTicket);

  assert.strictEqual(entry.legId, "leg-2", "legId swapped");
  assert.strictEqual(entry.retention, newTicket, "new retention adopted");
  assert.strictEqual(oldTicket.released, true, "old retention released");
  assert.strictEqual(entry.mode, "live", "back on the line");
  assert.strictEqual(entry.state, "idle");
  assert.strictEqual(entry.callbackEnabled, true, "callback flag survives rejoin");
  assert.strictEqual(entry.placedPublished, false, "Placed will fire again");
});

test("updatedAt advances on every transition", async () => {
  const entry = makeEntry();
  const t0 = entry.updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));

  entry.toDispatching("dial-1", ["100"]);
  assert.ok(entry.updatedAt > t0, "updatedAt advanced after toDispatching");

  const t1 = entry.updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  entry.toIdle();
  assert.ok(entry.updatedAt > t1, "updatedAt advanced after toIdle");

  const t2 = entry.updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  entry.toCallback();
  assert.ok(entry.updatedAt > t2, "updatedAt advanced after toCallback");

  const t3 = entry.updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  entry.toEnded();
  assert.ok(entry.updatedAt > t3, "updatedAt advanced after toEnded");
});

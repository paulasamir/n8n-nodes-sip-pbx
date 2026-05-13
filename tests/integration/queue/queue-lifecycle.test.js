"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

async function waitForCondition(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Wait timeout: ${label}`);
}

function createFakeSocket() {
  return {
    end() {},
    on() {},
    once() {},
    off() {},
    removeListener() {},
  };
}

test("queue lifecycle tracks enqueued and callback legs", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-queue-lifecycle.sock");

  try {
    daemon.registerTriggerStream({
      kind: "queue",
      config: {
        ref: "support",
        queueExtensions: [],
        queueRetryPauseSeconds: 0.01,
      },
      socket: createFakeSocket(),
      write() {},
    });

    const leg = daemon.legService.createLeg({
      legId: "queue-leg-1",
      direction: "inbound",
      transportType: "sip",
    });

    daemon.queueService.enqueueLeg("support", leg.legId, "back");
    assert.equal(daemon.queueService.getQueueStats({ ref: "support" }).size, 1);

    daemon.queueService.setQueueCallback(leg.legId);
    assert.equal(daemon.legService.getLeg(leg.legId).status, "callback");

    const removal = daemon.queueService.removeEntryForLeg(leg.legId);
    assert.deepStrictEqual(removal, { legId: leg.legId, removed: true });
    assert.equal(daemon.queueService.getQueueStats({ ref: "support" }).size, 0);
  } finally {
    await daemon.stop();
  }
});

test("flow-scoped queue trigger resolves operator availability across all same-flow extensions refs by extension number", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-queue-flow-scope.sock");
  const published = [];

  try {
    daemon.registerTriggerStream({
      kind: "queue",
      config: {
        ref: "flow:workflow%3Aalpha:queue:ru-support",
        publicRef: "ru-support",
        queueExtensions: ["100", "101"],
        queueRetryPauseSeconds: 0.01,
      },
      socket: createFakeSocket(),
      write(frame) {
        published.push(frame);
      },
    });

    daemon.extensionService.registerEndpoint({
      ref: "flow:workflow%3Aalpha:extensions:office-a",
      extensionNumber: "100",
      contactUri: "sip:100@alpha.local",
    });
    daemon.extensionService.registerEndpoint({
      ref: "flow:workflow%3Aalpha:extensions:office-b",
      extensionNumber: "101",
      contactUri: "sip:101@alpha.local",
    });
    daemon.extensionService.registerEndpoint({
      ref: "flow:workflow%3Abeta:extensions:office-c",
      extensionNumber: "100",
      contactUri: "sip:100@beta.local",
    });

    const leg = daemon.legService.createLeg({
      legId: "queue-leg-flow-alpha",
      direction: "inbound",
      transportType: "sip",
    });

    daemon.queueService.enqueueLeg("flow:workflow%3Aalpha:queue:ru-support", leg.legId, "back");
    await waitForCondition(() => published.length > 0, 1000, "queue caller ready");

    assert.equal(published[0].kind, "queue");
    assert.equal(published[0].branch, "Dispatch");
    assert.equal(published[0].payload.ref, "ru-support");
    assert.ok(String(published[0].payload.dialId || "").trim());
    assert.strictEqual("extensionNumbers" in published[0].payload, false);
    daemon.queueService.removeEntryForLeg(leg.legId);
  } finally {
    await daemon.stop();
  }
});

test("queue retry never republishes Placed after the first enqueue placement", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-queue-single-placed.sock");
  const published = [];

  try {
    daemon.registerTriggerStream({
      kind: "queue",
      config: {
        ref: "support",
        queueExtensions: ["200"],
        queueRetryPauseSeconds: 0.01,
      },
      socket: createFakeSocket(),
      write(frame) {
        published.push(frame);
      },
    });

    daemon.extensionService.registerEndpoint({
      ref: "support",
      extensionNumber: "200",
      contactUri: "sip:200@office.local",
    });
    daemon.legService.createLeg({
      legId: "queue-busy-operator-200",
      direction: "inbound",
      transportType: "sip",
      status: "answered",
      triggerMetadata: {
        ref: "support",
        extensionNumber: "200",
      },
    });

    const waitingLeg = daemon.legService.createLeg({
      legId: "queue-placed-once-leg",
      direction: "inbound",
      transportType: "sip",
      status: "created",
    });
    daemon.queueService.enqueueLeg("support", waitingLeg.legId, "back");
    await waitForCondition(() => published.some((frame) => frame.branch === "Placed"), 1000, "initial placed");

    daemon.legService.hangupLeg("queue-busy-operator-200", "operator_free");
    await waitForCondition(() => published.some((frame) => frame.branch === "Dispatch"), 1000, "dispatch after operator free");
    assert.ok(published.find((frame) => frame.branch === "Dispatch"));

    daemon.legService.createLeg({
      legId: "queue-busy-operator-200-retry",
      direction: "inbound",
      transportType: "sip",
      status: "answered",
      triggerMetadata: {
        ref: "support",
        extensionNumber: "200",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(published.filter((frame) => frame.branch === "Placed").length, 1);
    daemon.queueService.removeEntryForLeg(waitingLeg.legId);
  } finally {
    await daemon.stop();
  }
});

test("queue rejects duplicate enqueue for the same leg", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-queue-duplicate-enqueue.sock");

  try {
    daemon.registerTriggerStream({
      kind: "queue",
      config: {
        ref: "support",
        queueExtensions: [],
        queueRetryPauseSeconds: 0.01,
      },
      socket: createFakeSocket(),
      write() {},
    });

    const leg = daemon.legService.createLeg({
      legId: "queue-duplicate-leg",
      direction: "inbound",
      transportType: "sip",
      status: "created",
    });

    daemon.queueService.enqueueLeg("support", leg.legId, "back");
    assert.throws(
      () => daemon.queueService.enqueueLeg("support", leg.legId, "back"),
      /invalid_queue_entry|already owns an active queue entry/i,
    );
  } finally {
    await daemon.stop();
  }
});

test("queue request timeout retries the entry instead of taking it", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-queue-timeout-retry.sock");
  const published = [];

  try {
    daemon.registerTriggerStream({
      kind: "queue",
      config: {
        ref: "support",
        queueExtensions: ["200"],
        queueRetryPauseSeconds: 0.01,
      },
      socket: createFakeSocket(),
      write(frame) {
        published.push(frame);
      },
    });

    daemon.extensionService.registerEndpoint({
      ref: "support",
      extensionNumber: "200",
      contactUri: "sip:200@office.local",
    });

    const waitingLeg = daemon.legService.createLeg({
      legId: "queue-timeout-retry-leg",
      direction: "inbound",
      transportType: "sip",
      status: "created",
    });

    daemon.queueService.enqueueLeg("support", waitingLeg.legId, "back");
    await waitForCondition(() => published.filter((frame) => frame.branch === "Dispatch").length >= 2, 1000, "re-dispatch after timeout");

    assert.ok(daemon.queueService.getQueueStats({ legId: waitingLeg.legId }).position >= 1);
    daemon.queueService.removeEntryForLeg(waitingLeg.legId);
  } finally {
    await daemon.stop();
  }
});

test("queue retry cooldown is not bypassed by workflow refresh after failed queue-owned dial", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-queue-retry-cooldown-refresh.sock");
  const published = [];

  try {
    daemon.registerTriggerStream({
      kind: "queue",
      config: {
        ref: "support",
        queueExtensions: ["200"],
        queueRetryPauseSeconds: 0.05,
      },
      socket: createFakeSocket(),
      write(frame) {
        published.push(frame);
      },
    });

    daemon.extensionService.registerEndpoint({
      ref: "support",
      extensionNumber: "200",
      contactUri: "sip:200@office.local",
    });

    const waitingLeg = daemon.legService.createLeg({
      legId: "queue-retry-cooldown-leg",
      direction: "inbound",
      transportType: "sip",
      status: "created",
    });

    daemon.queueService.enqueueLeg("support", waitingLeg.legId, "back");
    await waitForCondition(() => published.filter((frame) => frame.branch === "Dispatch").length === 1, 1000, "initial dispatch");

    const firstDialId = String(published[0].payload.dialId || "");
    daemon.queueService.handleDialFinalized(firstDialId, "failed", "rejected");
    daemon.queueService.refreshWorkflowScope("");

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(published.filter((frame) => frame.branch === "Dispatch").length, 1);

    await waitForCondition(() => published.filter((frame) => frame.branch === "Dispatch").length === 2, 1000, "dispatch after retry cooldown");
    daemon.queueService.removeEntryForLeg(waitingLeg.legId);
  } finally {
    await daemon.stop();
  }
});

test("flow-scoped queue deduplicates extension numbers but keeps them available while at least one same-number endpoint is free", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-queue-flow-dedupe.sock");

  try {
    daemon.extensionService.registerEndpoint({
      ref: "flow:workflow%3Aalpha:extensions:office-a",
      extensionNumber: "100",
      contactUri: "sip:100@alpha-a.local",
    });
    daemon.extensionService.registerEndpoint({
      ref: "flow:workflow%3Aalpha:extensions:office-b",
      extensionNumber: "100",
      contactUri: "sip:100@alpha-b.local",
    });

    daemon.legService.createLeg({
      legId: "queue-busy-100-a",
      direction: "inbound",
      transportType: "sip",
      triggerMetadata: {
        ref: "flow:workflow%3Aalpha:extensions:office-a",
        extensionNumber: "100",
      },
      status: "answered",
    });

    assert.deepStrictEqual(
      daemon.extensionService.listAvailableExtensionNumbersInFlow("workflow:alpha", ["100"]),
      ["100"],
    );

    daemon.legService.createLeg({
      legId: "queue-busy-100-b",
      direction: "inbound",
      transportType: "sip",
      triggerMetadata: {
        ref: "flow:workflow%3Aalpha:extensions:office-b",
        extensionNumber: "100",
      },
      status: "answered",
    });

    assert.deepStrictEqual(
      daemon.extensionService.listAvailableExtensionNumbersInFlow("workflow:alpha", ["100"]),
      [],
    );
  } finally {
    await daemon.stop();
  }
});

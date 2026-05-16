"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("call.wait request cancellation releases wait retention without ending the leg", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../build-src/daemon/core/request-context.js");
  const { ControllerMethod } = require("../../../build-src/control/controller-protocol.js");

  const daemon = new SipPbxDaemon(".unused-leg-wait-cancellation.sock");
  const leg = daemon.legService.createLeg({
    legId: "leg-wait-cancel",
    direction: "inbound",
    transportType: "websocket",
  });
  const context = new RequestContext();

  try {
    const waitPromise = daemon.dispatchUnary(context, {
      method: ControllerMethod.executeAction,
      params: {
        operation: "call.wait",
        legId: leg.legId,
        timeoutSeconds: 5,
        rules: [],
      },
    });

    setTimeout(() => {
      context.cancel();
    }, 25);

    await assert.rejects(
      waitPromise,
      (error) => error && error.code === "request_cancelled",
    );

    const retainedLeg = daemon.legService.requireLeg(leg.legId);
    assert.ok(daemon.legService.getLeg(leg.legId));
    assert.notStrictEqual(retainedLeg.status, "ended");
    if (daemon.legService.getLeg(leg.legId)) {
      daemon.legService.hangupLeg(leg.legId, "test_cleanup");
    }
  } finally {
    await daemon.stop();
  }
});

test("call.wait treats timeoutSeconds=0 as immediate overall timeout", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../build-src/daemon/core/request-context.js");
  const { ControllerMethod } = require("../../../build-src/control/controller-protocol.js");

  const daemon = new SipPbxDaemon(".unused-leg-wait-zero-timeout.sock");
  const leg = daemon.legService.createLeg({
    legId: "leg-wait-zero-timeout",
    direction: "inbound",
    transportType: "websocket",
  });
  const context = new RequestContext();

  try {
    const result = await daemon.dispatchUnary(context, {
      method: ControllerMethod.executeAction,
      params: {
        operation: "call.wait",
        legId: leg.legId,
        timeoutSeconds: 0,
        rules: [{ pattern: "1", label: "Callback on" }],
      },
    });

    assert.equal(result.emissions[0].branch, "Timeout");
    assert.equal(result.emissions[0].payload.legId, leg.legId);
    assert.equal(result.emissions[0].payload.eventType, "timeout");
  } finally {
    if (daemon.legService.getLeg(leg.legId)) {
      daemon.legService.hangupLeg(leg.legId, "test_cleanup");
    }
    await daemon.stop();
  }
});

test("call.wait resolves ended from terminal snapshot when the leg has already ended and been removed", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../build-src/daemon/core/request-context.js");
  const { ControllerMethod } = require("../../../build-src/control/controller-protocol.js");

  const daemon = new SipPbxDaemon(".unused-leg-wait-finalized-ended.sock");
  const leg = daemon.legService.createLeg({
    legId: "leg-wait-finalized-ended",
    direction: "inbound",
    transportType: "websocket",
  });
  const context = new RequestContext();

  try {
    daemon.legService.hangupLeg(leg.legId, "test_completed");
    await waitForCondition(() => daemon.legService.getLeg(leg.legId) === null);

    const result = await daemon.dispatchUnary(context, {
      method: ControllerMethod.executeAction,
      params: {
        operation: "call.wait",
        legId: leg.legId,
        timeoutSeconds: 5,
        rules: [],
      },
    });

    assert.equal(result.emissions[0].branch, "Ended");
    assert.equal(result.emissions[0].payload.legId, leg.legId);
    assert.equal(result.emissions[0].payload.eventType, "ended");
    assert.equal(result.emissions[0].payload.reason, "test_completed");
  } finally {
    await daemon.stop();
  }
});

test("dial.wait request cancellation releases wait retention without adding any extra dial owner", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../build-src/daemon/core/request-context.js");
  const { ControllerMethod } = require("../../../build-src/control/controller-protocol.js");

  const daemon = new SipPbxDaemon(".unused-dial-wait-cancellation.sock");
  daemon.dialService.setOnAttemptStarted(() => undefined);
  const dial = daemon.dialService.createDial({
    strategy: "parallel",
    targets: ["100"],
    mode: "direct",
  });
  const context = new RequestContext();

  try {
    const waitPromise = daemon.dispatchUnary(context, {
      method: ControllerMethod.executeAction,
      params: {
        operation: "dial.wait",
        dialId: dial.dialId,
        dialTimeoutSeconds: 5,
        waitEventOutputs: [],
      },
    });

    setTimeout(() => {
      context.cancel();
    }, 25);

    await assert.rejects(
      waitPromise,
      (error) => error && error.code === "request_cancelled",
    );

    const retainedDial = daemon.dialService.requireDial(dial.dialId);
    assert.ok(daemon.dialService.getDial(dial.dialId));
    assert.strictEqual(retainedDial.finalizedAt, null);
  } finally {
    await daemon.stop();
  }
});

test("dial.wait resolves answered without re-looking up a finalized dial in finally", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../build-src/daemon/core/request-context.js");
  const { ControllerMethod } = require("../../../build-src/control/controller-protocol.js");

  const daemon = new SipPbxDaemon(".unused-dial-wait-finalized-answer.sock");
  daemon.dialService.setOnAttemptStarted(() => undefined);
  const dial = daemon.dialService.createDial({
    strategy: "parallel",
    targets: ["100"],
    mode: "direct",
  });
  const attemptLegId = dial.attemptLegIds[0];
  const context = new RequestContext();

  try {
    const waitPromise = daemon.dispatchUnary(context, {
      method: ControllerMethod.executeAction,
      params: {
        operation: "dial.wait",
        dialId: dial.dialId,
        dialTimeoutSeconds: 5,
        waitEventOutputs: [],
      },
    });

    setTimeout(() => {
      daemon.dialService.markAttemptAnswered(dial.dialId, attemptLegId);
    }, 25);

    const result = await waitPromise;
    assert.equal(result.emissions[0].branch, "Answered");
    assert.equal(result.emissions[0].payload.dialId, dial.dialId);
    assert.equal(daemon.dialService.getDial(dial.dialId), null);
  } finally {
    await daemon.stop();
  }
});

test("dial.wait resolves failed from terminal snapshot when the dial has already been finalized and removed", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../build-src/daemon/core/request-context.js");
  const { ControllerMethod } = require("../../../build-src/control/controller-protocol.js");

  const daemon = new SipPbxDaemon(".unused-dial-wait-finalized-failed.sock");
  daemon.dialService.setOnAttemptStarted(() => undefined);
  const dial = daemon.dialService.createDial({
    strategy: "parallel",
    targets: ["100"],
    mode: "direct",
  });
  const attemptLegId = dial.attemptLegIds[0];
  const context = new RequestContext();

  try {
    daemon.dialService.markAttemptRejected(dial.dialId, attemptLegId, "target_unavailable");

    assert.equal(daemon.dialService.getDial(dial.dialId), null);

    const result = await daemon.dispatchUnary(context, {
      method: ControllerMethod.executeAction,
      params: {
        operation: "dial.wait",
        dialId: dial.dialId,
        dialTimeoutSeconds: 5,
        waitEventOutputs: [],
      },
    });

    assert.equal(result.emissions[0].branch, "Failed");
    assert.equal(result.emissions[0].payload.dialId, dial.dialId);
    assert.equal(result.emissions[0].payload.eventType, "failed");
    assert.equal(result.emissions[0].payload.reason, "target_unavailable");
  } finally {
    await daemon.stop();
  }
});

async function waitForCondition(predicate, timeoutMs = 250) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("condition_timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

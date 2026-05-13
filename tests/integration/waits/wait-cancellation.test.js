"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("call.waitCallEvent request cancellation releases wait retention without ending the leg", async () => {
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
        operation: "call.waitCallEvent",
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

test("call.waitCallEvent treats timeoutSeconds=0 as immediate overall timeout", async () => {
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
        operation: "call.waitCallEvent",
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

test("dial.waitDialEvent request cancellation releases wait retention without adding any extra dial owner", async () => {
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
        operation: "dial.waitDialEvent",
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

test("dial.waitDialEvent resolves answered without re-looking up a finalized dial in finally", async () => {
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
        operation: "dial.waitDialEvent",
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

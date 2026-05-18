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
        legIds: [leg.legId],
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
        legIds: [leg.legId],
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
        legIds: [leg.legId],
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
        dialIds: [dial.dialId],
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
        dialIds: [dial.dialId],
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
        dialIds: [dial.dialId],
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

test("dial.wait resolves interrupted from master leg DTMF without stopping the dial", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../build-src/daemon/core/request-context.js");
  const { ControllerMethod } = require("../../../build-src/control/controller-protocol.js");

  const daemon = new SipPbxDaemon(".unused-dial-wait-interrupt-dtmf.sock");
  daemon.dialService.setOnAttemptStarted(() => undefined);
  const dial = daemon.dialService.createDial({
    strategy: "parallel",
    targets: ["100"],
    mode: "direct",
  });
  const masterLeg = daemon.legService.createLeg({
    legId: "leg-master-dtmf",
    direction: "inbound",
    transportType: "websocket",
  });
  const context = new RequestContext();

  try {
    const waitPromise = daemon.dispatchUnary(context, {
      method: ControllerMethod.executeAction,
      params: {
        operation: "dial.wait",
        dialIds: [dial.dialId],
        legId: masterLeg.legId,
        dialTimeoutSeconds: 5,
        waitEventOutputs: [],
        interruptOnDtmf: true,
      },
    });

    setTimeout(() => {
      daemon.legService.publishDtmf(masterLeg.legId, "6");
    }, 25);

    const result = await waitPromise;
    assert.equal(result.emissions[0].branch, "Interrupted");
    assert.equal(result.emissions[0].payload.dialId, dial.dialId);
    assert.equal(result.emissions[0].payload.legId, masterLeg.legId);
    assert.equal(result.emissions[0].payload.eventType, "interrupted");
    assert.equal(result.emissions[0].payload.interruptReason, "call_dtmf");
    assert.equal(result.emissions[0].payload.digit, "6");
    assert.equal(result.emissions[0].payload.digits, "6");
    assert.ok(daemon.dialService.getDial(dial.dialId));
  } finally {
    if (daemon.legService.getLeg(masterLeg.legId)) {
      daemon.legService.hangupLeg(masterLeg.legId, "test_cleanup");
    }
    await daemon.stop();
  }
});

test("dial.wait master leg interrupt does not consume queued DTMF before a later call.wait", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../build-src/daemon/core/request-context.js");
  const { ControllerMethod } = require("../../../build-src/control/controller-protocol.js");

  const daemon = new SipPbxDaemon(".unused-dial-wait-master-leg-queued-dtmf.sock");
  daemon.dialService.setOnAttemptStarted(() => undefined);
  const dial = daemon.dialService.createDial({
    strategy: "parallel",
    targets: ["100"],
    mode: "direct",
  });
  const masterLeg = daemon.legService.createLeg({
    legId: "leg-master-queued-dtmf",
    direction: "inbound",
    transportType: "websocket",
  });

  try {
    daemon.legService.publishDtmf(masterLeg.legId, "6");

    const dialWaitResult = await daemon.dispatchUnary(new RequestContext(), {
      method: ControllerMethod.executeAction,
      params: {
        operation: "dial.wait",
        dialIds: [dial.dialId],
        legId: masterLeg.legId,
        dialTimeoutSeconds: 5,
        waitEventOutputs: [],
        interruptOnDtmf: true,
      },
    });

    assert.equal(dialWaitResult.emissions[0].branch, "Interrupted");
    assert.equal(dialWaitResult.emissions[0].payload.interruptReason, "call_dtmf");
    assert.equal(dialWaitResult.emissions[0].payload.digits, "6");

    const callWaitResult = await daemon.dispatchUnary(new RequestContext(), {
      method: ControllerMethod.executeAction,
      params: {
        operation: "call.wait",
        legIds: [masterLeg.legId],
        timeoutSeconds: 5,
        rules: [{ pattern: "6", label: "Pressed 6" }],
      },
    });

    assert.equal(callWaitResult.emissions[0].branch, "Pressed 6");
    assert.equal(callWaitResult.emissions[0].payload.eventType, "dtmf");
    assert.equal(callWaitResult.emissions[0].payload.legId, masterLeg.legId);
  } finally {
    if (daemon.legService.getLeg(masterLeg.legId)) {
      daemon.legService.hangupLeg(masterLeg.legId, "test_cleanup");
    }
    await daemon.stop();
  }
});

test("dial.wait resolves interrupted when master leg ends even without DTMF interrupt", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../build-src/daemon/core/request-context.js");
  const { ControllerMethod } = require("../../../build-src/control/controller-protocol.js");

  const daemon = new SipPbxDaemon(".unused-dial-wait-interrupt-ended.sock");
  daemon.dialService.setOnAttemptStarted(() => undefined);
  const dial = daemon.dialService.createDial({
    strategy: "parallel",
    targets: ["100"],
    mode: "direct",
  });
  const masterLeg = daemon.legService.createLeg({
    legId: "leg-master-ended",
    direction: "inbound",
    transportType: "websocket",
  });
  const context = new RequestContext();

  try {
    const waitPromise = daemon.dispatchUnary(context, {
      method: ControllerMethod.executeAction,
      params: {
        operation: "dial.wait",
        dialIds: [dial.dialId],
        legId: masterLeg.legId,
        dialTimeoutSeconds: 5,
        waitEventOutputs: [],
        interruptOnDtmf: false,
      },
    });

    setTimeout(() => {
      daemon.legService.hangupLeg(masterLeg.legId, "caller_hangup");
    }, 25);

    const result = await waitPromise;
    assert.equal(result.emissions[0].branch, "Interrupted");
    assert.equal(result.emissions[0].payload.dialId, dial.dialId);
    assert.equal(result.emissions[0].payload.legId, masterLeg.legId);
    assert.equal(result.emissions[0].payload.eventType, "interrupted");
    assert.equal(result.emissions[0].payload.interruptReason, "call_ended");
    assert.ok(daemon.dialService.getDial(dial.dialId));
  } finally {
    if (daemon.legService.getLeg(masterLeg.legId)) {
      daemon.legService.hangupLeg(masterLeg.legId, "test_cleanup");
    }
    await daemon.stop();
  }
});

test("dial.wait with master leg and interruptOnDtmf=false consumes queued and live DTMF before a later call.wait", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../build-src/daemon/core/request-context.js");
  const { ControllerMethod } = require("../../../build-src/control/controller-protocol.js");

  const daemon = new SipPbxDaemon(".unused-dial-wait-master-leg-ignore-dtmf.sock");
  daemon.dialService.setOnAttemptStarted(() => undefined);
  const dial = daemon.dialService.createDial({
    strategy: "parallel",
    targets: ["100"],
    mode: "direct",
  });
  const masterLeg = daemon.legService.createLeg({
    legId: "leg-master-ignore-dtmf",
    direction: "inbound",
    transportType: "websocket",
  });

  try {
    daemon.legService.publishDtmf(masterLeg.legId, "5");

    const dialWaitPromise = daemon.dispatchUnary(new RequestContext(), {
      method: ControllerMethod.executeAction,
      params: {
        operation: "dial.wait",
        dialIds: [dial.dialId],
        legId: masterLeg.legId,
        dialTimeoutSeconds: 0.03,
        waitEventOutputs: [],
        interruptOnDtmf: false,
      },
    });

    setTimeout(() => {
      daemon.legService.publishDtmf(masterLeg.legId, "6");
    }, 10);

    const dialWaitResult = await dialWaitPromise;
    assert.equal(dialWaitResult.emissions[0].branch, "Timeout");

    const callWaitResult = await daemon.dispatchUnary(new RequestContext(), {
      method: ControllerMethod.executeAction,
      params: {
        operation: "call.wait",
        legIds: [masterLeg.legId],
        timeoutSeconds: 0,
        rules: [
          { pattern: "5", label: "Pressed 5" },
          { pattern: "6", label: "Pressed 6" },
        ],
      },
    });

    assert.equal(callWaitResult.emissions[0].branch, "Timeout");
    assert.equal(callWaitResult.emissions[0].payload.eventType, "timeout");
  } finally {
    if (daemon.legService.getLeg(masterLeg.legId)) {
      daemon.legService.hangupLeg(masterLeg.legId, "test_cleanup");
    }
    await daemon.stop();
  }
});

test("dial.wait resolves Timeout when master leg interrupt waiter times out first", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../build-src/daemon/core/request-context.js");
  const { ControllerMethod } = require("../../../build-src/control/controller-protocol.js");

  const daemon = new SipPbxDaemon(".unused-dial-wait-master-leg-timeout.sock");
  daemon.dialService.setOnAttemptStarted(() => undefined);
  const dial = daemon.dialService.createDial({
    strategy: "parallel",
    targets: ["100"],
    mode: "direct",
  });
  const masterLeg = daemon.legService.createLeg({
    legId: "leg-master-timeout",
    direction: "inbound",
    transportType: "websocket",
  });

  try {
    const result = await daemon.dispatchUnary(new RequestContext(), {
      method: ControllerMethod.executeAction,
      params: {
        operation: "dial.wait",
        dialIds: [dial.dialId],
        legId: masterLeg.legId,
        dialTimeoutSeconds: 0.02,
        waitEventOutputs: [],
        interruptOnDtmf: true,
      },
    });

    assert.equal(result.emissions[0].branch, "Timeout");
    assert.equal(result.emissions[0].payload.dialId, dial.dialId);
    assert.equal(result.emissions[0].payload.eventType, "timeout");
  } finally {
    if (daemon.legService.getLeg(masterLeg.legId)) {
      daemon.legService.hangupLeg(masterLeg.legId, "test_cleanup");
    }
    await daemon.stop();
  }
});

test("dial.wait releases master leg retention and cancels the interrupt waiter after normal answer", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../build-src/daemon/core/request-context.js");
  const { ControllerMethod } = require("../../../build-src/control/controller-protocol.js");

  const daemon = new SipPbxDaemon(".unused-dial-wait-master-leg-cleanup.sock");
  daemon.dialService.setOnAttemptStarted(() => undefined);
  const dial = daemon.dialService.createDial({
    strategy: "parallel",
    targets: ["100"],
    mode: "direct",
  });
  const attemptLegId = dial.attemptLegIds[0];
  const masterLeg = daemon.legService.createLeg({
    legId: "leg-master-cleanup",
    direction: "inbound",
    transportType: "websocket",
  });
  const context = new RequestContext();

  try {
    const waitPromise = daemon.dispatchUnary(context, {
      method: ControllerMethod.executeAction,
      params: {
        operation: "dial.wait",
        dialIds: [dial.dialId],
        legId: masterLeg.legId,
        dialTimeoutSeconds: 5,
        waitEventOutputs: [],
        interruptOnDtmf: true,
      },
    });

    setTimeout(() => {
      daemon.dialService.markAttemptAnswered(dial.dialId, attemptLegId);
    }, 25);

    const result = await waitPromise;
    assert.equal(result.emissions[0].branch, "Answered");
    assert.equal(result.emissions[0].payload.dialId, dial.dialId);
    assert.strictEqual(masterLeg.activeOperationCount, 0);
    assert.strictEqual(masterLeg.waiters.waiters.size, 0);
  } finally {
    if (daemon.legService.getLeg(masterLeg.legId)) {
      daemon.legService.hangupLeg(masterLeg.legId, "test_cleanup");
    }
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

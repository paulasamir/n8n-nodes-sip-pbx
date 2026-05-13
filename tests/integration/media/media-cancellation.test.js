"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("daemon unary boundary rejects already-cancelled request contexts", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../build-src/daemon/core/request-context.js");
  const { ControllerMethod } = require("../../../build-src/control/controller-protocol.js");
  const daemon = new SipPbxDaemon(".unused-cancellation.sock");
  const context = new RequestContext();
  context.cancel();

  try {
    await assert.rejects(
      daemon.dispatchUnary(context, { method: ControllerMethod.health }),
      (error) => error && error.code === "request_cancelled",
    );
  } finally {
    await daemon.stop();
  }
});

test("blocking media request cancellation interrupts the daemon-side media operation", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../build-src/daemon/core/request-context.js");

  async function waitForCondition(predicate, timeoutMs = 1000, label = "condition") {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Wait timeout: ${label}`);
  }

  const daemon = new SipPbxDaemon(".unused-cancellation-media.sock");
  const leg = daemon.legService.createLeg({
    legId: "leg-blocking-media-cancel",
    direction: "inbound",
    transportType: "websocket",
  });
  const context = new RequestContext();

  try {
    await daemon.mediaService.ensureTransportEndpoint(leg.legId);
    const playPromise = daemon.mediaService.playTone(leg.legId, {
      tone: "ringback",
      repeatInfinite: true,
      mediaExecutionMode: "blocking",
    }, context);

    await waitForCondition(
      () => daemon.mediaService.listMediaOperationsByLegId(leg.legId).length === 1,
      1000,
      "media operation created",
    );

    context.cancel();

    await assert.rejects(
      playPromise,
      (error) => error && error.code === "request_cancelled",
    );

    await waitForCondition(
      () => daemon.mediaService.listMediaOperationsByLegId(leg.legId).length === 0,
      1000,
      "media operation removed after interrupt",
    );

    assert.ok(daemon.legService.requireLeg(leg.legId));
  } finally {
    await daemon.stop();
  }
});

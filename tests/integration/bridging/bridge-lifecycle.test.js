"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function createRuntimeForDaemon(daemon) {
  const { PbxRuntime } = require("../../../build-src/runtime/pbx-runtime.js");
  const { RequestContext } = require("../../../build-src/daemon/core/request-context.js");
  return new PbxRuntime({
    async call(method, params) {
      return await daemon.dispatchUnary(new RequestContext(), { method, params });
    },
    async openStream() {
      return {
        onEvent() {
          return () => undefined;
        },
        close() {},
      };
    },
  });
}

test("bridge lifecycle interrupts peer leg when one bridge member ends", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-bridge-lifecycle.sock");
  const runtime = createRuntimeForDaemon(daemon);

  try {
    const legA = daemon.legService.createLeg({
      legId: "bridge-leg-a",
      direction: "inbound",
      transportType: "websocket",
    });
    const legB = daemon.legService.createLeg({
      legId: "bridge-leg-b",
      direction: "inbound",
      transportType: "websocket",
    });

    await runtime.bridge(legA.legId, legB.legId, {});
    const wait = runtime.waitForLegEvent(legB.legId, { timeoutSeconds: 1 });
    await runtime.hangup(legA.legId);

    const event = await wait;
    assert.equal(event.output, "interrupt");
    assert.equal(event.reason, "bridge");

    const ended = daemon.legService.getLeg(legA.legId);
    assert.ok(ended);
    assert.equal(ended.status, "ended");
    const surviving = daemon.legService.getLeg(legB.legId);
    assert.ok(surviving);
    assert.equal(surviving.bridgePeerLegId, undefined);
  } finally {
    await daemon.stop();
  }
});

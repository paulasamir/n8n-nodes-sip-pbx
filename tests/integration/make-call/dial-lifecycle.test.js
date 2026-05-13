"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("dial lifecycle reaches answered and finalizes", async () => {
  const originalTtl = process.env.SIP_PBX_FREE_TTL_MS;
  process.env.SIP_PBX_FREE_TTL_MS = "30";
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-dial-lifecycle.sock");

  try {
    daemon.dialService.setOnAttemptStarted(() => undefined);
    const dial = daemon.dialService.createDial({
      strategy: "parallel",
      targets: ["100"],
      mode: "direct",
    });
    const attemptLegId = dial.attemptLegIds[0];
    assert.ok(attemptLegId);

    const waited = daemon.dialWaitService.waitForEvent(dial.dialId, 1000);
    daemon.dialService.markAttemptAnswered(dial.dialId, attemptLegId);

    const event = await waited;
    assert.equal(event.eventType, "answered");
    assert.equal(event.legId, attemptLegId);
    assert.equal(event.stillDialingLegCount, 0);

    assert.equal(daemon.dialService.getDial(dial.dialId), null);
  } finally {
    process.env.SIP_PBX_FREE_TTL_MS = originalTtl;
    await daemon.stop();
  }
});

test("live dialing dial finalizes by free_ttl when no owner retains it", async () => {
  const originalTtl = process.env.SIP_PBX_FREE_TTL_MS;
  process.env.SIP_PBX_FREE_TTL_MS = "30";
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-dial-live-retention.sock");

  try {
    daemon.dialService.setOnAttemptStarted(() => undefined);
    const dial = daemon.dialService.createDial({
      strategy: "parallel",
      targets: ["100"],
      mode: "websocket",
    });
    const attemptLegId = dial.attemptLegIds[0];

    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(daemon.dialService.getDial(dial.dialId), null);
    assert.equal(daemon.legService.getLeg(String(attemptLegId || "")), null);
  } finally {
    process.env.SIP_PBX_FREE_TTL_MS = originalTtl;
    await daemon.stop();
  }
});

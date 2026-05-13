"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("bridged outbound attempt removes its dial immediately but keeps the leg alive while bridge retention owns it", async () => {
  const originalTtl = process.env.SIP_PBX_FREE_TTL_MS;
  process.env.SIP_PBX_FREE_TTL_MS = "30";
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { DialService } = require("../../../../build-src/daemon/dials/dial-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  try {
    const legService = new LegService(new MapRegistry());
    const dialRegistry = new MapRegistry();
    const dialService = new DialService(dialRegistry, legService);
    dialService.setOnAttemptStarted(() => undefined);

    const dial = dialService.createDial({
      strategy: "parallel",
      targets: ["100"],
      mode: "direct",
    });
    const legId = dial.attemptLegIds[0];
    assert.ok(legId);

    const bridgeRetention = legService.retainLeg(legId, "test-bridge");
    dialService.markAttemptBridged(dial.dialId, legId);

    assert.equal(dialService.getDial(dial.dialId), null);
    assert.ok(legService.getLeg(legId));

    bridgeRetention.release();
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(legService.getLeg(legId), null);
  } finally {
    process.env.SIP_PBX_FREE_TTL_MS = originalTtl;
  }
});

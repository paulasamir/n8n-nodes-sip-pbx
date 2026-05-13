"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("sequentialAttemptTimeoutSeconds does not affect non-sequential dial attempts", async () => {
  const originalTtl = process.env.SIP_PBX_FREE_TTL_MS;
  process.env.SIP_PBX_FREE_TTL_MS = "200";
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
      sequentialAttemptTimeoutSeconds: 0.01,
    });
    const dialRetention = dial.retain("test");

    await new Promise((resolve) => setTimeout(resolve, 40));

    const retainedDial = dialService.requireDial(dial.dialId);
    assert.equal(retainedDial.status, "dialing");
    assert.equal(retainedDial.finalizedAt, null);
    assert.deepStrictEqual(retainedDial.activeAttemptLegIds, [dial.attemptLegIds[0]]);

    dialRetention.release();
    dialService.breakDial(dial.dialId, "test_cleanup");
  } finally {
    process.env.SIP_PBX_FREE_TTL_MS = originalTtl;
  }
});

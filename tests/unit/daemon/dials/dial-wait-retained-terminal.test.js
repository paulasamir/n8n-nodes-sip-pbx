"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("DialWaitService rejects waiting on a dial that has already been finalized and removed", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { DialService } = require("../../../../build-src/daemon/dials/dial-service.js");
  const { DialWaitService } = require("../../../../build-src/daemon/dials/dial-wait-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legService = new LegService(new MapRegistry());
  const dialRegistry = new MapRegistry();
  const dialService = new DialService(dialRegistry, legService);
  const waitService = new DialWaitService(dialRegistry);
  dialService.setOnAttemptStarted(() => undefined);

  const dial = dialService.createDial({
    strategy: "parallel",
    targets: ["100"],
    mode: "websocket",
  });
  const legId = dial.attemptLegIds[0];
  dialService.markAttemptAnswered(dial.dialId, legId);

  await assert.rejects(
    waitService.waitForEvent(dial.dialId, {
      timeoutMs: 1000,
      waitEventOutputs: [],
    }),
    (error) => error && error.code === "invalid_dial_wait",
  );
});

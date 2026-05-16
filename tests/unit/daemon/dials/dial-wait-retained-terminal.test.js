"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("DialWaitService returns terminal snapshot when a dial has already been finalized and removed", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { DialService } = require("../../../../build-src/daemon/dials/dial-service.js");
  const { DialWaitService } = require("../../../../build-src/daemon/dials/dial-wait-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");
  const { TerminalSnapshotStore } = require("../../../../build-src/daemon/core/terminal-snapshot-store.js");

  const legService = new LegService(new MapRegistry());
  const dialRegistry = new MapRegistry();
  const terminalSnapshots = new TerminalSnapshotStore();
  const dialService = new DialService(dialRegistry, legService, undefined, terminalSnapshots);
  const waitService = new DialWaitService(dialRegistry, terminalSnapshots);
  dialService.setOnAttemptStarted(() => undefined);

  const dial = dialService.createDial({
    strategy: "parallel",
    targets: ["100"],
    mode: "websocket",
  });
  const legId = dial.attemptLegIds[0];
  dialService.markAttemptAnswered(dial.dialId, legId);

  const result = await waitService.waitForEvent(dial.dialId, {
    timeoutMs: 1000,
    waitEventOutputs: [],
  });

  assert.strictEqual(result.dialId, dial.dialId);
  assert.strictEqual(result.eventType, "answered");
  assert.strictEqual(result.legId, legId);
  assert.strictEqual(result.stillDialingLegCount, 0);
});

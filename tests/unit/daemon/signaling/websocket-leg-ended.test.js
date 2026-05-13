"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("WebSocketSignalingService serializes attempt leg end with websocket startup", async () => {
  const { WebSocketSignalingService } = require("../../../../build-src/daemon/signaling/websocket/websocket-signaling-service.js");
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { DialService } = require("../../../../build-src/daemon/dials/dial-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legService = new LegService(new MapRegistry());
  const dialRegistry = new MapRegistry();
  const dialService = new DialService(dialRegistry, legService);
  let releaseEnsure;
  const ensureEntered = new Promise((resolve) => {
    releaseEnsure = resolve;
  });
  let startupEnteredResolve;
  const startupEntered = new Promise((resolve) => {
    startupEnteredResolve = resolve;
  });
  const service = new WebSocketSignalingService({
    legService,
    dialRegistry,
    dialService,
    ensureMediaTransportEndpoint: async () => {
      startupEnteredResolve?.();
      await ensureEntered;
      return {};
    },
  });
  dialService.setOnAttemptStarted((dial, legId, target) => {
    service.handleAttemptStarted(dial, legId, target);
  });

  const dial = dialService.createDial({
    strategy: "parallel",
    targets: ["ws://example.test"],
    mode: "websocket",
    metadata: {
      transportProfile: "openai_realtime",
      openaiApiKey: "test-key",
    },
  });
  const legId = dial.attemptLegIds[0];
  assert.ok(legId);

  await startupEntered;
  legService.updateStatus(legId, "ended");
  const endPromise = service.handleLegEnded(legId, "free_ttl");
  releaseEnsure?.();
  await endPromise;

  assert.strictEqual(dialService.getDial(dial.dialId), null);
  assert.strictEqual(legService.requireLeg(legId).status, "ended");
});

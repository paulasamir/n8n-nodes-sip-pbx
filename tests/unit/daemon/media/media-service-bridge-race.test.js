"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

function buildStubbedExecutionPlane(bridgeMap, bridgeGate) {
  return {
    ensureTransportEndpoint: async () => ({}),
    activateBridge: async (legAId, legBId, options) => {
      bridgeMap.set(legAId, {
        peerLegId: legBId,
        relayDtmf: String(options?.relayDtmf || "disabled"),
        emitDtmfEvents: options?.emitDtmfEvents !== false,
      });
      bridgeMap.set(legBId, {
        peerLegId: legAId,
        relayDtmf: String(options?.relayDtmf || "disabled"),
        emitDtmfEvents: options?.emitDtmfEvents !== false,
      });
      if (bridgeGate) {
        await bridgeGate;
      }
    },
    deactivateBridge: async (ids) => {
      for (const id of ids) {
        if (id) bridgeMap.delete(id);
      }
    },
    beginBridgeTermination: async (legId) => {
      const peer = bridgeMap.get(legId) || null;
      if (peer) {
        bridgeMap.delete(legId);
        bridgeMap.delete(peer.peerLegId);
      }
      return peer;
    },
    orphanBridgeAfterLegEnd: async () => undefined,
    pruneLegIfIdle: async () => undefined,
    waitUntilLegStable: async () => undefined,
    removeLeg: async () => undefined,
    getBridgePeerInfo: (legId) => bridgeMap.get(legId) || null,
    getWorkerCount: () => 0,
    getSnapshot: () => null,
    getRecordingMediaId: () => null,
    registerPlayback: async () => { throw new Error("unused"); },
    unregisterPlayback: async () => null,
    startRecording: async () => { throw new Error("unused"); },
    stopRecording: async () => null,
    activateGlobalRecording: async () => { throw new Error("unused"); },
    deactivateGlobalRecording: async () => null,
    finalizeRecording: async () => ({}),
    pauseGlobalRecording: async () => undefined,
    resumeGlobalRecording: async () => undefined,
    sendDtmf: async () => false,
    sendWebSocketJson: async () => false,
    shutdown: async () => undefined,
  };
}

async function pumpMicrotasks(count = 8) {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("MediaService.bridgeLegs must not leak peer retention when peer ends mid-bridge", async () => {
  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  legService.setOnLegEnded((endedLeg) => service.handleLegEnded(endedLeg.legId));

  const legA = legService.createLeg({
    legId: "leg-bridge-race-a",
    direction: "inbound",
    transportType: "sip",
  });
  const legB = legService.createLeg({
    legId: "leg-bridge-race-b",
    direction: "outbound",
    transportType: "websocket",
  });

  const bridgeMap = new Map();
  let releaseBridgeGate;
  const bridgeGate = new Promise((resolve) => {
    releaseBridgeGate = resolve;
  });
  service.executionPlane = buildStubbedExecutionPlane(bridgeMap, bridgeGate);

  // Kick off bridgeLegs. The stubbed activateBridge will populate the bridge map
  // and then suspend at bridgeGate, simulating the window between activateBridge
  // releasing its internal lock and bridgeLegs running its trailing opBegin pair.
  const bridgePromise = service.bridgeLegs(legA.legId, legB.legId, {
    relayDtmf: "disabled",
    emitDtmfEvents: true,
  });

  // Let bridgeLegs reach the await inside activateBridge.
  await pumpMicrotasks();
  assert.ok(
    bridgeMap.has(legA.legId) && bridgeMap.has(legB.legId),
    "bridgeLegs should have populated the bridge map by now",
  );

  // Simulate the SIP peer ending in this window. handleLegEnded sees the bridge
  // mapping, clears it, and calls opEnd on both legs.
  const legEndedPromise = service.handleLegEnded(legA.legId);
  await pumpMicrotasks();
  await legEndedPromise;

  // Now bridgeLegs is allowed to finish its trailing opBegin pair.
  releaseBridgeGate();
  await bridgePromise;

  // The invariant: after the race, no leg may carry net retention from the bridge.
  // If bridgeLegs.opBegin runs after handleLegEnded's opEnd, count is "stuck" at 1
  // on each leg with no future opEnd to balance it — that is the leak.
  assert.strictEqual(
    legB.activeOperationCount,
    0,
    `legB retention leaked: count=${legB.activeOperationCount} (expected 0 — bridge opBegin/opEnd unbalanced)`,
  );
  assert.strictEqual(
    legA.activeOperationCount,
    0,
    `legA retention leaked: count=${legA.activeOperationCount} (expected 0 — bridge opBegin/opEnd unbalanced)`,
  );

  legService.hangupLeg(legA.legId, "test_cleanup");
  legService.hangupLeg(legB.legId, "test_cleanup");
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

/**
 * Setup: a stubbed executionPlane that lets the test drive bridge state
 * transitions deterministically (no real workers, no real RTP).
 */
function buildStubbedExecutionPlane(bridgeMap, hooks = {}) {
  return {
    ensureTransportEndpoint: async () => ({}),
    activateBridge: async (legAId, legBId, options) => {
      if (hooks.beforeActivate) await hooks.beforeActivate(legAId, legBId);
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
      if (hooks.afterActivate) await hooks.afterActivate(legAId, legBId);
    },
    deactivateBridge: async (ids) => {
      for (const id of ids) {
        if (id) bridgeMap.delete(id);
      }
    },
    beginBridgeTermination: async (legId) => {
      if (hooks.beforeBeginTermination) await hooks.beforeBeginTermination(legId);
      const peer = bridgeMap.get(legId) || null;
      if (peer) {
        bridgeMap.delete(legId);
        bridgeMap.delete(peer.peerLegId);
      }
      if (hooks.afterBeginTermination) await hooks.afterBeginTermination(legId);
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

async function pumpMicrotasks(count = 6) {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("MediaService.releaseBridgeRetention must not evict a concurrently-rebridged peer", async () => {
  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  legService.setOnLegEnded((endedLeg) => service.handleLegEnded(endedLeg.legId));

  const legA = legService.createLeg({
    legId: "leg-rebridge-a",
    direction: "inbound",
    transportType: "sip",
  });
  const legB = legService.createLeg({
    legId: "leg-rebridge-b",
    direction: "outbound",
    transportType: "websocket",
  });
  const legC = legService.createLeg({
    legId: "leg-rebridge-c",
    direction: "outbound",
    transportType: "websocket",
  });

  // Phase 1: establish bridge A↔B.
  const bridgeMap = new Map();
  service.executionPlane = buildStubbedExecutionPlane(bridgeMap);
  await service.bridgeLegs(legA.legId, legB.legId, {
    relayDtmf: "disabled",
    emitDtmfEvents: true,
  });
  assert.strictEqual(legA.activeOperationCount, 1, "legA retained by A-B bridge");
  assert.strictEqual(legB.activeOperationCount, 1, "legB retained by A-B bridge");

  // Phase 2: arm the race. handleLegEnded(A) clears executionPlane.bridgeMap
  // synchronously, then yields BEFORE MediaService.releaseBridgeRetention(A)
  // runs. In the yield, we slot in a fresh bridge B↔C that overwrites
  // bridgeRetentions[B]. Then we resume handleLegEnded(A) — its release must
  // honor ticket identity and leave bridgeRetentions[B]=ticket2 intact.
  let release1 = null;
  const gate1 = new Promise((resolve) => { release1 = resolve; });

  service.executionPlane = buildStubbedExecutionPlane(bridgeMap, {
    afterBeginTermination: async (legId) => {
      if (legId === legA.legId) {
        // Suspend after executionPlane state has been cleared, before
        // MediaService consumes the result.
        await gate1;
      }
    },
  });

  // Kick off handleLegEnded(A); it will pause at the gate after
  // beginBridgeTermination clears the map.
  const handleAPromise = service.handleLegEnded(legA.legId);

  // Let it reach the gate.
  await pumpMicrotasks();

  // Mid-race: bridgeLegs(B, C). detachPriorBridgesForRebridge sees no prior
  // bridge for B in executionPlane (already cleared), proceeds straight to
  // acquireBridgeRetention — which OVERWRITES bridgeRetentions[B] with a fresh
  // ticket2 covering B and C.
  await service.bridgeLegs(legB.legId, legC.legId, {
    relayDtmf: "disabled",
    emitDtmfEvents: true,
  });
  assert.strictEqual(legB.activeOperationCount, 2, "legB now retained by both old A-B and new B-C tickets");
  assert.strictEqual(legC.activeOperationCount, 1, "legC retained by B-C bridge");

  // Resume handleLegEnded(A). It runs releaseBridgeRetention(A), which must
  // NOT touch bridgeRetentions[B] (it now points at ticket2 from B-C bridge).
  release1();
  await handleAPromise;

  // After handleLegEnded(A): ticket1 released, legA's count back to 0,
  // legB's count drops to 1 (ticket2 still held), legC unchanged.
  assert.strictEqual(legA.activeOperationCount, 0, "legA fully released");
  assert.strictEqual(legB.activeOperationCount, 1, "legB still retained by B-C bridge");
  assert.strictEqual(legC.activeOperationCount, 1, "legC still retained by B-C bridge");

  // Phase 3: tear down B-C and verify bookkeeping was preserved correctly.
  await service.unbridgeLeg(legB.legId);
  assert.strictEqual(legB.activeOperationCount, 0, "legB fully released after unbridge");
  assert.strictEqual(legC.activeOperationCount, 0, "legC fully released after unbridge");

  legService.hangupLeg(legB.legId, "test_cleanup");
  legService.hangupLeg(legC.legId, "test_cleanup");
});

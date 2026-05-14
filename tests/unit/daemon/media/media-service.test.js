"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function cleanupLeg(legService, legId) {
  if (legService.getLeg(legId)) {
    legService.hangupLeg(legId, "test_cleanup");
  }
}

function createBackgroundMediaTestHarness() {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  legService.setOnLegEnded((endedLeg) => service.handleLegEnded(endedLeg.legId));
  const leg = legService.createLeg({
    legId: "leg-background-free-ttl",
    direction: "inbound",
    transportType: "websocket",
  });

  service.executionPlane = {
    registerPlayback: async (input) => ({
      legId: input.legId,
      playbackCount: 1,
      recordingActive: false,
      activePlaybackMediaIds: [input.mediaId],
      activeRecordingMediaId: null,
      playbackMix: [],
    }),
    unregisterPlayback: async () => null,
    startRecording: async (legId, mediaId) => ({
      legId,
      playbackCount: 0,
      recordingActive: true,
      activePlaybackMediaIds: [],
      activeRecordingMediaId: mediaId,
      playbackMix: [],
    }),
    stopRecording: async () => null,
    activateGlobalRecording: async () => {
      throw new Error("unused");
    },
    deactivateGlobalRecording: async () => null,
    finalizeRecording: async (_legId, _mediaId, result) => ({ ...(result || {}) }),
    pauseGlobalRecording: async () => undefined,
    resumeGlobalRecording: async () => undefined,
    getRecordingMediaId: () => null,
    sendDtmf: async () => false,
    ensureTransportEndpoint: async () => ({}),
    activateBridge: async () => undefined,
    deactivateBridge: async () => undefined,
    beginBridgeTermination: () => undefined,
    orphanBridgeAfterLegEnd: async () => undefined,
    pruneLegIfIdle: async () => undefined,
    waitUntilLegStable: async () => undefined,
    removeLeg: async () => undefined,
    getSnapshot: () => null,
    getBridgePeerInfo: () => null,
    getWorkerCount: () => 0,
    shutdown: async () => undefined,
  };

  return { service, legService, leg };
}

test("MediaService.playTone forwards finite tone identity and duration to execution plane", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  const leg = legService.createLeg({
    legId: "leg-tone-forwarding",
    direction: "inbound",
    transportType: "websocket",
  });

  let capturedPlayback = null;
  service.executionPlane = {
    registerPlayback: async (input) => {
      capturedPlayback = { ...input };
      return {
        legId: input.legId,
        playbackCount: 1,
        recordingActive: false,
        activePlaybackMediaIds: [input.mediaId],
        activeRecordingMediaId: null,
        playbackMix: [{
          mediaId: input.mediaId,
          priority: Number(input.priority || 0),
          duckingFactor: Number(input.duckingFactor == null ? 1 : input.duckingFactor),
          effectiveGain: 1,
          sourceRef: String(input.sourceRef || ""),
        }],
      };
    },
    unregisterPlayback: async () => null,
    startRecording: async () => { throw new Error("unused"); },
    stopRecording: async () => undefined,
    activateGlobalRecording: async () => { throw new Error("unused"); },
    deactivateGlobalRecording: async () => undefined,
    finalizeRecording: async () => ({}),
    pauseGlobalRecording: async () => undefined,
    resumeGlobalRecording: async () => undefined,
    getRecordingMediaId: () => null,
    sendDtmf: async () => false,
    ensureTransportEndpoint: async () => ({}),
    activateBridge: async () => undefined,
    deactivateBridge: async () => undefined,
    beginBridgeTermination: () => undefined,
    orphanBridgeAfterLegEnd: async () => undefined,
    pruneLegIfIdle: async () => undefined,
    waitUntilLegStable: async () => undefined,
    removeLeg: async () => undefined,
    getSnapshot: () => null,
    getBridgePeerInfo: () => null,
    getWorkerCount: () => 0,
    shutdown: async () => undefined,
  };

  try {
    const result = await service.playTone(leg.legId, {
      mediaExecutionMode: "background",
      tone: "busy",
      repeatInfinite: false,
    });

    assert.strictEqual(result.status, "started");
    assert.ok(capturedPlayback);
    assert.strictEqual(capturedPlayback.kind, "tone");
    assert.strictEqual(capturedPlayback.tone, "busy");
    assert.ok(Number(capturedPlayback.durationMs || 0) > 0);

    await service.finalizeOperation(String(result.mediaId || ""), "interrupted", {
      interruptReason: "test_cleanup",
    });
    await service.closeAll();
    cleanupLeg(legService, leg.legId);
  } finally {
    cleanupLeg(legService, leg.legId);
  }
});

test("MediaService.playTone rejects unsupported tone values before starting media", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  const leg = legService.createLeg({
    legId: "leg-tone-invalid-preset",
    direction: "inbound",
    transportType: "websocket",
  });

  await assert.rejects(
    service.playTone(leg.legId, {
      mediaExecutionMode: "background",
      tone: "not-a-real-tone",
    }),
    /Unsupported playTone tone/i,
  );
});

test("MediaService.playTone rejects invalid custom tone grammar before starting media", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  const leg = legService.createLeg({
    legId: "leg-tone-invalid-custom",
    direction: "inbound",
    transportType: "websocket",
  });

  await assert.rejects(
    service.playTone(leg.legId, {
      mediaExecutionMode: "background",
      tone: "custom",
      customTone: "480/",
    }),
    /Invalid custom tone pattern/i,
  );
});

test("MediaService.stopMedia by legId is a no-op success when the leg has no active media", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  const leg = legService.createLeg({
    legId: "leg-stop-no-active-media",
    direction: "inbound",
    transportType: "websocket",
  });

  const result = await service.stopMedia({
    stopMediaTarget: "legId",
    stopMediaLegId: leg.legId,
    stopMediaReason: "cleanup",
  });

  assert.deepStrictEqual(result, { legId: leg.legId });
});

test("MediaService.playTone with stopOtherMedia interrupts active playback on the same leg before startup", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  const leg = legService.createLeg({
    legId: "leg-stop-other-playback",
    direction: "inbound",
    transportType: "websocket",
  });

  const unregisteredMediaIds = [];
  service.executionPlane = {
    registerPlayback: async (input) => ({
      legId: input.legId,
      playbackCount: 1,
      recordingActive: false,
      activePlaybackMediaIds: [input.mediaId],
      activeRecordingMediaId: null,
      playbackMix: [],
    }),
    unregisterPlayback: async (_legId, mediaId) => {
      unregisteredMediaIds.push(mediaId);
      return null;
    },
    startRecording: async () => { throw new Error("unused"); },
    stopRecording: async () => null,
    activateGlobalRecording: async () => { throw new Error("unused"); },
    deactivateGlobalRecording: async () => null,
    finalizeRecording: async () => ({}),
    pauseGlobalRecording: async () => undefined,
    resumeGlobalRecording: async () => undefined,
    getRecordingMediaId: () => null,
    sendDtmf: async () => false,
    ensureTransportEndpoint: async () => ({}),
    activateBridge: async () => undefined,
    deactivateBridge: async () => undefined,
    beginBridgeTermination: () => null,
    orphanBridgeAfterLegEnd: async () => undefined,
    pruneLegIfIdle: async () => undefined,
    waitUntilLegStable: async () => undefined,
    removeLeg: async () => undefined,
    getSnapshot: () => null,
    getBridgePeerInfo: () => null,
    getWorkerCount: () => 0,
    shutdown: async () => undefined,
  };

  try {
    const first = await service.playAudio(leg.legId, {
      mediaExecutionMode: "background",
      sourceType: "binary",
      binaryDataBase64: Buffer.from("AUDIO").toString("base64"),
    });
    const second = await service.playTone(leg.legId, {
      mediaExecutionMode: "background",
      tone: "ringback",
      stopOtherMedia: true,
    });

    assert.strictEqual(first.status, "started");
    assert.strictEqual(second.status, "started");
    assert.deepStrictEqual(unregisteredMediaIds, [first.mediaId]);
    assert.strictEqual(service.getMediaOperation(String(first.mediaId)), null);

    await service.finalizeOperation(String(second.mediaId), "interrupted", {
      interruptReason: "test_cleanup",
    });
    await service.closeAll();
    cleanupLeg(legService, leg.legId);
  } finally {
    cleanupLeg(legService, leg.legId);
  }
});

test("MediaService.playAudio with stopOtherMedia interrupts active recording on the same leg before startup", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  const leg = legService.createLeg({
    legId: "leg-stop-other-recording",
    direction: "inbound",
    transportType: "websocket",
  });

  const stoppedRecordingMediaIds = [];
  let activeRecordingMediaId = null;
  service.executionPlane = {
    registerPlayback: async (input) => ({
      legId: input.legId,
      playbackCount: 1,
      recordingActive: false,
      activePlaybackMediaIds: [input.mediaId],
      activeRecordingMediaId: null,
      playbackMix: [],
    }),
    unregisterPlayback: async () => null,
    startRecording: async (_legId, mediaId) => {
      activeRecordingMediaId = mediaId;
      return {
        legId: leg.legId,
        playbackCount: 0,
        recordingActive: true,
        activePlaybackMediaIds: [],
        activeRecordingMediaId: mediaId,
        playbackMix: [],
      };
    },
    stopRecording: async (_legId, mediaId) => {
      stoppedRecordingMediaIds.push(mediaId);
      if (activeRecordingMediaId === mediaId) {
        activeRecordingMediaId = null;
      }
      return null;
    },
    activateGlobalRecording: async () => { throw new Error("unused"); },
    deactivateGlobalRecording: async () => null,
    finalizeRecording: async (_legId, _mediaId, result) => ({ ...(result || {}) }),
    pauseGlobalRecording: async () => undefined,
    resumeGlobalRecording: async () => undefined,
    getRecordingMediaId: () => activeRecordingMediaId,
    sendDtmf: async () => false,
    ensureTransportEndpoint: async () => ({}),
    activateBridge: async () => undefined,
    deactivateBridge: async () => undefined,
    beginBridgeTermination: () => null,
    orphanBridgeAfterLegEnd: async () => undefined,
    pruneLegIfIdle: async () => undefined,
    waitUntilLegStable: async () => undefined,
    removeLeg: async () => undefined,
    getSnapshot: () => null,
    getBridgePeerInfo: () => null,
    getWorkerCount: () => 0,
    shutdown: async () => undefined,
  };

  try {
    const first = await service.recordAudio(leg.legId, {
      mediaExecutionMode: "background",
      recordFileFormat: "wav",
      recordOutputType: "file",
      recordFilePath: "/tmp/stop-other-recording.wav",
    });
    const second = await service.playAudio(leg.legId, {
      mediaExecutionMode: "background",
      sourceType: "binary",
      binaryDataBase64: Buffer.from("NEXT").toString("base64"),
      stopOtherMedia: true,
    });

    assert.strictEqual(first.status, "started");
    assert.strictEqual(second.status, "started");
    assert.deepStrictEqual(stoppedRecordingMediaIds, [first.mediaId]);
    assert.strictEqual(service.getMediaOperation(String(first.mediaId)), null);

    await service.finalizeOperation(String(second.mediaId), "interrupted", {
      interruptReason: "test_cleanup",
    });
    await service.closeAll();
    cleanupLeg(legService, leg.legId);
  } finally {
    cleanupLeg(legService, leg.legId);
  }
});

for (const scenario of [
  {
    name: "playAudio",
    start: (service, legId) => service.playAudio(legId, {
      mediaExecutionMode: "background",
      sourceType: "binary",
      binaryDataBase64: Buffer.from("AUDIO").toString("base64"),
    }),
  },
  {
    name: "playTone",
    start: (service, legId) => service.playTone(legId, {
      mediaExecutionMode: "background",
      tone: "ringback",
      repeatInfinite: true,
    }),
  },
  {
    name: "recordAudio",
    start: (service, legId) => service.recordAudio(legId, {
      mediaExecutionMode: "background",
      recordFileFormat: "wav",
      recordOutputType: "file",
      recordFilePath: "/tmp/background-free-ttl.wav",
    }),
  },
]) {
  test(`MediaService.${scenario.name} background operation stays alive past its own free_ttl while leg is retained externally`, async () => {
    const previousFreeTtl = process.env.SIP_PBX_FREE_TTL_MS;
    process.env.SIP_PBX_FREE_TTL_MS = "40";
    const { service, legService, leg } = createBackgroundMediaTestHarness();

    try {
      const legRetention = leg.retain("test-external");
      const started = await scenario.start(service, leg.legId);
      assert.strictEqual(started.status, "started");
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.ok(service.getMediaOperation(String(started.mediaId || "")));
      await service.finalizeOperation(String(started.mediaId || ""), "interrupted", {
        interruptReason: "test_cleanup",
      });
      legRetention.release();
      await service.closeAll();
      cleanupLeg(legService, leg.legId);
    } finally {
      if (previousFreeTtl == null) {
        delete process.env.SIP_PBX_FREE_TTL_MS;
      } else {
        process.env.SIP_PBX_FREE_TTL_MS = previousFreeTtl;
      }
    }
  });

  test(`MediaService.${scenario.name} background operation does not retain its leg`, async () => {
    const previousFreeTtl = process.env.SIP_PBX_FREE_TTL_MS;
    process.env.SIP_PBX_FREE_TTL_MS = "40";
    const { service, legService, leg } = createBackgroundMediaTestHarness();

    try {
      const started = await scenario.start(service, leg.legId);
      assert.strictEqual(started.status, "started");
      await new Promise((resolve) => setTimeout(resolve, 60));
      const currentLeg = legService.getLeg(leg.legId);
      assert.ok(!currentLeg || currentLeg.status === "ended");
      if (service.getMediaOperation(String(started.mediaId || ""))) {
        await service.finalizeOperation(String(started.mediaId || ""), "interrupted", {
          interruptReason: "test_cleanup",
        }).catch(() => undefined);
      }
      await service.closeAll();
      cleanupLeg(legService, leg.legId);
    } finally {
      if (previousFreeTtl == null) {
        delete process.env.SIP_PBX_FREE_TTL_MS;
      } else {
        process.env.SIP_PBX_FREE_TTL_MS = previousFreeTtl;
      }
    }
  });
}

test("MediaService.bridgeLegs does not stop active global call recording", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  const legA = legService.createLeg({
    legId: "leg-record-bridge-a",
    direction: "inbound",
    transportType: "sip",
  });
  const legB = legService.createLeg({
    legId: "leg-record-bridge-b",
    direction: "outbound",
    transportType: "websocket",
  });

  let activeRecordingMediaId = null;
  let stopRecordingCalls = 0;
  let finalizeRecordingCalls = 0;
  let activateBridgeCalls = 0;

  service.executionPlane = {
    registerPlayback: async () => {
      throw new Error("unused");
    },
    unregisterPlayback: async () => null,
    activateGlobalRecording: async (legId, mediaId) => {
      activeRecordingMediaId = mediaId;
      return {
        legId,
        playbackCount: 0,
        recordingActive: true,
        activePlaybackMediaIds: [],
        activeRecordingMediaId: null,
        playbackMix: [],
      };
    },
    startRecording: async (legId, mediaId) => {
      activeRecordingMediaId = mediaId;
      return {
        legId,
        playbackCount: 0,
        recordingActive: true,
        activePlaybackMediaIds: [],
        activeRecordingMediaId: mediaId,
        playbackMix: [],
      };
    },
    deactivateGlobalRecording: async () => {
      stopRecordingCalls += 1;
      activeRecordingMediaId = null;
      return null;
    },
    stopRecording: async () => null,
    finalizeRecording: async () => {
      finalizeRecordingCalls += 1;
      return {};
    },
    pauseGlobalRecording: async () => undefined,
    resumeGlobalRecording: async () => undefined,
    getRecordingMediaId: () => activeRecordingMediaId,
    sendDtmf: async () => false,
    ensureTransportEndpoint: async () => ({}),
    activateBridge: async () => {
      activateBridgeCalls += 1;
    },
    deactivateBridge: async () => undefined,
    beginBridgeTermination: () => undefined,
    orphanBridgeAfterLegEnd: async () => undefined,
    pruneLegIfIdle: async () => undefined,
    waitUntilLegStable: async () => undefined,
    removeLeg: async () => undefined,
    getSnapshot: () => null,
    getBridgePeerInfo: () => null,
    getWorkerCount: () => 0,
    shutdown: async () => undefined,
  };

  await service.startGlobalCallRecording(legA.legId, {
    recordOutputType: "file",
    recordFilePath: "/tmp/test-recording.wav",
    recordFileFormat: "wav",
    recordSplitChannels: true,
  });

  await service.bridgeLegs(legA.legId, legB.legId, {});

  const operations = registry.values().filter((operation) => operation.legId === legA.legId);
  assert.strictEqual(activateBridgeCalls, 1);
  assert.strictEqual(stopRecordingCalls, 0);
  assert.strictEqual(finalizeRecordingCalls, 0);
  assert.strictEqual(operations.length, 0);
});

test("MediaService.bridgeLegs colocates deferred websocket legs before publishing bridge state", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  const legA = legService.createLeg({
    legId: "leg-bridge-websocket-a",
    direction: "outbound",
    transportType: "websocket",
    signalingDetails: {
      transportProfile: "openai_realtime",
      websocketStartMode: "deferred",
      websocketSessionActivated: false,
    },
  });
  const legB = legService.createLeg({
    legId: "leg-bridge-websocket-b",
    direction: "outbound",
    transportType: "websocket",
    signalingDetails: {
      transportProfile: "openai_realtime",
      websocketStartMode: "deferred",
      websocketSessionActivated: false,
    },
  });

  try {
    await service.ensureTransportEndpoint(legA.legId);
    await service.ensureTransportEndpoint(legB.legId);
    assert.strictEqual(service.getWorkerCount(), 2);

    await service.bridgeLegs(legA.legId, legB.legId, {});

    assert.strictEqual(legService.requireLeg(legA.legId).bridgePeerLegId, legB.legId);
    assert.strictEqual(legService.requireLeg(legB.legId).bridgePeerLegId, legA.legId);
    assert.strictEqual(service.getWorkerCount(), 1);
  } finally {
    await service.closeAll();
    cleanupLeg(legService, legA.legId);
    cleanupLeg(legService, legB.legId);
  }
});

test("MediaService.bridgeLegs rebridges legs after tearing down prior bridge memberships", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  const legA = legService.createLeg({
    legId: "leg-rebridge-a",
    direction: "outbound",
    transportType: "websocket",
    signalingDetails: {
      transportProfile: "openai_realtime",
      websocketStartMode: "deferred",
      websocketSessionActivated: false,
    },
  });
  const legB = legService.createLeg({
    legId: "leg-rebridge-b",
    direction: "outbound",
    transportType: "websocket",
    signalingDetails: {
      transportProfile: "openai_realtime",
      websocketStartMode: "deferred",
      websocketSessionActivated: false,
    },
  });
  const oldPeerA = legService.createLeg({
    legId: "leg-rebridge-old-peer-a",
    direction: "outbound",
    transportType: "websocket",
    signalingDetails: {
      transportProfile: "openai_realtime",
      websocketStartMode: "deferred",
      websocketSessionActivated: false,
    },
  });
  const oldPeerB = legService.createLeg({
    legId: "leg-rebridge-old-peer-b",
    direction: "outbound",
    transportType: "websocket",
    signalingDetails: {
      transportProfile: "openai_realtime",
      websocketStartMode: "deferred",
      websocketSessionActivated: false,
    },
  });

  try {
    await Promise.all([legA, legB, oldPeerA, oldPeerB].map(async (leg) => {
      await service.ensureTransportEndpoint(leg.legId);
    }));

    await service.bridgeLegs(legA.legId, oldPeerA.legId, {});
    await service.bridgeLegs(legB.legId, oldPeerB.legId, {});
    await service.bridgeLegs(legA.legId, legB.legId, {});

    assert.strictEqual(legService.requireLeg(legA.legId).bridgePeerLegId, legB.legId);
    assert.strictEqual(legService.requireLeg(legB.legId).bridgePeerLegId, legA.legId);
    assert.strictEqual(legService.requireLeg(oldPeerA.legId).bridgePeerLegId, undefined);
    assert.strictEqual(legService.requireLeg(oldPeerB.legId).bridgePeerLegId, undefined);

    const oldPeerAInterrupt = oldPeerA.shiftEventMatching((event) => event.eventType === "interrupt");
    const oldPeerBInterrupt = oldPeerB.shiftEventMatching((event) => event.eventType === "interrupt");
    assert.equal(oldPeerAInterrupt?.reason, "unbridge");
    assert.equal(oldPeerBInterrupt?.reason, "unbridge");
  } finally {
    await service.closeAll();
    for (const leg of [legA, legB, oldPeerA, oldPeerB]) {
      cleanupLeg(legService, leg.legId);
    }
  }
});

test("MediaService.bridgeLegs treats repeated bridge on the same pair as an idempotent refresh", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  const legA = legService.createLeg({
    legId: "leg-same-pair-a",
    direction: "outbound",
    transportType: "websocket",
    signalingDetails: {
      transportProfile: "openai_realtime",
      websocketStartMode: "deferred",
      websocketSessionActivated: false,
    },
  });
  const legB = legService.createLeg({
    legId: "leg-same-pair-b",
    direction: "outbound",
    transportType: "websocket",
    signalingDetails: {
      transportProfile: "openai_realtime",
      websocketStartMode: "deferred",
      websocketSessionActivated: false,
    },
  });

  let legARetainCalls = 0;
  let legBRetainCalls = 0;
  const originalARetain = legA.retain.bind(legA);
  const originalBRetain = legB.retain.bind(legB);
  legA.retain = (tag) => {
    legARetainCalls += 1;
    return originalARetain(tag);
  };
  legB.retain = (tag) => {
    legBRetainCalls += 1;
    return originalBRetain(tag);
  };

  try {
    await service.ensureTransportEndpoint(legA.legId);
    await service.ensureTransportEndpoint(legB.legId);

    await service.bridgeLegs(legA.legId, legB.legId, {
      relayDtmf: "disabled",
      emitDtmfEvents: true,
    });
    await service.bridgeLegs(legA.legId, legB.legId, {
      relayDtmf: "rfc2833",
      emitDtmfEvents: false,
    });

    assert.strictEqual(legARetainCalls, 1);
    assert.strictEqual(legBRetainCalls, 1);
    assert.strictEqual(legService.requireLeg(legA.legId).bridgePeerLegId, legB.legId);
    assert.strictEqual(legService.requireLeg(legA.legId).bridgeRelayDtmf, "rfc2833");
    assert.strictEqual(legService.requireLeg(legA.legId).bridgeEmitDtmfEvents, false);
    assert.strictEqual(legService.requireLeg(legB.legId).bridgePeerLegId, legA.legId);
    assert.strictEqual(legService.requireLeg(legB.legId).bridgeRelayDtmf, "rfc2833");
    assert.strictEqual(legService.requireLeg(legB.legId).bridgeEmitDtmfEvents, false);
  } finally {
    await service.closeAll();
    cleanupLeg(legService, legA.legId);
    cleanupLeg(legService, legB.legId);
  }
});

test("MediaService.handleLegEnded finalizes active global call recording", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  const leg = legService.createLeg({
    legId: "leg-global-record-end",
    direction: "inbound",
    transportType: "sip",
  });

  let activeRecordingMediaId = null;
  let stopRecordingCalls = 0;
  let finalizeRecordingCalls = 0;
  let removeLegCalls = 0;

  service.executionPlane = {
    registerPlayback: async () => {
      throw new Error("unused");
    },
    unregisterPlayback: async () => null,
    activateGlobalRecording: async (_legId, mediaId) => {
      activeRecordingMediaId = mediaId;
      return {
        legId: leg.legId,
        playbackCount: 0,
        recordingActive: true,
        activePlaybackMediaIds: [],
        activeRecordingMediaId: null,
        playbackMix: [],
      };
    },
    startRecording: async (_legId, mediaId) => {
      activeRecordingMediaId = mediaId;
      return {
        legId: leg.legId,
        playbackCount: 0,
        recordingActive: true,
        activePlaybackMediaIds: [],
        activeRecordingMediaId: mediaId,
        playbackMix: [],
      };
    },
    deactivateGlobalRecording: async () => {
      stopRecordingCalls += 1;
      activeRecordingMediaId = null;
      return null;
    },
    stopRecording: async () => null,
    finalizeRecording: async (_legId, _mediaId, result) => {
      finalizeRecordingCalls += 1;
      return { bytesProduced: 1234, ...(result || {}) };
    },
    pauseGlobalRecording: async () => undefined,
    resumeGlobalRecording: async () => undefined,
    getRecordingMediaId: () => activeRecordingMediaId,
    sendDtmf: async () => false,
    ensureTransportEndpoint: async () => ({}),
    activateBridge: async () => undefined,
    deactivateBridge: async () => undefined,
    beginBridgeTermination: () => null,
    orphanBridgeAfterLegEnd: async () => undefined,
    pruneLegIfIdle: async () => undefined,
    waitUntilLegStable: async () => undefined,
    removeLeg: async () => {
      removeLegCalls += 1;
    },
    getSnapshot: () => null,
    getBridgePeerInfo: () => null,
    getWorkerCount: () => 0,
    shutdown: async () => undefined,
  };

  await service.startGlobalCallRecording(leg.legId, {
    recordOutputType: "file",
    recordFilePath: "/tmp/test-recording.wav",
    recordFileFormat: "wav",
  });

  const waitPromise = service.waitForGlobalCallRecording(leg.legId);
  await service.handleLegEnded(leg.legId);
  const result = await waitPromise;

  assert.strictEqual(stopRecordingCalls, 1);
  assert.strictEqual(finalizeRecordingCalls, 1);
  assert.strictEqual(removeLegCalls, 1);
  assert.strictEqual(result.status, "interrupted");
  assert.strictEqual(result.eventType, undefined);
  assert.strictEqual(result.bytesProduced, 1234);
});

test("MediaService.startGlobalCallRecording does not retain the leg as an active operation", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  const leg = legService.createLeg({
    legId: "leg-global-record-no-retain",
    direction: "inbound",
    transportType: "sip",
  });

  let deactivateGlobalRecordingCalls = 0;

  service.executionPlane = {
    registerPlayback: async () => {
      throw new Error("unused");
    },
    unregisterPlayback: async () => null,
    activateGlobalRecording: async (legId) => ({
      legId,
      playbackCount: 0,
      recordingActive: true,
      activePlaybackMediaIds: [],
      activeRecordingMediaId: null,
      playbackMix: [],
    }),
    startRecording: async () => {
      throw new Error("unused");
    },
    deactivateGlobalRecording: async () => {
      deactivateGlobalRecordingCalls += 1;
      return null;
    },
    stopRecording: async () => null,
    finalizeRecording: async (_legId, _mediaId, result) => ({ ...(result || {}) }),
    pauseGlobalRecording: async () => undefined,
    resumeGlobalRecording: async () => undefined,
    getRecordingMediaId: () => null,
    sendDtmf: async () => false,
    ensureTransportEndpoint: async () => ({}),
    activateBridge: async () => undefined,
    deactivateBridge: async () => undefined,
    beginBridgeTermination: () => null,
    orphanBridgeAfterLegEnd: async () => undefined,
    pruneLegIfIdle: async () => undefined,
    waitUntilLegStable: async () => undefined,
    removeLeg: async () => undefined,
    getSnapshot: () => null,
    getBridgePeerInfo: () => null,
    getWorkerCount: () => 0,
    shutdown: async () => undefined,
  };

  assert.ok(legService.requireLeg(leg.legId));

  await service.startGlobalCallRecording(leg.legId, {
    recordFilePath: "/tmp/global-recording.wav",
    recordFileFormat: "wav",
  });

  assert.ok(legService.requireLeg(leg.legId));

  await service.handleLegEnded(leg.legId);

  assert.strictEqual(deactivateGlobalRecordingCalls, 1);
  assert.ok(legService.requireLeg(leg.legId));
});

test("MediaService.waitForGlobalCallRecording cancellation does not stop active global call recording", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  const leg = legService.createLeg({
    legId: "leg-global-record-cancel-wait",
    direction: "inbound",
    transportType: "sip",
  });

  let deactivateGlobalRecordingCalls = 0;
  let finalizeRecordingCalls = 0;

  service.executionPlane = {
    registerPlayback: async () => {
      throw new Error("unused");
    },
    unregisterPlayback: async () => null,
    activateGlobalRecording: async (legId, mediaId) => ({
      legId,
      playbackCount: 0,
      recordingActive: true,
      activePlaybackMediaIds: [],
      activeRecordingMediaId: null,
      playbackMix: [],
    }),
    startRecording: async () => {
      throw new Error("unused");
    },
    deactivateGlobalRecording: async () => {
      deactivateGlobalRecordingCalls += 1;
      return null;
    },
    stopRecording: async () => null,
    finalizeRecording: async (_legId, _mediaId, result) => {
      finalizeRecordingCalls += 1;
      return { ...(result || {}) };
    },
    pauseGlobalRecording: async () => undefined,
    resumeGlobalRecording: async () => undefined,
    getRecordingMediaId: () => null,
    sendDtmf: async () => false,
    ensureTransportEndpoint: async () => ({}),
    activateBridge: async () => undefined,
    deactivateBridge: async () => undefined,
    beginBridgeTermination: () => null,
    orphanBridgeAfterLegEnd: async () => undefined,
    pruneLegIfIdle: async () => undefined,
    waitUntilLegStable: async () => undefined,
    removeLeg: async () => undefined,
    getSnapshot: () => null,
    getBridgePeerInfo: () => null,
    getWorkerCount: () => 0,
    shutdown: async () => undefined,
  };

  await service.startGlobalCallRecording(leg.legId, {
    recordFilePath: "/tmp/global-recording.wav",
    recordFileFormat: "wav",
  });

  class TestRequestContext {
    cancelled = false;
    cancelHandlers = new Set();

    cancel() {
      if (this.cancelled) {
        return;
      }
      this.cancelled = true;
      for (const handler of Array.from(this.cancelHandlers)) {
        handler();
      }
      this.cancelHandlers.clear();
    }

    onCancel(handler) {
      if (this.cancelled) {
        handler();
        return () => undefined;
      }
      this.cancelHandlers.add(handler);
      return () => {
        this.cancelHandlers.delete(handler);
      };
    }

    throwIfCancelled() {
      if (!this.cancelled) {
        return;
      }
      const error = new Error("The request was cancelled");
      error.code = "request_cancelled";
      throw error;
    }
  }

  const context = new TestRequestContext();
  const waitPromise = service.waitForGlobalCallRecording(leg.legId, context);
  context.cancel();

  await assert.rejects(waitPromise, { code: "request_cancelled" });
  assert.strictEqual(deactivateGlobalRecordingCalls, 0);
  assert.strictEqual(finalizeRecordingCalls, 0);

  await service.controlRecording(leg.legId, "pause");
});

test("MediaService.restartGlobalCallRecording finalizes the active recording before starting a new one", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  const leg = legService.createLeg({
    legId: "leg-global-record-restart",
    direction: "inbound",
    transportType: "sip",
  });

  let activateCalls = 0;
  let deactivateCalls = 0;
  let finalizeCalls = 0;

  service.executionPlane = {
    registerPlayback: async () => {
      throw new Error("unused");
    },
    unregisterPlayback: async () => null,
    activateGlobalRecording: async (legId, mediaId) => {
      activateCalls += 1;
      return {
        legId,
        playbackCount: 0,
        recordingActive: true,
        activePlaybackMediaIds: [],
        activeRecordingMediaId: mediaId,
        playbackMix: [],
      };
    },
    startRecording: async () => {
      throw new Error("unused");
    },
    deactivateGlobalRecording: async () => {
      deactivateCalls += 1;
      return null;
    },
    stopRecording: async () => null,
    finalizeRecording: async (_legId, _mediaId, result) => {
      finalizeCalls += 1;
      return { ...(result || {}) };
    },
    pauseGlobalRecording: async () => undefined,
    resumeGlobalRecording: async () => undefined,
    getRecordingMediaId: () => null,
    sendDtmf: async () => false,
    ensureTransportEndpoint: async () => ({}),
    activateBridge: async () => undefined,
    deactivateBridge: async () => undefined,
    beginBridgeTermination: () => null,
    orphanBridgeAfterLegEnd: async () => undefined,
    pruneLegIfIdle: async () => undefined,
    waitUntilLegStable: async () => undefined,
    removeLeg: async () => undefined,
    getSnapshot: () => null,
    getBridgePeerInfo: () => null,
    getWorkerCount: () => 0,
    shutdown: async () => undefined,
  };

  await service.startGlobalCallRecording(leg.legId, {
    recordFilePath: "/tmp/global-recording-1.wav",
    recordFileFormat: "wav",
  });
  await service.restartGlobalCallRecording(leg.legId, {
    recordFilePath: "/tmp/global-recording-2.wav",
    recordFileFormat: "wav",
  });

  assert.strictEqual(activateCalls, 2);
  assert.strictEqual(deactivateCalls, 1);
  assert.strictEqual(finalizeCalls, 1);
});

test("MediaService.recordAudio does not reject when global call recording is active on the same leg", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { MediaService } = require("../../../../build-src/daemon/media/media-service.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");

  const legRegistry = new MapRegistry();
  const legService = new LegService(legRegistry);
  const registry = new MapRegistry();
  const service = new MediaService(registry, legService);
  const leg = legService.createLeg({
    legId: "leg-global-plus-media-record",
    direction: "inbound",
    transportType: "sip",
  });

  let mediaRecordingMediaId = null;
  const localStarted = [];
  const globalStarted = [];
  service.executionPlane = {
    registerPlayback: async () => {
      throw new Error("unused");
    },
    unregisterPlayback: async () => null,
    activateGlobalRecording: async (legId, mediaId, _startedAt, input) => {
      globalStarted.push({ legId, mediaId, input: { ...(input || {}) } });
      return {
        legId,
        playbackCount: 0,
        recordingActive: true,
        activePlaybackMediaIds: [],
        activeRecordingMediaId: mediaRecordingMediaId,
        playbackMix: [],
      };
    },
    startRecording: async (legId, mediaId, _startedAt, input) => {
      localStarted.push({ legId, mediaId, input: { ...(input || {}) } });
      mediaRecordingMediaId = mediaId;
      return {
        legId,
        playbackCount: 0,
        recordingActive: true,
        activePlaybackMediaIds: [],
        activeRecordingMediaId: mediaRecordingMediaId,
        playbackMix: [],
      };
    },
    deactivateGlobalRecording: async (_legId, mediaId) => {
      return null;
    },
    stopRecording: async (_legId, mediaId) => {
      if (mediaRecordingMediaId === mediaId) {
        mediaRecordingMediaId = null;
      }
      return null;
    },
    finalizeRecording: async (_legId, _mediaId, result) => ({ ...(result || {}) }),
    pauseGlobalRecording: async () => undefined,
    resumeGlobalRecording: async () => undefined,
    getRecordingMediaId: () => mediaRecordingMediaId,
    sendDtmf: async () => false,
    ensureTransportEndpoint: async () => ({}),
    activateBridge: async () => undefined,
    deactivateBridge: async () => undefined,
    beginBridgeTermination: () => null,
    orphanBridgeAfterLegEnd: async () => undefined,
    pruneLegIfIdle: async () => undefined,
    waitUntilLegStable: async () => undefined,
    removeLeg: async () => undefined,
    getSnapshot: () => null,
    getBridgePeerInfo: () => null,
    getWorkerCount: () => 0,
    shutdown: async () => undefined,
  };

  await service.startGlobalCallRecording(leg.legId, {
    recordFilePath: "/tmp/global-recording.wav",
    recordFileFormat: "wav",
    recordSplitChannels: true,
  });

  const result = await service.recordAudio(leg.legId, {
    mediaExecutionMode: "background",
    recordFilePath: "/tmp/media-recording.wav",
    recordFileFormat: "wav",
  });

  assert.strictEqual(result.status, "started");
  assert.strictEqual(globalStarted.length, 1);
  assert.strictEqual(localStarted.length, 1);
  assert.strictEqual(globalStarted[0].legId, leg.legId);
  assert.strictEqual(localStarted[0].legId, leg.legId);
});

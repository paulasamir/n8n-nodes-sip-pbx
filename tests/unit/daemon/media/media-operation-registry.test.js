"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("MediaOperation storage uses MapRegistry and MediaOperation owns queued events and self-detach", async () => {
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { PlayAudioOperation } = require("../../../../build-src/daemon/media/operations/play-audio-operation.js");
  const registry = new MapRegistry();
  const operation = PlayAudioOperation.create(registry, {
    mediaId: "media-1",
    legId: "leg-1",
    sourceRef: "tone.wav",
    options: {},
    onDestroy: async (currentOperation, status, result) => {
      currentOperation.status = status;
      currentOperation.finalizedAt = 3;
      currentOperation.result = { ...(result || {}) };
      currentOperation.finalized = true;
      currentOperation.publishEvent({
        mediaId: currentOperation.mediaId,
        legId: currentOperation.legId,
        eventType: status,
        createdAt: 3,
        ...(currentOperation.result || {}),
      });
      return {
        mediaId: currentOperation.mediaId,
        legId: currentOperation.legId,
        status,
        eventType: status,
        ...(currentOperation.result || {}),
      };
    },
  });
  operation.publishEvent({
    mediaId: operation.mediaId,
    legId: operation.legId,
    eventType: "started",
    createdAt: 2,
  });

  const startedEvent = operation.shiftEvent();
  assert.deepStrictEqual(startedEvent, {
    mediaId: "media-1",
    legId: "leg-1",
    eventType: "started",
    createdAt: 2,
  });

  const result = await operation.destroy("completed", {
    bytesProduced: 64,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.mediaId, "media-1");
  assert.equal(operation.finalized, true);
  assert.equal(operation.result.bytesProduced, 64);
  assert.equal(registry.get(operation.mediaId), null);
});

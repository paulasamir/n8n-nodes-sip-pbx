"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("worker Media accepts plain non-retained operation descriptors", () => {
  const { Media } = require("../../../../build-src/daemon/media/worker/entities/media.js");

  const media = new Media({
    operation: {
      mediaId: "media-worker-tone",
      legId: "leg-worker-tone",
      kind: "tone",
      options: {
        tone: "busy",
        durationMs: 1000,
      },
    },
  });

  assert.strictEqual(media.mediaId, "media-worker-tone");
  assert.strictEqual(media.legId, "leg-worker-tone");
  assert.strictEqual(media.kind, "tone");
  assert.deepStrictEqual(media.operationInput, {
    tone: "busy",
    durationMs: 1000,
  });
});

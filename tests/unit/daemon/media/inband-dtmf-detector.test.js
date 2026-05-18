"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("InbandDtmfDetector emits one digit after tone end", async () => {
  const { InbandDtmfDetector } = require("../../../../build-src/daemon/media/dtmf/inband-dtmf-detector.js");
  const { createInbandDtmfPcm } = require("../../../../build-src/daemon/media/transports/rtp-transport.js");

  const detector = new InbandDtmfDetector();
  const pcm = createInbandDtmfPcm("5", 160, 40, 8000, 1);
  const emitted = [];
  for (let offset = 0; offset < pcm.length; offset += 320) {
    emitted.push(...detector.feed({
      pcm: pcm.subarray(offset, offset + 320),
      bytes: Math.min(320, pcm.length - offset),
      sampleRate: 8000,
      channels: 1,
      durationMs: 20,
      nowMs: offset / 16,
    }));
  }
  for (let index = 0; index < 4; index += 1) {
    emitted.push(...detector.feed({
      pcm: Buffer.alloc(320),
      bytes: 320,
      sampleRate: 8000,
      channels: 1,
      durationMs: 20,
      nowMs: 200 + (index * 20),
    }));
  }

  assert.deepStrictEqual(emitted, ["5"]);
});

test("InbandDtmfDetector suppresses detections immediately after external DTMF", async () => {
  const { InbandDtmfDetector } = require("../../../../build-src/daemon/media/dtmf/inband-dtmf-detector.js");
  const { createInbandDtmfPcm } = require("../../../../build-src/daemon/media/transports/rtp-transport.js");

  const detector = new InbandDtmfDetector();
  detector.notifyExternalDtmf(0);
  const pcm = createInbandDtmfPcm("5", 160, 40, 8000, 1);
  const emitted = [];
  for (let offset = 0; offset < pcm.length; offset += 320) {
    emitted.push(...detector.feed({
      pcm: pcm.subarray(offset, offset + 320),
      bytes: Math.min(320, pcm.length - offset),
      sampleRate: 8000,
      channels: 1,
      durationMs: 20,
      nowMs: offset / 16,
    }));
  }
  for (let index = 0; index < 4; index += 1) {
    emitted.push(...detector.feed({
      pcm: Buffer.alloc(320),
      bytes: 320,
      sampleRate: 8000,
      channels: 1,
      durationMs: 20,
      nowMs: 200 + (index * 20),
    }));
  }

  assert.deepStrictEqual(emitted, []);
});


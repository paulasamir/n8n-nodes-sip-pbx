"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("native codec and stream surfaces are available through source wrappers", async () => {
  const { getImplementedCodecDescriptors } = require("../../../build-src/daemon/media/codecs/audio-codec.js");
  const { createStream } = require("../../../build-src/daemon/media/streams/media-stream.js");

  const audioCodecs = getImplementedCodecDescriptors("audio").map((entry) => entry.name);
  assert.ok(audioCodecs.includes("pcmu"));
  assert.ok(audioCodecs.includes("pcma"));
  if (process.platform === "linux") {
    assert.ok(audioCodecs.includes("g722"));
    assert.ok(audioCodecs.includes("g729"));
    assert.ok(audioCodecs.includes("opus"));
  }

  assert.equal(createStream({ mode: "decode", format: "mp3" }).implementationName, "ffmpeg");
  assert.equal(createStream({ mode: "encode", format: "wav" }).implementationName, "ffmpeg");
});

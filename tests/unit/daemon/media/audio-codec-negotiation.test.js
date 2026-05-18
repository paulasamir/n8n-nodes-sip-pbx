"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("buildLocalAudioSdpDescription filters local offer codecs and RFC2833 by allowed lists", async () => {
  const { buildLocalAudioSdpDescription } = require("../../../../build-src/daemon/media/codecs/audio-codec.js");
  const {
    SIP_AUDIO_CODEC_ALAW,
    SIP_DTMF_METHOD_INFO,
  } = require("../../../../build-src/shared/sip-media-filters.js");

  const localAudio = buildLocalAudioSdpDescription(
    4000,
    [],
    {},
    [SIP_AUDIO_CODEC_ALAW],
    [SIP_DTMF_METHOD_INFO],
  );

  assert.ok(localAudio);
  assert.strictEqual(localAudio.primaryAudioPayloadType, 8);
  assert.strictEqual(localAudio.dtmfPayloadType, null);
  assert.ok(localAudio.lines.some((line) => String(line).includes("PCMA/8000")));
  assert.ok(!localAudio.lines.some((line) => String(line).includes("telephone-event")));
  assert.ok(!localAudio.lines.some((line) => String(line).includes("PCMU/8000")));
  assert.ok(!localAudio.lines.some((line) => String(line).includes("opus/48000/2")));
});

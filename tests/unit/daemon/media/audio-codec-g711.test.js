"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createCodec } = require("../../../../build-src/daemon/media/codecs/audio-codec.js");

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const ALAW_SEG_END = [
  0x1f,
  0x3f,
  0x7f,
  0xff,
  0x1ff,
  0x3ff,
  0x7ff,
  0xfff,
];

function searchSegment(value, table) {
  for (let index = 0; index < table.length; index += 1) {
    if (value <= table[index]) {
      return index;
    }
  }
  return table.length;
}

function encodeReferenceMulaw(sample) {
  let pcm = sample | 0;
  let mask = 0xff;
  if (pcm < 0) {
    pcm = MULAW_BIAS - pcm;
    mask = 0x7f;
  } else {
    pcm = MULAW_BIAS + pcm;
  }
  if (pcm > MULAW_CLIP) {
    pcm = MULAW_CLIP;
  }
  let exponent = 0;
  for (let value = pcm >> 7; value > 1; value >>= 1) {
    exponent += 1;
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ((exponent << 4) | mantissa) ^ mask;
}

function decodeReferenceMulaw(value) {
  const mulaw = (~value) & 0xff;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  if (mulaw & 0x80) {
    sample = -sample;
  }
  return sample === 0 ? 0 : sample;
}

function encodeReferenceAlaw(sample) {
  let pcm = (sample | 0) >> 3;
  let mask = 0xd5;
  if (pcm < 0) {
    mask = 0x55;
    pcm = -pcm - 1;
    if (pcm < 0) {
      pcm = 0;
    }
  }
  const exponent = searchSegment(pcm, ALAW_SEG_END);
  if (exponent >= ALAW_SEG_END.length) {
    return (0x7f ^ mask) & 0xff;
  }
  const mantissa = exponent === 0
    ? ((pcm >> 1) & 0x0f)
    : ((pcm >> exponent) & 0x0f);
  return (((exponent << 4) | mantissa) ^ mask) & 0xff;
}

function decodeReferenceAlaw(value) {
  const alaw = (value ^ 0x55) & 0xff;
  const exponent = (alaw & 0x70) >> 4;
  const mantissa = alaw & 0x0f;
  let sample = exponent === 0
    ? ((mantissa << 4) + 8)
    : (((mantissa << 4) + 0x108) << (exponent - 1));
  if ((alaw & 0x80) === 0) {
    sample = -sample;
  }
  return sample;
}

test("G.711 PCMU encode and decode match canonical mu-law tables", async () => {
  const codec = createCodec("g711");
  const descriptor = codec.listDescriptors().find((entry) => entry.name === "pcmu");
  assert.ok(descriptor, "PCMU descriptor must exist");

  const pcm = Buffer.allocUnsafe(65536 * 2);
  for (let sample = -32768; sample <= 32767; sample += 1) {
    pcm.writeInt16LE(sample, (sample + 32768) * 2);
  }

  const encoded = Buffer.allocUnsafe(65536);
  const encodedBytes = codec.encodeRtpPayload(descriptor, pcm, 1, encoded);
  assert.equal(encodedBytes, encoded.length);
  for (let sample = -32768; sample <= 32767; sample += 1) {
    assert.equal(
      encoded[sample + 32768],
      encodeReferenceMulaw(sample),
      `unexpected PCMU encode result for sample ${sample}`,
    );
  }

  const payload = Buffer.allocUnsafe(256);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = index;
  }
  const decoded = Buffer.allocUnsafe(256 * 2);
  const decodedBytes = codec.decodeRtpPayload(descriptor, descriptor.payloadType, payload, decoded);
  assert.equal(decodedBytes, decoded.length);
  for (let index = 0; index < payload.length; index += 1) {
    assert.equal(
      decoded.readInt16LE(index * 2),
      decodeReferenceMulaw(index),
      `unexpected PCMU decode result for code ${index}`,
    );
  }

  codec.close();
});

test("G.711 PCMA encode and decode match canonical A-law tables", async () => {
  const codec = createCodec("g711");
  const descriptor = codec.listDescriptors().find((entry) => entry.name === "pcma");
  assert.ok(descriptor, "PCMA descriptor must exist");

  const pcm = Buffer.allocUnsafe(65536 * 2);
  for (let sample = -32768; sample <= 32767; sample += 1) {
    pcm.writeInt16LE(sample, (sample + 32768) * 2);
  }

  const encoded = Buffer.allocUnsafe(65536);
  const encodedBytes = codec.encodeRtpPayload(descriptor, pcm, 1, encoded);
  assert.equal(encodedBytes, encoded.length);
  for (let sample = -32768; sample <= 32767; sample += 1) {
    assert.equal(
      encoded[sample + 32768],
      encodeReferenceAlaw(sample),
      `unexpected PCMA encode result for sample ${sample}`,
    );
  }

  const payload = Buffer.allocUnsafe(256);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = index;
  }
  const decoded = Buffer.allocUnsafe(256 * 2);
  const decodedBytes = codec.decodeRtpPayload(descriptor, descriptor.payloadType, payload, decoded);
  assert.equal(decodedBytes, decoded.length);
  for (let index = 0; index < payload.length; index += 1) {
    assert.equal(
      decoded.readInt16LE(index * 2),
      decodeReferenceAlaw(index),
      `unexpected PCMA decode result for code ${index}`,
    );
  }

  codec.close();
});

test("G.711 roundtrip preserves practical signal level without early saturation", async () => {
  const codec = createCodec("g711");
  try {
    const sampleCount = 160;
    const pcm = Buffer.allocUnsafe(sampleCount * 2);
    for (let index = 0; index < sampleCount; index += 1) {
      const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / 8000) * 12000);
      pcm.writeInt16LE(value, index * 2);
    }

    for (const codecName of ["pcma", "pcmu"]) {
      const descriptor = codec.listDescriptors().find((entry) => entry.name === codecName);
      assert.ok(descriptor, `${codecName} descriptor must exist`);
      const encoded = Buffer.allocUnsafe(sampleCount);
      const encodedBytes = codec.encodeRtpPayload(descriptor, pcm, 1, encoded);
      assert.equal(encodedBytes, sampleCount);
      const decoded = Buffer.allocUnsafe(sampleCount * 2);
      const decodedBytes = codec.decodeRtpPayload(descriptor, descriptor.payloadType, encoded, decoded);
      assert.equal(decodedBytes, sampleCount * 2);

      let peak = 0;
      for (let index = 0; index < sampleCount; index += 1) {
        peak = Math.max(peak, Math.abs(decoded.readInt16LE(index * 2)));
      }
      assert.ok(peak >= 10000 && peak <= 14000, `${codecName} roundtrip peak out of expected range: ${peak}`);
    }
  } finally {
    codec.close();
  }
});

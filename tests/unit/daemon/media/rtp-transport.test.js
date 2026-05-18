"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("RtpTransport emits one inbound DTMF event for repeated RFC2833 end packets", async () => {
  const { RtpTransport } = require("../../../../build-src/daemon/media/transports/rtp-transport.js");
  const { SIP_DTMF_METHOD_RFC2833 } = require("../../../../build-src/shared/sip-media-filters.js");

  const outboundPackets = [];
  const sender = new RtpTransport({
    sendPacket(packet, bytes) {
      const normalizedBytes = Math.max(0, Math.min(Number(bytes ?? packet.length) || 0, packet.length));
      outboundPackets.push(Buffer.from(packet.subarray(0, normalizedBytes)));
      return true;
    },
  });
  const receiver = new RtpTransport({
    sendPacket() {
      return false;
    },
  });
  const inboundEvents = [];
  receiver.subscribe((event) => {
    if (event.type === "dtmf") {
      inboundEvents.push({ ...event });
    }
  });

  const sent = await sender.sendDtmf("5", SIP_DTMF_METHOD_RFC2833);
  assert.strictEqual(sent, true);
  assert.ok(outboundPackets.length >= 2);

  const endPacket = outboundPackets[outboundPackets.length - 1];
  receiver.handlePacket(endPacket, { address: "127.0.0.1", port: 30000 });
  receiver.handlePacket(endPacket, { address: "127.0.0.1", port: 30000 });
  receiver.handlePacket(Buffer.from(endPacket), { address: "127.0.0.1", port: 30000 });

  assert.deepStrictEqual(inboundEvents.map((event) => event.digits), ["5"]);
});

test("RtpTransport respects allowed audio codecs and DTMF methods during SDP negotiation", async () => {
  const { RtpTransport } = require("../../../../build-src/daemon/media/transports/rtp-transport.js");
  const {
    SIP_AUDIO_CODEC_ALAW,
    SIP_DTMF_METHOD_INFO,
  } = require("../../../../build-src/shared/sip-media-filters.js");

  const transport = new RtpTransport({
    sendPacket() {
      return false;
    },
  });
  const details = await transport.configure({
    payloadTypes: [8, 9, 97],
    payloadCodecs: {
      8: { codec: "pcma", clockRate: 8000, channels: 1 },
      9: { codec: "g722", clockRate: 8000, channels: 1 },
      97: { codec: "telephone-event", clockRate: 8000, channels: 1, fmtp: "0-16" },
    },
    allowedAudioCodecs: [SIP_AUDIO_CODEC_ALAW],
    allowedDtmfMethods: [SIP_DTMF_METHOD_INFO],
  });

  assert.strictEqual(details.audioPayloadType, 8);
  assert.strictEqual(details.dtmfPayloadType, null);
  assert.deepStrictEqual(details.payloadTypes, [8]);
  assert.ok(Array.isArray(details.localSdpAudioLines));
  assert.ok(details.localSdpAudioLines.some((line) => String(line).includes("PCMA/8000")));
  assert.ok(!details.localSdpAudioLines.some((line) => String(line).includes("telephone-event")));
});

test("RtpTransport detects inbound inband DTMF when enabled", async () => {
  const { RtpTransport, createInbandDtmfPcm } = require("../../../../build-src/daemon/media/transports/rtp-transport.js");
  const { SIP_DTMF_METHOD_INBAND } = require("../../../../build-src/shared/sip-media-filters.js");

  const outboundPackets = [];
  const sender = new RtpTransport({
    sendPacket(packet, bytes) {
      const normalizedBytes = Math.max(0, Math.min(Number(bytes ?? packet.length) || 0, packet.length));
      outboundPackets.push(Buffer.from(packet.subarray(0, normalizedBytes)));
      return true;
    },
  });
  await sender.configure({
    allowedDtmfMethods: [SIP_DTMF_METHOD_INBAND],
  });
  const receiver = new RtpTransport({
    sendPacket() {
      return false;
    },
  });
  await receiver.configure({
    allowedDtmfMethods: [SIP_DTMF_METHOD_INBAND],
  });
  const inboundDigits = [];
  receiver.subscribe((event) => {
    if (event.type === "dtmf") {
      inboundDigits.push(event.digits);
    }
  });

  const tonePcm = createInbandDtmfPcm("5", 160, 40, 8000, 1);
  const sentTone = await sender.sendPlaybackPcm(tonePcm, true, tonePcm.length);
  const sentSilence = await sender.sendPlaybackPcm(Buffer.alloc(640), false, 640);
  assert.strictEqual(sentTone, true);
  assert.strictEqual(sentSilence, true);
  assert.ok(outboundPackets.length > 0);

  for (const packet of outboundPackets) {
    receiver.handlePacket(packet, { address: "127.0.0.1", port: 30000 });
  }

  assert.deepStrictEqual(inboundDigits, ["5"]);
});

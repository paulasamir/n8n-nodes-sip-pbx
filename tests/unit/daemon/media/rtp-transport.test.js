"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("RtpTransport emits one inbound DTMF event for repeated RFC2833 end packets", async () => {
  const { RtpTransport } = require("../../../../build-src/daemon/media/transports/rtp-transport.js");

  const outboundPackets = [];
  const sender = new RtpTransport({
    sendPacket(packet, bytes) {
      const normalizedBytes = Math.max(0, Math.min(Number(bytes ?? packet.length) || 0, packet.length));
      outboundPackets.push(Buffer.from(packet.subarray(0, normalizedBytes)));
      return true;
    },
  });
  const receiver = new RtpTransport();
  const inboundEvents = [];
  receiver.subscribe((event) => {
    if (event.type === "dtmf") {
      inboundEvents.push({ ...event });
    }
  });

  const sent = await sender.sendDtmf("5", "rfc2833");
  assert.strictEqual(sent, true);
  assert.ok(outboundPackets.length >= 2);

  const endPacket = outboundPackets[outboundPackets.length - 1];
  receiver.handlePacket(endPacket, { address: "127.0.0.1", port: 30000 });
  receiver.handlePacket(endPacket, { address: "127.0.0.1", port: 30000 });
  receiver.handlePacket(Buffer.from(endPacket), { address: "127.0.0.1", port: 30000 });

  assert.deepStrictEqual(inboundEvents.map((event) => event.digits), ["5"]);
});

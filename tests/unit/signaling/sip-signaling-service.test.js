"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("sip signaling leg end triggers local hangup teardown", async () => {
  const { SipSignalingService } = require("../../../build-src/daemon/signaling/sip/sip-signaling-service.js");

  const calls = [];
  const sipTransportService = {
    rejectOrHangupLeg(legId, reason) {
      calls.push(["rejectOrHangupLeg", legId, reason]);
    },
    handleLegEnded(legId) {
      calls.push(["handleLegEnded", legId]);
    },
  };

  const service = new SipSignalingService({
    legService: {},
    dialRegistry: { values: () => [] },
    dialService: {},
    sipTransportService,
  });

  await service.handleLegEnded("leg-1", "free_ttl");

  assert.deepEqual(calls, [
    ["rejectOrHangupLeg", "leg-1", "free_ttl"],
    ["handleLegEnded", "leg-1"],
  ]);
});

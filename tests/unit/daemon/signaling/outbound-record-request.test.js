"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

class FakeSocket extends EventEmitter {
  end() {}
  destroy() {}
}

test("SipPbxDaemon publishes outbound trunk Record requests for dial.make when trigger recording is enabled", async () => {
  const { SipPbxDaemon } = require("../../../../build-src/daemon/sip-pbx-daemon.js");

  const daemon = new SipPbxDaemon(".unused-outbound-trunk-record.sock");
  const published = [];
  daemon.signalingService.handleAttemptStarted = () => {};
  daemon.registerTriggerStream({
    kind: "trunk",
    config: {
      ref: "trunk-a",
      enableCallRecording: true,
      sipCredentials: {
        username: "carrier-user",
      },
    },
    socket: new FakeSocket(),
    write(frame) {
      published.push(frame);
    },
  });

  const result = daemon.signalingService.makeDial({
    callMode: "trunk",
    ref: "trunk-a",
    destination: "200",
  });

  assert.ok(result.legId);
  assert.strictEqual(published.length, 0);
  daemon.legService.updateSignalingDetails(result.legId, {
    ...(daemon.legService.requireLeg(result.legId).signalingDetails || {}),
    callId: "call-outbound-trunk-1@example.test",
  });
  await daemon.signalingService.answerLeg(result.legId);
  assert.strictEqual(published.length, 1);
  assert.strictEqual(published[0].kind, "trunk");
  assert.strictEqual(published[0].branch, "Recording");
  assert.strictEqual(published[0].payload.eventType, "record");
  assert.strictEqual(published[0].payload.kind, "trunk");
  assert.strictEqual(published[0].payload.ref, "trunk-a");
  assert.strictEqual(published[0].payload.legId, result.legId);
  assert.strictEqual(published[0].payload.direction, "outbound");
  assert.strictEqual(published[0].payload.from, "sip:carrier-user");
  assert.strictEqual(published[0].payload.to, "sip:200");
  assert.strictEqual(published[0].payload.callId, "call-outbound-trunk-1@example.test");
  assert.ok(String(published[0].payload.recordRequestId || "").trim());

  const consumed = daemon.consumeRecordRequest(String(published[0].payload.recordRequestId || ""));
  assert.strictEqual(consumed.legId, result.legId);
  assert.strictEqual(consumed.kind, "trunk");
  assert.strictEqual(consumed.ref, "trunk-a");
});

test("SipPbxDaemon publishes outbound extensions Record requests for the answered winner leg only", async () => {
  const { SipPbxDaemon } = require("../../../../build-src/daemon/sip-pbx-daemon.js");

  const daemon = new SipPbxDaemon(".unused-outbound-extensions-record.sock");
  const published = [];
  daemon.signalingService.handleAttemptStarted = () => {};
  daemon.registerTriggerStream({
    kind: "extensions",
    config: {
      ref: "office-ext",
      extensionsEnableCallRecording: true,
    },
    socket: new FakeSocket(),
    write(frame) {
      published.push(frame);
    },
  });
  daemon.extensionService.registerEndpoint({
    ref: "office-ext",
    extensionNumber: "300",
    contactUri: "sip:300@office.local",
  });
  daemon.extensionService.registerEndpoint({
    ref: "office-ext",
    extensionNumber: "301",
    contactUri: "sip:301@office.local",
  });

  const result = daemon.signalingService.makeDial({
    callMode: "extension",
    extensionNumbers: ["300", "301"],
    callStrategy: "parallel",
    callerNumber: "500",
  });

  assert.strictEqual(published.length, 0);
  const dial = daemon.dialRegistry.get(result.dialId);
  assert.strictEqual(dial.attemptLegIds.length, 2);
  const winnerLegId = dial.attemptLegIds[0];
  const loserLegId = dial.attemptLegIds[1];
  daemon.legService.updateSignalingDetails(winnerLegId, {
    ...(daemon.legService.requireLeg(winnerLegId).signalingDetails || {}),
    callId: "call-outbound-ext-1@example.test",
  });
  await daemon.signalingService.answerLeg(winnerLegId);

  assert.strictEqual(published.length, 1);
  assert.strictEqual(published[0].kind, "extensions");
  assert.strictEqual(published[0].branch, "Recording");
  assert.strictEqual(published[0].payload.kind, "extensions");
  assert.strictEqual(published[0].payload.ref, "office-ext");
  assert.strictEqual(published[0].payload.legId, winnerLegId);
  assert.strictEqual(published[0].payload.direction, "outbound");
  assert.strictEqual(published[0].payload.from, "sip:500");
  assert.strictEqual(published[0].payload.to, "sip:300");
  assert.strictEqual(published[0].payload.extension, "300");
  assert.strictEqual(published[0].payload.callId, "call-outbound-ext-1@example.test");
  assert.ok(!published.some((frame) => frame.payload.legId === loserLegId));

  const consumed = daemon.consumeRecordRequest(String(published[0].payload.recordRequestId || ""));
  assert.strictEqual(consumed.legId, winnerLegId);
  assert.strictEqual(consumed.kind, "extensions");
  assert.strictEqual(consumed.ref, "office-ext");
});

test("SipPbxDaemon expires pending Record requests after recordResponseTimeoutSeconds", async () => {
  const { SipPbxDaemon } = require("../../../../build-src/daemon/sip-pbx-daemon.js");

  const daemon = new SipPbxDaemon(".unused-record-timeout.sock");
  const published = [];
  daemon.registerTriggerStream({
    kind: "trunk",
    config: {
      ref: "trunk-a",
      enableCallRecording: true,
      recordResponseTimeoutSeconds: 0.01,
      sipCredentials: {
        username: "carrier-user",
      },
    },
    socket: new FakeSocket(),
    write(frame) {
      published.push(frame);
    },
  });

  const leg = daemon.legService.createLeg({
    legId: "record-timeout-leg-1",
    direction: "inbound",
    transportType: "sip",
    status: "answered",
  });
  await daemon.maybePublishRecordRequest({
    kind: "trunk",
    ref: "trunk-a",
    legId: leg.legId,
    direction: "inbound",
    from: "sip:100@example.test",
    to: "sip:200@example.test",
    callId: "call-record-timeout-1@example.test",
  });

  assert.strictEqual(published.length, 1);
  const recordRequestId = String(published[0].payload.recordRequestId || "");
  assert.ok(recordRequestId);

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.throws(() => {
    daemon.consumeRecordRequest(recordRequestId);
  }, /Unknown record request/i);
});

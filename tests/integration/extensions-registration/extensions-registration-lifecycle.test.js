"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("extension registration lifecycle updates online extension visibility", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-extensions-registration.sock");

  try {
    daemon.extensionService.registerEndpoint({
      ref: "sales",
      extensionNumber: "101",
      contactUri: "sip:101@127.0.0.1",
      expiresAt: Date.now() + 1000,
    });
    daemon.extensionService.registerEndpoint({
      ref: "sales",
      extensionNumber: "101",
      contactUri: "sip:101@127.0.0.2",
      expiresAt: Date.now() + 1000,
    });

    assert.deepStrictEqual(daemon.extensionService.listOnlineExtensionNumbers("sales"), ["101"]);
    assert.deepStrictEqual(
      daemon.extensionService.listOnlineExtensionTargetsByRef("sales").map((entry) => entry.endpointId),
      ["contact:sip:101@127.0.0.1", "contact:sip:101@127.0.0.2"],
    );

    daemon.extensionService.unregisterEndpoint("sales", "101", {
      contactUri: "sip:101@127.0.0.1",
    });
    assert.deepStrictEqual(daemon.extensionService.listOnlineExtensionNumbers("sales"), ["101"]);
    assert.deepStrictEqual(
      daemon.extensionService.listOnlineExtensionTargetsByRef("sales").map((entry) => entry.endpointId),
      ["contact:sip:101@127.0.0.2"],
    );

    daemon.extensionService.unregisterEndpoint("sales", "101", {
      contactUri: "sip:101@127.0.0.2",
    });
    assert.deepStrictEqual(daemon.extensionService.listOnlineExtensionNumbers("sales"), []);
  } finally {
    await daemon.stop();
  }
});

test("same-ref same-number endpoints remain available while at least one endpoint is still free", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-extensions-registration-availability.sock");

  try {
    daemon.extensionService.registerEndpoint({
      ref: "sales",
      extensionNumber: "101",
      contactUri: "sip:101@sales-a.local",
      expiresAt: Date.now() + 1000,
    });
    daemon.extensionService.registerEndpoint({
      ref: "sales",
      extensionNumber: "101",
      contactUri: "sip:101@sales-b.local",
      expiresAt: Date.now() + 1000,
    });

    daemon.legService.createLeg({
      legId: "sales-busy-endpoint-a",
      direction: "outbound",
      transportType: "sip",
      status: "answered",
      triggerMetadata: {
        ref: "sales",
        extensionNumber: "101",
        endpointId: "contact:sip:101@sales-a.local",
      },
    });

    assert.deepStrictEqual(daemon.extensionService.listAvailableExtensionNumbers("sales", ["101"]), ["101"]);
    assert.deepStrictEqual(
      daemon.extensionService.listAvailableExtensionTargets(["101"]).map((entry) => entry.endpointId),
      ["contact:sip:101@sales-b.local"],
    );
  } finally {
    await daemon.stop();
  }
});

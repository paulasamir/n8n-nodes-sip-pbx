"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("extension list dial resolves registrations only within the current flow", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-extension-dial-scope.sock");

  try {
    daemon.extensionService.registerEndpoint({
      ref: "flow:workflow%3Aalpha:extensions:sales",
      extensionNumber: "100",
      contactUri: "sip:100@alpha.local",
    });
    daemon.extensionService.registerEndpoint({
      ref: "flow:workflow%3Abeta:extensions:support",
      extensionNumber: "100",
      contactUri: "sip:100@beta.local",
    });

    const result = daemon.signalingService.makeDial({
      callMode: "extension",
      extensionNumbers: ["100"],
      workflowScopeKey: "workflow:alpha",
    });

    const dial = daemon.dialRegistry.get(result.dialId);
    assert.deepStrictEqual(dial.targets, [
      {
        kind: "extension",
        ref: "flow:workflow%3Aalpha:extensions:sales",
        extensionNumber: "100",
        endpointId: "contact:sip:100@alpha.local",
      },
    ]);
    assert.deepStrictEqual(dial.attemptLegIds.length, 1);
  } finally {
    await daemon.stop();
  }
});

test("extension list dial fans out to all same-flow endpoints for the requested extension numbers across different refs", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-extension-dial-fanout.sock");

  try {
    daemon.extensionService.registerEndpoint({
      ref: "flow:workflow%3Aalpha:extensions:sales",
      extensionNumber: "100",
      contactUri: "sip:100@sales.local",
    });
    daemon.extensionService.registerEndpoint({
      ref: "flow:workflow%3Aalpha:extensions:support",
      extensionNumber: "100",
      contactUri: "sip:100@support.local",
    });

    const result = daemon.signalingService.makeDial({
      callMode: "extension",
      extensionNumbers: ["100"],
      workflowScopeKey: "workflow:alpha",
    });

    const dial = daemon.dialRegistry.get(result.dialId);
    assert.deepStrictEqual(dial.targets, [
      {
        kind: "extension",
        ref: "flow:workflow%3Aalpha:extensions:sales",
        extensionNumber: "100",
        endpointId: "contact:sip:100@sales.local",
      },
      {
        kind: "extension",
        ref: "flow:workflow%3Aalpha:extensions:support",
        extensionNumber: "100",
        endpointId: "contact:sip:100@support.local",
      },
    ]);
    assert.deepStrictEqual(dial.attemptLegIds.length, 2);
  } finally {
    await daemon.stop();
  }
});

test("extension list dial targets only free endpoints by default and can include busy endpoints explicitly", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-extension-list-free-only.sock");

  try {
    daemon.extensionService.registerEndpoint({
      ref: "flow:workflow%3Aalpha:extensions:sales",
      extensionNumber: "100",
      contactUri: "sip:100@sales-a.local",
    });
    daemon.extensionService.registerEndpoint({
      ref: "flow:workflow%3Aalpha:extensions:sales",
      extensionNumber: "100",
      contactUri: "sip:100@sales-b.local",
    });

    daemon.legService.createLeg({
      legId: "busy-sales-endpoint-a",
      direction: "outbound",
      transportType: "sip",
      status: "answered",
      triggerMetadata: {
        ref: "flow:workflow%3Aalpha:extensions:sales",
        extensionNumber: "100",
        endpointId: "contact:sip:100@sales-a.local",
      },
    });

    const freeOnly = daemon.signalingService.makeDial({
      callMode: "extension",
      extensionNumbers: ["100"],
      workflowScopeKey: "workflow:alpha",
    });
    assert.deepStrictEqual(daemon.dialRegistry.get(freeOnly.dialId).targets, [
      {
        kind: "extension",
        ref: "flow:workflow%3Aalpha:extensions:sales",
        extensionNumber: "100",
        endpointId: "contact:sip:100@sales-b.local",
      },
    ]);

    const allEndpoints = daemon.signalingService.makeDial({
      callMode: "extension",
      extensionNumbers: ["100"],
      extensionOnlyFreeEndpoints: false,
      workflowScopeKey: "workflow:alpha",
    });
    assert.deepStrictEqual(daemon.dialRegistry.get(allEndpoints.dialId).targets, [
      {
        kind: "extension",
        ref: "flow:workflow%3Aalpha:extensions:sales",
        extensionNumber: "100",
        endpointId: "contact:sip:100@sales-a.local",
      },
      {
        kind: "extension",
        ref: "flow:workflow%3Aalpha:extensions:sales",
        extensionNumber: "100",
        endpointId: "contact:sip:100@sales-b.local",
      },
    ]);
  } finally {
    await daemon.stop();
  }
});

test("extension sequential dial preserves extension number order and exhausts all matching endpoints of one number before the next", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-extension-list-sequential-order.sock");

  try {
    daemon.extensionService.registerEndpoint({
      ref: "flow:workflow%3Aalpha:extensions:sales",
      extensionNumber: "100",
      contactUri: "sip:100@sales.local",
    });
    daemon.extensionService.registerEndpoint({
      ref: "flow:workflow%3Aalpha:extensions:support",
      extensionNumber: "200",
      contactUri: "sip:200-b@support.local",
    });
    daemon.extensionService.registerEndpoint({
      ref: "flow:workflow%3Aalpha:extensions:support",
      extensionNumber: "200",
      contactUri: "sip:200-a@support.local",
    });

    const result = daemon.signalingService.makeDial({
      callMode: "extension",
      callStrategy: "sequential",
      extensionNumbers: ["200", "100"],
      workflowScopeKey: "workflow:alpha",
    });

    const dial = daemon.dialRegistry.get(result.dialId);
    assert.deepStrictEqual(dial.targets, [
      {
        kind: "extension",
        ref: "flow:workflow%3Aalpha:extensions:support",
        extensionNumber: "200",
        endpointId: "contact:sip:200-a@support.local",
      },
      {
        kind: "extension",
        ref: "flow:workflow%3Aalpha:extensions:support",
        extensionNumber: "200",
        endpointId: "contact:sip:200-b@support.local",
      },
      {
        kind: "extension",
        ref: "flow:workflow%3Aalpha:extensions:sales",
        extensionNumber: "100",
        endpointId: "contact:sip:100@sales.local",
      },
    ]);
    assert.deepStrictEqual(dial.attemptLegIds.length, 1);
  } finally {
    await daemon.stop();
  }
});

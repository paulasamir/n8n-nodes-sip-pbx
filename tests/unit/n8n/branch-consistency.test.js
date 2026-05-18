"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const actionDescription = require("../../../build-src/n8n/ui/action-description.js");
const triggerDescription = require("../../../build-src/n8n/ui/trigger-description.js");
const branches = require("../../../build-src/shared/branches.js");

// === Helpers ===============================================================

function parseExpression(expr) {
  // n8n parameter expressions are of the form `={{ <js> }}`. We strip the
  // wrapper and evaluate the body in isolation with a $parameter object so we
  // can compare what the UI declares against what the runtime emits.
  const trimmed = String(expr || "").trim();
  if (!trimmed.startsWith("={{") || !trimmed.endsWith("}}")) {
    throw new Error(`Not an n8n expression: ${trimmed.slice(0, 80)}`);
  }
  return trimmed.slice(3, -2);
}

function evaluateOutputs(expression, parameterValues) {
  const body = parseExpression(expression);
  const factory = new Function("$parameter", `return (${body});`);
  return factory(parameterValues);
}

function uiOutputCount(operation, parameterValues = {}) {
  const desc = actionDescription.createSipPbxActionDescription();
  const params = { ...parameterValues, operation };
  const outputs = evaluateOutputs(desc.outputs, params);
  return outputs.length;
}

function triggerOutputCount(parameterValues) {
  const desc = triggerDescription.createSipPbxTriggerDescription();
  const outputs = evaluateOutputs(desc.outputs, parameterValues);
  return outputs.length;
}

// === Trigger consistency ===================================================

test("queue trigger declares exactly the registry-ordered branches", () => {
  const count = triggerOutputCount({ triggerOn: "queue" });
  assert.strictEqual(count, branches.QueueTriggerBranches.length);
});

test("ai tool trigger declares exactly the registry-ordered branches", () => {
  const count = triggerOutputCount({ triggerOn: "aiTool" });
  assert.strictEqual(count, branches.AiToolTriggerBranches.length);
});

test("trunk trigger output count matches buildTrunkTriggerBranchOrder for fixed/dynamic auth combinations", () => {
  for (const trunkConnectionMode of ["fixed", "dynamic"]) {
    for (const enableCallRecording of [false, true]) {
      for (const authMode of ["static", "digest-first", "raw"]) {
        const enableAuth = trunkConnectionMode === "dynamic" && authMode !== "static";
        assert.strictEqual(
          triggerOutputCount({ triggerOn: "trunk", trunkConnectionMode, enableCallRecording, authMode }),
          branches.buildTrunkTriggerBranchOrder(enableCallRecording, enableAuth).length,
        );
      }
    }
  }
});

test("recording and auth trigger branches use stable names", () => {
  assert.strictEqual(branches.TrunkTriggerBranchRecord, "Recording");
  assert.strictEqual(branches.TrunkTriggerBranchAuth, "Auth");
  assert.strictEqual(branches.ExtensionsTriggerBranchRecord, "Recording");
});

test("extensions trigger output count matches buildExtensionsTriggerBranchOrder for all combinations", () => {
  for (const enableRecording of [false, true]) {
    for (const authMode of ["static", "digest-first", "raw"]) {
      const enableAuth = authMode !== "static";
      const actual = triggerOutputCount({
        triggerOn: "extensions",
        extensionsEnableCallRecording: enableRecording,
        authMode,
      });
      const expected = branches.buildExtensionsTriggerBranchOrder(enableRecording, enableAuth).length;
      assert.strictEqual(actual, expected, `recording=${enableRecording} auth=${authMode}: got ${actual}, want ${expected}`);
    }
  }
});

// === Action consistency ====================================================

test("single-output actions declare one branch (Result-style)", () => {
  for (const op of [
    "call.ringing", "call.answer", "call.hangup",
    "recording.control", "recording.start",
    "dial.break",
    "media.stopMedia", "media.sendDtmf",
    "queue.putLeg", "queue.setCallback", "queue.getStats",
    "respond.toRecord", "respond.toAuth", "respond.toAiTool",
    "ai.attachVoiceAgent",
  ]) {
    assert.strictEqual(uiOutputCount(op), 1, `${op} should declare exactly 1 output`);
  }
});

test("dial.make declares one branch for non-extension modes and two branches for extension mode", () => {
  assert.strictEqual(uiOutputCount("dial.make", { callMode: "trunk" }), 1);
  assert.strictEqual(uiOutputCount("dial.make", { callMode: "direct" }), 1);
  assert.strictEqual(uiOutputCount("dial.make", { callMode: "websocket" }), 1);
  assert.strictEqual(uiOutputCount("dial.make", { callMode: "extension" }), branches.DialMakeBranches.length);
  assert.deepStrictEqual(branches.DialMakeBranches, ["Result", "Unavailable"]);
});

test("call.bridge declares one branch (BridgeBranch)", () => {
  assert.strictEqual(uiOutputCount("call.bridge"), branches.BridgeBranches.length);
});

test("call.unbridge declares Orig + Peer", () => {
  assert.strictEqual(uiOutputCount("call.unbridge"), branches.UnbridgeBranches.length);
});

test("media.wait declares Interrupted/Timeout/Completed", () => {
  assert.strictEqual(uiOutputCount("media.wait"), branches.WaitMediaBranches.length);
  assert.deepStrictEqual(branches.WaitMediaBranches, ["Interrupted", "Timeout", "Completed"]);
});

test("media play/record blocking declares 2 branches", () => {
  for (const op of ["media.playAudio", "media.playTone", "media.recordAudio"]) {
    assert.strictEqual(
      uiOutputCount(op, { options: { mediaExecutionMode: "blocking" } }),
      2,
      `${op} blocking should declare 2 outputs`,
    );
  }
});

test("media play/record background declares 1 branch", () => {
  for (const op of ["media.playAudio", "media.playTone", "media.recordAudio"]) {
    assert.strictEqual(
      uiOutputCount(op, { options: { mediaExecutionMode: "background" } }),
      1,
      `${op} background should declare 1 output`,
    );
  }
});

test("media.playTone with repeatInfinite declares 1 branch (Interrupted)", () => {
  assert.strictEqual(
    uiOutputCount("media.playTone", { options: {}, repeatInfinite: true }),
    1,
  );
});

test("dial.wait output count matches the runtime plan for every selectedOutput combination", () => {
  for (const includeRinging of [false, true]) {
    for (const includeProgress of [false, true]) {
      for (const includeRejected of [false, true]) {
        const selected = [];
        if (includeRinging) selected.push("ringing");
        if (includeProgress) selected.push("progress");
        if (includeRejected) selected.push("rejected");
        const ui = uiOutputCount("dial.wait", {
          waitEventOutputs: selected,
          legId: "",
          interruptOn: [],
        });
        const plan = branches.buildDialWaitBranchOrder({ includeRinging, includeProgress, includeRejected }).length;
        assert.strictEqual(ui, plan, `dial selected=${selected.join(",")}: ui=${ui} plan=${plan}`);
      }
    }
  }
});

test("dial.wait branch order keeps Timeout before Failed and Rejected before Answered", () => {
  assert.deepStrictEqual(
    branches.buildDialWaitBranchOrder({ includeRinging: false, includeProgress: false, includeRejected: false }),
    ["Answered", "Interrupted", "Timeout", "Failed"],
  );
  assert.deepStrictEqual(
    branches.buildDialWaitBranchOrder({ includeRinging: true, includeProgress: true, includeRejected: true }),
    ["Ringing", "Progress", "Rejected", "Answered", "Interrupted", "Timeout", "Failed"],
  );
});

test("call.wait output count = rules + static tail", () => {
  const rulesShape = [
    { rules: { item: [] }, expectedRuleCount: 0 },
    { rules: { item: [{ pattern: "1", label: "A" }] }, expectedRuleCount: 1 },
    { rules: { item: [{ pattern: "1", label: "A" }, { pattern: "2", label: "B" }, { pattern: "3", label: "C" }] }, expectedRuleCount: 3 },
    { rules: { item: [{ pattern: "1", label: "" }] }, expectedRuleCount: 0 }, // empty label is filtered
  ];
  for (const withFallback of [false, true]) {
    for (const withInterrupt of [false, true]) {
      const tailSize = branches.buildCallWaitStaticTail(withFallback, withInterrupt).length;
      for (const { rules, expectedRuleCount } of rulesShape) {
        const ui = uiOutputCount("call.wait", {
          rules,
          waitDtmfFallbackEnabled: withFallback,
          options: { interruptReasons: withInterrupt ? ["call_bridge_joined"] : [] },
        });
        assert.strictEqual(
          ui,
          expectedRuleCount + tailSize,
          `fallback=${withFallback} interrupt=${withInterrupt} rules=${expectedRuleCount}: got ${ui}`,
        );
      }
    }
  }
});

test("call.wait static tail order keeps Ended last", () => {
  assert.deepStrictEqual(
    branches.buildCallWaitStaticTail(false, false),
    ["Timeout", "Ended"],
  );
  assert.deepStrictEqual(
    branches.buildCallWaitStaticTail(false, true),
    ["Interrupted", "Timeout", "Ended"],
  );
  assert.deepStrictEqual(
    branches.buildCallWaitStaticTail(true, false),
    ["DTMF Fallback", "Timeout", "Ended"],
  );
  assert.deepStrictEqual(
    branches.buildCallWaitStaticTail(true, true),
    ["DTMF Fallback", "Interrupted", "Timeout", "Ended"],
  );
});

// === Branch name registry sanity ==========================================

test("requireBranchIndex throws for unknown names", () => {
  assert.throws(() => branches.requireBranchIndex(["A", "B"], "Z"));
});

test("buildEmptyOutputs has one [] slot per branch", () => {
  for (const order of [
    branches.QueueTriggerBranches,
    branches.UnbridgeBranches,
    branches.WaitMediaBranches,
    branches.buildTrunkTriggerBranchOrder(true, true),
    branches.buildExtensionsTriggerBranchOrder(true, true),
    branches.buildDialWaitBranchOrder({ includeRinging: true, includeProgress: true, includeRejected: true }),
    branches.buildCallWaitStaticTail(true, true),
  ]) {
    const outputs = branches.buildEmptyOutputs(order);
    assert.strictEqual(outputs.length, order.length);
    for (const slot of outputs) {
      assert.ok(Array.isArray(slot) && slot.length === 0);
    }
  }
});

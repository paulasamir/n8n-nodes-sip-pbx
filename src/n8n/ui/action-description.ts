import {
  ActionResultBranch,
  BridgeBranch,
  buildCallWaitStaticTail,
  DialMakeBranchUnavailable,
  DialMakeBranchResult,
  DialWaitBranchAnswered,
  DialWaitBranchFailed,
  DialWaitBranchProgress,
  DialWaitBranchRejected,
  DialWaitBranchRinging,
  DialWaitBranchTimeout,
  MediaBackgroundBranchResult,
  MediaBlockingBranchCompleted,
  MediaBlockingBranchInterrupted,
  MediaInfiniteToneBranchInterrupted,
  UnbridgeBranches,
  WaitMediaBranches,
} from "../../shared/branches";
import { buildActionNodeProperties } from "./action-properties";
import { buildWebSocketDialProfileCredentials } from "../websocket-profiles";

function listToOutputs(names: readonly string[]): string {
  return names.map((name) => `{ type: "main", displayName: ${JSON.stringify(name)} }`).join(", ");
}

function actionInputsExpression(): string {
  return `={{(() => {
    const operation = $parameter["operation"];
    if (operation === "ai.invokeAiTool") {
      return [];
    }
    if (operation === "ai.attachVoiceAgent") {
      return [
        "main",
        { type: "ai_memory", maxConnections: 1 },
        "ai_tool",
      ];
    }
    return ["main"];
  })()}}`;
}

function actionOutputsExpression(): string {
  const result = JSON.stringify(ActionResultBranch);
  const bridge = JSON.stringify(BridgeBranch);
  const unbridge = listToOutputs(UnbridgeBranches);
  const waitMedia = listToOutputs(WaitMediaBranches);
  const callWaitTailNoFallback = buildCallWaitStaticTail(false);
  const callWaitTailWithFallback = buildCallWaitStaticTail(true);
  const callTailNoFallbackJs = JSON.stringify(callWaitTailNoFallback);
  const callTailWithFallbackJs = JSON.stringify(callWaitTailWithFallback);
  const dialMakeResult = JSON.stringify(DialMakeBranchResult);
  const dialMakeUnavailable = JSON.stringify(DialMakeBranchUnavailable);
  const dialRinging = JSON.stringify(DialWaitBranchRinging);
  const dialProgress = JSON.stringify(DialWaitBranchProgress);
  const dialAnswered = JSON.stringify(DialWaitBranchAnswered);
  const dialRejected = JSON.stringify(DialWaitBranchRejected);
  const dialFailed = JSON.stringify(DialWaitBranchFailed);
  const dialTimeout = JSON.stringify(DialWaitBranchTimeout);
  const mediaInterrupted = JSON.stringify(MediaBlockingBranchInterrupted);
  const mediaCompleted = JSON.stringify(MediaBlockingBranchCompleted);
  const mediaBackground = JSON.stringify(MediaBackgroundBranchResult);
  const mediaInfiniteTone = JSON.stringify(MediaInfiniteToneBranchInterrupted);
  return `={{(() => {
    const operation = $parameter["operation"];
    const mediaOptions = $parameter["mediaOptions"] || {};
    const mediaExecutionMode = mediaOptions.mediaExecutionMode || $parameter["mediaExecutionMode"];
    if (operation === "ai.invokeAiTool") return [{ type: "ai_tool", displayName: "Tool" }];
    if (operation === "call.bridge") return [{ type: "main", displayName: ${bridge} }];
    if (operation === "ai.attachVoiceAgent") return [{ type: "main", displayName: ${result} }];
    if (operation === "call.unbridge") return [${unbridge}];
    if (operation === "dial.make") {
      if ($parameter["callMode"] === "extension") {
        return [
          { type: "main", displayName: ${dialMakeResult} },
          { type: "main", displayName: ${dialMakeUnavailable} },
        ];
      }
      return [{ type: "main", displayName: ${result} }];
    }
    if (operation === "call.wait") {
      const rulesRoot = $parameter["rules"] || {};
      const rules = Array.isArray(rulesRoot.item) ? rulesRoot.item : [];
      const outputs = rules
        .filter((rule) => rule && rule.pattern && rule.label)
        .map((rule, index) => ({ type: "main", displayName: String(rule.label || rule.pattern || ("DTMF " + (index + 1))) }));
      const tail = $parameter["waitDtmfFallbackEnabled"] ? ${callTailWithFallbackJs} : ${callTailNoFallbackJs};
      for (const name of tail) outputs.push({ type: "main", displayName: name });
      return outputs;
    }
    if (operation === "dial.wait") {
      const selected = Array.isArray($parameter["waitEventOutputs"]) ? $parameter["waitEventOutputs"] : [];
      const outputs = [];
      if (selected.includes("ringing")) outputs.push({ type: "main", displayName: ${dialRinging} });
      if (selected.includes("progress")) outputs.push({ type: "main", displayName: ${dialProgress} });
      if (selected.includes("rejected")) outputs.push({ type: "main", displayName: ${dialRejected} });
      outputs.push({ type: "main", displayName: ${dialAnswered} });
      outputs.push({ type: "main", displayName: ${dialTimeout} });
      outputs.push({ type: "main", displayName: ${dialFailed} });
      return outputs;
    }
    if (operation === "media.wait") {
      return [${waitMedia}];
    }
    if (operation === "media.playAudio" || operation === "media.playTone" || operation === "media.recordAudio") {
      if (mediaExecutionMode === "background") {
        return [{ type: "main", displayName: ${mediaBackground} }];
      }
      if (operation === "media.playTone" && $parameter["repeatInfinite"]) {
        return [{ type: "main", displayName: ${mediaInfiniteTone} }];
      }
      return [{ type: "main", displayName: ${mediaInterrupted} }, { type: "main", displayName: ${mediaCompleted} }];
    }
    return [{ type: "main", displayName: ${result} }];
  })()}}`;
}

function actionSubtitleExpression(): string {
  return `={{(() => {
    const operation = $parameter["operation"];
    return operation;
  })()}}`;
}

export function createSipPbxActionDescription(): Record<string, unknown> {
  return {
    displayName: "SIP PBX",
    name: "sipPbx",
    documentationUrl: "https://github.com/siptg/n8n-nodes-sip-pbx/wiki",
    icon: "file:siptg-phone.svg",
    group: ["transform"],
    version: 1,
    subtitle: actionSubtitleExpression(),
    defaults: { name: "SIP PBX" },
    keywords: [
      "sip",
      "pbx",
      "voip",
      "ivr",
      "call",
      "dial",
      "bridge",
      "unbridge",
      "ring",
      "answer",
      "hangup",
      "dtmf",
      "media",
      "play",
      "tone",
      "record",
      "queue",
      "callback",
      "dispatch",
      "trunk",
      "extension",
      "websocket",
      "voice",
    ],
    usableAsTool: true,
    inputs: actionInputsExpression(),
    outputs: actionOutputsExpression(),
    credentials: [
      {
        name: "__sipPbxHiddenCredentialSentinel",
        required: false,
        displayOptions: { show: { resource: ["__never__"] } },
      },
      {
        name: "sipPbxExternal",
        required: false,
        displayOptions: { show: { resource: ["dial"], operation: ["dial.make"], callMode: ["direct"] } },
      },
      ...buildWebSocketDialProfileCredentials({ resource: ["dial"], operation: ["dial.make"], callMode: ["websocket"] }),
    ],
    properties: buildActionNodeProperties(),
  };
}

import {
  AiToolTriggerBranches,
  ExtensionsTriggerBranchAuth,
  ExtensionsTriggerBranchCall,
  ExtensionsTriggerBranchRecord,
  QueueTriggerBranches,
  TrunkTriggerBranchAuth,
  TrunkTriggerBranchCall,
  TrunkTriggerBranchRecord,
} from "../../shared/branches";
import { buildTriggerNodeProperties } from "./trigger-properties";

function listToOutputs(names: readonly string[]): string {
  return names.map((name) => `{ type: "main", displayName: ${JSON.stringify(name)} }`).join(", ");
}

function triggerOutputsExpression(): string {
  const aiTool = listToOutputs(AiToolTriggerBranches);
  const queue = listToOutputs(QueueTriggerBranches);
  const callName = JSON.stringify(TrunkTriggerBranchCall);
  const recordName = JSON.stringify(TrunkTriggerBranchRecord);
  const trunkAuthName = JSON.stringify(TrunkTriggerBranchAuth);
  const authName = JSON.stringify(ExtensionsTriggerBranchAuth);
  const extCallName = JSON.stringify(ExtensionsTriggerBranchCall);
  const extRecordName = JSON.stringify(ExtensionsTriggerBranchRecord);
  return `={{(() => {
    const triggerOn = $parameter["triggerOn"];
    if (triggerOn === "aiTool") return [${aiTool}];
    if (triggerOn === "extensions") {
      const authMode = $parameter["authMode"];
      const outputs = [{ type: "main", displayName: ${extCallName} }];
      if ($parameter["extensionsEnableCallRecording"]) {
        outputs.push({ type: "main", displayName: ${extRecordName} });
      }
      if (authMode !== "static") {
        outputs.push({ type: "main", displayName: ${authName} });
      }
      return outputs;
    }
    if (triggerOn === "queue") return [${queue}];
    const outputs = [{ type: "main", displayName: ${callName} }];
    if ($parameter["enableCallRecording"]) {
      outputs.push({ type: "main", displayName: ${recordName} });
    }
    if ($parameter["trunkRegisterMode"] === "auth") {
      outputs.push({ type: "main", displayName: ${trunkAuthName} });
    }
    return outputs;
  })()}}`;
}

export function createSipPbxTriggerDescription(): Record<string, unknown> {
  return {
    displayName: "SIP PBX Trigger",
    name: "sipPbxTrigger",
    documentationUrl: "https://github.com/siptg/n8n-nodes-sip-pbx/wiki",
    icon: "file:siptg-phone.svg",
    group: ["trigger"],
    version: 1,
    subtitle: `={{(() => {
      return $parameter["triggerOn"] + ": " + $parameter["ref"];
    })()}}`,
    defaults: { name: "SIP PBX Trigger" },
    keywords: [
      "sip",
      "pbx",
      "trigger",
      "voip",
      "ivr",
      "trunk",
      "extension",
      "record",
      "queue",
      "voice",
      "agent",
    ],
    inputs: [],
    outputs: triggerOutputsExpression(),
    credentials: [
      {
        name: "sipPbxExternal",
        required: false,
        displayOptions: { show: { triggerOn: ["trunk"], trunkRegisterMode: ["register"] } },
      },
    ],
    properties: buildTriggerNodeProperties(),
  };
}

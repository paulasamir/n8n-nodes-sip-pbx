import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { AiToolTriggerBranches, AiToolTriggerBranchRequest, buildEmptyOutputs, requireBranchIndex } from "../../shared/branches";
import { readOptions, readStringParameter } from "../shared/input-normalization";
import { attachResponseHandle, buildTriggerItem } from "../shared/output-builders";

export async function activateAiToolTrigger(node: any, runtime: PbxRuntime): Promise<any> {
  const ref = readStringParameter(node, "ref", 0, OPTION_DEFAULTS.common.string);
  if (!ref) {
    throw new Error("Trigger ref is required");
  }
  const options = readOptions(node, 0);
  await runtime.openAiToolTrigger(
    {
      ref,
      aiToolResponseTimeoutSeconds: (() => {
        const raw = options.aiToolResponseTimeoutSeconds;
        if (raw == null || raw === "") {
          return OPTION_DEFAULTS.trigger.aiTool.responseTimeoutSeconds;
        }
        const numeric = Number(raw);
        return Number.isFinite(numeric) ? numeric : OPTION_DEFAULTS.trigger.aiTool.responseTimeoutSeconds;
      })(),
    },
    ({ payload }) => {
      if (typeof node?.emit !== "function") {
        return;
      }
      const refValue = String(payload.ref || "");
      const aiToolRequestId = String(payload.aiToolRequestId || "");
      const item = buildTriggerItem({
        ref: refValue,
        aiToolRequestId,
        aiLegId: String(payload.aiLegId || ""),
        peerLegId: String(payload.peerLegId || ""),
        flowParams: payload.flowParams && typeof payload.flowParams === "object" && !Array.isArray(payload.flowParams)
          ? payload.flowParams as Record<string, unknown>
          : {},
        toolParams: payload.toolParams && typeof payload.toolParams === "object" && !Array.isArray(payload.toolParams)
          ? payload.toolParams as Record<string, unknown>
          : {},
      }, {
        ref: refValue,
        aiToolRequestId: aiToolRequestId || undefined,
      });
      if (aiToolRequestId) {
        attachResponseHandle(item, "aiTool", aiToolRequestId);
      }
      const outputs = buildEmptyOutputs(AiToolTriggerBranches);
      outputs[requireBranchIndex(AiToolTriggerBranches, AiToolTriggerBranchRequest)].push(item);
      node.emit(outputs);
    },
  );

  return {
    closeFunction: async () => {
      await runtime.closeTriggerStream("aiTool", { ref });
    },
  };
}

import type { PbxRuntime } from "../../runtime/pbx-runtime";
import {
  buildEmptyOutputs,
  QueueTriggerBranchDispatch,
  QueueTriggerBranchOffline,
  QueueTriggerBranchPlaced,
  QueueTriggerBranches,
  requireBranchIndex,
  type QueueTriggerBranch,
} from "../../shared/branches";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { readStringParameter } from "../shared/input-normalization";
import { buildTriggerItem } from "../shared/output-builders";

export async function activateQueueTrigger(node: any, runtime: PbxRuntime): Promise<any> {
  const ref = readStringParameter(node, "ref", 0, OPTION_DEFAULTS.common.string);
  if (!ref) {
    throw new Error("Trigger ref is required");
  }
  const queueExtensions = readStringParameter(node, "queueExtensions", 0, OPTION_DEFAULTS.common.string)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  await runtime.openQueueTrigger(
    {
      ref,
      queueExtensions,
    },
    ({ branch, payload }) => {
      if (typeof node?.emit !== "function") {
        return;
      }
      const branchName = branch as QueueTriggerBranch;
      if (!(QueueTriggerBranches as readonly string[]).includes(branchName)) {
        return;
      }
      const refValue = String(payload.ref || "");
      const outputs = buildEmptyOutputs(QueueTriggerBranches);
      if (branchName === QueueTriggerBranchPlaced) {
        const legId = String(payload.legId || "");
        outputs[requireBranchIndex(QueueTriggerBranches, QueueTriggerBranchPlaced)].push(buildTriggerItem({
          ref: refValue,
          legId,
          callerNumber: String(payload.callerNumber || ""),
          callerName: String(payload.callerName || ""),
          trunkRef: String(payload.trunkRef || ""),
        }, { ref: refValue, legId: legId || undefined }));
      } else if (branchName === QueueTriggerBranchDispatch) {
        const rawLegId = typeof payload.legId === "string" ? String(payload.legId).trim() : "";
        const itemPayload: Record<string, unknown> = {
          ref: refValue,
          mode: String(payload.mode || ""),
          dialId: String(payload.dialId || ""),
          callerNumber: String(payload.callerNumber || ""),
          callerName: String(payload.callerName || ""),
          trunkRef: String(payload.trunkRef || ""),
        };
        if (rawLegId) {
          itemPayload.legId = rawLegId;
        }
        outputs[requireBranchIndex(QueueTriggerBranches, QueueTriggerBranchDispatch)].push(buildTriggerItem(itemPayload, {
          ref: refValue,
          legId: rawLegId || undefined,
          dialId: String(payload.dialId || "") || undefined,
        }));
      } else if (branchName === QueueTriggerBranchOffline) {
        const rawLegId = typeof payload.legId === "string" ? String(payload.legId).trim() : "";
        const itemPayload: Record<string, unknown> = {
          ref: refValue,
          mode: String(payload.mode || ""),
          callerNumber: String(payload.callerNumber || ""),
          callerName: String(payload.callerName || ""),
          trunkRef: String(payload.trunkRef || ""),
        };
        if (rawLegId) {
          itemPayload.legId = rawLegId;
        }
        outputs[requireBranchIndex(QueueTriggerBranches, QueueTriggerBranchOffline)].push(buildTriggerItem(itemPayload, { ref: refValue, legId: rawLegId || undefined }));
      }
      node.emit(outputs);
    },
  );

  return {
    closeFunction: async () => {
      await runtime.closeTriggerStream("queue", { ref });
    },
  };
}

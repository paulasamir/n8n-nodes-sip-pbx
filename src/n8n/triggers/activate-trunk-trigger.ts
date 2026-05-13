import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import {
  buildEmptyOutputs,
  buildTrunkTriggerBranchOrder,
  requireBranchIndex,
  TrunkTriggerBranchCall,
  TrunkTriggerBranchRecord,
  type TrunkTriggerBranch,
} from "../../shared/branches";
import { readCredentialsParameter } from "../shared/credential-loading";
import { readCollectionOptions, readHeaderLinesFromCollectionOptions, readStringParameter } from "../shared/input-normalization";
import { attachResponseHandle, buildTriggerItem, normalizePublicRawObject } from "../shared/output-builders";

function extractSipUser(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const uriMatch = raw.match(/<([^>]+)>/);
  const uri = String(uriMatch ? uriMatch[1] : raw).trim();
  const sipMatch = uri.match(/^sips?:([^@;>]+)/i);
  if (sipMatch) {
    return decodeURIComponent(String(sipMatch[1] || "").trim());
  }
  const atIndex = uri.indexOf("@");
  if (atIndex > 0) {
    return uri.slice(0, atIndex).trim();
  }
  return uri;
}

export async function activateTrunkTrigger(node: any, runtime: PbxRuntime): Promise<any> {
  const ref = readStringParameter(node, "ref", 0, "");
  if (!ref) {
    throw new Error("Trigger ref is required");
  }
  const sipCredentials = await readCredentialsParameter(node, "sipPbxExternal", 0);
  const registerOnStart = Boolean(node.getNodeParameter?.("registerOnStart", 0, OPTION_DEFAULTS.trigger.trunk.registerOnStart));
  const enableCallRecording = Boolean(node.getNodeParameter?.("enableCallRecording", 0, OPTION_DEFAULTS.trigger.trunk.enableCallRecording));
  const options = readCollectionOptions(node, "trunkOptions", 0);
  const config: Record<string, unknown> = {
    ref,
    sipCredentials,
    registerOnStart,
    enableCallRecording,
  };
  if (registerOnStart) {
    const rawRegistrationExpires = options.registrationExpires;
    const numericRegistrationExpires = Number(rawRegistrationExpires);
    config.registrationExpires = Number.isFinite(numericRegistrationExpires)
      ? numericRegistrationExpires
      : OPTION_DEFAULTS.sip.registrationExpiresSeconds;
    config.registerHeaders = readHeaderLinesFromCollectionOptions(options, "registerHeaders");
  }
  if (enableCallRecording) {
    config.recordResponseTimeoutSeconds = (() => {
      const raw = options.recordResponseTimeoutSeconds;
      if (raw == null || raw === "") {
        return OPTION_DEFAULTS.trigger.trunk.recordResponseTimeoutSeconds;
      }
      const numeric = Number(raw);
      return Number.isFinite(numeric) ? numeric : OPTION_DEFAULTS.trigger.trunk.recordResponseTimeoutSeconds;
    })();
  }
  await runtime.openTrunkTrigger(
    config,
    ({ branch, payload }) => {
      if (typeof node?.emit !== "function") {
        return;
      }
      const branchOrder = buildTrunkTriggerBranchOrder(enableCallRecording);
      const branchName = branch as TrunkTriggerBranch;
      if (!(branchOrder as readonly string[]).includes(branchName)) {
        return;
      }
      const outputs = buildEmptyOutputs(branchOrder);
      if (branchName === TrunkTriggerBranchRecord) {
        outputs[requireBranchIndex(branchOrder, TrunkTriggerBranchRecord)].push(buildTriggerItem({
          eventType: String(payload.eventType || "record"),
          recordRequestId: String(payload.recordRequestId || ""),
          kind: String(payload.kind || ""),
          ref: String(payload.ref || ""),
          legId: String(payload.legId || ""),
          callId: String(payload.callId || ""),
          direction: String(payload.direction || ""),
          from: String(payload.from || ""),
          callerNumber: extractSipUser(payload.from),
          callerName: String(payload.callerName || ""),
          to: String(payload.to || ""),
          called: extractSipUser(payload.to),
          extension: String(payload.extension || ""),
        }, {
          ref: String(payload.ref || ""),
          legId: String(payload.legId || "") || undefined,
          callId: String(payload.callId || "") || undefined,
          recordRequestId: String(payload.recordRequestId || "") || undefined,
        }));
        const recordIndex = requireBranchIndex(branchOrder, TrunkTriggerBranchRecord);
        if (String(payload.recordRequestId || "")) {
          attachResponseHandle(outputs[recordIndex][0] as any, "record", String(payload.recordRequestId || ""));
        }
        node.emit(outputs);
        return;
      }
      outputs[requireBranchIndex(branchOrder, TrunkTriggerBranchCall)].push(buildTriggerItem({
        eventType: String(payload.eventType || ""),
        ref: String(payload.ref || ""),
        legId: String(payload.legId || ""),
        callId: String(payload.callId || ""),
        direction: String(payload.direction || ""),
        from: String(payload.from || ""),
        callerNumber: extractSipUser(payload.from),
        callerName: String(payload.callerName || ""),
        to: String(payload.to || ""),
        called: extractSipUser(payload.to),
        raw: normalizePublicRawObject({
          callId: String(payload.callId || ""),
          from: String(payload.from || ""),
          callerName: String(payload.callerName || ""),
          to: String(payload.to || ""),
          headers: payload.headers && typeof payload.headers === "object" ? payload.headers : {},
          ...(payload.raw && typeof payload.raw === "object" ? payload.raw as Record<string, unknown> : {}),
        }),
      }, {
        ref: String(payload.ref || ""),
        legId: String(payload.legId || "") || undefined,
        callId: String(payload.callId || "") || undefined,
      }));
      node.emit(outputs);
    },
  );

  return {
    closeFunction: async () => {
      await runtime.closeTriggerStream("trunk", { ref });
    },
  };
}

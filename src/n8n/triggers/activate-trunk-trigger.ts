import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import {
  buildEmptyOutputs,
  buildTrunkTriggerBranchOrder,
  requireBranchIndex,
  TrunkTriggerBranchAuth,
  TrunkTriggerBranchCall,
  TrunkTriggerBranchRecord,
  type TrunkTriggerBranch,
} from "../../shared/branches";
import { readCredentialsParameter } from "../shared/credential-loading";
import { readCollectionOptions, readHeaderLinesFromCollectionOptions, readStringParameter } from "../shared/input-normalization";
import { attachResponseHandle, buildTriggerItem, normalizePublicRawObject } from "../shared/output-builders";
import { extractSipDisplayName, extractSipUser } from "../shared/sip-address";

function optionalNumber(value: unknown, fallback: number): number {
  if (value == null || value === "") {
    return fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function pickFirst(...sources: unknown[]): unknown {
  for (const value of sources) {
    if (value != null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function normalizeTrunkRegisterModeValue(value: unknown): "register" | "auth" {
  return String(value || OPTION_DEFAULTS.trigger.trunk.registerMode).trim().toLowerCase() === "auth"
    ? "auth"
    : "register";
}

export async function activateTrunkTrigger(node: any, runtime: PbxRuntime): Promise<any> {
  const ref = readStringParameter(node, "ref", 0, "");
  if (!ref) {
    throw new Error("Trigger ref is required");
  }
  const trunkRegisterMode = normalizeTrunkRegisterModeValue(
    node.getNodeParameter?.("trunkRegisterMode", 0, OPTION_DEFAULTS.trigger.trunk.registerMode),
  );
  const registerMode = trunkRegisterMode === "register";
  const enableCallRecording = Boolean(node.getNodeParameter?.("enableCallRecording", 0, OPTION_DEFAULTS.trigger.trunk.enableCallRecording));
  const options = readCollectionOptions(node, "trunkOptions", 0);
  const sipCredentials = registerMode
    ? await readCredentialsParameter(node, "sipPbxExternal", 0)
    : null;
  const credentials = sipCredentials || {};
  const hasAuthBranch = !registerMode;
  const config: Record<string, unknown> = {
    ref,
    trunkRegisterMode,
    enableCallRecording,
    transport: String(pickFirst(options.transport, credentials.transport) || OPTION_DEFAULTS.sip.transport),
    localBindIp: String(pickFirst(options.localBindIp, credentials.localBindIp) || "").trim(),
    localBindPort: Number(pickFirst(options.localBindPort, credentials.localBindPort) || 0) || 0,
    tlsBindPort: optionalNumber(pickFirst(options.tlsBindPort), OPTION_DEFAULTS.sip.tlsPort),
    advertisedIp: String(pickFirst(options.advertisedIp, credentials.publicDomain) || "").trim(),
  };
  if (sipCredentials) {
    config.sipCredentials = sipCredentials;
  }
  if (registerMode) {
    config.registrationExpires = optionalNumber(options.registrationExpires, OPTION_DEFAULTS.sip.registrationExpiresSeconds);
    config.registerHeaders = readHeaderLinesFromCollectionOptions(options, "registerHeaders");
  } else {
    config.realm = String(options.realm || "").trim();
    config.authTimeoutSeconds = optionalNumber(options.authTimeoutSeconds, OPTION_DEFAULTS.trigger.trunk.authTimeoutSeconds);
    config.continueTraversalOnAuthReject = options.continueTraversalOnAuthReject === true;
  }
  if (enableCallRecording) {
    config.recordResponseTimeoutSeconds = optionalNumber(options.recordResponseTimeoutSeconds, OPTION_DEFAULTS.trigger.trunk.recordResponseTimeoutSeconds);
  }
  await runtime.openTrunkTrigger(
    config,
    ({ branch, payload }) => {
      if (typeof node?.emit !== "function") {
        return;
      }
      const branchOrder = buildTrunkTriggerBranchOrder(enableCallRecording, hasAuthBranch);
      const branchName = branch as TrunkTriggerBranch;
      if (!(branchOrder as readonly string[]).includes(branchName)) {
        return;
      }
      const outputs = buildEmptyOutputs(branchOrder);
      if (branchName === TrunkTriggerBranchAuth && hasAuthBranch) {
        const authRequestId = String(payload.authRequestId || "");
        const auth = payload.auth && typeof payload.auth === "object"
          ? payload.auth as Record<string, unknown>
          : {};
        const item = buildTriggerItem({
          authRequestId,
          ref: String(payload.ref || ""),
          requestType: String(payload.requestType || ""),
          auth: Object.fromEntries(Object.entries(auth).map(([name, value]) => [name, String(value ?? "")])),
          remoteIp: String(payload.remoteIp || ""),
          remotePort: Number(payload.remotePort || 0),
          transport: String(payload.transport || ""),
          localIp: String(payload.localIp || ""),
          localPort: Number(payload.localPort || 0),
          raw: normalizePublicRawObject(payload.raw && typeof payload.raw === "object" ? payload.raw : {}),
        }, {
          ref: String(payload.ref || ""),
          authRequestId: authRequestId || undefined,
        });
        if (authRequestId) {
          attachResponseHandle(item, "auth", authRequestId);
        }
        outputs[requireBranchIndex(branchOrder, TrunkTriggerBranchAuth)].push(item);
        node.emit(outputs);
        return;
      }
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
          calledNumber: extractSipUser(payload.to),
          calledName: extractSipDisplayName(payload.to),
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
        calledNumber: extractSipUser(payload.to),
        calledName: extractSipDisplayName(payload.to),
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

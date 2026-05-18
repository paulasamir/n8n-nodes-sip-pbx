import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import {
  TRUNK_CONNECTION_MODE_DYNAMIC,
  TRUNK_CONNECTION_MODE_FIXED,
  type TrunkConnectionMode,
} from "../../shared/trunk-trigger";
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
import {
  readHeaderLinesFromCollectionOptions,
  readOptions,
  readStringParameter,
} from "../shared/input-normalization";
import { attachResponseHandle, buildTriggerItem, normalizePublicRawObject } from "../shared/output-builders";
import { extractSipDisplayName, extractSipUser } from "../shared/sip-address";
import { readSharedAuthTriggerConfig } from "./shared-auth-trigger";
import { normalizeSipAudioCodecFilters, normalizeSipDtmfMethodFilters } from "../../shared/sip-media-filters";

function normalizeSipAudioCodecFiltersOrDefault(value: unknown): string[] {
  const normalized = normalizeSipAudioCodecFilters(value);
  return normalized.length > 0 ? normalized : [...OPTION_DEFAULTS.sipMedia.codecs];
}

function normalizeSipDtmfMethodFiltersOrDefault(value: unknown): string[] {
  const normalized = normalizeSipDtmfMethodFilters(value);
  return normalized.length > 0 ? normalized : [...OPTION_DEFAULTS.sipMedia.dtmfMethods];
}

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

export async function activateTrunkTrigger(node: any, runtime: PbxRuntime): Promise<any> {
  const ref = readStringParameter(node, "ref", 0, OPTION_DEFAULTS.common.string);
  if (!ref) {
    throw new Error("Trigger ref is required");
  }
  const trunkConnectionMode = (
    String(node.getNodeParameter?.("trunkConnectionMode", 0, OPTION_DEFAULTS.trigger.trunk.connectionMode) || "").trim()
    === TRUNK_CONNECTION_MODE_DYNAMIC
      ? TRUNK_CONNECTION_MODE_DYNAMIC
      : TRUNK_CONNECTION_MODE_FIXED
  ) as TrunkConnectionMode;
  const fixedAddressMode = trunkConnectionMode === TRUNK_CONNECTION_MODE_FIXED;
  const useRegistration = fixedAddressMode
    ? Boolean(node.getNodeParameter?.("trunkUseRegistration", 0, OPTION_DEFAULTS.trigger.trunk.useRegistration))
    : false;
  const enableCallRecording = Boolean(node.getNodeParameter?.("enableCallRecording", 0, OPTION_DEFAULTS.trigger.trunk.enableCallRecording));
  const options = readOptions(node, 0);
  const authConfig = trunkConnectionMode === TRUNK_CONNECTION_MODE_DYNAMIC
    ? readSharedAuthTriggerConfig(node, 0, {
      kind: "trunk",
      authModeName: "authMode",
      staticUsernameName: "trunkStaticUsername",
      staticPasswordName: "trunkStaticPassword",
      authTimeoutDefault: OPTION_DEFAULTS.trigger.trunk.authTimeoutSeconds,
      continueTraversalDefault: OPTION_DEFAULTS.trigger.trunk.continueTraversalOnAuthReject,
    })
    : null;
  const sipCredentials = fixedAddressMode
    ? await readCredentialsParameter(node, "sipPbxExternal", 0)
    : null;
  const credentials = sipCredentials || {};
  const hasAuthBranch = trunkConnectionMode === TRUNK_CONNECTION_MODE_DYNAMIC
    && authConfig?.authMode !== "static";
  const config: Record<string, unknown> = {
    ref,
    trunkConnectionMode,
    trunkUseRegistration: useRegistration,
    enableCallRecording,
    transport: String(pickFirst(options.transport, credentials.transport) || OPTION_DEFAULTS.sip.transport),
    localBindIp: String(pickFirst(options.localBindIp, credentials.localBindIp) || "").trim(),
    localBindPort: (() => {
      const raw = pickFirst(options.localBindPort, credentials.localBindPort);
      if (raw == null || raw === "") {
        return OPTION_DEFAULTS.sip.port;
      }
      const numeric = Number(raw);
      return Number.isFinite(numeric) ? numeric : OPTION_DEFAULTS.sip.port;
    })(),
    tlsBindPort: optionalNumber(pickFirst(options.tlsBindPort), OPTION_DEFAULTS.sip.tlsPort),
    advertisedIp: String(pickFirst(options.advertisedIp, credentials.publicDomain) || "").trim(),
    codecs: normalizeSipAudioCodecFiltersOrDefault(options.codecs),
    dtmfMethods: normalizeSipDtmfMethodFiltersOrDefault(options.dtmfMethods),
  };
  if (sipCredentials) {
    config.sipCredentials = sipCredentials;
  }
  if (fixedAddressMode && useRegistration) {
    config.registrationExpires = optionalNumber(options.registrationExpires, OPTION_DEFAULTS.sip.registrationExpiresSeconds);
    config.registerHeaders = readHeaderLinesFromCollectionOptions(options, "registerHeaders");
  } else if (trunkConnectionMode === TRUNK_CONNECTION_MODE_DYNAMIC) {
    config.realm = String(options.realm || "").trim();
    config.authMode = authConfig?.authMode || OPTION_DEFAULTS.trigger.trunk.authMode;
    config.authorizationUsernamePrefix = authConfig?.authorizationUsernamePrefix || "";
    config.continueTraversalOnAuthReject = authConfig?.continueTraversalOnAuthReject === true;
    if (authConfig?.authMode === "static") {
      config.staticCredentials = authConfig.staticCredentials || [];
    } else {
      config.authTimeoutSeconds = authConfig?.authTimeoutSeconds;
    }
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

import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import {
  buildEmptyOutputs,
  buildExtensionsTriggerBranchOrder,
  ExtensionsTriggerBranchAuth,
  ExtensionsTriggerBranchCall,
  ExtensionsTriggerBranchRecord,
  requireBranchIndex,
  type ExtensionsTriggerBranch,
} from "../../shared/branches";
import { readCollectionOptions, readFixedCollectionItems, readStringParameter } from "../shared/input-normalization";
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

function readExtensionsTransportSet(options: Record<string, unknown>): string[] {
  if (!Object.prototype.hasOwnProperty.call(options, "extensionTransports")) {
    return [...OPTION_DEFAULTS.trigger.extensions.transports];
  }
  const raw = options.extensionTransports;
  if (Array.isArray(raw)) {
    return raw
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => value === OPTION_DEFAULTS.sip.transport);
  }
  const text = String(raw || "").trim().toLowerCase();
  return text === OPTION_DEFAULTS.sip.transport ? [...OPTION_DEFAULTS.trigger.extensions.transports] : [];
}

export async function activateExtensionsTrigger(node: any, runtime: PbxRuntime): Promise<any> {
  const ref = readStringParameter(node, "ref", 0, "");
  if (!ref) {
    throw new Error("Trigger ref is required");
  }
  const authMode = readStringParameter(node, "authMode", 0, OPTION_DEFAULTS.trigger.extensions.authMode);
  const extensionsEnableCallRecording = Boolean(node.getNodeParameter?.("extensionsEnableCallRecording", 0, OPTION_DEFAULTS.trigger.extensions.enableCallRecording));
  const options = readCollectionOptions(node, "extensionsOptions", 0);
  const extensionTransports = readExtensionsTransportSet(options);
  if (extensionTransports.length === 0) {
    throw new Error("At least one extensions transport must be selected");
  }
  const hasAuthBranch = authMode !== "static";
  const hasRecordBranch = extensionsEnableCallRecording;
  const config: Record<string, unknown> = {
    ref,
    transport: extensionTransports[0] || OPTION_DEFAULTS.sip.transport,
    extensionTransports: extensionTransports.length > 0 ? extensionTransports : [...OPTION_DEFAULTS.trigger.extensions.transports],
    extensionsLocalBindIp: String(options.extensionsLocalBindIp || "").trim(),
    extensionsLocalBindPort: (() => {
      const raw = options.extensionsLocalBindPort;
      if (raw == null || raw === "") {
        return OPTION_DEFAULTS.trigger.extensions.localBindPort;
      }
      const numeric = Number(raw);
      return Number.isFinite(numeric) ? numeric : OPTION_DEFAULTS.trigger.extensions.localBindPort;
    })(),
    extensionsTlsBindPort: (() => {
      const raw = options.extensionsTlsBindPort;
      if (raw == null || raw === "") {
        return OPTION_DEFAULTS.trigger.extensions.tlsBindPort;
      }
      const numeric = Number(raw);
      return Number.isFinite(numeric) ? numeric : OPTION_DEFAULTS.trigger.extensions.tlsBindPort;
    })(),
    advertisedIp: String(options.advertisedIp || "").trim(),
    realm: String(options.realm || "").trim(),
    authorizationUsernamePrefix: String(options.authorizationUsernamePrefix || "").trim(),
    continueTraversalOnAuthReject: options.continueTraversalOnAuthReject === true,
    authMode,
    extensionsEnableCallRecording,
  };
  if (authMode === "static") {
    config.staticCredentials = readFixedCollectionItems(node, "staticCredentials", 0).map((entry) => ({
      username: String(entry.username || "").trim(),
      password: String(entry.password || "").trim(),
      extension: String(entry.extension || "").trim(),
    }));
  } else {
    config.authTimeoutSeconds = (() => {
      const raw = options.authTimeoutSeconds;
      if (raw == null || raw === "") {
        return OPTION_DEFAULTS.trigger.extensions.authTimeoutSeconds;
      }
      const numeric = Number(raw);
      return Number.isFinite(numeric) ? numeric : OPTION_DEFAULTS.trigger.extensions.authTimeoutSeconds;
    })();
  }
  if (extensionsEnableCallRecording) {
    config.recordResponseTimeoutSeconds = (() => {
      const raw = options.recordResponseTimeoutSeconds;
      if (raw == null || raw === "") {
        return OPTION_DEFAULTS.trigger.extensions.recordResponseTimeoutSeconds;
      }
      const numeric = Number(raw);
      return Number.isFinite(numeric) ? numeric : OPTION_DEFAULTS.trigger.extensions.recordResponseTimeoutSeconds;
    })();
  }
  await runtime.openExtensionsTrigger(
    config,
    ({ branch, payload }) => {
      if (typeof node?.emit !== "function") {
        return;
      }
      const branchOrder = buildExtensionsTriggerBranchOrder(hasRecordBranch, hasAuthBranch);
      const branchName = branch as ExtensionsTriggerBranch;
      if (!(branchOrder as readonly string[]).includes(branchName)) {
        return;
      }
      const emitOutputs = (outputs: any[][]): void => {
        node.emit(outputs);
      };
      if (branchName === ExtensionsTriggerBranchAuth && hasAuthBranch) {
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
        const outputs = buildEmptyOutputs(branchOrder);
        outputs[requireBranchIndex(branchOrder, ExtensionsTriggerBranchAuth)].push(item);
        emitOutputs(outputs);
        return;
      }
      if (branchName === ExtensionsTriggerBranchRecord && hasRecordBranch) {
        const recordRequestId = String(payload.recordRequestId || "");
        const item = buildTriggerItem({
          eventType: String(payload.eventType || "record"),
          recordRequestId,
          kind: String(payload.kind || ""),
          ref: String(payload.ref || ""),
          legId: String(payload.legId || ""),
          callId: String(payload.callId || ""),
          direction: String(payload.direction || ""),
          extension: String(payload.extension || ""),
          from: String(payload.from || ""),
          callerNumber: extractSipUser(payload.from),
          callerName: String(payload.callerName || ""),
          to: String(payload.to || ""),
          called: extractSipUser(payload.to),
        }, {
          ref: String(payload.ref || ""),
          legId: String(payload.legId || "") || undefined,
          callId: String(payload.callId || "") || undefined,
          recordRequestId: recordRequestId || undefined,
        });
        if (recordRequestId) {
          attachResponseHandle(item, "record", recordRequestId);
        }
        const outputs = buildEmptyOutputs(branchOrder);
        outputs[requireBranchIndex(branchOrder, ExtensionsTriggerBranchRecord)].push(item);
        emitOutputs(outputs);
        return;
      }
      const sessionItem = buildTriggerItem({
        eventType: String(payload.eventType || ""),
        ref: String(payload.ref || ""),
        legId: String(payload.legId || ""),
        callId: String(payload.callId || ""),
        direction: String(payload.direction || ""),
        extension: String(payload.extension || ""),
        from: String(payload.from || ""),
        callerNumber: extractSipUser(payload.from),
        callerName: String(payload.callerName || ""),
        to: String(payload.to || ""),
        called: extractSipUser(payload.to),
        raw: normalizePublicRawObject({
          callId: String(payload.callId || ""),
          extension: String(payload.extension || ""),
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
      });
      const outputs = buildEmptyOutputs(branchOrder);
      outputs[requireBranchIndex(branchOrder, ExtensionsTriggerBranchCall)].push(sessionItem);
      emitOutputs(outputs);
    },
  );

  return {
    closeFunction: async () => {
      await runtime.closeTriggerStream("extensions", { ref });
    },
  };
}

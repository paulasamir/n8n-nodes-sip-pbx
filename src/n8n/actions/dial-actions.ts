import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import {
  normalizeExtensionDialConfig,
  readCollectionOptions,
  readFixedCollectionItems,
  readHeaderLinesFromCollectionOptions,
  readNumberParameter,
  readStringListParameter,
  readStringParameter,
  requireActionValue,
} from "../shared/input-normalization";
import { readCredentialsParameter } from "../shared/credential-loading";
import { resolveDialId } from "../shared/id-resolution";
import { applyWebSocketDialProfileInput } from "../websocket-profiles";

export function resolveWaitDialIds(node: any, item: any, index: number): string[] {
  const explicitDialIds = readFixedCollectionItems(node, "dialIds", index)
    .map((entry) => String(entry.dialId || "").trim())
    .filter(Boolean);
  if (explicitDialIds.length > 0) {
    return explicitDialIds;
  }
  const fallbackDialId = String((item?.json && (item.json.dialId || item.json.sipPbx?.dialId)) || "").trim();
  return fallbackDialId ? [fallbackDialId] : [];
}

export async function executeMakeCall(node: any, runtime: PbxRuntime, index: number): Promise<any> {
  const callMode = readStringParameter(node, "callMode", index, "");
  if (!["trunk", "direct", "extension", "websocket"].includes(callMode)) {
    throw new Error("callMode is required");
  }
  const dialOptions = readCollectionOptions(node, "dialOptions", index);
  const callStrategy = callMode === "websocket"
    ? OPTION_DEFAULTS.dial.strategy
    : String(dialOptions.callStrategy || OPTION_DEFAULTS.dial.strategy);
  const sipCredentials = callMode === "direct"
    ? await readCredentialsParameter(node, "sipPbxExternal", index)
    : null;
  const input: Record<string, unknown> = {
    callMode,
  };
  if (callMode === "trunk" || callMode === "direct" || callMode === "extension") {
    input.callStrategy = callStrategy;
    input.callerNumber = String(dialOptions.callerNumber || "").trim();
    input.callerName = String(dialOptions.callerName || "").trim();
    input.customSipHeaders = readHeaderLinesFromCollectionOptions(dialOptions, "customSipHeaders");
    if (callStrategy === "sequential") {
      input.sequentialAttemptTimeoutSeconds = Number(dialOptions.sequentialAttemptTimeoutSeconds ?? OPTION_DEFAULTS.dial.sequentialAttemptTimeoutSeconds);
      input.sequentialGapSeconds = Number(dialOptions.sequentialGapSeconds ?? OPTION_DEFAULTS.dial.sequentialGapSeconds);
    }
  }
  if (callMode === "trunk") {
    input.ref = readStringParameter(node, "ref", index, "");
    input.destination = readStringListParameter(node, "destination", index);
  } else if (callMode === "direct") {
    input.destination = readStringListParameter(node, "destination", index);
    input.sipCredentials = sipCredentials;
  } else if (callMode === "extension") {
    const extensionDialConfig = normalizeExtensionDialConfig({
      extensionNumbers: readStringParameter(node, "extensionNumbers", index, ""),
      callStrategy,
      sequentialAttemptTimeoutSeconds: dialOptions.sequentialAttemptTimeoutSeconds ?? OPTION_DEFAULTS.dial.sequentialAttemptTimeoutSeconds,
      sequentialGapSeconds: dialOptions.sequentialGapSeconds ?? OPTION_DEFAULTS.dial.sequentialGapSeconds,
      options: dialOptions,
      extensionListOnlyFreeEndpointsDefault: OPTION_DEFAULTS.dial.extensionListOnlyFreeEndpoints,
    });
    input.extensionNumbers = extensionDialConfig.extensionNumbers;
    input.callerNumber = extensionDialConfig.callerNumber;
    input.callerName = extensionDialConfig.callerName;
    input.customSipHeaders = extensionDialConfig.customSipHeaders;
    input.extensionListOnlyFreeEndpoints = extensionDialConfig.extensionListOnlyFreeEndpoints;
    if (callStrategy === "sequential") {
      input.sequentialAttemptTimeoutSeconds = extensionDialConfig.sequentialAttemptTimeoutSeconds;
      input.sequentialGapSeconds = extensionDialConfig.sequentialGapSeconds;
    }
  } else if (callMode === "websocket") {
    input.websocketStartMode = readStringParameter(node, "websocketStartMode", index, OPTION_DEFAULTS.dial.websocketStartMode);
    await applyWebSocketDialProfileInput(node, index, input);
  }
  return await runtime.makeDial(input);
}

export async function executeBreakDial(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const dialOptions = readCollectionOptions(node, "dialOptions", index);
  return await runtime.breakDial(
    requireActionValue("dialId", resolveDialId(node, item, index, "dialId", "dialOptions")),
    String(dialOptions.dialBreakReason || "").trim() || readStringParameter(node, "dialBreakReason", index, OPTION_DEFAULTS.dial.breakReason),
  );
}

export async function executeWaitDial(node: any, runtime: PbxRuntime, item: any, index: number, waitEventOutputs: string[]): Promise<any> {
  const dialIds = resolveWaitDialIds(node, item, index);
  if (dialIds.length === 0) {
    throw new Error("dialId is required");
  }
  return await runtime.waitForDialEvent(
    dialIds.length === 1 ? dialIds[0]! : dialIds,
    {
      dialTimeoutSeconds: readNumberParameter(node, "dialTimeoutSeconds", index, OPTION_DEFAULTS.dial.waitTimeoutSeconds),
      waitEventOutputs,
    },
  );
}

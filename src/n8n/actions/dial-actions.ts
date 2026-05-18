import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import {
  hasInterruptSelection,
  normalizeExtensionDialConfig,
  readFixedCollectionItems,
  readInterruptSelections,
  readHeaderLinesFromCollectionOptions,
  readNumberParameter,
  readOptions,
  readStringListParameter,
  readStringParameter,
  requireActionValue,
} from "../shared/input-normalization";
import { INTERRUPT_SELECTION_DTMF } from "../../shared/interrupt-selections";
import { readCredentialsParameter } from "../shared/credential-loading";
import { resolveDialId } from "../shared/id-resolution";
import { applyWebSocketDialProfileInput } from "../websocket-profiles";
import { normalizeSipAudioCodecFilters, normalizeSipDtmfMethodFilters } from "../../shared/sip-media-filters";

function normalizeSipAudioCodecFiltersOrDefault(value: unknown): string[] {
  const normalized = normalizeSipAudioCodecFilters(value);
  return normalized.length > 0 ? normalized : [...OPTION_DEFAULTS.sipMedia.codecs];
}

function normalizeSipDtmfMethodFiltersOrDefault(value: unknown): string[] {
  const normalized = normalizeSipDtmfMethodFilters(value);
  return normalized.length > 0 ? normalized : [...OPTION_DEFAULTS.sipMedia.dtmfMethods];
}

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
  const callMode = readStringParameter(node, "callMode", index, OPTION_DEFAULTS.common.string);
  if (!["trunk", "direct", "extension", "websocket"].includes(callMode)) {
    throw new Error("callMode is required");
  }
  const options = readOptions(node, index);
  const callStrategy = callMode === "websocket"
    ? OPTION_DEFAULTS.dial.strategy
    : String(options.callStrategy || OPTION_DEFAULTS.dial.strategy);
  const sipCredentials = callMode === "direct"
    ? await readCredentialsParameter(node, "sipPbxExternal", index)
    : null;
  const input: Record<string, unknown> = {
    callMode,
  };
  if (callMode === "trunk" || callMode === "direct" || callMode === "extension") {
    input.callStrategy = callStrategy;
    input.callerNumber = String(options.callerNumber || "").trim();
    input.callerName = String(options.callerName || "").trim();
    input.customSipHeaders = readHeaderLinesFromCollectionOptions(options, "customSipHeaders");
    if (callStrategy === "sequential") {
      input.sequentialAttemptTimeoutSeconds = Number(options.sequentialAttemptTimeoutSeconds ?? OPTION_DEFAULTS.dial.sequentialAttemptTimeoutSeconds);
      input.sequentialGapSeconds = Number(options.sequentialGapSeconds ?? OPTION_DEFAULTS.dial.sequentialGapSeconds);
    }
  }
  if (callMode === "trunk") {
    input.ref = readStringParameter(node, "ref", index, OPTION_DEFAULTS.common.string);
    input.destination = readStringListParameter(node, "destination", index);
  } else if (callMode === "direct") {
    input.destination = readStringListParameter(node, "destination", index);
    input.sipCredentials = sipCredentials;
    input.codecs = normalizeSipAudioCodecFiltersOrDefault(options.codecs);
    input.dtmfMethods = normalizeSipDtmfMethodFiltersOrDefault(options.dtmfMethods);
  } else if (callMode === "extension") {
    const extensionDialConfig = normalizeExtensionDialConfig({
      extensionNumbers: readStringParameter(node, "extensionNumbers", index, OPTION_DEFAULTS.common.string),
      callStrategy,
      sequentialAttemptTimeoutSeconds: options.sequentialAttemptTimeoutSeconds ?? OPTION_DEFAULTS.dial.sequentialAttemptTimeoutSeconds,
      sequentialGapSeconds: options.sequentialGapSeconds ?? OPTION_DEFAULTS.dial.sequentialGapSeconds,
      options,
      extensionOnlyFreeEndpointsDefault: OPTION_DEFAULTS.dial.extensionOnlyFreeEndpoints,
    });
    input.extensionNumbers = extensionDialConfig.extensionNumbers;
    input.callerNumber = extensionDialConfig.callerNumber;
    input.callerName = extensionDialConfig.callerName;
    input.customSipHeaders = extensionDialConfig.customSipHeaders;
    input.extensionOnlyFreeEndpoints = extensionDialConfig.extensionOnlyFreeEndpoints;
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
  const options = readOptions(node, index);
  return await runtime.breakDial(
    requireActionValue("dialId", resolveDialId(node, item, index)),
    String(options.dialBreakReason || "").trim() || readStringParameter(node, "dialBreakReason", index, OPTION_DEFAULTS.dial.breakReason),
  );
}

export async function executeWaitDial(node: any, runtime: PbxRuntime, item: any, index: number, waitEventOutputs: string[]): Promise<any> {
  const dialIds = resolveWaitDialIds(node, item, index);
  if (dialIds.length === 0) {
    throw new Error("dialIds are required");
  }
  const legId = readStringParameter(node, "legId", index, OPTION_DEFAULTS.common.string).trim();
  const interruptOn = readInterruptSelections(node, "interruptOn", index, [INTERRUPT_SELECTION_DTMF]);
  return await runtime.waitForDialEvent(
    dialIds.length === 1 ? dialIds[0]! : dialIds,
    {
      ...(legId ? { legId } : {}),
      dialTimeoutSeconds: readNumberParameter(node, "dialTimeoutSeconds", index, OPTION_DEFAULTS.dial.waitTimeoutSeconds),
      waitEventOutputs,
      interruptOnDtmf: hasInterruptSelection(interruptOn, INTERRUPT_SELECTION_DTMF),
    },
  );
}

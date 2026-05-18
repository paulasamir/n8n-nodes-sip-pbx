import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { assertDtmfString, readBooleanParameter, readCallInterruptReasons, readFixedCollectionItems, readNumberParameter, readOptions, readStringParameter, requireActionValue } from "../shared/input-normalization";
import { normalizeDtmfRules } from "../shared/input-normalization";
import { resolveLegId } from "../shared/id-resolution";

export function getWaitLegRules(node: any, index: number): Array<{ pattern: string; label: string }> {
  return normalizeDtmfRules(node, index);
}

export function resolveWaitLegIds(node: any, item: any, index: number): string[] {
  const explicitLegIds = readFixedCollectionItems(node, "legIds", index)
    .map((entry) => String(entry.legId || "").trim())
    .filter(Boolean);
  if (explicitLegIds.length > 0) {
    return explicitLegIds;
  }
  const fallbackLegId = String((item?.json && (item.json.legId || item.json.sipPbx?.legId)) || "").trim();
  return fallbackLegId ? [fallbackLegId] : [];
}

export async function executeRing(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  return await runtime.ringing(requireActionValue("legId", resolveLegId(node, item, index)));
}

export async function executeAnswer(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  return await runtime.answer(requireActionValue("legId", resolveLegId(node, item, index)));
}

export async function executeHangup(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  return await runtime.hangup(requireActionValue("legId", resolveLegId(node, item, index)));
}

export async function executeBridge(node: any, runtime: PbxRuntime, _item: any, index: number): Promise<any> {
  const options = readOptions(node, index);
    const rawEmitDtmfEvents = options.emitDtmfEvents;
    const rawRelayDtmf = String(options.relayDtmf || "").trim();
  return await runtime.bridge(
    requireActionValue("legAId", readStringParameter(node, "legAId", index, OPTION_DEFAULTS.common.string)),
    requireActionValue("legBId", readStringParameter(node, "legBId", index, OPTION_DEFAULTS.common.string)),
    {
      emitDtmfEvents: rawEmitDtmfEvents == null ? readBooleanParameter(node, "emitDtmfEvents", index, OPTION_DEFAULTS.call.emitDtmfEvents) : Boolean(rawEmitDtmfEvents),
      relayDtmf: rawRelayDtmf || readStringParameter(node, "relayDtmf", index, OPTION_DEFAULTS.call.relayDtmf),
    },
  );
}

export async function executeUnbridge(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  return await runtime.unbridge(requireActionValue("legId", resolveLegId(node, item, index)));
}

export async function executeWaitLegEvent(
  node: any,
  runtime: PbxRuntime,
  item: any,
  index: number,
  rules: Array<{ pattern: string; label: string }>,
): Promise<any> {
  const legIds = resolveWaitLegIds(node, item, index);
  const options = readOptions(node, index);
  const rawInterdigitTimeoutSeconds = options.interdigitTimeoutSeconds;
  const parsedInterdigitTimeoutSeconds = Number(rawInterdigitTimeoutSeconds);
  if (legIds.length === 0) {
    throw new Error("legIds are required");
  }
  return await runtime.waitForLegEvent(legIds.length === 1 ? legIds[0]! : legIds, {
    timeoutSeconds: readNumberParameter(node, "timeoutSeconds", index, OPTION_DEFAULTS.call.waitTimeoutSeconds),
    interdigitTimeoutSeconds: Number.isFinite(parsedInterdigitTimeoutSeconds)
      ? parsedInterdigitTimeoutSeconds
      : readNumberParameter(node, "interdigitTimeoutSeconds", index, OPTION_DEFAULTS.call.interdigitTimeoutSeconds),
    rules,
    interruptReasons: readCallInterruptReasons(node, "interruptReasons", index),
    clearDtmfBuffer: options.clearDtmfBuffer == null
      ? OPTION_DEFAULTS.call.clearDtmfBuffer
      : Boolean(options.clearDtmfBuffer),
    waitDtmfFallbackEnabled: readBooleanParameter(node, "waitDtmfFallbackEnabled", index, OPTION_DEFAULTS.call.waitDtmfFallbackEnabled),
    waitDtmfMultiDigitFallbackEnabled: readBooleanParameter(node, "waitDtmfMultiDigitFallbackEnabled", index, OPTION_DEFAULTS.call.waitDtmfMultiDigitFallbackEnabled),
    dtmfTerminatorDigit: assertDtmfString("dtmfTerminatorDigit", readStringParameter(node, "dtmfTerminatorDigit", index, OPTION_DEFAULTS.call.dtmfTerminatorDigit), { exactLength: 1 }),
  });
}

export async function executeControlRecording(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  return await runtime.controlRecording(
    requireActionValue("legId", resolveLegId(node, item, index)),
    readStringParameter(node, "recordingControlAction", index, OPTION_DEFAULTS.call.recordingControlAction) as "pause" | "resume",
  );
}

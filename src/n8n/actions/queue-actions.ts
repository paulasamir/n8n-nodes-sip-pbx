import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { normalizeExtensionDialConfig, readBooleanParameter, readOptions, readStringParameter, requireActionValue } from "../shared/input-normalization";
import { resolveLegId } from "../shared/id-resolution";

export async function executeEnqueueLeg(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const options = readOptions(node, index);
  const legId = requireActionValue("legId", resolveLegId(node, item, index));
  const ref =
    readStringParameter(node, "ref", index, OPTION_DEFAULTS.common.string)
    || String((item?.json && item.json.ref) || (item?.json?.sipPbx && item.json.sipPbx.ref) || "").trim();
  const extensionDialConfig = normalizeExtensionDialConfig({
    extensionNumbers: [],
    callStrategy: options.callStrategy ?? OPTION_DEFAULTS.dial.strategy,
    sequentialAttemptTimeoutSeconds: options.sequentialAttemptTimeoutSeconds ?? OPTION_DEFAULTS.dial.sequentialAttemptTimeoutSeconds,
    sequentialGapSeconds: options.sequentialGapSeconds ?? OPTION_DEFAULTS.dial.sequentialGapSeconds,
    options: {
      ...options,
      extensionOnlyFreeEndpoints: true,
    },
    extensionOnlyFreeEndpointsDefault: true,
  });
  const rejoinExisting = options.rejoinExisting == null
    ? OPTION_DEFAULTS.queueAction.rejoinExisting
    : Boolean(options.rejoinExisting);
  const retryAttempts = options.retryAttempts == null
    ? OPTION_DEFAULTS.trigger.queue.retryAttempts
    : Number(options.retryAttempts);
  const retryPauseSeconds = options.retryPauseSeconds == null
    ? OPTION_DEFAULTS.trigger.queue.retryPauseSeconds
    : Number(options.retryPauseSeconds);
  return await runtime.enqueueLeg(requireActionValue("ref", ref), legId, {
    queuePlacement: (String(options.queuePlacement || "").trim() || readStringParameter(node, "queuePlacement", index, OPTION_DEFAULTS.queueAction.placement)) as "front" | "back",
    callStrategy: extensionDialConfig.callStrategy,
    callerNumber: extensionDialConfig.callerNumber,
    callerName: extensionDialConfig.callerName,
    customSipHeaders: extensionDialConfig.customSipHeaders,
    sequentialAttemptTimeoutSeconds: extensionDialConfig.sequentialAttemptTimeoutSeconds,
    sequentialGapSeconds: extensionDialConfig.sequentialGapSeconds,
    extensionOnlyFreeEndpoints: true,
    rejoinExisting,
    retryAttempts,
    retryPauseSeconds,
  });
}

export async function executeSetQueueCallback(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const callbackEnabled = readBooleanParameter(node, "callbackEnabled", index, OPTION_DEFAULTS.queueAction.callbackEnabled);
  return await runtime.setQueueCallback(
    requireActionValue("legId", resolveLegId(node, item, index)),
    callbackEnabled,
  );
}

export async function executeGetQueueStats(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const target = readStringParameter(node, "queueStatsTarget", index, OPTION_DEFAULTS.queueAction.statsTarget);
  const ref =
    readStringParameter(node, "ref", index, OPTION_DEFAULTS.common.string)
    || String((item?.json && item.json.ref) || (item?.json?.sipPbx && item.json.sipPbx.ref) || "").trim();
  return await runtime.getQueueStats({
    queueStatsTarget: target,
    ref,
    legId: resolveLegId(node, item, index),
  });
}

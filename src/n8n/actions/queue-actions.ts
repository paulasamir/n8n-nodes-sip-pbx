import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { normalizeExtensionDialConfig, readBooleanParameter, readCollectionOptions, readStringParameter, requireActionValue } from "../shared/input-normalization";
import { resolveLegId } from "../shared/id-resolution";

export async function executeEnqueueLeg(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const queueOptions = readCollectionOptions(node, "queueOptions", index);
  const legId = requireActionValue("legId", resolveLegId(node, item, index, "legId", "queueOptions"));
  const ref =
    readStringParameter(node, "ref", index, "")
    || String((item?.json && item.json.ref) || (item?.json?.sipPbx && item.json.sipPbx.ref) || "").trim();
  const extensionDialConfig = normalizeExtensionDialConfig({
    extensionNumbers: [],
    callStrategy: queueOptions.callStrategy ?? OPTION_DEFAULTS.dial.strategy,
    sequentialAttemptTimeoutSeconds: queueOptions.sequentialAttemptTimeoutSeconds ?? OPTION_DEFAULTS.dial.sequentialAttemptTimeoutSeconds,
    sequentialGapSeconds: queueOptions.sequentialGapSeconds ?? OPTION_DEFAULTS.dial.sequentialGapSeconds,
    options: {
      ...queueOptions,
      extensionListOnlyFreeEndpoints: true,
    },
    extensionListOnlyFreeEndpointsDefault: true,
  });
  const rejoinExisting = queueOptions.rejoinExisting == null
    ? true
    : Boolean(queueOptions.rejoinExisting);
  const retryAttempts = queueOptions.retryAttempts == null
    ? OPTION_DEFAULTS.trigger.queue.retryAttempts
    : Number(queueOptions.retryAttempts);
  const retryPauseSeconds = queueOptions.retryPauseSeconds == null
    ? OPTION_DEFAULTS.trigger.queue.retryPauseSeconds
    : Number(queueOptions.retryPauseSeconds);
  return await runtime.enqueueLeg(requireActionValue("ref", ref), legId, {
    queuePlacement: (String(queueOptions.queuePlacement || "").trim() || readStringParameter(node, "queuePlacement", index, OPTION_DEFAULTS.queueAction.placement)) as "front" | "back",
    callStrategy: extensionDialConfig.callStrategy,
    callerNumber: extensionDialConfig.callerNumber,
    callerName: extensionDialConfig.callerName,
    customSipHeaders: extensionDialConfig.customSipHeaders,
    sequentialAttemptTimeoutSeconds: extensionDialConfig.sequentialAttemptTimeoutSeconds,
    sequentialGapSeconds: extensionDialConfig.sequentialGapSeconds,
    extensionListOnlyFreeEndpoints: true,
    rejoinExisting,
    retryAttempts,
    retryPauseSeconds,
  });
}

export async function executeSetQueueCallback(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const callbackEnabled = readBooleanParameter(node, "callbackEnabled", index, true);
  return await runtime.setQueueCallback(
    requireActionValue("legId", resolveLegId(node, item, index, "legId", "queueOptions")),
    callbackEnabled,
  );
}

export async function executeGetQueueStats(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const target = readStringParameter(node, "queueStatsTarget", index, OPTION_DEFAULTS.queueAction.statsTarget);
  const ref =
    readStringParameter(node, "ref", index, "")
    || String((item?.json && item.json.ref) || (item?.json?.sipPbx && item.json.sipPbx.ref) || "").trim();
  return await runtime.getQueueStats({
    queueStatsTarget: target,
    ref,
    legId: resolveLegId(node, item, index, "legId", "queueOptions"),
  });
}

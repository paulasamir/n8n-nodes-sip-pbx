import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { requireActionValue } from "../shared/input-normalization";
import { resolveLegId } from "../shared/id-resolution";
import { buildGlobalRecordingActionInput } from "./respond-actions";

export async function executeStartGlobalRecording(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const legId = requireActionValue("legId", resolveLegId(node, item, index));
  return await runtime.startGlobalRecording({
    legId,
    ...buildGlobalRecordingActionInput(node, index, false),
  });
}

import { getPbxRuntime } from "../../runtime/runtime-factory";
import { createSipPbxTriggerDescription } from "../ui/trigger-description";
import { activateAiToolTrigger } from "../triggers/activate-ai-tool-trigger";
import { activateExtensionsTrigger } from "../triggers/activate-extensions-trigger";
import { activateQueueTrigger } from "../triggers/activate-queue-trigger";
import { activateTrunkTrigger } from "../triggers/activate-trunk-trigger";
import { readStringParameter, type NodeParameterReader } from "../shared/input-normalization";

type TriggerNodeScope = NodeParameterReader & {
  getWorkflow?: () => { id?: unknown } | null;
};

export class SipPbxTrigger {
  description: Record<string, unknown>;

  constructor() {
    this.description = createSipPbxTriggerDescription();
  }

  async trigger(): Promise<any> {
    const scope = this as unknown as TriggerNodeScope;
    const runtime = getPbxRuntime(scope);
    const triggerOn = readStringParameter(scope, "triggerOn", 0, "");
    try {
      if (triggerOn === "aiTool") {
        return await activateAiToolTrigger(scope, runtime);
      }
      if (triggerOn === "extensions") {
        return await activateExtensionsTrigger(scope, runtime);
      }
      if (triggerOn === "queue") {
        return await activateQueueTrigger(scope, runtime);
      }
      if (triggerOn === "trunk") {
        return await activateTrunkTrigger(scope, runtime);
      }
      throw new Error("Trigger On is required");
    } catch (error) {
      await runtime.closeAllTriggerStreamsAndWait();
      throw error;
    }
  }
}

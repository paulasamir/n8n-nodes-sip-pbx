import { ControllerClient } from "../control/controller-client";
import { ControllerMethod, TriggerStreamKind } from "../control/controller-protocol";
import { OPTION_DEFAULTS } from "../shared/option-defaults";
import { TriggerStreamRegistry } from "./trigger-stream-registry";
import type { RuntimeTriggerStream } from "./trigger-stream-registry";

type TriggerEventHandler = (event: { branch: string; payload: Record<string, unknown> }) => void;
type ActionEmission = { payload?: Record<string, unknown> };
type ActionResultEnvelope = { emissions?: ActionEmission[] };

export class PbxRuntime {
  readonly controllerClient: ControllerClient;
  readonly triggerStreamRegistry: TriggerStreamRegistry;
  readonly workflowScopeKey: string;

  constructor(controllerClient?: ControllerClient, workflowScopeKey = "") {
    this.controllerClient = controllerClient || new ControllerClient();
    this.triggerStreamRegistry = new TriggerStreamRegistry();
    this.workflowScopeKey = String(workflowScopeKey || "").trim();
  }

  async health(): Promise<unknown> {
    return await this.controllerClient.call(ControllerMethod.health);
  }

  async ringing(legId: string): Promise<any> {
    return await this.executeAction({ operation: "call.ringing", legId });
  }

  async answer(legId: string): Promise<any> {
    return await this.executeAction({ operation: "call.answer", legId });
  }

  async hangup(legId: string): Promise<any> {
    return await this.executeAction({ operation: "call.hangup", legId });
  }

  async bridge(legAId: string, legBId: string, options?: Record<string, unknown>): Promise<any> {
    return await this.executeAction({
      operation: "call.bridge",
      legAId,
      legBId,
      ...(options || {}),
    });
  }

  async unbridge(legId: string): Promise<any> {
    return await this.executeAction({ operation: "call.unbridge", legId });
  }

  async attachVoiceAgent(legId: string): Promise<any> {
    return await this.executeAction({ operation: "ai.attachVoiceAgent", legId });
  }

  async invokeAiTool(input: {
    ref: string;
    aiLegId: string;
    flowParams?: Record<string, unknown>;
    toolParams?: Record<string, unknown>;
  }): Promise<any> {
    const publicRef = String(input.ref || "").trim();
    return await this.controllerClient.call(ControllerMethod.invokeAiTool, {
      ref: this.scopeFlowRef("aiTool", publicRef),
      publicRef,
      aiLegId: input.aiLegId,
      ...(input.flowParams ? { flowParams: input.flowParams } : {}),
      ...(input.toolParams ? { toolParams: input.toolParams } : {}),
    });
  }

  async respondVoiceAgentToolCall(input: {
    voiceAgentRequestId: string;
    outputText: string;
    isError?: boolean;
  }): Promise<any> {
    return await this.controllerClient.call(ControllerMethod.respondVoiceAgentToolCall, {
      voiceAgentRequestId: input.voiceAgentRequestId,
      outputText: input.outputText,
      ...(input.isError ? { isError: true } : {}),
    });
  }

  async waitForLegEvent(legIdOrLegIds: string | string[], options?: Record<string, unknown>): Promise<any> {
    return await this.executeAction({
      operation: "call.wait",
      ...(Array.isArray(legIdOrLegIds) ? { legIds: legIdOrLegIds } : { legId: legIdOrLegIds }),
      ...(options || {}),
    });
  }

  async controlRecording(legId: string, recordingControlAction: "pause" | "resume"): Promise<any> {
    return await this.executeAction({
      operation: "recording.control",
      legId,
      recordingControlAction,
    });
  }

  async startGlobalRecording(input: Record<string, unknown>): Promise<any> {
    return await this.executeAction({
      operation: "recording.start",
      ...(input || {}),
    });
  }

  async makeDial(input: Record<string, unknown>): Promise<any> {
    return await this.executeAction({
      operation: "dial.make",
      ...(input || {}),
    });
  }

  async breakDial(dialId: string, reason?: string): Promise<any> {
    return await this.executeAction({
      operation: "dial.break",
      dialId,
      dialBreakReason: reason || OPTION_DEFAULTS.dial.breakReason,
    });
  }

  async waitForDialEvent(dialIdOrDialIds: string | string[], options?: Record<string, unknown>): Promise<any> {
    return await this.executeAction({
      operation: "dial.wait",
      ...(Array.isArray(dialIdOrDialIds) ? { dialIds: dialIdOrDialIds } : { dialId: dialIdOrDialIds }),
      ...(options || {}),
    });
  }

  async playAudio(legId: string, input: Record<string, unknown>): Promise<any> {
    return await this.executeAction({
      operation: "media.playAudio",
      mediaLegId: legId,
      ...(input || {}),
    });
  }

  async playTone(legId: string, input: Record<string, unknown>): Promise<any> {
    return await this.executeAction({
      operation: "media.playTone",
      mediaLegId: legId,
      ...(input || {}),
    });
  }

  async recordAudio(legId: string, input: Record<string, unknown>): Promise<any> {
    return await this.executeAction({
      operation: "media.recordAudio",
      mediaLegId: legId,
      ...(input || {}),
    });
  }

  async stopMedia(input: Record<string, unknown>): Promise<any> {
    return await this.executeAction({
      operation: "media.stopMedia",
      ...(input || {}),
    });
  }

  async waitMedia(input: Record<string, unknown>): Promise<any> {
    return await this.executeAction({
      operation: "media.wait",
      ...(input || {}),
    });
  }

  async sendDtmf(legId: string, digits: string, input?: Record<string, unknown>): Promise<any> {
    return await this.executeAction({
      operation: "media.sendDtmf",
      mediaLegId: legId,
      dtmfDigits: digits,
      ...(input || {}),
    });
  }

  async respondToAuth(input: Record<string, unknown>): Promise<any> {
    return await this.executeAction({
      operation: "respond.toAuth",
      ...(input || {}),
    });
  }

  async respondToRecord(input: Record<string, unknown>): Promise<any> {
    return await this.executeAction({
      operation: "respond.toRecord",
      ...(input || {}),
    });
  }

  async enqueueLeg(
    ref: string,
    legId: string,
    input?: { queuePlacement?: "front" | "back" } & Record<string, unknown>,
  ): Promise<any> {
    return await this.executeAction({
      operation: "queue.putLeg",
      ref,
      legId,
      queuePlacement: String(input?.queuePlacement || "").trim() || OPTION_DEFAULTS.queueAction.placement,
      ...(input || {}),
    });
  }

  async setQueueCallback(legId: string, callbackEnabled: boolean): Promise<any> {
    return await this.executeAction({
      operation: "queue.setCallback",
      legId,
      callbackEnabled,
    });
  }

  async respondToAiTool(input: Record<string, unknown>): Promise<any> {
    return await this.executeAction({
      operation: "respond.toAiTool",
      ...(input || {}),
    });
  }

  async getQueueStats(input: Record<string, unknown>): Promise<any> {
    return await this.executeAction({
      operation: "queue.getStats",
      ...(input || {}),
    });
  }

  async openTrunkTrigger(config: Record<string, unknown>, onEvent: TriggerEventHandler): Promise<RuntimeTriggerStream> {
    return await this.openTriggerStream("trunk", config, onEvent);
  }

  async openExtensionsTrigger(config: Record<string, unknown>, onEvent: TriggerEventHandler): Promise<RuntimeTriggerStream> {
    return await this.openTriggerStream("extensions", config, onEvent);
  }

  async openQueueTrigger(config: Record<string, unknown>, onEvent: TriggerEventHandler): Promise<RuntimeTriggerStream> {
    return await this.openTriggerStream("queue", config, onEvent);
  }

  async openAiToolTrigger(config: Record<string, unknown>, onEvent: TriggerEventHandler): Promise<RuntimeTriggerStream> {
    return await this.openTriggerStream("aiTool", config, onEvent);
  }

  async openVoiceAgentStream(config: Record<string, unknown>, onEvent: TriggerEventHandler): Promise<RuntimeTriggerStream> {
    return await this.openTriggerStream("voiceAgent", config, onEvent);
  }

  async executeAction(action: Record<string, unknown>): Promise<any> {
    const result = await this.controllerClient.call(ControllerMethod.executeAction, this.normalizeActionInput(action));
    if (result && typeof result === "object" && Array.isArray((result as ActionResultEnvelope).emissions)) {
      const first = (result as ActionResultEnvelope).emissions?.find(
        (emission): emission is ActionEmission => Boolean(emission && typeof emission === "object"),
      );
      return first && typeof first.payload === "object" && first.payload ? first.payload : {};
    }
    return result;
  }

  closeAllTriggerStreams(): void {
    this.triggerStreamRegistry.closeAll();
  }

  async closeAllTriggerStreamsAndWait(): Promise<void> {
    await this.triggerStreamRegistry.closeAllAndWait();
  }

  async closeTriggerStream(kind: keyof typeof TriggerStreamKind, input: { ref?: string; legId?: string }): Promise<void> {
    const publicRef = kind === "voiceAgent"
      ? String((input || {}).legId || "").trim()
      : String((input || {}).ref || "").trim();
    if (!publicRef) {
      return;
    }
    const ref = kind === "voiceAgent" ? publicRef : this.scopeTriggerRef(kind, publicRef);
    const logicalKey = `${kind}:${ref}`;
    await this.triggerStreamRegistry.closeAndWait(logicalKey);
  }

  private async openTriggerStream(
    kind: keyof typeof TriggerStreamKind,
    config: Record<string, unknown>,
    onEvent: TriggerEventHandler,
  ): Promise<RuntimeTriggerStream> {
    const normalizedConfig = this.normalizeTriggerConfig(kind, config);
    const ref = kind === "voiceAgent"
      ? String((normalizedConfig || {}).legId || "").trim()
      : String((normalizedConfig || {}).ref || "").trim();
    const logicalKey = `${kind}:${ref}`;
    return await this.triggerStreamRegistry.open(logicalKey, async () => {
      const stream = await this.controllerClient.openStream({
        kind: TriggerStreamKind[kind],
        config: normalizedConfig,
      });
      stream.onEvent((event) => {
        onEvent({
          branch: String((event && event.branch) || "Result"),
          payload: ((event && event.payload) || {}) as Record<string, unknown>,
        });
      });
      return stream;
    });
  }

  private isFlowScopedTriggerKind(kind: keyof typeof TriggerStreamKind): kind is "trunk" | "extensions" | "queue" | "aiTool" {
    return kind === "trunk" || kind === "extensions" || kind === "queue" || kind === "aiTool";
  }

  private scopeFlowRef(kind: "trunk" | "extensions" | "queue" | "aiTool", ref: string): string {
    const normalizedRef = String(ref || "").trim();
    if (!normalizedRef || !this.workflowScopeKey) {
      return normalizedRef;
    }
    return `flow:${encodeURIComponent(this.workflowScopeKey)}:${encodeURIComponent(kind)}:${encodeURIComponent(normalizedRef)}`;
  }

  private scopeTriggerRef(kind: keyof typeof TriggerStreamKind, ref: string): string {
    if (!this.isFlowScopedTriggerKind(kind)) {
      return String(ref || "").trim();
    }
    return this.scopeFlowRef(kind, ref);
  }

  private normalizeTriggerConfig(
    kind: keyof typeof TriggerStreamKind,
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    const normalized = { ...(config || {}) };
    if (kind === "voiceAgent") {
      return normalized;
    }
    const publicRef = String(normalized.ref || "").trim();
    if (!publicRef || !this.isFlowScopedTriggerKind(kind)) {
      return normalized;
    }
    normalized.publicRef = publicRef;
    normalized.ref = this.scopeFlowRef(kind, publicRef);
    return normalized;
  }

  private normalizeActionInput(action: Record<string, unknown>): Record<string, unknown> {
    const normalized = { ...(action || {}) };
    const operation = String(normalized.operation || "").trim();
    if (operation === "dial.make" && String(normalized.callMode || "").trim() === "trunk") {
      const publicRef = String(normalized.ref || "").trim();
      if (publicRef) {
        normalized.publicRef = publicRef;
        normalized.ref = this.scopeFlowRef("trunk", publicRef);
      }
      return normalized;
    }
    if (operation === "dial.make" && String(normalized.callMode || "").trim() === "extension") {
      if (this.workflowScopeKey) {
        normalized.workflowScopeKey = this.workflowScopeKey;
      }
      return normalized;
    }
    if (operation === "queue.putLeg") {
      const publicRef = String(normalized.ref || "").trim();
      if (publicRef) {
        normalized.ref = this.scopeFlowRef("queue", publicRef);
      }
      return normalized;
    }
    if (operation === "queue.getStats" && String(normalized.queueStatsTarget || "").trim() === "ref") {
      const publicRef = String(normalized.ref || "").trim();
      if (publicRef) {
        normalized.ref = this.scopeFlowRef("queue", publicRef);
      }
      return normalized;
    }
    return normalized;
  }
}

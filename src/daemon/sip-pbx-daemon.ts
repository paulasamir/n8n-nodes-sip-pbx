import type { Socket } from "net";
import * as path from "path";
import type { ControllerRequestDto, TriggerStreamStartDto } from "../control/controller-dto";
import { ControllerMethod, TriggerStreamKind } from "../control/controller-protocol";
import { getDefaultSocketPath } from "../control/socket-path";
import {
  ActionResultBranch,
  AiToolTriggerBranchRequest,
  BridgeBranch,
  CallWaitBranchDtmfFallback,
  CallWaitBranchEnded,
  CallWaitBranchInterrupt,
  CallWaitBranchTimeout,
  DialWaitBranchAnswered,
  DialWaitBranchFailed,
  DialWaitBranchProgress,
  DialWaitBranchRejected,
  DialWaitBranchRinging,
  DialWaitBranchTimeout,
  MediaBackgroundBranchResult,
  MediaBlockingBranchCompleted,
  MediaBlockingBranchInterrupted,
  MediaInfiniteToneBranchInterrupted,
  TrunkTriggerBranchRecord,
  UnbridgeBranchOrig,
  VoiceAgentStreamBranchMemoryTurn,
  VoiceAgentStreamBranchToolCall,
  WaitMediaBranchCompleted,
  WaitMediaBranchInterrupted,
  WaitMediaBranchTimeout,
} from "../shared/branches";
import { OPTION_DEFAULTS } from "../shared/option-defaults";
import {
  CALL_EVENT_ENDED,
  CALL_EVENT_INTERRUPT,
  CALL_WAIT_OUTPUT_DTMF_FALLBACK,
  CALL_WAIT_OUTPUT_ENDED,
  CALL_WAIT_OUTPUT_INTERRUPT,
  CALL_WAIT_OUTPUT_MATCHED,
  DIAL_EVENT_ANSWERED,
  DIAL_EVENT_FAILED,
  DIAL_EVENT_PROGRESS,
  DIAL_EVENT_REJECTED,
  DIAL_EVENT_RINGING,
  DIAL_EVENT_TIMEOUT,
  DIAL_STATUS_ANSWERED,
  LEG_STATUS_ANSWERED,
  LEG_STATUS_ENDED,
  MEDIA_EVENT_COMPLETED,
  MEDIA_EVENT_FAILED,
  MEDIA_EVENT_INTERRUPTED,
  MEDIA_EVENT_TIMEOUT,
} from "../shared/result-events";
import { normalizeStringList } from "../shared/string-utils";
import { ControllerServer } from "./controller-server";
import { daemonError } from "./core/daemon-error";
import { RequestContext } from "./core/request-context";
import { newAiToolRequestId, newRecordRequestId, newSocketId, newTriggerKey } from "./core/ids";
import { MapRegistry } from "../shared/map-registry";
import { DialService } from "./dials/dial-service";
import type { Dial } from "./dials/types";
import { DialWaitService } from "./dials/dial-wait-service";
import { InteractiveAuthRequestRegistry } from "./extensions-auth/interactive-auth-request-registry";
import { InteractiveAuthService } from "./extensions-auth/interactive-auth-service";
import { InteractiveAuthTriggerPublisher } from "./extensions-auth/interactive-auth-trigger-publisher";
import { LegCoordinator } from "./legs/leg-coordinator";
import { LegService } from "./legs/leg-service";
import type { Leg } from "./legs/types";
import { LegWaitService } from "./legs/leg-wait-service";
import type { WaitRule } from "./legs/leg-wait-service";
import { MediaService } from "./media/media-service";
import type { MediaOperation } from "./media/operations/media-operation";
import { createWebSocketTransportProfile } from "./media/transports/websocket-transport";
import type { WebSocketVoiceAgentEvent } from "./media/transports/websocket-profiles";
import { QueueEntryRegistry } from "./queue/queue-entry-registry";
import { QueueService } from "./queue/queue-service";
import { QueueTriggerPublisherService } from "./queue/queue-trigger-publisher";
import { InboundCallService } from "./signaling/calls/inbound-call-service";
import { ExtensionAuthBridge } from "./signaling/extensions/extension-auth-bridge";
import { ExtensionBindingRegistry } from "./signaling/extensions/extension-binding-registry";
import { ExtensionHost } from "./signaling/extensions/extension-host";
import { SignalingService } from "./signaling/signaling-service";
import { SipTransportService } from "./signaling/sip/sip-transport-service";
import { assertValidTriggerRef, buildFlowScopedTriggerRef, parseFlowScopedTriggerRef } from "./signaling/triggers/ref-policy";
import { TrunkClient } from "./signaling/trunks/trunk-client";

type WaitCallEventResult = {
  output?: string;
  matchedLabel?: string;
};

type WaitEventLikeResult = {
  eventType?: string;
  status?: string;
};

function closeTriggerSocket(socket: Pick<Socket, "destroy" | "end">): void {
  try {
    if (typeof socket.destroy === "function") {
      socket.destroy();
      return;
    }
  } catch (error) {
    console.error(
      `[sip-pbx:daemon] trigger socket destroy failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
    );
  }
  try {
    socket.end();
  } catch (error) {
    console.error(
      `[sip-pbx:daemon] trigger socket end failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
    );
  }
}

function readResultString(result: unknown, key: string): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  return String((result as Record<string, unknown>)[key] || "").trim();
}

function readResultEventType(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  const value = (result as WaitEventLikeResult).eventType || (result as WaitEventLikeResult).status || "";
  return String(value).trim();
}

function normalizeActionRules(value: unknown): WaitRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rules: WaitRule[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const pattern = String(record.pattern || "").trim();
    const label = String(record.label || "").trim();
    if (!pattern || !label) {
      continue;
    }
    rules.push({ pattern, label });
  }
  return rules;
}

function normalizeQueuePlacement(value: unknown): "front" | "back" {
  return String(value || OPTION_DEFAULTS.queueAction.placement) === "front" ? "front" : "back";
}

function normalizeAuthAction(value: unknown): "allow" | "deny" | "challenge" | "not_applicable" {
  const action = String(value || OPTION_DEFAULTS.extensionsAction.authAction).trim();
  if (action === "allow" || action === "deny" || action === "challenge" || action === "not_applicable") {
    return action;
  }
  return OPTION_DEFAULTS.extensionsAction.authAction;
}

export function getSocketPath(): string {
  return getDefaultSocketPath();
}

function normalizeRecordPartyUri(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (/^<?sips?:/i.test(raw) || raw.includes("@")) {
    return raw;
  }
  return `sip:${raw}`;
}

type RecordRequest = {
  recordRequestId: string;
  triggerKey: string;
  kind: "trunk" | "extensions";
  ref: string;
  legId: string;
  payload: Record<string, unknown>;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
};

type ActiveTriggerStream = {
  triggerKey: string;
  socketId: string;
  ref: string;
  kind: "trunk" | "extensions" | "queue" | "aiTool" | "voiceAgent";
  config: Record<string, unknown>;
  socket: Socket;
  write: (frame: unknown) => void;
};

type PendingAiToolRequest = {
  aiToolRequestId: string;
  triggerKey: string;
  ref: string;
  aiLegId: string;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  resolve: (result: { aiToolRequestId: string; outputText: string }) => void;
  reject: (error: Error) => void;
};

type VoiceAgentToolDescriptor = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type VoiceAgentMemoryToolCall = {
  voiceAgentRequestId: string;
  toolName: string;
  argumentsJson: string;
  outputText: string;
  isError: boolean;
};

type ActiveVoiceAgentController = {
  legId: string;
  triggerKey: string;
  transportProfile: string;
  memoryText: string;
  hasConnectedMemory: boolean;
  tools: VoiceAgentToolDescriptor[];
  pendingMemoryUserTexts: string[];
  pendingMemoryToolCalls: VoiceAgentMemoryToolCall[];
};

type PendingVoiceAgentToolCall = {
  legId: string;
  voiceAgentRequestId: string;
  toolName: string;
  argumentsJson: string;
};

function normalizeVoiceAgentTools(raw: unknown): VoiceAgentToolDescriptor[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => {
      const tool = entry as Record<string, unknown>;
      const name = String(tool.name || "").trim();
      if (!name) {
        return null;
      }
      const description = String(tool.description || "").trim();
      const parameters = tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters)
        ? { ...(tool.parameters as Record<string, unknown>) }
        : { type: "object", properties: {}, additionalProperties: true };
      return {
        name,
        description: description || name,
        parameters,
      };
    })
    .filter(Boolean) as VoiceAgentToolDescriptor[];
}

export class SipPbxDaemon {
  readonly socketPath: string;
  readonly controllerServer: ControllerServer;

  readonly legRegistry = new MapRegistry<string, Leg>();
  readonly legService = new LegService(this.legRegistry);
  readonly legWaitService = new LegWaitService(this.legRegistry);
  readonly legCoordinator = new LegCoordinator();
  readonly dialRegistry = new MapRegistry<string, Dial>();
  readonly dialService = new DialService(this.dialRegistry, this.legService, this.legCoordinator);
  readonly dialWaitService = new DialWaitService(this.dialRegistry);
  readonly mediaService: MediaService;
  readonly extensionService: ExtensionHost;
  readonly trunkService: TrunkClient;
  readonly authService: InteractiveAuthService;
  readonly queueService: QueueService;
  readonly sipTransportService: SipTransportService;
  readonly signalingService: SignalingService;
  private readonly triggerStreams = new Map<string, ActiveTriggerStream>();
  private readonly triggerStreamIndex = new Map<string, string>();
  private readonly activeVoiceAgentControllers = new Map<string, ActiveVoiceAgentController>();
  private readonly pendingVoiceAgentToolCalls = new Map<string, PendingVoiceAgentToolCall>();
  private readonly pendingAiToolRequests = new Map<string, PendingAiToolRequest>();
  private readonly aiToolRequestIdsByLegId = new Map<string, Set<string>>();
  private readonly aiToolRequestIdsByTriggerKey = new Map<string, Set<string>>();
  private readonly recordRequests = new Map<string, RecordRequest>();
  private readonly recordRequestIdsByLegId = new Map<string, string>();
  private readonly recordRequestIdsByTriggerKey = new Map<string, Set<string>>();
  private started = false;
  private stopPromise: Promise<void> | null = null;
  private idleStopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(socketPath?: string) {
    this.socketPath = socketPath || getSocketPath();
    this.authService = new InteractiveAuthService(
      new InteractiveAuthRequestRegistry(),
      new InteractiveAuthTriggerPublisher((ref, branch, payload) => {
        this.publishTriggerStream("extensions", ref, branch, payload);
      }),
      (ref) => this.readExtensionsAuthTimeoutMs(ref),
    );
    const inboundCallService = new InboundCallService(this.legService, async (input) => {
      await this.maybePublishRecordRequest(input);
    });
    this.extensionService = new ExtensionHost({
      registry: new ExtensionBindingRegistry(),
      legService: this.legService,
      inboundCallService,
      authBridge: new ExtensionAuthBridge({
        authService: this.authService,
        resolveActiveTriggerKey: (ref) => this.getActiveTriggerKey("extensions", ref),
      }),
      publish: (ref, branch, payload) => {
        this.publishTriggerStream("extensions", ref, branch, payload);
      },
      onAvailabilityChanged: (ref) => {
        const parsed = parseFlowScopedTriggerRef(ref);
        if (!parsed || parsed.kind !== "extensions") {
          this.queueService.refreshWorkflowScope("");
          return;
        }
        this.queueService.refreshWorkflowScope(parsed.workflowScopeKey);
      },
    });
    this.trunkService = new TrunkClient({
      legService: this.legService,
      inboundCallService,
      publish: (ref, branch, payload) => {
        this.publishTriggerStream("trunk", ref, branch, payload);
      },
    });
    this.queueService = new QueueService(
      new QueueEntryRegistry(),
      this.legService,
      this.dialService,
      new QueueTriggerPublisherService((ref, branch, payload) => {
        this.publishTriggerStream("queue", ref, branch, payload);
      }),
      // signalingService is constructed later in this same body — the arrow
      // function defers the lookup until the queue actually needs to make a
      // dial, by which time the field is bound.
      (input) => this.signalingService.makeDial(input),
      (ref) => this.readQueueTriggerConfig(ref),
      (workflowScopeKey, configuredExtensionNumbers) => this.extensionService.listOnlineExtensionNumbersInFlow(workflowScopeKey, configuredExtensionNumbers),
      (workflowScopeKey, configuredExtensionNumbers) => this.extensionService.listAvailableExtensionNumbersInFlow(workflowScopeKey, configuredExtensionNumbers),
    );
    this.mediaService = new MediaService(new MapRegistry<string, MediaOperation>(), this.legService, {
      recordingsRoot: path.join(path.dirname(this.socketPath), "recordings"),
      sendSignalingDtmf: (legId, digits, method) => this.signalingService.sendDtmf(legId, digits, method),
      sendSignalingProgress: (legId) => {
        this.signalingService.progressLeg(legId);
      },
      onVoiceAgentEvent: (legId, event) => {
        void this.handleVoiceAgentTransportEvent(legId, event).catch((error) => {
          console.error(
            `[sip-pbx:daemon] voice agent transport event failed; leg=${legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
          );
        });
      },
      legCoordinator: this.legCoordinator,
    });
    this.sipTransportService = new SipTransportService({
      legService: this.legService,
      extensionService: this.extensionService,
      trunkService: this.trunkService,
      authService: this.authService,
      ensureMediaTransportEndpoint: (legId) => this.mediaService.ensureTransportEndpoint(legId),
      legCoordinator: this.legCoordinator,
      onAttemptRinging: (legId) => {
        if (!this.legService.getLeg(legId)) {
          return;
        }
        this.signalingService.ringLeg(legId);
      },
      onAttemptProgress: (legId) => {
        if (!this.legService.getLeg(legId)) {
          return;
        }
        this.signalingService.progressLeg(legId);
      },
      onAttemptAnswered: (legId) => {
        void this.signalingService.answerLeg(legId).catch((error) => {
          console.error(
            `[sip-pbx:daemon] attempt answer callback failed; leg=${legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
          );
        });
      },
      onAttemptRejected: (legId, reason) => {
        if (!this.legService.getLeg(legId)) {
          return;
        }
        this.signalingService.rejectLeg(legId, reason);
      },
      onInboundDtmf: (legId, digits) => {
        void this.mediaService.handleTransportDtmf(legId, digits);
      },
    });
    this.signalingService = new SignalingService({
      legService: this.legService,
      dialRegistry: this.dialRegistry,
      dialService: this.dialService,
      resolveExtensionTargets: (extensionNumbers, workflowScopeKey, onlyFree = true) => {
        if (workflowScopeKey) {
          return onlyFree
            ? this.extensionService.listExtensionTargetsInFlow(workflowScopeKey, extensionNumbers, true)
            : this.extensionService.listExtensionTargetsInFlow(workflowScopeKey, extensionNumbers, false);
        }
        return onlyFree
          ? this.extensionService.listAvailableExtensionTargets(extensionNumbers)
          : this.extensionService.listOnlineExtensionTargets(extensionNumbers);
      },
      sipTransportService: this.sipTransportService,
      ensureMediaTransportEndpoint: (legId) => this.mediaService.ensureTransportEndpoint(legId),
      legCoordinator: this.legCoordinator,
    });
    this.dialService.setOnAttemptStarted((dial, legId, target) => {
      this.signalingService.handleAttemptStarted(dial, legId, target);
    });
    this.dialService.setOnAttemptAnswered((_dial, legId) => {
      this.maybePublishAnsweredOutboundRecordRequest(legId);
    });
    this.dialService.setOnDialFinalized((dial, status, reason) => {
      this.queueService.handleDialFinalized(dial.dialId, status, reason);
    });
    this.legService.setOnLegEnded(async (leg, reason) => {
      try {
        this.queueService.removeEntryForLeg(leg.legId);
        await this.signalingService.handleLegEnded(leg.legId, reason);
        if (String(leg.triggerMetadata?.ref || "").trim() && String(leg.triggerMetadata?.extensionNumber || "").trim()) {
          const triggerRef = String(leg.triggerMetadata.ref || "").trim();
          const parsed = parseFlowScopedTriggerRef(triggerRef);
          if (parsed && parsed.kind === "extensions") {
            this.queueService.refreshWorkflowScope(parsed.workflowScopeKey);
          } else {
            this.queueService.refreshWorkflowScope("");
          }
        }
      } catch (error) {
        console.error("[sip-pbx:daemon]", error instanceof Error ? error.message : String(error || "leg-ended cleanup failed"));
      }
      this.clearRecordRequestsForLeg(leg.legId);
      this.clearAiToolRequestsForLeg(leg.legId);
      return this.mediaService.handleLegEnded(leg.legId).finally(() => {
        this.scheduleIdleShutdown(50);
      });
    });
    this.controllerServer = new ControllerServer({
      socketPath: this.socketPath,
      handleUnary: async (context, request) => await this.dispatchUnary(context, request),
      handleStreamStart: async (start, framed, socket) => {
        const kind = start.kind as keyof typeof TriggerStreamKind;
        const normalizedConfig = kind === "voiceAgent"
          ? {
              ...(start.config || {}),
              legId: String(((start.config || {}) as Record<string, unknown>).legId || "").trim(),
            }
          : {
              ...(start.config || {}),
              ref: assertValidTriggerRef((start.config || {}).ref),
            };
        const registered = this.registerTriggerStream({
          kind,
          config: normalizedConfig,
          socket,
          write: framed.writeFrame.bind(framed),
        });
        const ref = this.extractTriggerStreamRef(kind, normalizedConfig);
        if ((kind === "trunk" || kind === "extensions") && ref) {
          await this.signalingService.activateTrigger(kind, normalizedConfig);
        }
        if (kind === "extensions" && ref) {
          this.extensionService.handleTriggerActivated(ref);
          const handleStreamClosed = () => {
            if (this.getActiveSocketId("extensions", ref)) {
              return;
            }
            this.clearRecordRequestsForTriggerKey(this.triggerStreamIndexKey("extensions", ref));
            void this.signalingService.deactivateTrigger("extensions", ref).catch((error) => {
              console.error(
                `[sip-pbx:daemon] extensions trigger deactivation failed; ref=${ref}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
              );
            });
            this.extensionService.handleTriggerClosed(ref);
          };
          socket.on("close", handleStreamClosed);
          socket.on("error", handleStreamClosed);
        }
        if (kind === "trunk" && ref) {
          const handleStreamClosed = () => {
            if (this.getActiveSocketId("trunk", ref)) {
              return;
            }
            this.clearRecordRequestsForTriggerKey(this.triggerStreamIndexKey("trunk", ref));
            void this.signalingService.deactivateTrigger("trunk", ref).catch((error) => {
              console.error(
                `[sip-pbx:daemon] trunk trigger deactivation failed; ref=${ref}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
              );
            });
          };
          socket.on("close", handleStreamClosed);
          socket.on("error", handleStreamClosed);
        }
        if (kind === "aiTool" && ref) {
          const handleStreamClosed = () => {
            if (this.getActiveSocketId("aiTool", ref)) {
              return;
            }
            this.clearAiToolRequestsForTriggerKey(this.triggerStreamIndexKey("aiTool", ref));
          };
          socket.on("close", handleStreamClosed);
          socket.on("error", handleStreamClosed);
        }
        if (kind === "voiceAgent" && ref) {
          const handleStreamClosed = () => {
            const active = this.getActiveTriggerKey("voiceAgent", ref);
            if (active) {
              return;
            }
            this.detachVoiceAgentController(ref);
          };
          socket.on("close", handleStreamClosed);
          socket.on("error", handleStreamClosed);
        }
        return registered;
      },
    });
  }

  async start(): Promise<void> {
    this.clearIdleShutdownTimer();
    await this.controllerServer.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return await this.stopPromise;
    }
    this.clearIdleShutdownTimer();
    this.started = false;
    this.stopPromise = (async () => {
      this.closeAllTriggerStreams();
      await this.mediaService.closeAll();
      this.signalingService.closeAll();
      await this.controllerServer.stop();
    })();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  async dispatchUnary(context: RequestContext, request: ControllerRequestDto): Promise<unknown> {
    context.throwIfCancelled();
    switch (request.method) {
      case ControllerMethod.health:
        return { status: "ok" };
      case ControllerMethod.stopDaemon:
        setImmediate(() => {
          void this.stop().catch((error) => {
            console.error(
              `[sip-pbx:daemon] stopDaemon async stop failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
            );
          });
        });
        return undefined;
      case ControllerMethod.executeAction:
        return await this.executeAction(context, request.params || {});
      case ControllerMethod.invokeAiTool:
        return await this.invokeAiTool(request.params || {});
      case ControllerMethod.respondVoiceAgentToolCall:
        return await this.respondVoiceAgentToolCall(request.params || {});
      case ControllerMethod.getRetentionSnapshot:
        return this.getRetentionSnapshot();
      default:
        throw daemonError("unsupported_operation", `Unsupported controller method ${request.method}`);
    }
  }

  private readQueueTriggerConfig(ref: string): {
    ref: string;
    publicRef: string;
    workflowScopeKey: string;
    queueExtensions: string[];
  } | null {
    const config = this.getTriggerConfig("queue", ref);
    if (!config) {
      return null;
    }
    return {
      ref,
      publicRef: String(config.publicRef || ref || "").trim(),
      workflowScopeKey: String(parseFlowScopedTriggerRef(ref)?.workflowScopeKey || "").trim(),
      queueExtensions: normalizeStringList(config.queueExtensions),
    };
  }

  private readExtensionsAuthTimeoutMs(ref: string): number | null {
    const config = this.getTriggerConfig("extensions", ref);
    if (!config) {
      return null;
    }
    const timeoutMs = Math.max(0, Math.round(Number(config.authTimeoutSeconds || OPTION_DEFAULTS.trigger.extensions.authTimeoutSeconds) * 1000));
    return timeoutMs > 0 ? timeoutMs : null;
  }

  private readRecordResponseTimeoutMs(kind: "trunk" | "extensions", ref: string): number | null {
    const config = this.getTriggerConfig(kind, ref);
    if (!config) {
      return null;
    }
    const defaultSeconds = kind === "extensions"
      ? OPTION_DEFAULTS.trigger.extensions.recordResponseTimeoutSeconds
      : OPTION_DEFAULTS.trigger.trunk.recordResponseTimeoutSeconds;
    const timeoutMs = Math.max(0, Math.round(Number(config.recordResponseTimeoutSeconds || defaultSeconds) * 1000));
    return timeoutMs > 0 ? timeoutMs : null;
  }

  /**
   * Diagnostic snapshot of every active retention ticket across legs and
   * dials. Intended for debugging stuck-leg scenarios — if a leg never reaches
   * its free-TTL, this surfaces which tag holds it. Pure read-only, no side
   * effects. Media operations no longer participate in retention themselves
   * (blocking ops show up under their leg's tags via `acquireMediaRetention`).
   */
  getRetentionSnapshot(): {
    legs: Array<{ id: string; tags: string[] }>;
    dials: Array<{ id: string; tags: string[] }>;
  } {
    const collect = (tags: Array<{ tag: string }>): string[] => tags.map((entry) => entry.tag);
    return {
      legs: this.legRegistry.values().map((leg) => ({
        id: leg.legId,
        tags: collect(leg.describeRetentions()),
      })),
      dials: this.dialRegistry.values().map((dial) => ({
        id: dial.dialId,
        tags: collect(dial.describeRetentions()),
      })),
    };
  }

  private async invokeAiTool(params: Record<string, unknown>): Promise<{ aiToolRequestId: string; outputText: string }> {
    const ref = String(params.ref || "").trim();
    const publicRef = String(params.publicRef || ref || "").trim();
    if (!ref) {
      throw daemonError("invalid_request", "ref is required");
    }
    const aiLegId = String(params.aiLegId || "").trim();
    if (!aiLegId) {
      throw daemonError("invalid_request", "aiLegId is required");
    }
    const leg = this.legService.requireLeg(aiLegId);
    if (leg.transportType !== "websocket" || leg.status === LEG_STATUS_ENDED) {
      throw daemonError("invalid_leg", `Leg ${aiLegId} is not a live websocket leg`);
    }
    const triggerKey = this.getActiveTriggerKey("aiTool", ref);
    if (!triggerKey) {
      throw daemonError("not_found", `No active AI trigger for ref ${publicRef || ref}`);
    }
    const triggerConfig = this.getTriggerConfig("aiTool", ref) || {};
    const resolvedPublicRef = String(triggerConfig.publicRef || publicRef || ref || "").trim();
    const timeoutMs = Math.max(0, Math.round(Number(triggerConfig.aiToolResponseTimeoutSeconds || OPTION_DEFAULTS.trigger.aiTool.responseTimeoutSeconds) * 1000));
    const flowParams = params.flowParams && typeof params.flowParams === "object" && !Array.isArray(params.flowParams)
      ? { ...(params.flowParams as Record<string, unknown>) }
      : {};
    const toolParams = params.toolParams && typeof params.toolParams === "object" && !Array.isArray(params.toolParams)
      ? { ...(params.toolParams as Record<string, unknown>) }
      : {};
    const aiToolRequestId = newAiToolRequestId();
    const peerLegId = String(leg.bridgePeerLegId || "").trim();
    const result = await new Promise<{ aiToolRequestId: string; outputText: string }>((resolve, reject) => {
      const pending: PendingAiToolRequest = {
        aiToolRequestId,
        triggerKey,
        ref,
        aiLegId,
        timeoutHandle: null,
        resolve,
        reject,
      };
      if (timeoutMs > 0) {
        pending.timeoutHandle = setTimeout(() => {
          this.clearAiToolRequest(aiToolRequestId);
          reject(daemonError("timeout", `AI tool ${resolvedPublicRef || ref} did not respond before timeout`));
        }, timeoutMs);
      }
      this.storeAiToolRequest(pending);
      this.publishTriggerStream("aiTool", ref, AiToolTriggerBranchRequest, {
        ref: resolvedPublicRef,
        aiToolRequestId,
        aiLegId,
        peerLegId,
        flowParams,
        toolParams,
      });
    });
    return result;
  }

  private respondToAiTool(aiToolRequestId: string, outputText: string): { aiToolRequestId: string } {
    const pending = this.clearAiToolRequest(aiToolRequestId);
    if (!pending) {
      throw daemonError("invalid_request", `Unknown aiToolRequestId ${aiToolRequestId}`);
    }
    pending.resolve({
      aiToolRequestId,
      outputText,
    });
    return { aiToolRequestId };
  }

  private async executeAction(context: RequestContext, action: Record<string, unknown>): Promise<unknown> {
    this.assertExecuteActionPayload(action);
    const result = await this.executeActionResult(context, action);
    return {
      emissions: [
        {
          branch: this.resolveActionResultBranch(action, result),
          payload: result && typeof result === "object" ? result : {},
        },
      ],
    };
  }

  private assertExecuteActionPayload(action: Record<string, unknown>): void {
    const operation = String(action.operation || "").trim();
    const allowed = this.allowedExecuteActionFields(operation);
    if (!allowed) {
      throw daemonError("unsupported_operation", `Unsupported action operation ${operation}`);
    }
    for (const key of Object.keys(action)) {
      if (!allowed.has(key)) {
        throw daemonError("invalid_request", `Unknown field ${key} for operation ${operation}`);
      }
    }
  }

  private allowedExecuteActionFields(operation: string): Set<string> | null {
    const fieldsByOperation: Record<string, string[]> = {
      "call.ringing": ["operation", "legId"],
      "call.answer": ["operation", "legId"],
      "call.hangup": ["operation", "legId"],
      "call.bridge": ["operation", "legAId", "legBId", "emitDtmfEvents", "relayDtmf"],
      "call.unbridge": ["operation", "legId"],
      "call.controlRecording": ["operation", "legId", "recordingControlAction"],
      "call.waitCallEvent": ["operation", "legId", "legIds", "timeoutSeconds", "interdigitTimeoutSeconds", "rules", "waitDtmfFallbackEnabled", "waitDtmfMultiDigitFallbackEnabled", "dtmfTerminatorDigit"],
      "ai.attachVoiceAgent": ["operation", "legId"],
      "dial.make": ["operation", "callMode", "ref", "publicRef", "destination", "extensionNumbers", "extensionListOnlyFreeEndpoints", "workflowScopeKey", "callStrategy", "callerNumber", "callerName", "customSipHeaders", "sequentialAttemptTimeoutSeconds", "sequentialGapSeconds", "transportProfile", "websocketStartMode", "openaiApiKey", "openaiRealtimeModel", "openaiRealtimeVoice", "openaiRealtimeInputTranscriptionModel", "openaiRealtimeInstructions", "openaiRealtimePromptId", "openaiRealtimePromptVersion", "openaiRealtimePromptVariablesJson", "geminiApiKey", "geminiLiveModel", "geminiLiveVoice", "geminiLiveApiVersion", "geminiLiveInstructions", "websocketUrl", "websocketHeadersJson", "websocketInitialMessagesJson", "websocketAudioInputEventType", "websocketAudioInputField", "websocketAudioInputSampleRate", "websocketAudioOutputEventTypes", "websocketAudioOutputField", "websocketAudioOutputSampleRate", "sipCredentials"],
      "dial.break": ["operation", "dialId", "dialBreakReason"],
      "dial.waitDialEvent": ["operation", "dialId", "dialIds", "dialTimeoutSeconds", "waitEventOutputs"],
      "media.playAudio": ["operation", "mediaLegId", "sourceType", "binaryProperty", "binaryDataBase64", "filePath", "playbackHttpUrl", "playbackHttpMethod", "playbackHttpHeaders", "interruptOnDtmf", "interruptOnVoice", "voiceThreshold", "voiceDurationMs", "duckingFactor", "mediaExecutionMode", "stopOtherMedia"],
      "media.playTone": ["operation", "mediaLegId", "tone", "customTone", "repeatInfinite", "interruptOnDtmf", "interruptOnVoice", "voiceThreshold", "voiceDurationMs", "duckingFactor", "mediaExecutionMode", "stopOtherMedia"],
      "media.recordAudio": ["operation", "mediaLegId", "interruptOnDtmf", "interruptOnSilence", "silenceThreshold", "silenceDurationMs", "maxDurationSeconds", "recordFileFormat", "recordWavSampleRate", "recordWavBitDepth", "recordCompressedSampleRate", "recordCompressedBitrate", "recordOutputType", "recordBinaryProperty", "recordFilePath", "recordHttpUrl", "recordHttpMethod", "recordHttpHeaders", "mediaExecutionMode", "stopOtherMedia"],
      "media.stopMedia": ["operation", "stopMediaTarget", "stopMediaId", "stopMediaLegId", "stopMediaReason"],
      "media.waitMedia": ["operation", "waitMediaIds", "waitMediaTimeoutSeconds"],
      "media.sendDtmf": ["operation", "mediaLegId", "dtmfDigits", "dtmfMethod", "dtmfDurationMs", "dtmfGapMs"],
      "respond.respondToRecord": ["operation", "recordRequestId", "active", "recordFilePath", "recordFileFormat", "recordWavSampleRate", "recordWavBitDepth", "recordCompressedSampleRate", "recordCompressedBitrate", "recordSplitChannels", "waitForRecordingCompletion"],
      "respond.respondToAuth": ["operation", "authRequestId", "authAction", "password", "extension", "statusCode", "reason"],
      "queue.enqueueLeg": ["operation", "legId", "ref", "queuePlacement", "callStrategy", "callerNumber", "callerName", "customSipHeaders", "sequentialAttemptTimeoutSeconds", "sequentialGapSeconds", "extensionListOnlyFreeEndpoints", "rejoinExisting", "retryAttempts", "retryPauseSeconds"],
      "queue.setQueueCallback": ["operation", "legId", "callbackEnabled"],
      "respond.respondToAiTool": ["operation", "aiToolRequestId", "outputText"],
      "queue.getQueueStats": ["operation", "queueStatsTarget", "ref", "legId"],
    };
    const fields = fieldsByOperation[operation] || null;
    return fields ? new Set(fields) : null;
  }

  private resolveActionResultBranch(action: Record<string, unknown>, result: unknown): string {
    const operation = String(action.operation || "");
    if (operation === "call.unbridge") {
      return UnbridgeBranchOrig;
    }
    if (operation === "call.bridge") {
      return BridgeBranch;
    }
    if (operation === "ai.attachVoiceAgent") {
      return ActionResultBranch;
    }
    if (operation === "call.waitCallEvent") {
      const output = readResultString(result, "output");
      if (output === CALL_WAIT_OUTPUT_MATCHED) return readResultString(result, "matchedLabel") || CallWaitBranchTimeout;
      if (output === CALL_WAIT_OUTPUT_DTMF_FALLBACK) return CallWaitBranchDtmfFallback;
      if (output === CALL_WAIT_OUTPUT_INTERRUPT) return CallWaitBranchInterrupt;
      if (output === CALL_WAIT_OUTPUT_ENDED) return CallWaitBranchEnded;
      return CallWaitBranchTimeout;
    }
    if (operation === "dial.waitDialEvent") {
      const eventType = readResultEventType(result);
      if (eventType === DIAL_EVENT_RINGING) return DialWaitBranchRinging;
      if (eventType === DIAL_EVENT_PROGRESS) return DialWaitBranchProgress;
      if (eventType === DIAL_EVENT_ANSWERED) return DialWaitBranchAnswered;
      if (eventType === DIAL_EVENT_REJECTED) return DialWaitBranchRejected;
      if (eventType === DIAL_EVENT_TIMEOUT) return DialWaitBranchTimeout;
      return DialWaitBranchFailed;
    }
    if (operation === "media.waitMedia") {
      const eventType = readResultEventType(result);
      if (eventType === MEDIA_EVENT_INTERRUPTED) return WaitMediaBranchInterrupted;
      if (eventType === MEDIA_EVENT_COMPLETED || eventType === MEDIA_EVENT_FAILED) return WaitMediaBranchCompleted;
      if (eventType === MEDIA_EVENT_TIMEOUT) return WaitMediaBranchTimeout;
      return WaitMediaBranchCompleted;
    }
    if (operation === "media.playAudio" || operation === "media.playTone" || operation === "media.recordAudio") {
      if (String(action.mediaExecutionMode || OPTION_DEFAULTS.mediaExecution.mode) === "background") {
        return MediaBackgroundBranchResult;
      }
      const eventType = readResultEventType(result);
      if (operation === "media.playTone" && Boolean(action.repeatInfinite)) {
        if (eventType !== MEDIA_EVENT_INTERRUPTED) {
          throw new Error("media.playTone with repeatInfinite=true must terminate only with interrupted result");
        }
        return MediaInfiniteToneBranchInterrupted;
      }
      if (eventType === MEDIA_EVENT_INTERRUPTED) return MediaBlockingBranchInterrupted;
      return MediaBlockingBranchCompleted;
    }
    return ActionResultBranch;
  }

  private async executeActionResult(context: RequestContext, action: Record<string, unknown>): Promise<unknown> {
    const operation = String(action.operation || "");
    switch (operation) {
      case "call.ringing":
      {
        const legId = String(action.legId || "");
        const retention = this.legService.retainLeg(legId, "action:call.ringing");
        try {
          return this.signalingService.ringLeg(legId);
        } finally {
          retention.release();
        }
      }
      case "call.answer":
      {
        const legId = String(action.legId || "");
        const retention = this.legService.retainLeg(legId, "action:call.answer");
        try {
          return await this.signalingService.answerLeg(legId);
        } finally {
          retention.release();
        }
      }
      case "call.hangup":
      {
        const legId = String(action.legId || "");
        const retention = this.legService.retainLeg(legId, "action:call.hangup");
        try {
          return this.signalingService.rejectLeg(legId, "hangup");
        } finally {
          retention.release();
        }
      }
      case "call.bridge":
      {
        const legAId = String(action.legAId || action.legId || "");
        const legBId = String(action.legBId || "");
        const result = await this.mediaService.bridgeLegs(
          legAId,
          legBId,
          {
            relayDtmf: String(action.relayDtmf || OPTION_DEFAULTS.call.relayDtmf),
            emitDtmfEvents: Boolean(action.emitDtmfEvents),
          },
        );
        this.completeBridgedDialAttempt(legAId);
        this.completeBridgedDialAttempt(legBId);
        await this.signalingService.syncBridgeSignaling(legAId, legBId);
        return result;
      }
      case "ai.attachVoiceAgent":
        return await this.attachVoiceAgent(context, String(action.legId || ""));
      case "call.unbridge":
      {
        const legId = String(action.legId || "");
        const retention = this.legService.retainLeg(legId, "action:call.unbridge");
        try {
          return await this.mediaService.unbridgeLeg(legId);
        } finally {
          retention.release();
        }
      }
      case "call.waitCallEvent":
      {
        const legIds = Array.isArray(action.legIds)
          ? Array.from(new Set(normalizeStringList(action.legIds)))
          : normalizeStringList(action.legId);
        const waitTimeoutSeconds =
          action.timeoutSeconds == null || action.timeoutSeconds === ""
            ? OPTION_DEFAULTS.call.waitTimeoutSeconds
            : action.timeoutSeconds;
        const retention = this.legService.retainLegs(legIds, "action:call.waitCallEvent");
        try {
          return await this.legWaitService.waitForEvent(
            legIds.length > 1 ? legIds : (legIds[0] || ""),
            {
              timeoutMs: Math.max(0, Math.round(Number(waitTimeoutSeconds) * 1000)),
              interdigitTimeoutMs: Math.max(0, Math.round(Number(action.interdigitTimeoutSeconds == null ? OPTION_DEFAULTS.call.interdigitTimeoutSeconds : action.interdigitTimeoutSeconds) * 1000)),
              rules: normalizeActionRules(action.rules),
              waitDtmfFallbackEnabled: Boolean(action.waitDtmfFallbackEnabled),
              waitDtmfMultiDigitFallbackEnabled: Boolean(action.waitDtmfMultiDigitFallbackEnabled),
              dtmfTerminatorDigit: String(action.dtmfTerminatorDigit || OPTION_DEFAULTS.call.dtmfTerminatorDigit),
            },
            context,
          );
        } finally {
          retention.release();
        }
      }
      case "dial.waitDialEvent":
      {
        const dialIds = Array.isArray(action.dialIds)
          ? normalizeStringList(action.dialIds)
          : normalizeStringList(action.dialId);
        const retentions = dialIds.map((dialId) => this.dialService.retainDial(dialId, "action:dial.waitDialEvent"));
        try {
          return await this.dialWaitService.waitForEvent(dialIds.length > 1 ? dialIds : (dialIds[0] || ""), {
            timeoutMs: Math.max(0, Math.round(Number(action.dialTimeoutSeconds || OPTION_DEFAULTS.dial.waitTimeoutSeconds) * 1000)),
            waitEventOutputs: Array.isArray(action.waitEventOutputs) ? action.waitEventOutputs as string[] : [],
          }, context);
        } finally {
          for (const ticket of retentions) {
            ticket.release();
          }
        }
      }
      case "call.controlRecording":
      {
        const legId = String(action.legId || "");
        const retention = this.legService.retainLeg(legId, "action:call.controlRecording");
        try {
          return await this.mediaService.controlRecording(
            legId,
            String(action.recordingControlAction || OPTION_DEFAULTS.call.recordingControlAction) as "pause" | "resume",
          );
        } finally {
          retention.release();
        }
      }
      case "dial.make":
      {
        const result = this.signalingService.makeDial(action);
        const retention = this.dialService.retainDial(String(result.dialId || ""), "action:dial.make");
        try {
          return result;
        } finally {
          retention.release();
        }
      }
      case "dial.break":
      {
        const dialId = String(action.dialId || "");
        const retention = this.dialService.retainDial(dialId, "action:dial.break");
        try {
          return this.dialService.breakDial(dialId, String(action.dialBreakReason || OPTION_DEFAULTS.dial.breakReason));
        } finally {
          retention.release();
        }
      }
      case "respond.respondToRecord":
      {
        const recordRequest = this.consumeRecordRequest(String(action.recordRequestId || ""));
        const active = action.active !== false;
        const waitForRecordingCompletion = Boolean(action.waitForRecordingCompletion);
        if (!active) {
          return {
            recordRequestId: recordRequest.recordRequestId,
            active: false,
          };
        }
        const recordFilePath = String(action.recordFilePath || "").trim();
        if (!recordFilePath) {
          throw daemonError("invalid_request", "recordFilePath is required when global recording is active");
        }
        const recordFileFormat = String(action.recordFileFormat || OPTION_DEFAULTS.recordAudio.fileFormat).trim().toLowerCase() || OPTION_DEFAULTS.recordAudio.fileFormat;
        const recordInput: Record<string, unknown> = {
          mediaExecutionMode: "background",
          recordOutputType: "file",
          recordFilePath,
          recordFileFormat,
          recordSplitChannels: Boolean(action.recordSplitChannels ?? OPTION_DEFAULTS.autoRecording.splitChannels),
        };
        if (recordFileFormat === "wav") {
          recordInput.recordWavSampleRate = Number(action.recordWavSampleRate || OPTION_DEFAULTS.recordAudio.wavSampleRate);
          recordInput.recordWavBitDepth = Number(action.recordWavBitDepth || OPTION_DEFAULTS.recordAudio.wavBitDepth);
        } else {
          recordInput.recordCompressedSampleRate = Number(action.recordCompressedSampleRate || OPTION_DEFAULTS.recordAudio.compressedSampleRate);
          recordInput.recordCompressedBitrate = Number(action.recordCompressedBitrate || OPTION_DEFAULTS.recordAudio.compressedBitrateKbps);
        }
        await this.mediaService.startGlobalCallRecording(recordRequest.legId, recordInput);
        if (waitForRecordingCompletion) {
          const finalResult = await this.mediaService.waitForGlobalCallRecording(recordRequest.legId, context);
          return {
            recordRequestId: recordRequest.recordRequestId,
            active: true,
            legId: recordRequest.legId,
            filePath: recordFilePath,
            ...(finalResult || {}),
          };
        }
        return {
          recordRequestId: recordRequest.recordRequestId,
          active: true,
          legId: recordRequest.legId,
          filePath: recordFilePath,
        };
      }
      case "respond.respondToAuth":
        return this.authService.resolveRequest(String(action.authRequestId || ""), {
          action: normalizeAuthAction(action.authAction),
          password: String(action.password || ""),
          extension: String(action.extension || ""),
          statusCode: action.statusCode == null ? undefined : Number(action.statusCode),
          reason: String(action.reason || ""),
        });
      case "queue.enqueueLeg":
        return this.queueService.enqueueLeg(
          String(action.ref || ""),
          String(action.legId || ""),
          normalizeQueuePlacement(action.queuePlacement),
          {
            callStrategy: String(action.callStrategy || OPTION_DEFAULTS.dial.strategy) === "sequential" ? "sequential" : "parallel",
            callerNumber: String(action.callerNumber || ""),
            callerName: String(action.callerName || ""),
            customSipHeaders: Array.isArray(action.customSipHeaders) ? action.customSipHeaders as Array<{ name: string; value: string }> : [],
            extensionListOnlyFreeEndpoints: action.extensionListOnlyFreeEndpoints !== false,
            sequentialAttemptTimeoutSeconds: Math.max(0, Number(action.sequentialAttemptTimeoutSeconds || OPTION_DEFAULTS.dial.sequentialAttemptTimeoutSeconds)),
            sequentialGapSeconds: Math.max(0, Number(action.sequentialGapSeconds || OPTION_DEFAULTS.dial.sequentialGapSeconds)),
          },
          {
            rejoinExisting: action.rejoinExisting !== false,
            retryAttempts: action.retryAttempts == null
              ? OPTION_DEFAULTS.trigger.queue.retryAttempts
              : Math.max(0, Math.round(Number(action.retryAttempts))),
            retryPauseMs: action.retryPauseSeconds == null
              ? Math.round(OPTION_DEFAULTS.trigger.queue.retryPauseSeconds * 1000)
              : Math.max(0, Math.round(Number(action.retryPauseSeconds) * 1000)),
          },
        );
      case "queue.setQueueCallback":
        return this.queueService.setQueueCallback(String(action.legId || ""), action.callbackEnabled !== false);
      case "respond.respondToAiTool":
      {
        const aiToolRequestId = String(action.aiToolRequestId || "");
        const outputText = String(action.outputText || "");
        return this.respondToAiTool(aiToolRequestId, outputText);
      }
      case "queue.getQueueStats":
        return this.queueService.getQueueStats({
          ref: String(action.queueStatsTarget || OPTION_DEFAULTS.queueAction.statsTarget) === OPTION_DEFAULTS.queueAction.statsTarget ? String(action.ref || "") : undefined,
          legId: String(action.queueStatsTarget || OPTION_DEFAULTS.queueAction.statsTarget) === "legId" ? String(action.legId || "") : undefined,
        });
      case "media.playAudio":
        return this.mediaService.playAudio(String(action.mediaLegId || action.legId || ""), action, context);
      case "media.playTone":
        return this.mediaService.playTone(String(action.mediaLegId || action.legId || ""), action, context);
      case "media.recordAudio":
        return this.mediaService.recordAudio(String(action.mediaLegId || action.legId || ""), action, context);
      case "media.stopMedia":
        return this.mediaService.stopMedia({
          stopMediaTarget: String(action.stopMediaTarget || OPTION_DEFAULTS.stopMedia.target),
          stopMediaId: String(action.stopMediaId || ""),
          stopMediaLegId: String(action.stopMediaLegId || action.legId || ""),
          stopMediaReason: String(action.stopMediaReason || OPTION_DEFAULTS.stopMedia.reason),
        }, context);
      case "media.waitMedia":
        return this.mediaService.waitMedia({
          waitMediaIds: Array.isArray(action.waitMediaIds) ? action.waitMediaIds.map((value) => String(value || "")) : [],
          waitMediaTimeoutMs: Math.max(0, Math.round(Number(action.waitMediaTimeoutSeconds || OPTION_DEFAULTS.waitMedia.timeoutSeconds) * 1000)),
        }, context);
      case "media.sendDtmf":
        return this.mediaService.sendDtmf(String(action.mediaLegId || action.legId || ""), String(action.dtmfDigits || ""), action);
      default:
        throw daemonError("unsupported_operation", `Unsupported action operation ${operation}`);
    }
  }

  private async attachVoiceAgent(
    context: RequestContext,
    legId: string,
  ): Promise<{ legId: string; eventType: typeof CALL_EVENT_ENDED | typeof MEDIA_EVENT_INTERRUPTED; reason?: string }> {
    const normalizedLegId = String(legId || "").trim();
    if (!normalizedLegId) {
      throw daemonError("invalid_request", "legId is required");
    }
    const leg = this.legService.requireLeg(normalizedLegId);
    if (leg.transportType !== "websocket" || leg.status === LEG_STATUS_ENDED) {
      throw daemonError("invalid_leg", `Leg ${normalizedLegId} is not a live websocket leg`);
    }
    const signalingDetails = { ...(leg.signalingDetails || {}) };
    const transportProfile = String(signalingDetails.transportProfile || "").trim();
    if (!["openai_realtime", "gemini_live"].includes(transportProfile)) {
      throw daemonError("invalid_request", `Voice agent attach is not supported for transportProfile=${transportProfile || "none"}`);
    }
    const voiceAgentConfig = this.getTriggerConfig("voiceAgent", normalizedLegId);
    if (!voiceAgentConfig) {
      throw daemonError("invalid_request", `Voice agent stream is not active for leg ${normalizedLegId}`);
    }
    const memoryText = String(voiceAgentConfig.memoryText || "").trim();
    const needsInputTranscription = voiceAgentConfig.needsInputTranscription === true;
    const tools = normalizeVoiceAgentTools(voiceAgentConfig.tools);
    if (tools.length > 0 && !["openai_realtime", "gemini_live"].includes(transportProfile)) {
      throw daemonError("configuration_error", `ai_tool is not supported for transportProfile=${transportProfile}`);
    }
    this.activeVoiceAgentControllers.set(normalizedLegId, {
      legId: normalizedLegId,
      triggerKey: String(this.getActiveTriggerKey("voiceAgent", normalizedLegId) || ""),
      transportProfile,
      memoryText,
      hasConnectedMemory: voiceAgentConfig.hasConnectedMemory === true,
      tools,
      pendingMemoryUserTexts: [],
      pendingMemoryToolCalls: [],
    });
    const websocketStartMode = String(signalingDetails.websocketStartMode || OPTION_DEFAULTS.dial.websocketStartMode).trim()
      || OPTION_DEFAULTS.dial.websocketStartMode;
    if (
      transportProfile === "gemini_live"
      && signalingDetails.websocketSessionActivated === true
      && tools.length > 0
    ) {
      throw daemonError("configuration_error", "gemini_live tools require websocketStartMode=deferred");
    }
    const updatedSignalingDetails = {
      ...signalingDetails,
      voiceAgentEnabled: true,
      voiceAgentMemoryText: memoryText,
      voiceAgentNeedsInputTranscription: needsInputTranscription,
      voiceAgentToolsJson: tools,
    };
    this.legService.updateSignalingDetails(normalizedLegId, updatedSignalingDetails);
    try {
      if (websocketStartMode === "deferred" && signalingDetails.websocketSessionActivated !== true) {
        this.legService.updateSignalingDetails(normalizedLegId, {
          ...updatedSignalingDetails,
          websocketSessionActivated: true,
        });
        try {
          await this.mediaService.ensureTransportEndpoint(normalizedLegId);
        } catch (error) {
          this.legService.updateSignalingDetails(normalizedLegId, {
            ...updatedSignalingDetails,
            websocketSessionActivated: false,
          });
          throw error;
        }
      } else {
        const profile = createWebSocketTransportProfile(updatedSignalingDetails);
        if (transportProfile === "gemini_live" && (memoryText || tools.length > 0)) {
          throw daemonError("configuration_error", "gemini_live memory/tools require websocketStartMode=deferred");
        }
        const messages = profile.buildVoiceAgentSessionMessages?.({
          memoryText,
          tools,
        }) || [];
        for (const payload of messages) {
          const sent = await this.mediaService.sendWebSocketJson(normalizedLegId, payload);
          if (!sent) {
            throw daemonError("transport_error", `Unable to send voice-agent session update for leg ${normalizedLegId}`);
          }
        }
      }
      return await this.waitForVoiceAgentTermination(normalizedLegId, context);
    } finally {
      this.detachVoiceAgentController(normalizedLegId);
    }
  }

  private async respondVoiceAgentToolCall(params: Record<string, unknown>): Promise<{ voiceAgentRequestId: string }> {
    const voiceAgentRequestId = String(params.voiceAgentRequestId || "").trim();
    if (!voiceAgentRequestId) {
      throw daemonError("invalid_request", "voiceAgentRequestId is required");
    }
    const pending = this.pendingVoiceAgentToolCalls.get(voiceAgentRequestId) || null;
    if (!pending) {
      throw daemonError("invalid_request", `Unknown voiceAgentRequestId ${voiceAgentRequestId}`);
    }
    this.pendingVoiceAgentToolCalls.delete(voiceAgentRequestId);
    const controller = this.activeVoiceAgentControllers.get(pending.legId) || null;
    const leg = this.legService.getLeg(pending.legId);
    if (!controller || !leg || leg.status === LEG_STATUS_ENDED) {
      return { voiceAgentRequestId };
    }
    const profile = createWebSocketTransportProfile({ ...(leg.signalingDetails || {}) });
    const messages = profile.buildVoiceAgentToolResultMessages?.({
      voiceAgentRequestId,
      outputText: String(params.outputText || ""),
      isError: params.isError === true,
    }) || [];
    if (messages.length === 0) {
      throw daemonError("configuration_error", `Tool results are not supported for transportProfile=${controller.transportProfile}`);
    }
    for (const payload of messages) {
      const sent = await this.mediaService.sendWebSocketJson(pending.legId, payload);
      if (!sent) {
        throw daemonError("transport_error", `Unable to deliver tool result for leg ${pending.legId}`);
      }
    }
    controller.pendingMemoryToolCalls.push({
      voiceAgentRequestId,
      toolName: pending.toolName,
      argumentsJson: pending.argumentsJson,
      outputText: String(params.outputText || ""),
      isError: params.isError === true,
    });
    return { voiceAgentRequestId };
  }

  private detachVoiceAgentController(legId: string): void {
    this.activeVoiceAgentControllers.delete(legId);
    for (const [voiceAgentRequestId, pending] of Array.from(this.pendingVoiceAgentToolCalls.entries())) {
      if (pending.legId === legId) {
        this.pendingVoiceAgentToolCalls.delete(voiceAgentRequestId);
      }
    }
  }

  private async handleVoiceAgentTransportEvent(legId: string, event: WebSocketVoiceAgentEvent): Promise<void> {
    const controller = this.activeVoiceAgentControllers.get(legId) || null;
    if (!controller) {
      return;
    }
    if (event.type === "tool_call") {
      this.pendingVoiceAgentToolCalls.set(event.voiceAgentRequestId, {
        legId,
        voiceAgentRequestId: event.voiceAgentRequestId,
        toolName: event.toolName,
        argumentsJson: event.argumentsJson,
      });
      this.publishTriggerStream("voiceAgent", legId, VoiceAgentStreamBranchToolCall, {
        legId,
        voiceAgentRequestId: event.voiceAgentRequestId,
        toolName: event.toolName,
        argumentsJson: event.argumentsJson,
      });
      return;
    }
    if (event.type === "user_transcript") {
      controller.pendingMemoryUserTexts.push(event.text);
      return;
    }
    if (event.type === "assistant_transcript") {
      const userText = controller.pendingMemoryUserTexts.shift() || "";
      if (!userText || !event.text) {
        return;
      }
      const toolCalls = controller.pendingMemoryToolCalls.splice(0);
      this.publishTriggerStream("voiceAgent", legId, VoiceAgentStreamBranchMemoryTurn, {
        legId,
        userText,
        assistantText: event.text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
    }
  }

  private async waitForVoiceAgentTermination(
    legId: string,
    context: RequestContext,
  ): Promise<{ legId: string; eventType: typeof CALL_EVENT_ENDED | typeof MEDIA_EVENT_INTERRUPTED; reason?: string }> {
    const leg = this.legRegistry.get(legId);
    if (!leg) {
      throw daemonError("invalid_leg", `Unknown leg ${legId}`);
    }
    const immediateEnded = leg.shiftEventMatching((event) => event.eventType === CALL_EVENT_ENDED);
    if (immediateEnded) {
      return {
        legId,
        eventType: CALL_EVENT_ENDED,
        reason: immediateEnded.eventType === CALL_EVENT_ENDED ? immediateEnded.reason : undefined,
      };
    }
    if (leg.status === LEG_STATUS_ENDED) {
      return { legId, eventType: CALL_EVENT_ENDED };
    }
    const endedTicket = leg.waitForEventCancellable((event) => event.eventType === CALL_EVENT_ENDED, 0);
    try {
      let release = () => undefined;
      const cancelled = new Promise<null>((resolve) => {
        release = context.onCancel(() => resolve(null));
      });
      const endedEvent = await Promise.race([
        endedTicket.promise.then((event) => event as { eventType: typeof CALL_EVENT_ENDED; reason: string; createdAt: number }),
        cancelled,
      ]);
      release();
      if (!endedEvent) {
        return {
          legId,
          eventType: MEDIA_EVENT_INTERRUPTED,
          reason: "request_cancelled",
        };
      }
      return {
        legId,
        eventType: CALL_EVENT_ENDED,
        reason: endedEvent.reason,
      };
    } finally {
      endedTicket.cancel();
    }
  }

  private registerTriggerStream(input: {
    kind: "trunk" | "extensions" | "queue" | "aiTool" | "voiceAgent";
    config: Record<string, unknown>;
    socket: Socket;
    write: (frame: unknown) => void;
  }): { triggerKey: string; socketId: string } {
    this.clearIdleShutdownTimer();
    const ref = this.extractTriggerStreamRef(input.kind, input.config);
    if (!ref) {
      throw daemonError("invalid_trigger", input.kind === "voiceAgent" ? "voiceAgent legId is required" : "Trigger ref is required");
    }
    const previous = this.getActiveTriggerStream(input.kind, ref);
    const publicRef = this.getTriggerPublicRef(input.kind, ref, input.config);
    const duplicatePublicRef = input.kind === "extensions"
      ? this.findActiveExtensionsTriggerStreamByPublicRef(publicRef)
      : null;
    if (previous || duplicatePublicRef) {
      throw daemonError("invalid_trigger", `Active ${input.kind} trigger for ref ${publicRef || ref} already exists`);
    }
    const triggerKey = newTriggerKey(input.kind, ref);
    const socketId = newSocketId();
    const stream: ActiveTriggerStream = {
      triggerKey,
      socketId,
      ref,
      kind: input.kind,
      config: { ...(input.config || {}) },
      socket: input.socket,
      write: input.write,
    };
    this.triggerStreams.set(triggerKey, stream);
    this.triggerStreamIndex.set(this.triggerStreamIndexKey(input.kind, ref), triggerKey);
    const unregister = () => {
      const current = this.triggerStreams.get(triggerKey) || null;
      if (!current || current.socketId !== socketId) {
        return;
      }
      this.removeTriggerStream(triggerKey);
    };
    input.socket.on("close", unregister);
    input.socket.on("error", unregister);
    return { triggerKey, socketId };
  }

  private publishTriggerStream(kind: "trunk" | "extensions" | "queue" | "aiTool" | "voiceAgent", ref: string, branch: string, payload: Record<string, unknown>): void {
    const stream = this.getActiveTriggerStream(kind, ref);
    if (!stream) {
      return;
    }
    stream.write({
      kind,
      branch,
      payload,
    });
  }

  private getTriggerConfig(kind: "trunk" | "extensions" | "queue" | "aiTool" | "voiceAgent", ref: string): Record<string, unknown> | null {
    return this.getActiveTriggerStream(kind, ref)?.config || null;
  }

  private getActiveSocketId(kind: "trunk" | "extensions" | "queue" | "aiTool" | "voiceAgent", ref: string): string | null {
    return this.getActiveTriggerStream(kind, ref)?.socketId || null;
  }

  private getActiveTriggerKey(kind: "trunk" | "extensions" | "queue" | "aiTool" | "voiceAgent", ref: string): string | null {
    return this.getActiveTriggerStream(kind, ref)?.triggerKey || null;
  }

  private isTriggerKeyActive(triggerKey: string): boolean {
    return this.triggerStreams.has(triggerKey);
  }

  private closeAllTriggerStreams(): void {
    this.clearIdleShutdownTimer();
    for (const [triggerKey, stream] of this.triggerStreams.entries()) {
      this.triggerStreams.delete(triggerKey);
      this.triggerStreamIndex.delete(this.triggerStreamIndexKey(stream.kind, stream.ref));
      this.clearRecordRequestsForTriggerKey(triggerKey);
      this.clearAiToolRequestsForTriggerKey(triggerKey);
      if (stream.kind === "voiceAgent") {
        this.detachVoiceAgentController(stream.ref);
      }
      closeTriggerSocket(stream.socket);
    }
  }

  private countTriggerStreams(): number {
    return this.triggerStreams.size;
  }

  private removeTriggerStream(triggerKey: string): void {
    const stream = this.triggerStreams.get(triggerKey) || null;
    if (!stream) {
      return;
    }
    this.triggerStreams.delete(triggerKey);
    const indexKey = this.triggerStreamIndexKey(stream.kind, stream.ref);
    if (this.triggerStreamIndex.get(indexKey) === triggerKey) {
      this.triggerStreamIndex.delete(indexKey);
    }
    this.clearRecordRequestsForTriggerKey(triggerKey);
    this.clearAiToolRequestsForTriggerKey(triggerKey);
    if (stream.kind === "voiceAgent") {
      this.detachVoiceAgentController(stream.ref);
    }
    this.scheduleIdleShutdown();
  }

  private getActiveTriggerStream(kind: "trunk" | "extensions" | "queue" | "aiTool" | "voiceAgent", ref: string): ActiveTriggerStream | null {
    const triggerKey = this.triggerStreamIndex.get(this.triggerStreamIndexKey(kind, ref));
    if (!triggerKey) {
      return null;
    }
    return this.triggerStreams.get(triggerKey) || null;
  }

  private triggerStreamIndexKey(kind: "trunk" | "extensions" | "queue" | "aiTool" | "voiceAgent", ref: string): string {
    return `${kind}:${ref}`;
  }

  private getTriggerPublicRef(
    kind: "trunk" | "extensions" | "queue" | "aiTool" | "voiceAgent",
    ref: string,
    config?: Record<string, unknown> | null,
  ): string {
    if (kind === "trunk" || kind === "extensions" || kind === "queue" || kind === "aiTool") {
      return String(config?.publicRef || ref || "").trim();
    }
    return ref;
  }

  private findActiveExtensionsTriggerStreamByPublicRef(publicRef: string): ActiveTriggerStream | null {
    if (!publicRef) {
      return null;
    }
    for (const stream of this.triggerStreams.values()) {
      if (stream.kind !== "extensions") {
        continue;
      }
      if (this.getTriggerPublicRef(stream.kind, stream.ref, stream.config) === publicRef) {
        return stream;
      }
    }
    return null;
  }

  private extractTriggerStreamRef(kind: "trunk" | "extensions" | "queue" | "aiTool" | "voiceAgent", config: Record<string, unknown>): string {
    if (kind === "voiceAgent") {
      return String(config.legId || "").trim();
    }
    return String(config.ref || "").trim();
  }

  private clearIdleShutdownTimer(): void {
    if (!this.idleStopTimer) {
      return;
    }
    clearTimeout(this.idleStopTimer);
    this.idleStopTimer = null;
  }

  private scheduleIdleShutdown(delayMs = 100): void {
    if (!this.started || this.stopPromise || this.idleStopTimer || this.countTriggerStreams() > 0) {
      return;
    }
    this.idleStopTimer = setTimeout(() => {
      this.idleStopTimer = null;
      if (!this.started || this.stopPromise) {
        return;
      }
      if (this.hasActiveTasks()) {
        if (this.countTriggerStreams() === 0) {
          this.scheduleIdleShutdown(250);
        }
        return;
      }
      void this.stop().catch((error) => {
        console.error(
          `[sip-pbx:daemon] idle stop failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
        );
      });
    }, Math.max(0, delayMs));
  }

  private hasActiveTasks(): boolean {
    if (this.countTriggerStreams() > 0) {
      return true;
    }
    if (this.mediaService.hasActiveWork()) {
      return true;
    }
    if (this.legRegistry.values().length > 0) {
      return true;
    }
    if (this.dialRegistry.values().length > 0) {
      return true;
    }
    return false;
  }

  private describeActiveTasks(): string {
    const triggerStreams = this.countTriggerStreams();
    const mediaActive = this.mediaService.hasActiveWork();
    const activeLegs = this.legRegistry.values()
      .map((leg) => `${leg.legId}:${leg.status}`);
    const activeDials = this.dialRegistry.values()
      .map((dial) => `${dial.dialId}:${dial.status}:finalized=${Boolean(dial.finalizedAt)}`);
    return [
      `triggerStreams=${triggerStreams}`,
      `mediaActive=${mediaActive}`,
      `activeLegs=${activeLegs.length > 0 ? activeLegs.join(",") : "none"}`,
      `activeDials=${activeDials.length > 0 ? activeDials.join(",") : "none"}`,
    ].join("; ");
  }

  private async maybePublishRecordRequest(input: {
    kind: "trunk" | "extensions";
    ref: string;
    legId: string;
    direction?: string;
    from: string;
    to: string;
    callId?: string;
    callerName?: string;
    extensionNumber?: string;
  }): Promise<void> {
    const config = this.getTriggerConfig(input.kind, input.ref);
    if (!config) {
      return;
    }
    const enabled = input.kind === "extensions"
      ? Boolean(config.extensionsEnableCallRecording)
      : Boolean(config.enableCallRecording);
    if (!enabled) {
      return;
    }
    const triggerKey = this.getActiveTriggerKey(input.kind, input.ref);
    if (!triggerKey) {
      return;
    }
    this.clearRecordRequestsForLeg(input.legId);
    const recordRequestId = newRecordRequestId();
    const payload = {
      eventType: "record",
      recordRequestId,
      kind: input.kind,
      ref: String(config.publicRef || input.ref || "").trim(),
      legId: input.legId,
      direction: String(input.direction || "inbound").trim() || "inbound",
      from: input.from,
      to: input.to,
      callId: input.callId || "",
      callerName: input.callerName || "",
      extension: input.extensionNumber || "",
    };
    this.storeRecordRequest({
      recordRequestId,
      triggerKey,
      kind: input.kind,
      ref: input.ref,
      legId: input.legId,
      payload,
      timeoutHandle: null,
    });
    this.publishTriggerStream(input.kind, input.ref, TrunkTriggerBranchRecord, payload);
  }

  private maybePublishAnsweredOutboundRecordRequest(legId: string): void {
    const leg = this.legService.getLeg(legId);
    if (!leg || leg.direction !== "outbound") {
      return;
    }
    const metadata = leg.signalingDetails || {};
    const triggerMetadata = leg.triggerMetadata || {};
    const mode = String(metadata.callMode || "").trim();
    if (mode !== "trunk" && mode !== "extension") {
      return;
    }
    const winningDial = Array.from(this.dialRegistry.values())
      .find((dial) => dial.winnerLegId === legId && dial.status === DIAL_STATUS_ANSWERED);
    if (!winningDial) {
      return;
    }
    const extensionTarget = mode === "extension"
      ? {
        ref: String(metadata.ref || triggerMetadata.ref || "").trim(),
        extensionNumber: String(metadata.target || "").trim(),
        endpointId: String(triggerMetadata.endpointId || "").trim(),
      }
      : null;
    const kind = mode === "trunk" ? "trunk" : "extensions";
    const ref = String(
      mode === "trunk"
        ? metadata.ref || ""
        : extensionTarget?.ref || triggerMetadata.ref || "",
    ).trim();
    if (!ref) {
      return;
    }
    const extensionNumber = String(extensionTarget?.extensionNumber || triggerMetadata.extensionNumber || "").trim();
    const to = normalizeRecordPartyUri(mode === "trunk" ? metadata.target || "" : extensionNumber);
    const from = this.resolveOutboundRecordFrom(kind, ref, metadata);
    void this.maybePublishRecordRequest({
      kind,
      ref,
      legId,
      direction: "outbound",
      from,
      to,
      callId: String(metadata.callId || ""),
      callerName: String(metadata.callerName || ""),
      extensionNumber,
    });
  }

  private completeBridgedDialAttempt(legId: string): void {
    const leg = this.legService.getLeg(legId);
    if (!leg || leg.direction !== "outbound" || leg.status === LEG_STATUS_ANSWERED || leg.status === LEG_STATUS_ENDED) {
      return;
    }
    const dialId = String(leg.signalingDetails?.dialId || "").trim();
    if (!dialId) {
      return;
    }
    try {
      this.dialService.markAttemptBridged(dialId, legId);
    } catch (error) {
      console.error(
        `[sip-pbx:daemon] bridged dial attempt completion failed; dial=${dialId}; leg=${legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    }
  }

  private resolveOutboundRecordFrom(
    kind: "trunk" | "extensions",
    ref: string,
    metadata: Record<string, unknown>,
  ): string {
    const explicitCallerNumber = normalizeRecordPartyUri(metadata.callerNumber);
    if (explicitCallerNumber) {
      return explicitCallerNumber;
    }
    if (metadata.sipCredentials && typeof metadata.sipCredentials === "object") {
      const directUsername = normalizeRecordPartyUri((metadata.sipCredentials as Record<string, unknown>).username);
      if (directUsername) {
        return directUsername;
      }
    }
    if (kind === "trunk") {
      const triggerConfig = this.getTriggerConfig("trunk", ref);
      if (triggerConfig?.sipCredentials && typeof triggerConfig.sipCredentials === "object") {
        const trunkUsername = normalizeRecordPartyUri((triggerConfig.sipCredentials as Record<string, unknown>).username);
        if (trunkUsername) {
          return trunkUsername;
        }
      }
    }
    return normalizeRecordPartyUri("n8n");
  }

  private storeRecordRequest(request: RecordRequest): void {
    const existingRequestId = this.recordRequestIdsByLegId.get(request.legId) || null;
    if (existingRequestId && existingRequestId !== request.recordRequestId) {
      this.clearRecordRequest(existingRequestId);
    }
    const timeoutMs = this.readRecordResponseTimeoutMs(request.kind, request.ref);
    if (timeoutMs && timeoutMs > 0) {
      request.timeoutHandle = setTimeout(() => {
        this.clearRecordRequest(request.recordRequestId);
      }, timeoutMs);
    }
    this.recordRequests.set(request.recordRequestId, request);
    this.recordRequestIdsByLegId.set(request.legId, request.recordRequestId);
    const triggerRequests = this.recordRequestIdsByTriggerKey.get(request.triggerKey) || new Set<string>();
    triggerRequests.add(request.recordRequestId);
    this.recordRequestIdsByTriggerKey.set(request.triggerKey, triggerRequests);
  }

  private clearRecordRequest(recordRequestId: string): RecordRequest | null {
    const request = this.recordRequests.get(recordRequestId) || null;
    if (!request) {
      return null;
    }
    if (request.timeoutHandle) {
      clearTimeout(request.timeoutHandle);
      request.timeoutHandle = null;
    }
    this.recordRequests.delete(recordRequestId);
    if (this.recordRequestIdsByLegId.get(request.legId) === recordRequestId) {
      this.recordRequestIdsByLegId.delete(request.legId);
    }
    const triggerRequests = this.recordRequestIdsByTriggerKey.get(request.triggerKey) || null;
    if (triggerRequests) {
      triggerRequests.delete(recordRequestId);
      if (triggerRequests.size === 0) {
        this.recordRequestIdsByTriggerKey.delete(request.triggerKey);
      }
    }
    return request;
  }

  private consumeRecordRequest(recordRequestId: string): RecordRequest {
    const request = this.clearRecordRequest(recordRequestId);
    if (!request) {
      throw daemonError("invalid_record_request", `Unknown record request ${recordRequestId}`);
    }
    return request;
  }

  private clearRecordRequestsForLeg(legId: string): void {
    const requestId = this.recordRequestIdsByLegId.get(legId) || null;
    if (!requestId) {
      return;
    }
    this.clearRecordRequest(requestId);
  }

  private clearRecordRequestsForTriggerKey(triggerKey: string): void {
    const requestIds = Array.from(this.recordRequestIdsByTriggerKey.get(triggerKey) || []);
    for (const requestId of requestIds) {
      this.clearRecordRequest(requestId);
    }
  }

  private storeAiToolRequest(request: PendingAiToolRequest): void {
    this.pendingAiToolRequests.set(request.aiToolRequestId, request);
    const byLeg = this.aiToolRequestIdsByLegId.get(request.aiLegId) || new Set<string>();
    byLeg.add(request.aiToolRequestId);
    this.aiToolRequestIdsByLegId.set(request.aiLegId, byLeg);
    const byTrigger = this.aiToolRequestIdsByTriggerKey.get(request.triggerKey) || new Set<string>();
    byTrigger.add(request.aiToolRequestId);
    this.aiToolRequestIdsByTriggerKey.set(request.triggerKey, byTrigger);
  }

  private clearAiToolRequest(aiToolRequestId: string): PendingAiToolRequest | null {
    const request = this.pendingAiToolRequests.get(aiToolRequestId) || null;
    if (!request) {
      return null;
    }
    this.pendingAiToolRequests.delete(aiToolRequestId);
    if (request.timeoutHandle) {
      clearTimeout(request.timeoutHandle);
    }
    const byLeg = this.aiToolRequestIdsByLegId.get(request.aiLegId) || null;
    if (byLeg) {
      byLeg.delete(aiToolRequestId);
      if (byLeg.size === 0) {
        this.aiToolRequestIdsByLegId.delete(request.aiLegId);
      }
    }
    const byTrigger = this.aiToolRequestIdsByTriggerKey.get(request.triggerKey) || null;
    if (byTrigger) {
      byTrigger.delete(aiToolRequestId);
      if (byTrigger.size === 0) {
        this.aiToolRequestIdsByTriggerKey.delete(request.triggerKey);
      }
    }
    return request;
  }

  private clearAiToolRequestsForLeg(aiLegId: string): void {
    const requestIds = Array.from(this.aiToolRequestIdsByLegId.get(aiLegId) || []);
    for (const aiToolRequestId of requestIds) {
      const request = this.clearAiToolRequest(aiToolRequestId);
      if (request) {
        request.reject(daemonError("invalid_leg", `AI leg ${aiLegId} ended before AI tool response`));
      }
    }
  }

  private clearAiToolRequestsForTriggerKey(triggerKey: string): void {
    const requestIds = Array.from(this.aiToolRequestIdsByTriggerKey.get(triggerKey) || []);
    for (const aiToolRequestId of requestIds) {
      const request = this.clearAiToolRequest(aiToolRequestId);
      if (request) {
        request.reject(daemonError("not_found", "AI tool stream closed before response"));
      }
    }
  }
}

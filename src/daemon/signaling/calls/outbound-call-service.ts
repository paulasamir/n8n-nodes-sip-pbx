import { daemonError } from "../../core/daemon-error";
import { OPTION_DEFAULTS } from "../../../shared/option-defaults";
import { normalizeStringList } from "../../../shared/string-utils";
import { DialService } from "../../dials/dial-service";
import type { DialTarget } from "../../dials/types";
import { createWebSocketTransportProfile } from "../../media/transports/websocket-transport";

export class OutboundCallService {
  constructor(
    private readonly dialService: DialService,
    private readonly resolveExtensionTargets: (
      extensionNumbers: string[],
      workflowScopeKey?: string,
      onlyFree?: boolean,
    ) => Array<{ ref: string; extensionNumber: string; endpointId: string }>,
  ) {}

  createDialFromAction(action: Record<string, unknown>): { dialId: string; legId?: string } {
    const mode = String(action.callMode || "").trim();
    if (!["trunk", "direct", "extension", "websocket"].includes(mode)) {
      throw daemonError("invalid_request", "callMode is required");
    }
    const strategy = (mode === "websocket"
      ? OPTION_DEFAULTS.dial.strategy
      : String(action.callStrategy || OPTION_DEFAULTS.dial.strategy)) as "parallel" | "sequential";
    if (mode !== "websocket" && strategy !== "parallel" && strategy !== "sequential") {
      throw daemonError("invalid_request", "callStrategy must be parallel or sequential");
    }
    if (mode === "websocket") {
      const transportProfile = String(action.transportProfile || "").trim();
      const websocketStartMode = String(action.websocketStartMode || OPTION_DEFAULTS.dial.websocketStartMode).trim() || OPTION_DEFAULTS.dial.websocketStartMode;
      if (websocketStartMode === "deferred" && transportProfile === "generic") {
        throw daemonError("configuration_error", "websocketStartMode=deferred is not supported for transportProfile=generic");
      }
    }
    const targets = this.resolveTargets(action, mode);
    const dial = this.dialService.createDial({
      mode,
      strategy,
      targets,
      metadata: this.buildDialMetadata(action, mode),
      sequentialAttemptTimeoutMs: Math.max(0, Math.round(Number(action.sequentialAttemptTimeoutSeconds || 0) * 1000)),
      sequentialGapMs: Math.max(0, Math.round(Number(action.sequentialGapSeconds || 0) * 1000)),
    });
    if (dial.targets.length === 1 && dial.attemptLegIds.length === 1) {
      return { dialId: dial.dialId, legId: dial.attemptLegIds[0] };
    }
    return { dialId: dial.dialId };
  }

  private resolveTargets(action: Record<string, unknown>, mode: string): DialTarget[] {
    if (mode === "extension") {
      if (String(action.ref || "").trim()) {
        throw daemonError("invalid_request", "Extension dial must not include ref");
      }
      const extensionNumbers = normalizeStringList(action.extensionNumbers);
      if (extensionNumbers.length === 0) {
        throw daemonError("invalid_dial_targets", "Extension dial requires extension numbers");
      }
      const onlyFreeEndpoints = action.extensionListOnlyFreeEndpoints !== false;
      const resolved = this.resolveExtensionTargets(extensionNumbers, String(action.workflowScopeKey || "").trim(), onlyFreeEndpoints);
      if (resolved.length === 0) {
        throw daemonError("invalid_dial_targets", "Extension dial requires active registrations");
      }
      return resolved.map((registration) => ({
        kind: "extension",
        ref: String(registration.ref || "").trim(),
        extensionNumber: String(registration.extensionNumber || "").trim(),
        endpointId: String(registration.endpointId || "").trim(),
      }));
    }
    if (mode === "websocket") {
      const profile = createWebSocketTransportProfile({ ...(action || {}) });
      if (profile.syntheticDialTarget) {
        return [{ kind: "opaque", value: profile.syntheticDialTarget }];
      }
      if (!profile.resolveWebSocketUrl(action)) {
        throw daemonError("invalid_dial_targets", "Generic WebSocket dial requires websocketUrl");
      }
      return [{ kind: "opaque", value: profile.resolveWebSocketUrl(action) }];
    }
    const targets = normalizeStringList(action.destination);
    if (targets.length === 0) {
      throw daemonError("invalid_dial_targets", "Dial requires at least one target");
    }
    return targets.map((value) => ({ kind: "opaque" as const, value }));
  }

  private buildDialMetadata(action: Record<string, unknown>, mode: string): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      callMode: mode,
      ref: String(action.ref || ""),
      publicRef: String(action.publicRef || action.ref || ""),
      callerNumber: String(action.callerNumber || ""),
      callerName: String(action.callerName || ""),
      customSipHeaders: Array.isArray(action.customSipHeaders)
        ? (action.customSipHeaders as unknown[]).filter((value) => value && typeof value === "object")
        : [],
    };
    if (mode === "websocket") {
      const websocketStartMode = String(action.websocketStartMode || OPTION_DEFAULTS.dial.websocketStartMode).trim()
        || OPTION_DEFAULTS.dial.websocketStartMode;
      metadata.transportProfile = String(action.transportProfile || "").trim();
      metadata.websocketStartMode = websocketStartMode;
      metadata.websocketSessionActivated = websocketStartMode !== "deferred";
      metadata.websocketUrl = String(action.websocketUrl || "");
      metadata.websocketHeadersJson = action.websocketHeadersJson && typeof action.websocketHeadersJson === "object"
        ? action.websocketHeadersJson
        : {};
      metadata.websocketInitialMessagesJson = Array.isArray(action.websocketInitialMessagesJson)
        ? action.websocketInitialMessagesJson
        : [];
      metadata.openaiApiKey = String(action.openaiApiKey || "");
      metadata.openaiRealtimeModel = String(action.openaiRealtimeModel || OPTION_DEFAULTS.dial.openaiRealtimeModel);
      metadata.openaiRealtimeVoice = String(action.openaiRealtimeVoice || OPTION_DEFAULTS.dial.openaiRealtimeVoice);
      metadata.openaiRealtimeInputTranscriptionModel = String(
        action.openaiRealtimeInputTranscriptionModel || OPTION_DEFAULTS.dial.openaiRealtimeInputTranscriptionModel,
      );
      metadata.openaiRealtimeInstructions = String(action.openaiRealtimeInstructions || "");
      metadata.openaiRealtimePromptId = String(action.openaiRealtimePromptId || "");
      metadata.openaiRealtimePromptVersion = String(action.openaiRealtimePromptVersion || "");
      metadata.openaiRealtimePromptVariablesJson = action.openaiRealtimePromptVariablesJson && typeof action.openaiRealtimePromptVariablesJson === "object"
        ? action.openaiRealtimePromptVariablesJson
        : {};
      const profile = createWebSocketTransportProfile({ ...(action || {}) });
      if (!profile.syntheticDialTarget) {
        metadata.websocketAudioInputEventType = String(action.websocketAudioInputEventType || OPTION_DEFAULTS.dial.websocketAudioInputEventType);
        metadata.websocketAudioInputField = String(action.websocketAudioInputField || OPTION_DEFAULTS.dial.websocketAudioInputField);
        metadata.websocketAudioInputSampleRate = Number(action.websocketAudioInputSampleRate || OPTION_DEFAULTS.dial.websocketAudioSampleRate);
        metadata.websocketAudioOutputEventTypes = Array.isArray(action.websocketAudioOutputEventTypes)
          ? action.websocketAudioOutputEventTypes
          : [OPTION_DEFAULTS.dial.websocketAudioOutputEventTypesCsv];
        metadata.websocketAudioOutputField = String(action.websocketAudioOutputField || OPTION_DEFAULTS.dial.websocketAudioOutputField);
        metadata.websocketAudioOutputSampleRate = Number(action.websocketAudioOutputSampleRate || OPTION_DEFAULTS.dial.websocketAudioSampleRate);
      }
      metadata.geminiApiKey = String(action.geminiApiKey || "");
      metadata.geminiLiveModel = String(action.geminiLiveModel || OPTION_DEFAULTS.dial.geminiLiveModel);
      metadata.geminiLiveVoice = String(action.geminiLiveVoice || OPTION_DEFAULTS.dial.geminiLiveVoice);
      metadata.geminiLiveApiVersion = String(action.geminiLiveApiVersion || OPTION_DEFAULTS.dial.geminiLiveApiVersion);
      metadata.geminiLiveInstructions = String(action.geminiLiveInstructions || "");
    }
    if (action.sipCredentials && typeof action.sipCredentials === "object") {
      metadata.sipCredentials = { ...(action.sipCredentials as Record<string, unknown>) };
    }
    return metadata;
  }
}

import { TrunkTriggerBranchCall } from "../../../shared/branches";
import { LegService } from "../../legs/leg-service";
import type { InboundSipInvite } from "../types";

type InboundCallPublisher = (ref: string, branch: string, payload: Record<string, unknown>) => void;
type InboundLegCreatedHandler = (input: {
  kind: "trunk" | "extensions";
  ref: string;
  legId: string;
  direction?: "inbound" | "outbound";
  from: string;
  to: string;
  callId?: string;
  callerName?: string;
  extensionNumber?: string;
}) => void | Promise<void>;

export class InboundCallService {
  private readonly legService: LegService;
  private readonly onInboundLegCreated: InboundLegCreatedHandler;

  constructor(legService: LegService, onInboundLegCreated?: InboundLegCreatedHandler) {
    this.legService = legService;
    this.onInboundLegCreated = onInboundLegCreated || (() => undefined);
  }

  emitForExtensions(input: InboundSipInvite, publish: InboundCallPublisher): { legId: string; ref: string } {
    const publicRef = String(input.publicRef || input.ref || "").trim();
    const leg = this.legService.createLeg({
      direction: "inbound",
      transportType: input.transportType || "sip",
      signalingDetails: {
        from: input.from,
        to: input.to,
        callerName: input.callerName || "",
        callerNumber: input.callerNumber || "",
        headers: { ...(input.headers || {}) },
      },
      triggerMetadata: {
        ref: input.ref,
        publicRef,
        extensionNumber: input.extensionNumber || "",
        endpointId: input.endpointId || "",
      },
    });
    publish(input.ref, TrunkTriggerBranchCall, {
      eventType: "invite",
      ref: publicRef,
      legId: leg.legId,
      callId: input.callId || "",
      extension: input.extensionNumber || "",
      from: input.from,
      callerName: input.callerName || "",
      callerNumber: input.callerNumber || "",
      to: input.to,
      headers: { ...(input.headers || {}) },
      raw: { ...(input.raw || {}) },
    });
    void Promise.resolve(this.onInboundLegCreated({
      kind: "extensions",
      ref: input.ref,
      legId: leg.legId,
      direction: "inbound",
      from: input.from,
      to: input.to,
      callId: input.callId || "",
      callerName: input.callerName || "",
      extensionNumber: input.extensionNumber || "",
    })).catch((error) => {
      console.error(
        `[sip-pbx:signaling] inbound extensions leg callback failed; leg=${leg.legId}; ref=${input.ref}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    });
    return { legId: leg.legId, ref: input.ref };
  }

  emitForTrunk(input: InboundSipInvite, publish: InboundCallPublisher): { legId: string; ref: string } {
    const publicRef = String(input.publicRef || input.ref || "").trim();
    const leg = this.legService.createLeg({
      direction: "inbound",
      transportType: input.transportType || "sip",
      signalingDetails: {
        from: input.from,
        to: input.to,
        callerName: input.callerName || "",
        callerNumber: input.callerNumber || "",
        headers: { ...(input.headers || {}) },
      },
      triggerMetadata: {
        ref: input.ref,
        publicRef,
      },
    });
    publish(input.ref, TrunkTriggerBranchCall, {
      eventType: "invite",
      ref: publicRef,
      legId: leg.legId,
      callId: input.callId || "",
      from: input.from,
      callerName: input.callerName || "",
      callerNumber: input.callerNumber || "",
      to: input.to,
      headers: { ...(input.headers || {}) },
      raw: { ...(input.raw || {}) },
    });
    void Promise.resolve(this.onInboundLegCreated({
      kind: "trunk",
      ref: input.ref,
      legId: leg.legId,
      direction: "inbound",
      from: input.from,
      to: input.to,
      callId: input.callId || "",
      callerName: input.callerName || "",
    })).catch((error) => {
      console.error(
        `[sip-pbx:signaling] inbound trunk leg callback failed; leg=${leg.legId}; ref=${input.ref}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    });
    return { legId: leg.legId, ref: input.ref };
  }
}

import {
  DIAL_EVENT_ANSWERED,
  DIAL_EVENT_PROGRESS,
  DIAL_EVENT_REJECTED,
  DIAL_EVENT_RINGING,
  LEG_STATUS_ANSWERED,
  LEG_STATUS_ENDED,
} from "../../shared/result-events";
import { MapRegistry } from "../../shared/map-registry";
import { DialService } from "../dials/dial-service";
import { formatDialTarget, type Dial, type DialTarget } from "../dials/types";
import { LegCoordinator } from "../legs/leg-coordinator";
import { LegService } from "../legs/leg-service";
import type { Leg } from "../legs/types";
import { OutboundCallService } from "./calls/outbound-call-service";
import type { SignalingDialView, TransportSignalingService } from "./types";
import { SipTransportService } from "./sip/sip-transport-service";
import { SipSignalingService } from "./sip/sip-signaling-service";
import { WebSocketSignalingService } from "./websocket/websocket-signaling-service";

export class SignalingService {
  private readonly legService: LegService;
  private readonly dialService: DialService;
  private readonly outboundCallService: OutboundCallService;
  private readonly sipSignalingService: SipSignalingService;
  private readonly websocketSignalingService: WebSocketSignalingService;
  private readonly transportServices: TransportSignalingService[];

  constructor(input: {
    legService: LegService;
    dialRegistry: MapRegistry<string, Dial>;
    dialService: DialService;
    resolveExtensionTargets?: (
      extensionNumbers: string[],
      workflowScopeKey?: string,
      onlyFree?: boolean,
    ) => Array<{ ref: string; extensionNumber: string; endpointId: string }>;
    sipTransportService?: SipTransportService | null;
    ensureMediaTransportEndpoint?: (legId: string) => Promise<Record<string, unknown>>;
    legCoordinator?: LegCoordinator;
  }) {
    this.legService = input.legService;
    this.dialService = input.dialService;
    this.outboundCallService = new OutboundCallService(
      input.dialService,
      input.resolveExtensionTargets || (() => []),
    );
    const dependencies = {
      legService: this.legService,
      dialRegistry: input.dialRegistry,
      dialService: input.dialService,
    };
    this.sipSignalingService = new SipSignalingService({
      ...dependencies,
      sipTransportService: input.sipTransportService || null,
    });
    this.websocketSignalingService = new WebSocketSignalingService({
      ...dependencies,
      ensureMediaTransportEndpoint: input.ensureMediaTransportEndpoint || (async () => ({})),
      legCoordinator: input.legCoordinator,
    });
    this.transportServices = [
      this.sipSignalingService,
      this.websocketSignalingService,
    ];
  }

  async activateTrigger(kind: "trunk" | "extensions", config: Record<string, unknown>): Promise<void> {
    await Promise.all(this.transportServices.map(async (service) => {
      await service.activateTrigger(kind, config);
    }));
  }

  async deactivateTrigger(kind: "trunk" | "extensions", ref: string): Promise<void> {
    await Promise.all(this.transportServices.map(async (service) => {
      await service.deactivateTrigger(kind, ref);
    }));
  }

  closeAll(): void {
    for (const service of this.transportServices) {
      service.closeAll();
    }
  }

  handleAttemptStarted(dial: SignalingDialView, legId: string, target: DialTarget): void {
    const transportService = this.getTransportServiceForMode(dial.mode);
    console.error(
      `[sip-pbx:signaling] attempt dispatch; dial=${dial.dialId}; leg=${legId}; mode=${String(dial.mode || "unknown")}; target=${formatDialTarget(target) || "none"}; transport=${transportService.constructor.name}`,
    );
    transportService.handleAttemptStarted(dial, legId, target);
  }

  async handleLegEnded(legId: string, reason?: string): Promise<void> {
    this.dialService.handleAttemptLegEnded(legId);
    await Promise.all(this.transportServices.map(async (service) => {
      await service.handleLegEnded(legId, reason);
    }));
  }

  makeDial(action: Record<string, unknown>): { dialId: string; legId?: string } {
    return this.outboundCallService.createDialFromAction(action);
  }

  ringLeg(legId: string): { legId: string } {
    return this.applyLegSignal(legId, DIAL_EVENT_RINGING, undefined, true);
  }

  progressLeg(legId: string): { legId: string } {
    return this.applyLegSignal(legId, DIAL_EVENT_PROGRESS, undefined, true);
  }

  async answerLeg(legId: string): Promise<{ legId: string }> {
    return await this.applyAnsweredLegSignal(legId, true);
  }

  rejectLeg(legId: string, reason: string): { legId: string } {
    return this.applyLegSignal(legId, DIAL_EVENT_REJECTED, reason, true);
  }

  async syncBridgeSignaling(legAId: string, legBId: string): Promise<void> {
    await this.syncBridgeLegSignaling(legAId, legBId);
    await this.syncBridgeLegSignaling(legBId, legAId);
  }

  async sendDtmf(legId: string, digits: string, method: string): Promise<boolean> {
    const leg = this.legService.getLeg(legId);
    if (!leg) {
      return false;
    }
    const service = this.getTransportServiceForTransportType(leg.transportType);
    return await service.sendDtmf(legId, digits, method);
  }

  private getTransportServiceForMode(mode: string): TransportSignalingService {
    return this.transportServices.find((service) => service.supportsDialMode(mode))
      || this.sipSignalingService;
  }

  private getTransportServiceForLeg(legId: string): TransportSignalingService {
    const leg = this.legService.requireLeg(legId);
    return this.getTransportServiceForTransportType(leg.transportType);
  }

  private getTransportServiceForTransportType(transportType: "sip" | "websocket"): TransportSignalingService {
    return this.transportServices.find((service) => service.supportsTransportType(transportType))
      || this.sipSignalingService;
  }

  private applyLegSignal(
    legId: string,
    eventType: typeof DIAL_EVENT_RINGING | typeof DIAL_EVENT_PROGRESS | typeof DIAL_EVENT_REJECTED,
    reason?: string,
    relayBridgeSignaling = false,
  ): { legId: string } {
    const service = this.getTransportServiceForLeg(legId);
    const result = eventType === DIAL_EVENT_RINGING
      ? service.ringLeg(legId)
      : eventType === DIAL_EVENT_PROGRESS
        ? service.progressLeg(legId)
        : service.rejectLeg(legId, reason || "");
    if (relayBridgeSignaling) {
      void this.relayBridgeSignaling(legId, eventType, reason);
    }
    return result;
  }

  private async applyAnsweredLegSignal(legId: string, relayBridgeSignaling = false): Promise<{ legId: string }> {
    const result = await this.getTransportServiceForLeg(legId).answerLeg(legId);
    if (relayBridgeSignaling) {
      await this.relayBridgeSignaling(legId, DIAL_EVENT_ANSWERED);
    }
    return result;
  }

  private async syncBridgeLegSignaling(sourceLegId: string, targetLegId: string): Promise<void> {
    const sourceLeg = this.legService.getLeg(sourceLegId);
    const targetLeg = this.legService.getLeg(targetLegId);
    if (!sourceLeg || !targetLeg) {
      return;
    }
    if (sourceLeg.bridgePeerLegId !== targetLegId) {
      return;
    }
    const state = String(sourceLeg.signalingDetails?.bridgeSignalingState || "").trim();
    if (state === DIAL_EVENT_RINGING) {
      await this.applyBridgeSignalingToPeer(targetLeg, DIAL_EVENT_RINGING);
      return;
    }
    if (state === DIAL_EVENT_PROGRESS) {
      await this.applyBridgeSignalingToPeer(targetLeg, DIAL_EVENT_PROGRESS);
      return;
    }
    if (state === DIAL_EVENT_ANSWERED) {
      await this.applyBridgeSignalingToPeer(targetLeg, DIAL_EVENT_ANSWERED);
    }
  }

  private async relayBridgeSignaling(
    sourceLegId: string,
    eventType: typeof DIAL_EVENT_RINGING | typeof DIAL_EVENT_PROGRESS | typeof DIAL_EVENT_ANSWERED | typeof DIAL_EVENT_REJECTED,
    reason?: string,
  ): Promise<void> {
    const sourceLeg = this.legService.getLeg(sourceLegId);
    if (!sourceLeg?.bridgePeerLegId) {
      return;
    }
    const targetLeg = this.legService.getLeg(sourceLeg.bridgePeerLegId);
    if (!targetLeg) {
      return;
    }
    await this.applyBridgeSignalingToPeer(targetLeg, eventType, reason);
  }

  private async applyBridgeSignalingToPeer(
    targetLeg: Leg | null,
    eventType: typeof DIAL_EVENT_RINGING | typeof DIAL_EVENT_PROGRESS | typeof DIAL_EVENT_ANSWERED | typeof DIAL_EVENT_REJECTED,
    reason?: string,
  ): Promise<void> {
    if (!targetLeg || targetLeg.transportType !== "sip" || targetLeg.direction !== "inbound" || targetLeg.status === LEG_STATUS_ENDED) {
      return;
    }
    if (eventType === DIAL_EVENT_RINGING) {
      if (targetLeg.status !== LEG_STATUS_ANSWERED) {
        this.applyLegSignal(targetLeg.legId, DIAL_EVENT_RINGING);
      }
      return;
    }
    if (eventType === DIAL_EVENT_PROGRESS) {
      if (targetLeg.status !== LEG_STATUS_ANSWERED) {
        this.applyLegSignal(targetLeg.legId, DIAL_EVENT_PROGRESS);
      }
      return;
    }
    if (eventType === DIAL_EVENT_ANSWERED) {
      if (targetLeg.status !== LEG_STATUS_ANSWERED) {
        await this.applyAnsweredLegSignal(targetLeg.legId);
      }
      return;
    }
    if (eventType === DIAL_EVENT_REJECTED && targetLeg.status !== LEG_STATUS_ANSWERED) {
      this.applyLegSignal(targetLeg.legId, DIAL_EVENT_REJECTED, reason || "bridge_peer_rejected");
    }
  }
}

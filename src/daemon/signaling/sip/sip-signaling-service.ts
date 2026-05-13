import { BaseTransportSignalingService, type BaseSignalingDependencies } from "../base-signaling-service";
import { daemonError } from "../../core/daemon-error";
import type { DialTarget } from "../../dials/types";
import type { SignalingDialView } from "../types";
import { SipTransportService } from "./sip-transport-service";

export class SipSignalingService extends BaseTransportSignalingService {
  private readonly sipTransportService: SipTransportService | null;

  constructor(input: BaseSignalingDependencies & { sipTransportService?: SipTransportService | null }) {
    super(input);
    this.sipTransportService = input.sipTransportService || null;
  }

  supportsDialMode(mode: string): boolean {
    return String(mode || "") !== "websocket";
  }

  supportsTransportType(transportType: "sip" | "websocket"): boolean {
    return transportType === "sip";
  }

  async activateTrigger(kind: "trunk" | "extensions", config: Record<string, unknown>): Promise<void> {
    if (!this.sipTransportService) {
      return;
    }
    if (kind === "trunk") {
      await this.sipTransportService.activateTrunkTrigger(config);
      return;
    }
    await this.sipTransportService.activateExtensionsTrigger(config);
  }

  async deactivateTrigger(kind: "trunk" | "extensions", ref: string): Promise<void> {
    if (!this.sipTransportService) {
      return;
    }
    if (kind === "trunk") {
      await this.sipTransportService.deactivateTrunkTrigger(ref);
      return;
    }
    await this.sipTransportService.deactivateExtensionsTrigger(ref);
  }

  handleAttemptStarted(dial: SignalingDialView, legId: string, target: DialTarget): void {
    if (!this.sipTransportService) {
      return;
    }
    void this.sipTransportService.startAttempt(dial, legId, target).catch((error) => {
      console.error(
        `[sip-pbx:signaling] SIP attempt startup failed; dial=${dial.dialId}; leg=${legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
      this.markAttemptFailed(dial.dialId, legId, "transport_error");
    });
  }

  ringLeg(legId: string): { legId: string } {
    if (this.sipTransportService) {
      this.sipTransportService.ringInboundLeg(legId);
    }
    return super.ringLeg(legId);
  }

  progressLeg(legId: string): { legId: string } {
    if (this.sipTransportService) {
      this.sipTransportService.progressInboundLeg(legId);
    }
    return super.progressLeg(legId);
  }

  async answerLeg(legId: string): Promise<{ legId: string }> {
    if (this.sipTransportService) {
      const handledInbound = await this.sipTransportService.answerInboundLeg(legId);
      if (handledInbound) {
        return await super.answerLeg(legId);
      }
    }
    const leg = this.legService.requireLeg(legId);
    if (leg.direction === "inbound" && leg.transportType === "sip") {
      throw daemonError("invalid_leg", `No inbound SIP session for leg ${legId}`);
    }
    return await super.answerLeg(legId);
  }

  rejectLeg(legId: string, reason: string): { legId: string } {
    if (this.sipTransportService) {
      void this.sipTransportService.rejectOrHangupLeg(legId, reason).catch((error) => {
        console.error(
          `[sip-pbx:signaling] SIP reject/hangup failed; leg=${legId}; reason=${reason}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
        );
      });
    }
    return super.rejectLeg(legId, reason);
  }

  async sendDtmf(legId: string, digits: string, method: string): Promise<boolean> {
    if (!this.sipTransportService) {
      return false;
    }
    return await this.sipTransportService.sendDtmf(legId, digits, method);
  }

  async handleLegEnded(legId: string, reason?: string): Promise<void> {
    if (this.sipTransportService) {
      await this.sipTransportService.rejectOrHangupLeg(legId, String(reason || "hangup"));
      await this.sipTransportService.handleLegEnded(legId);
    }
  }

  closeAll(): void {
    if (this.sipTransportService) {
      this.sipTransportService.closeAll();
    }
  }
}

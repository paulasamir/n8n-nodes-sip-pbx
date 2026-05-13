import { MapRegistry } from "../../shared/map-registry";
import { DIAL_EVENT_RINGING } from "../../shared/result-events";
import { DialService } from "../dials/dial-service";
import type { Dial, DialTarget } from "../dials/types";
import { LegService } from "../legs/leg-service";
import type { SignalingDialView, TransportSignalingService } from "./types";

export type BaseSignalingDependencies = {
  legService: LegService;
  dialRegistry: MapRegistry<string, Dial>;
  dialService: DialService;
};

export abstract class BaseTransportSignalingService implements TransportSignalingService {
  protected readonly legService: LegService;
  protected readonly dialRegistry: MapRegistry<string, Dial>;
  protected readonly dialService: DialService;

  constructor(input: BaseSignalingDependencies) {
    this.legService = input.legService;
    this.dialRegistry = input.dialRegistry;
    this.dialService = input.dialService;
  }

  abstract supportsDialMode(mode: string): boolean;
  abstract supportsTransportType(transportType: "sip" | "websocket"): boolean;

  async activateTrigger(_kind: "trunk" | "extensions", _config: Record<string, unknown>): Promise<void> {
    return;
  }

  async deactivateTrigger(_kind: "trunk" | "extensions", _ref: string): Promise<void> {
    return;
  }

  handleAttemptStarted(_dial: SignalingDialView, _legId: string, _target: DialTarget): void {
    return;
  }

  ringLeg(legId: string): { legId: string } {
    this.legService.updateStatus(legId, "ringing");
    const leg = this.legService.requireLeg(legId);
    this.legService.updateSignalingDetails(legId, {
      ...(leg.signalingDetails || {}),
      bridgeSignalingState: "ringing",
    });
    const dial = this.findDialByAttemptLegId(legId);
    if (dial) {
      this.dialRegistry.get(dial.dialId)?.publishEvent({
        eventType: DIAL_EVENT_RINGING,
        legId,
        createdAt: Date.now(),
      });
    }
    return { legId };
  }

  progressLeg(legId: string): { legId: string } {
    const leg = this.legService.requireLeg(legId);
    this.legService.updateSignalingDetails(legId, {
      ...(leg.signalingDetails || {}),
      bridgeSignalingState: "progress",
    });
    const dial = this.findDialByAttemptLegId(legId);
    if (dial) {
      this.dialService.markAttemptProgress(dial.dialId, legId);
    }
    return { legId };
  }

  async answerLeg(legId: string): Promise<{ legId: string }> {
    this.legService.updateStatus(legId, "answered");
    const leg = this.legService.requireLeg(legId);
    this.legService.updateSignalingDetails(legId, {
      ...(leg.signalingDetails || {}),
      bridgeSignalingState: "answered",
    });
    const dial = this.findDialByAttemptLegId(legId);
    if (dial) {
      this.dialService.markAttemptAnswered(dial.dialId, legId);
    }
    return { legId };
  }

  rejectLeg(legId: string, reason: string): { legId: string } {
    const leg = this.legService.getLeg(legId);
    if (leg) {
      this.legService.updateSignalingDetails(legId, {
        ...(leg.signalingDetails || {}),
        bridgeSignalingState: "rejected",
      });
    }
    const dial = this.findDialByAttemptLegId(legId);
    if (dial) {
      this.dialService.markAttemptRejected(dial.dialId, legId, reason);
      return { legId };
    }
    return this.legService.hangupLeg(legId, reason);
  }

  async handleLegEnded(_legId: string, _reason?: string): Promise<void> {
    return;
  }

  closeAll(): void {
    return;
  }

  async sendDtmf(_legId: string, _digits: string, _method: string): Promise<boolean> {
    return false;
  }

  protected findDialByAttemptLegId(legId: string): SignalingDialView | null {
    for (const dial of this.dialRegistry.values()) {
      if (dial.attemptLegIds.includes(legId)) {
        return dial;
      }
    }
    return null;
  }

  protected markAttemptFailed(dialId: string, legId: string, reason: string): void {
    const dial = this.dialService.getDial(dialId);
    if (!dial) {
      console.error(
        `[sip-pbx:signaling] markAttemptFailed skipped; dial=${dialId}; leg=${legId}; reason=${reason}; cause=dial_missing`,
      );
      return;
    }
    if (!dial.hasActiveAttempt(legId)) {
      console.error(
        `[sip-pbx:signaling] markAttemptFailed skipped; dial=${dialId}; leg=${legId}; reason=${reason}; cause=attempt_inactive`,
      );
      return;
    }
    this.dialService.markAttemptFailed(dialId, legId, reason);
  }
}

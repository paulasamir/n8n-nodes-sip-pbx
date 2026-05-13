import { BaseTransportSignalingService, type BaseSignalingDependencies } from "../base-signaling-service";
import { LEG_STATUS_ENDED } from "../../../shared/result-events";
import { LegCoordinator } from "../../legs/leg-coordinator";
import { createWebSocketTransportProfile } from "../../media/transports/websocket-transport";
import type { DialTarget } from "../../dials/types";
import type { SignalingDialView } from "../types";

type ActiveWebSocketAttempt = {
  dialId: string;
  legId: string;
};

function isDeferredWebSocketSession(details: Record<string, unknown>): boolean {
  return String(details.websocketStartMode || "").trim() === "deferred"
    && details.websocketSessionActivated !== true;
}

export class WebSocketSignalingService extends BaseTransportSignalingService {
  private readonly websocketAttempts = new Map<string, ActiveWebSocketAttempt>();
  private readonly legCoordinator: LegCoordinator;
  private readonly ensureMediaTransportEndpoint: (legId: string) => Promise<Record<string, unknown>>;

  constructor(input: BaseSignalingDependencies & {
    ensureMediaTransportEndpoint: (legId: string) => Promise<Record<string, unknown>>;
    legCoordinator?: LegCoordinator;
  }) {
    super(input);
    this.ensureMediaTransportEndpoint = input.ensureMediaTransportEndpoint;
    this.legCoordinator = input.legCoordinator || new LegCoordinator();
  }

  supportsDialMode(mode: string): boolean {
    return String(mode || "") === "websocket";
  }

  supportsTransportType(transportType: "sip" | "websocket"): boolean {
    return transportType === "websocket";
  }

  handleAttemptStarted(dial: SignalingDialView, legId: string, target: DialTarget): void {
    const websocketUrl = this.resolveWebSocketUrl(dial, target);
    console.error(
      `[sip-pbx:websocket] attempt start; dial=${dial.dialId}; leg=${legId}; profile=${String(dial.metadata.transportProfile || "none")}; url=${websocketUrl || "null"}`,
    );
    if (!websocketUrl) {
      this.dialService.markAttemptFailed(dial.dialId, legId, "websocket_url_missing");
      return;
    }
    const attempt: ActiveWebSocketAttempt = {
      dialId: dial.dialId,
      legId,
    };
    void (async () => {
      const started = await this.withLegLock(legId, async () => {
        const leg = this.legService.getLeg(legId);
        if (!leg || leg.status === LEG_STATUS_ENDED) {
          return false;
        }
        this.websocketAttempts.set(legId, attempt);
        this.legService.updateSignalingDetails(legId, {
          ...(this.legService.requireLeg(legId).signalingDetails || {}),
          websocketUrl,
          websocketHeadersJson: this.resolveWebSocketHeaders(dial),
        });
        return true;
      });
      if (!started) {
        // Leg was destroyed before the attempt could register. Surface a
        // failure so the dial can finalize and its remaining state is cleaned
        // up — otherwise the dial sits with this legId in activeAttemptLegIds
        // and the eventual free-TTL path throws inside handleDialDestroy.
        console.error(
          `[sip-pbx:websocket] attempt aborted before settle; dial=${dial.dialId}; leg=${legId}; reason=leg_unavailable`,
        );
        this.markAttemptFailed(dial.dialId, legId, "websocket_leg_ended");
        return;
      }
      try {
        await this.ensureMediaTransportEndpoint(legId);
        await this.withLegLock(legId, async () => {
          const active = this.websocketAttempts.get(legId) || null;
          if (active !== attempt) {
            return;
          }
          if (isDeferredWebSocketSession(this.legService.requireLeg(legId).signalingDetails || {})) {
            console.error(`[sip-pbx:websocket] attempt deferred; dial=${dial.dialId}; leg=${legId}`);
          }
          console.error(`[sip-pbx:websocket] attempt media ready; dial=${dial.dialId}; leg=${legId}`);
          await this.answerLeg(legId);
          this.websocketAttempts.delete(legId);
          console.error(`[sip-pbx:websocket] attempt answered; dial=${dial.dialId}; leg=${legId}`);
        });
      } catch (error) {
        await this.withLegLock(legId, async () => {
          const current = this.websocketAttempts.get(legId) || null;
          if (current !== attempt) {
            return;
          }
          this.websocketAttempts.delete(legId);
          const failureReason = error instanceof Error && error.message === "invalid_leg"
            ? "websocket_leg_ended"
            : "websocket_error";
          console.error(
            `[sip-pbx:websocket] attempt media failed; dial=${dial.dialId}; leg=${legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
          );
          this.markAttemptFailed(dial.dialId, legId, failureReason);
        });
      }
    })().catch((error) => {
      console.error(
        `[sip-pbx:websocket] attempt lifecycle failed; dial=${dial.dialId}; leg=${legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
      this.markAttemptFailed(dial.dialId, legId, "websocket_error");
    });
  }

  rejectLeg(legId: string, reason: string): { legId: string } {
    return super.rejectLeg(legId, reason);
  }

  async handleLegEnded(legId: string, reason?: string): Promise<void> {
    await this.withLegLock(legId, async () => {
      const attempt = this.websocketAttempts.get(legId) || null;
      this.websocketAttempts.delete(legId);
      if (!attempt) {
        return;
      }
      console.error(`[sip-pbx:websocket] attempt leg ended before settle; dial=${attempt.dialId}; leg=${legId}; reason=${String(reason || "websocket_leg_ended")}`);
      this.markAttemptFailed(attempt.dialId, legId, String(reason || "websocket_leg_ended"));
    });
  }

  closeAll(): void {
    this.websocketAttempts.clear();
  }

  async sendDtmf(_legId: string, _digits: string, _method: string): Promise<boolean> {
    return false;
  }

  private resolveWebSocketUrl(dial: SignalingDialView, target: DialTarget): string {
    const explicitUrl = String(dial.metadata.websocketUrl || "").trim();
    if (explicitUrl) {
      return explicitUrl;
    }
    const targetUrl = target.kind === "opaque" ? String(target.value || "").trim() : "";
    if (/^wss?:\/\//i.test(targetUrl)) {
      return targetUrl;
    }
    const profile = createWebSocketTransportProfile({ ...(dial.metadata || {}) });
    return profile.resolveWebSocketUrl(dial.metadata || {});
  }

  private resolveWebSocketHeaders(dial: SignalingDialView): Record<string, string> {
    const profile = createWebSocketTransportProfile({ ...(dial.metadata || {}) });
    const headers: Record<string, string> = profile.resolveWebSocketHeaders(dial.metadata || {});
    const rawHeaders = dial.metadata.websocketHeadersJson;
    if (rawHeaders && typeof rawHeaders === "object") {
      for (const [name, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
        if (!name) {
          continue;
        }
        headers[name] = String(value ?? "");
      }
    }
    return headers;
  }

  private async withLegLock<T>(legId: string, callback: () => Promise<T> | T): Promise<T> {
    return await this.legCoordinator.withLeg(legId, callback);
  }
}

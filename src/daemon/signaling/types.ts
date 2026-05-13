import type { DialTarget } from "../dials/types";

export type InboundSipInvite = {
  ref: string;
  publicRef?: string;
  from: string;
  to: string;
  callId?: string;
  callerName?: string;
  callerNumber?: string;
  extensionNumber?: string;
  endpointId?: string;
  headers?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  transportType?: "sip" | "websocket";
};

export type SignalingTransportType = "sip" | "websocket";

export type SignalingDialView = {
  dialId: string;
  mode?: string;
  metadata: Record<string, unknown>;
  attemptLegIds: string[];
};

export interface TransportSignalingService {
  supportsDialMode(mode: string): boolean;
  supportsTransportType(transportType: SignalingTransportType): boolean;
  activateTrigger(kind: "trunk" | "extensions", config: Record<string, unknown>): Promise<void>;
  deactivateTrigger(kind: "trunk" | "extensions", ref: string): Promise<void>;
  handleAttemptStarted(dial: SignalingDialView, legId: string, target: DialTarget): void;
  ringLeg(legId: string): { legId: string };
  progressLeg(legId: string): { legId: string };
  answerLeg(legId: string): Promise<{ legId: string }>;
  rejectLeg(legId: string, reason: string): { legId: string };
  handleLegEnded(legId: string, reason?: string): Promise<void>;
  sendDtmf(legId: string, digits: string, method: string): Promise<boolean>;
  closeAll(): void;
}

import type {
  WorkerControlPlane,
  WorkerTransportInputMessage,
} from "../worker/media-worker";
import type { BufferReleasePool } from "../streams/media-stream";

const WORKER_MESSAGE_KIND_TRANSPORT_INPUT = 4;
const WORKER_TRANSPORT_INPUT_OPCODE_RTP_PACKET = 1;
const WORKER_TRANSPORT_INPUT_OPCODE_WEBSOCKET_PAYLOAD = 2;
const WORKER_TRANSPORT_INPUT_OPCODE_TRANSPORT_CLOSED = 3;

export type MediaTransportType = "sip" | "websocket";

export type MediaTransportDetails = Record<string, unknown>;

export type MediaTransportInputEvent =
  | {
      type: "audio";
      pcm: Buffer;
      bytes?: number;
      sampleRate: number;
      channels: number;
      durationMs?: number;
      level?: number;
      payloadType?: number;
      eventType?: string;
      releasePool?: BufferReleasePool | null;
    }
  | {
      type: "dtmf";
      digits: string;
      createdAt?: number;
      payloadType?: number;
    }
  | {
      type: "interrupt";
      reason: string;
      eventType?: string;
    }
  | {
      type: "transport";
      state: "closed";
      reason: string;
    };

export interface MediaTransport {
  readonly transportType: MediaTransportType;
  configure(config: Record<string, unknown>): Promise<MediaTransportDetails>;
  getDetails(): MediaTransportDetails;
  subscribe(listener: (event: MediaTransportInputEvent) => void): () => void;
  sendPlaybackPcm(pcm: Buffer, marker?: boolean, bytes?: number): Promise<boolean>;
  sendDtmf(digits: string, method: string): Promise<boolean>;
  close(): void;
}

export type MediaTransportFactoryInput = {
  sendPacket?: (packet: Buffer, bytes?: number) => Promise<boolean> | boolean;
  sendJson?: (payload: Record<string, unknown>) => Promise<boolean> | boolean | void;
  close?: () => void;
  config?: Record<string, unknown>;
};

export abstract class TransportAttachment {
  readonly legId: string;
  readonly transportType: MediaTransportType;
  private boundControl: WorkerControlPlane | null = null;
  private suspended = false;
  private readonly pendingInputs: WorkerTransportInputMessage[] = [];

  protected constructor(legId: string, transportType: MediaTransportType) {
    this.legId = legId;
    this.transportType = transportType;
  }

  rebind(control: WorkerControlPlane | null): void {
    this.boundControl = control;
  }

  suspend(): void {
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
    const pending = this.pendingInputs.splice(0);
    for (const message of pending) {
      this.deliverToWorker(message);
    }
  }

  protected queueTransportInput(message: WorkerTransportInputMessage): void {
    if (this.suspended || !this.boundControl) {
      if (this.pendingInputs.length >= 16) {
        this.pendingInputs.shift();
      }
      this.pendingInputs.push(message);
      return;
    }
    this.deliverToWorker(message);
  }

  protected deliverTransportClosed(reason: string): void {
    this.queueTransportInput({
      kind: WORKER_MESSAGE_KIND_TRANSPORT_INPUT,
      opcode: WORKER_TRANSPORT_INPUT_OPCODE_TRANSPORT_CLOSED,
      payload: {
        legId: this.legId,
        reason,
      },
    });
  }

  private deliverToWorker(message: WorkerTransportInputMessage): void {
    const control = this.boundControl;
    if (!control) {
      return;
    }
    if (message.opcode === WORKER_TRANSPORT_INPUT_OPCODE_RTP_PACKET) {
      control.deliverRtpPacket(message.payload.legId, message.payload.packet);
      return;
    }
    if (message.opcode === WORKER_TRANSPORT_INPUT_OPCODE_WEBSOCKET_PAYLOAD) {
      control.deliverWebSocketPayload(message.payload.legId, message.payload.payload);
      return;
    }
    control.notifyTransportClosed(message.payload.legId, message.payload.reason);
  }

  async sendControlJson(_payload: Record<string, unknown>): Promise<boolean> {
    return false;
  }

  abstract configure(config: Record<string, unknown>): Promise<Record<string, unknown>>;
  abstract handleWorkerOutput(
    message: import("../worker/media-worker").WorkerTransportOutputMessage,
  ): Promise<boolean>;
  abstract close(): Promise<void>;
}

export function createTransport(
  transportType: MediaTransportType,
  input?: MediaTransportFactoryInput,
): MediaTransport {
  if (transportType === "websocket") {
    const { WebSocketTransport } = require("./websocket-transport") as typeof import("./websocket-transport");
    return new WebSocketTransport({
      sendJson: input?.sendJson,
      close: input?.close,
      config: input?.config,
    });
  }
  const { RtpTransport } = require("./rtp-transport") as typeof import("./rtp-transport");
  return new RtpTransport({
    sendPacket: input?.sendPacket,
    config: input?.config,
  });
}

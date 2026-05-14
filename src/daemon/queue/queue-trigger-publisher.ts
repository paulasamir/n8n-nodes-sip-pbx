import type { QueueTriggerBranch } from "../../shared/branches";

export type QueueTriggerPublisher = (ref: string, branch: QueueTriggerBranch, payload: Record<string, unknown>) => void;

export type QueueDispatchPayload = {
  mode: "live" | "callback";
  legId?: string;
  dialId: string;
  callerNumber: string;
  callerName: string;
  trunkRef: string;
};

export type QueueSharedPayload = {
  mode?: "live" | "callback";
  legId?: string;
  callerNumber: string;
  callerName: string;
  trunkRef: string;
};

export class QueueTriggerPublisherService {
  private readonly publish: QueueTriggerPublisher;

  constructor(publish: QueueTriggerPublisher) {
    this.publish = publish;
  }

  publishPlaced(ref: string, publicRef: string, input: QueueSharedPayload & { legId: string }): void {
    this.publish(ref, "Placed", {
      ref: publicRef,
      legId: input.legId,
      callerNumber: input.callerNumber,
      callerName: input.callerName,
      trunkRef: input.trunkRef,
    });
  }

  publishDispatch(ref: string, publicRef: string, input: QueueDispatchPayload): void {
    this.publish(ref, "Dispatch", {
      ref: publicRef,
      mode: input.mode,
      ...(input.legId ? { legId: input.legId } : {}),
      dialId: input.dialId,
      callerNumber: input.callerNumber,
      callerName: input.callerName,
      trunkRef: input.trunkRef,
    });
  }

  publishOffline(ref: string, publicRef: string, input: QueueSharedPayload): void {
    this.publish(ref, "Offline", {
      ref: publicRef,
      mode: input.mode,
      ...(input.legId ? { legId: input.legId } : {}),
      callerNumber: input.callerNumber,
      callerName: input.callerName,
      trunkRef: input.trunkRef,
    });
  }
}

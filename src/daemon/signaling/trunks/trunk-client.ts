import { LegService } from "../../legs/leg-service";
import { InboundCallService } from "../calls/inbound-call-service";
import type { InboundSipInvite } from "../types";

type TrunkTriggerPublisher = (ref: string, branch: string, payload: Record<string, unknown>) => void;

export class TrunkClient {
  private readonly legService: LegService;
  private readonly inboundCallService: InboundCallService;
  private readonly publish: TrunkTriggerPublisher;

  constructor(input: {
    legService: LegService;
    inboundCallService: InboundCallService;
    publish: TrunkTriggerPublisher;
  }) {
    this.legService = input.legService;
    this.inboundCallService = input.inboundCallService;
    this.publish = input.publish;
  }

  emitInboundInvite(input: InboundSipInvite): { legId: string; ref: string } {
    return this.inboundCallService.emitForTrunk(input, this.publish);
  }
}

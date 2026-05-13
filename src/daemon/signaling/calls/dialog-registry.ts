import { MapRegistry } from "../../../shared/map-registry";

export type DialogRecord = {
  legId: string;
  callId: string;
  direction: "inbound" | "outbound";
};

export class DialogRegistry extends MapRegistry<string, DialogRecord> {
  private readonly byCallId = new Map<string, DialogRecord>();

  upsert(record: DialogRecord): void {
    this.store(record.legId, record);
    this.byCallId.set(record.callId, record);
  }

  getByLegId(legId: string): DialogRecord | null {
    return this.get(legId);
  }

  getByCallId(callId: string): DialogRecord | null {
    return this.byCallId.get(callId) || null;
  }

  removeByLegId(legId: string): void {
    const record = this.get(legId);
    if (!record) {
      return;
    }
    this.remove(legId);
    this.byCallId.delete(record.callId);
  }
}

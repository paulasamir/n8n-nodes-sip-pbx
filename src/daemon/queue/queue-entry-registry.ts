import { MapRegistry } from "../../shared/map-registry";
import { QueueEntry } from "./types";

export class QueueEntryRegistry extends MapRegistry<string, QueueEntry> {
  private readonly activeEntryIdByLeg = new Map<string, string>();

  create(entry: QueueEntry, placement: "front" | "back"): QueueEntry {
    if (placement === "front") {
      this.storeFront(entry.queueEntryId, entry);
    } else {
      this.store(entry.queueEntryId, entry);
    }
    this.activeEntryIdByLeg.set(entry.legId, entry.queueEntryId);
    return entry;
  }

  getByLegId(legId: string): QueueEntry | null {
    const queueEntryId = this.activeEntryIdByLeg.get(legId);
    if (!queueEntryId) return null;
    return this.get(queueEntryId);
  }

  getByDialId(dialId: string): QueueEntry | null {
    if (!dialId) {
      return null;
    }
    for (const entry of this.values()) {
      if (entry.dispatchedDialId === dialId) {
        return entry;
      }
    }
    return null;
  }

  listByRef(ref: string): QueueEntry[] {
    return this.values().filter((entry) => entry.ref === ref);
  }

  replaceLegBinding(entry: QueueEntry, newLegId: string): void {
    for (const [knownLegId, mappedEntryId] of this.activeEntryIdByLeg) {
      if (mappedEntryId === entry.queueEntryId && knownLegId !== newLegId) {
        this.activeEntryIdByLeg.delete(knownLegId);
      }
    }
    this.activeEntryIdByLeg.set(newLegId, entry.queueEntryId);
  }

  removeEntry(queueEntryId: string): QueueEntry | null {
    const entry = this.remove(queueEntryId);
    if (!entry) return null;
    const mapped = this.activeEntryIdByLeg.get(entry.legId);
    if (mapped === queueEntryId) {
      this.activeEntryIdByLeg.delete(entry.legId);
    }
    return entry;
  }
}

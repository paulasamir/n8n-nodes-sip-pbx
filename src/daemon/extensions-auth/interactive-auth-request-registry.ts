import { MapRegistry } from "../../shared/map-registry";
import type { InteractiveAuthRequest } from "./types";

export class InteractiveAuthRequestRegistry extends MapRegistry<string, InteractiveAuthRequest> {
  storeRequest(request: InteractiveAuthRequest): void {
    this.store(request.authRequestId, request);
  }

  getRequest(authRequestId: string): InteractiveAuthRequest | null {
    return this.get(authRequestId);
  }

  removeRequest(authRequestId: string): InteractiveAuthRequest | null {
    return this.remove(authRequestId);
  }

  sweepExpired(now: number): InteractiveAuthRequest[] {
    return this.sweep((request) => request.expiresAt <= now);
  }
}

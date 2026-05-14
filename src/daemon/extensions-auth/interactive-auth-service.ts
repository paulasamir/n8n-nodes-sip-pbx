import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { newAuthRequestId } from "../core/ids";
import { deadlineFromTimeout, nowMs } from "../core/time";
import { daemonError } from "../core/daemon-error";
import { InteractiveAuthRequestRegistry } from "./interactive-auth-request-registry";
import { InteractiveAuthTriggerPublisher } from "./interactive-auth-trigger-publisher";
import type { InteractiveAuthRequest, InteractiveAuthResponse } from "./types";

type PendingResolution = {
  promise: Promise<InteractiveAuthResponse>;
  resolve: (response: InteractiveAuthResponse) => void;
};

export class InteractiveAuthService {
  private readonly registry: InteractiveAuthRequestRegistry;
  private readonly publisher: InteractiveAuthTriggerPublisher;
  private readonly resolveDefaultTimeoutMs: (ref: string) => number | null;
  private readonly onResolved: (request: InteractiveAuthRequest, response: InteractiveAuthResponse) => void;
  private readonly timeoutHandles = new Map<string, NodeJS.Timeout>();
  private readonly pendingResolutions = new Map<string, PendingResolution>();

  constructor(
    registry: InteractiveAuthRequestRegistry,
    publisher: InteractiveAuthTriggerPublisher,
    resolveDefaultTimeoutMs?: (ref: string) => number | null,
    onResolved?: (request: InteractiveAuthRequest, response: InteractiveAuthResponse) => void,
  ) {
    this.registry = registry;
    this.publisher = publisher;
    this.resolveDefaultTimeoutMs = resolveDefaultTimeoutMs || (() => null);
    this.onResolved = onResolved || (() => undefined);
  }

  createRequest(input: Omit<InteractiveAuthRequest, "authRequestId" | "expiresAt" | "timeout"> & { timeout?: number }): InteractiveAuthRequest {
    const timeout = input.timeout || this.resolveDefaultTimeoutMs(input.ref) || Math.round(OPTION_DEFAULTS.trigger.extensions.authTimeoutSeconds * 1000);
    const request: InteractiveAuthRequest = {
      authRequestId: newAuthRequestId(),
      triggerKey: input.triggerKey,
      triggerKind: input.triggerKind,
      ref: input.ref,
      publicRef: input.publicRef,
      timeout,
      requestContext: input.requestContext,
      expiresAt: deadlineFromTimeout(timeout),
    };
    let resolvePending: (response: InteractiveAuthResponse) => void = () => undefined;
    const pending: PendingResolution = {
      promise: new Promise<InteractiveAuthResponse>((resolve) => {
        resolvePending = resolve;
      }),
      resolve: (response) => {
        resolvePending(response);
      },
    };
    this.registry.storeRequest(request);
    this.pendingResolutions.set(request.authRequestId, pending);
    const timeoutHandle = setTimeout(() => {
      const expired = this.registry.removeRequest(request.authRequestId);
      if (!expired) {
        return;
      }
      this.timeoutHandles.delete(request.authRequestId);
      const response: InteractiveAuthResponse = { action: "not_applicable" };
      this.resolvePending(expired.authRequestId, response);
      this.onResolved(expired, response);
    }, Math.max(0, timeout));
    this.timeoutHandles.set(request.authRequestId, timeoutHandle);
    this.publisher.publishRequest(request);
    return request;
  }

  waitForResolution(authRequestId: string): Promise<InteractiveAuthResponse> {
    const pending = this.pendingResolutions.get(authRequestId);
    if (!pending) {
      throw daemonError("invalid_auth_request", `Unknown auth request ${authRequestId}`);
    }
    return pending.promise;
  }

  resolveRequest(authRequestId: string, response: InteractiveAuthResponse): { authRequestId: string } {
    const request = this.registry.removeRequest(authRequestId);
    if (!request) {
      throw daemonError("invalid_auth_request", `Unknown auth request ${authRequestId}`);
    }
    this.clearTimeoutHandle(authRequestId);
    this.resolvePending(authRequestId, response);
    this.onResolved(request, response);
    return { authRequestId: request.authRequestId };
  }

  sweepExpired(): InteractiveAuthRequest[] {
    const expired = this.registry.sweepExpired(nowMs());
    for (const request of expired) {
      this.clearTimeoutHandle(request.authRequestId);
      const response: InteractiveAuthResponse = { action: "not_applicable" };
      this.resolvePending(request.authRequestId, response);
      this.onResolved(request, response);
    }
    return expired;
  }

  private clearTimeoutHandle(authRequestId: string): void {
    const handle = this.timeoutHandles.get(authRequestId);
    if (!handle) {
      return;
    }
    clearTimeout(handle);
    this.timeoutHandles.delete(authRequestId);
  }

  private resolvePending(authRequestId: string, response: InteractiveAuthResponse): void {
    const pending = this.pendingResolutions.get(authRequestId);
    if (!pending) {
      return;
    }
    this.pendingResolutions.delete(authRequestId);
    pending.resolve(response);
  }
}

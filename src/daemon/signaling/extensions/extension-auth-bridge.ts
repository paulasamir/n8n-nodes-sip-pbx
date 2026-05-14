import { daemonError } from "../../core/daemon-error";
import { InteractiveAuthService } from "../../extensions-auth/interactive-auth-service";

export class TriggerAuthBridge {
  private readonly authService: InteractiveAuthService;
  private readonly triggerKind: "extensions" | "trunk";
  private readonly resolveActiveTriggerKey: (ref: string) => string | null;
  private readonly resolveDefaultTimeoutMs: (ref: string) => number | null;

  constructor(input: {
    authService: InteractiveAuthService;
    triggerKind: "extensions" | "trunk";
    resolveActiveTriggerKey?: (ref: string) => string | null;
    resolveDefaultTimeoutMs?: (ref: string) => number | null;
  }) {
    this.authService = input.authService;
    this.triggerKind = input.triggerKind;
    this.resolveActiveTriggerKey = input.resolveActiveTriggerKey || (() => null);
    this.resolveDefaultTimeoutMs = input.resolveDefaultTimeoutMs || (() => null);
  }

  createRequest(input: {
    ref: string;
    publicRef?: string;
    requestContext: {
      requestType: string;
      method: string;
      username?: string;
      externalUsername?: string;
      endpointExtension?: string;
      realm?: string;
      hasAuthorization?: boolean;
      authorization?: Record<string, unknown>;
      sourceIp?: string;
      raw?: Record<string, unknown>;
    };
    timeout?: number;
  }) {
    const triggerKey = this.resolveActiveTriggerKey(input.ref);
    if (!triggerKey) {
      throw daemonError("invalid_trigger", `No active ${this.triggerKind} trigger for ref ${input.ref}`);
    }
    const timeout = input.timeout ?? this.resolveDefaultTimeoutMs(input.ref) ?? undefined;
    return this.authService.createRequest({
      triggerKey,
      triggerKind: this.triggerKind,
      ref: input.ref,
      publicRef: input.publicRef,
      requestContext: input.requestContext,
      timeout,
    });
  }
}

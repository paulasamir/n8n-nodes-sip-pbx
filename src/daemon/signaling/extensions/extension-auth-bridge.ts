import { daemonError } from "../../core/daemon-error";
import { InteractiveAuthService } from "../../extensions-auth/interactive-auth-service";

export class ExtensionAuthBridge {
  private readonly authService: InteractiveAuthService;
  private readonly resolveActiveTriggerKey: (ref: string) => string | null;

  constructor(input: {
    authService: InteractiveAuthService;
    resolveActiveTriggerKey?: (ref: string) => string | null;
  }) {
    this.authService = input.authService;
    this.resolveActiveTriggerKey = input.resolveActiveTriggerKey || (() => null);
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
      throw daemonError("invalid_trigger", `No active extensions trigger for ref ${input.ref}`);
    }
    return this.authService.createRequest({
      triggerKey,
      ref: input.ref,
      publicRef: input.publicRef,
      requestContext: input.requestContext,
      timeout: input.timeout,
    });
  }
}

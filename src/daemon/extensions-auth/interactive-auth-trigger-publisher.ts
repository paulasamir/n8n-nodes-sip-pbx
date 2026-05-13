import { ExtensionsTriggerBranchAuth } from "../../shared/branches";
import type { InteractiveAuthRequest } from "./types";

export type AuthTriggerPublisher = (ref: string, branch: typeof ExtensionsTriggerBranchAuth, payload: Record<string, unknown>) => void;

function buildPublicAuthorization(value: unknown): Record<string, unknown> {
  const authorization = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const params = authorization.params && typeof authorization.params === "object"
    ? authorization.params as Record<string, unknown>
    : {};
  const result: Record<string, unknown> = {};
  for (const [name, rawValue] of Object.entries(params)) {
    const key = String(name || "").trim();
    if (!key) {
      continue;
    }
    result[key] = String(rawValue ?? "");
  }
  return result;
}

export class InteractiveAuthTriggerPublisher {
  private readonly publish: AuthTriggerPublisher;

  constructor(publish: AuthTriggerPublisher) {
    this.publish = publish;
  }

  publishRequest(request: InteractiveAuthRequest): void {
    this.publish(request.ref, ExtensionsTriggerBranchAuth, {
      authRequestId: request.authRequestId,
      ref: String(request.publicRef || request.ref || ""),
      requestType: request.requestContext.requestType,
      auth: buildPublicAuthorization(request.requestContext.authorization),
      remoteIp: request.requestContext.sourceIp,
      remotePort: request.requestContext.clientPort,
      transport: request.requestContext.transport,
      localIp: request.requestContext.localIp,
      localPort: request.requestContext.localPort,
      raw: request.requestContext.raw,
    });
  }
}

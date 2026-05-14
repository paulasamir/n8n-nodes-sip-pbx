export type InteractiveAuthRequest = {
  authRequestId: string;
  triggerKey: string;
  triggerKind: "extensions" | "trunk";
  ref: string;
  publicRef?: string;
  timeout: number;
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
    clientPort?: number;
    transport?: string;
    localIp?: string;
    localPort?: number;
    raw?: Record<string, unknown>;
  };
  expiresAt: number;
};

export type InteractiveAuthAction = "verify_password" | "allow" | "not_applicable" | "challenge" | "deny";

export type InteractiveAuthResponse = {
  action: InteractiveAuthAction;
  password?: string;
  extension?: string;
  statusCode?: number;
  reason?: string;
};

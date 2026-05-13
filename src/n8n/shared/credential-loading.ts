import * as http from "http";
import * as https from "https";
import { PassThrough } from "stream";
import type { HeaderEntry, NodeParameterReader } from "./input-normalization";

export async function readCredentialsParameter(
  node: NodeParameterReader,
  name: string,
  index: number,
): Promise<Record<string, unknown> | null> {
  if (typeof node?.getCredentials !== "function") {
    throw new Error(`Credential reader is not available for ${name}`);
  }
  const raw = await node.getCredentials(name, index);
  if (!raw || typeof raw !== "object") {
    throw new Error(`Credential ${name} is required`);
  }
  return { ...(raw as Record<string, unknown>) };
}

type HttpAuthRequestOptions = {
  method: string;
  url: string;
  headers: HeaderEntry[];
};

type CapturedHttpRequest = {
  method: string;
  url: string;
  headers: HeaderEntry[];
};

type DynamicRequestArgs = unknown[];

type InterceptedRequestCallback = (response: MockIncomingMessage) => void;

type HttpRequestWithAuthenticationHelper = (
  this: NodeParameterReader & { helpers?: Record<string, unknown> },
  credentialType: string,
  request: {
    method: string;
    url: string;
    headers: Record<string, string | string[]>;
    returnFullResponse: true;
  },
) => Promise<unknown>;

type MockIncomingMessage = PassThrough & {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, unknown>;
};

type MockClientRequest = PassThrough & {
  setHeader: (name: string, value: string | string[]) => MockClientRequest;
  getHeader: (name: string) => string | string[] | undefined;
  removeHeader: (name: string) => MockClientRequest;
  abort: () => MockClientRequest;
  destroy: () => MockClientRequest;
  flushHeaders: () => MockClientRequest;
  end: (...endArgs: unknown[]) => MockClientRequest;
};

function toHeaderRecord(headers: HeaderEntry[]): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const entry of headers) {
    const name = String(entry?.name || "").trim();
    if (!name) {
      continue;
    }
    const existing = output[name];
    if (existing == null) {
      output[name] = entry.value;
      continue;
    }
    if (Array.isArray(existing)) {
      existing.push(entry.value);
      continue;
    }
    output[name] = [existing, entry.value];
  }
  return output;
}

function toHeaderEntries(headers: unknown): HeaderEntry[] {
  if (headers instanceof Headers) {
    const entries: HeaderEntry[] = [];
    headers.forEach((value, name) => {
      entries.push({ name, value });
    });
    return entries;
  }
  if (!headers || typeof headers !== "object") {
    return [];
  }
  const entries: HeaderEntry[] = [];
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        entries.push({ name, value: String(item ?? "") });
      }
      continue;
    }
    if (value != null) {
      entries.push({ name, value: String(value) });
    }
  }
  return entries;
}

function normalizeCapturedUrl(raw: string | URL): string {
  return raw instanceof URL ? raw.toString() : String(raw || "").trim();
}

function normalizeOptionalCapturedUrl(raw: unknown): string {
  return raw instanceof URL ? raw.toString() : String(raw || "").trim();
}

function normalizeRequestUrl(input: unknown, options?: Record<string, unknown>): string {
  if (typeof input === "string" || input instanceof URL) {
    return normalizeCapturedUrl(input);
  }
  const requestOptions = (input && typeof input === "object") ? input as Record<string, unknown> : {};
  const protocol = String(requestOptions.protocol || options?.protocol || "http:").trim() || "http:";
  const hostname = String(requestOptions.hostname || requestOptions.host || options?.hostname || options?.host || "").trim();
  const port = String(requestOptions.port || options?.port || "").trim();
  const path = String(requestOptions.path || options?.path || "/").trim() || "/";
  const origin = hostname ? `${protocol}//${hostname}${port ? `:${port}` : ""}` : "";
  if (!origin) {
    return path;
  }
  return new URL(path, origin).toString();
}

function normalizeRequestMethod(input: unknown, options?: Record<string, unknown>): string {
  const requestOptions = (input && typeof input === "object") ? input as Record<string, unknown> : {};
  return String(requestOptions.method || options?.method || "GET").toUpperCase();
}

function matchesTargetRequest(candidateUrl: string, candidateMethod: string, targetUrl: URL, targetMethod: string): boolean {
  try {
    const parsed = new URL(candidateUrl);
    return parsed.protocol === targetUrl.protocol
      && parsed.hostname === targetUrl.hostname
      && String(parsed.port || "") === String(targetUrl.port || "")
      && parsed.pathname === targetUrl.pathname
      && candidateMethod.toUpperCase() === targetMethod.toUpperCase();
  } catch (_error) {
    return false;
  }
}

function createInterceptedRequestRecorder(
  targetUrl: URL,
  targetMethod: string,
  captured: CapturedHttpRequest[],
  original: typeof http.request,
) {
  return function interceptedRequest(...args: DynamicRequestArgs): unknown {
    const callback =
      typeof args[args.length - 1] === "function"
        ? args.pop() as InterceptedRequestCallback
        : null;
    const input = args[0];
    const requestOptions = (args[1] && typeof args[1] === "object") ? args[1] as Record<string, unknown> : undefined;
    const finalUrl = normalizeRequestUrl(input, requestOptions);
    const finalMethod = normalizeRequestMethod(input, requestOptions);
    if (!matchesTargetRequest(finalUrl, finalMethod, targetUrl, targetMethod)) {
      const forwardedArgs = callback ? [...args, callback] : args;
      return (original as unknown as (...input: DynamicRequestArgs) => unknown)(...forwardedArgs);
    }
    const storedHeaders: Record<string, string | string[]> = {
      ...toHeaderRecord(toHeaderEntries(requestOptions?.headers ?? ((input && typeof input === "object") ? (input as Record<string, unknown>).headers : undefined))),
    };
    captured.push({
      method: finalMethod,
      url: finalUrl,
      headers: toHeaderEntries(storedHeaders),
    });
    const request = new PassThrough() as MockClientRequest;
    request.setHeader = (name: string, value: string | string[]) => {
      storedHeaders[name] = value;
      captured[captured.length - 1] = {
        method: finalMethod,
        url: finalUrl,
        headers: toHeaderEntries(storedHeaders),
      };
      return request;
    };
    request.getHeader = (name: string) => storedHeaders[name];
    request.removeHeader = (name: string) => {
      delete storedHeaders[name];
      captured[captured.length - 1] = {
        method: finalMethod,
        url: finalUrl,
        headers: toHeaderEntries(storedHeaders),
      };
      return request;
    };
    request.abort = () => request;
    request.destroy = () => request;
    request.flushHeaders = () => request;
    request.end = (...endArgs: unknown[]) => {
      if (typeof PassThrough.prototype.end === "function") {
        PassThrough.prototype.end.apply(request, endArgs);
      }
      const response = new PassThrough() as MockIncomingMessage;
      response.statusCode = 204;
      response.statusMessage = "No Content";
      response.headers = {};
      process.nextTick(() => {
        if (callback) {
          callback(response);
        }
        request.emit("response", response);
        response.end();
      });
      return request;
    };
    return request;
  };
}

export async function normalizeHttpRequestAuthentication(
  node: NodeParameterReader & { helpers?: Record<string, unknown> },
  credentialType: string,
  request: HttpAuthRequestOptions,
): Promise<{ url: string; headers: HeaderEntry[] }> {
  const helper = node?.helpers && typeof (node.helpers as Record<string, unknown>).httpRequestWithAuthentication === "function"
    ? (node.helpers as Record<string, unknown>).httpRequestWithAuthentication as HttpRequestWithAuthenticationHelper
    : null;
  if (!helper) {
    throw new Error("httpRequestWithAuthentication helper is not available");
  }
  const targetUrl = new URL(request.url);
  const captured: CapturedHttpRequest[] = [];
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalFetch = globalThis.fetch;
  const interceptedHttpRequest = createInterceptedRequestRecorder(targetUrl, request.method, captured, originalHttpRequest);
  const interceptedHttpsRequest = createInterceptedRequestRecorder(targetUrl, request.method, captured, originalHttpsRequest as unknown as typeof http.request);
  const interceptedFetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const requestInput = input as { url?: unknown; method?: unknown; headers?: unknown };
    const finalUrl = typeof input === "string" || input instanceof URL
      ? normalizeCapturedUrl(input)
      : normalizeOptionalCapturedUrl(requestInput?.url);
    const finalMethod = String(init?.method || requestInput?.method || "GET").toUpperCase();
    if (!matchesTargetRequest(finalUrl, finalMethod, targetUrl, request.method)) {
      if (!originalFetch) {
        throw new Error("fetch is not available");
      }
      if (
        typeof input !== "string"
        && !(input instanceof URL)
        && !(typeof Request !== "undefined" && input instanceof Request)
      ) {
        throw new Error("Unsupported fetch input for authenticated request normalization");
      }
      return await originalFetch(input, init);
    }
    captured.push({
      method: finalMethod,
      url: finalUrl,
      headers: toHeaderEntries(init?.headers || requestInput?.headers || {}),
    });
    return new Response(null, { status: 204, statusText: "No Content" });
  };
  try {
    (http as typeof http & { request: typeof http.request }).request = interceptedHttpRequest as unknown as typeof http.request;
    (https as typeof https & { request: typeof https.request }).request = interceptedHttpsRequest as unknown as typeof https.request;
    if (originalFetch) {
      (globalThis as typeof globalThis & { fetch: typeof globalThis.fetch }).fetch = interceptedFetch as typeof globalThis.fetch;
    }
    await helper.call(node, credentialType, {
      method: request.method,
      url: request.url,
      headers: toHeaderRecord(request.headers),
      returnFullResponse: true,
    });
  } finally {
    (http as typeof http & { request: typeof originalHttpRequest }).request = originalHttpRequest;
    (https as typeof https & { request: typeof originalHttpsRequest }).request = originalHttpsRequest;
    if (originalFetch) {
      (globalThis as typeof globalThis & { fetch: typeof originalFetch }).fetch = originalFetch;
    }
  }
  const finalRequest = captured[captured.length - 1];
  if (!finalRequest) {
    throw new Error(`Could not resolve authenticated request for credential type ${credentialType}`);
  }
  return {
    url: finalRequest.url,
    headers: finalRequest.headers,
  };
}

import dgram from "dgram";
import { randomBytes } from "crypto";
import os from "os";
import type { AddressInfo } from "net";
import { OPTION_DEFAULTS } from "../../../shared/option-defaults";
import { LEG_STATUS_ENDED } from "../../../shared/result-events";
import { LegCoordinator } from "../../legs/leg-coordinator";
import { daemonError } from "../../core/daemon-error";
import { InteractiveAuthService } from "../../extensions-auth/interactive-auth-service";
import { TriggerAuthBridge } from "../extensions/extension-auth-bridge";
import type { DialTarget, ExtensionDialTarget } from "../../dials/types";
import { LegService } from "../../legs/leg-service";
import { ExtensionHost } from "../extensions/extension-host";
import { TrunkClient } from "../trunks/trunk-client";
import type { InboundSipInvite, SignalingDialView } from "../types";
import type { SipDigestAuthorization } from "./digest-auth";
import { buildLocalAudioSdpDescription } from "../../media/codecs/audio-codec";
import {
  buildSipDigestAuthorization,
  buildSipDigestChallenge,
  parseSipAuthorization,
  parseSipDigestChallenge,
  verifySipDigestAuthorization,
} from "./digest-auth";
import { SipDigestNonceRegistry } from "./digest-nonce-registry";
import { formatSipRequest, formatSipResponse, getSipHeader, parseContactHeader, parseCseq, parseSipMessage, type SipHeaderEntry, type SipMessage } from "./sip-message";
import { buildLocalSipSdp, parseSipSdp } from "./sip-sdp";
import { parseSipNameAddress, parseSipUri } from "./sip-uri";

type SipHostBase = {
  ref: string;
  publicRef: string;
  socket: dgram.Socket;
  bindIp: string;
  bindPort: number;
  advertisedIp: string;
  realm: string;
};

type ExtensionsHost = SipHostBase & {
  authMode: string;
  authorizationUsernamePrefix: string;
  continueTraversalOnAuthReject: boolean;
  staticCredentials: Array<{ username: string; password: string; extension: string }>;
};

type TrunkHost = SipHostBase & {
  routeToken: string;
  credentials: Record<string, unknown>;
  registerMode: boolean;
  authTimeoutMs: number;
  continueTraversalOnAuthReject: boolean;
  registrationExpires: number;
  registerHeaders: SipHeaderEntry[];
  registrationTimer: ReturnType<typeof setTimeout> | null;
  registration: {
    requestUri: string;
    remoteAddress: string;
    remotePort: number;
    callId: string;
    cseq: number;
    from: string;
    to: string;
    contactUri: string;
    localHost: string;
    lastChallenge: SipDigestAuthorization | null;
    authorizationHeaderName: "authorization" | "proxy-authorization" | null;
    lastNonce: string | null;
    nonceCount: number;
    authAttempts: number;
  } | null;
};

type SipUdpListener = {
  socket: dgram.Socket;
  bindIp: string;
  bindPort: number;
};

type SipAuthOutcome = {
  allow: boolean;
  extension?: string;
  statusCode?: number;
  reasonPhrase?: string;
  stale?: boolean;
  notApplicable?: boolean;
  challenge?: boolean;
};

type SipAuthRequestKind = "register" | "invite";

type InboundSipSession = {
  legId: string;
  socket: dgram.Socket;
  remoteAddress: string;
  remotePort: number;
  transactionKey: string;
  callId: string;
  cseq: number;
  requestUri: string;
  from: string;
  to: string;
  via: string;
  localTag: string;
  answered: boolean;
  contactUri: string;
  inviteSuccessResponse: string | null;
  inviteSuccessRetransmitTimer: ReturnType<typeof setTimeout> | null;
  inviteSuccessIntervalMs: number;
};

type OutboundSipSession = {
  legId: string;
  dialId: string;
  socket: dgram.Socket;
  ownsSocket: boolean;
  remoteAddress: string;
  remotePort: number;
  requestUri: string;
  callId: string;
  cseq: number;
  from: string;
  to: string;
  localTag: string;
  contactUri: string;
  viaHost: string;
  localSdp: string;
  inviteHeaders: SipHeaderEntry[];
  authUsername: string;
  authPassword: string;
  authChallenge: SipDigestAuthorization | null;
  authorizationHeaderName: "authorization" | "proxy-authorization" | null;
  lastAuthNonce: string | null;
  authNonceCount: number;
  authAttempts: number;
  inviteBranch: string;
  state: "inviting" | "cancelling" | "answered" | "terminated";
};

type PendingOutboundSipStartup = {
  legId: string;
  dialId: string;
  socket: dgram.Socket;
  ownsSocket: boolean;
  cancelledReason: string | null;
};

type OutboundSipTransaction = {
  key: string;
  socket: dgram.Socket;
  request: string;
  remoteAddress: string;
  remotePort: number;
  method: string;
  isInvite: boolean;
  state: "calling" | "trying" | "proceeding";
  intervalMs: number;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  retransmitTimer: ReturnType<typeof setTimeout> | null;
  onTimeout?: (() => void) | null;
  onFinal?: (() => void) | null;
};

type SipInteractiveAuthDecision = {
  action: "verify_password" | "allow" | "not_applicable" | "challenge" | "deny";
  password?: string;
  extension?: string;
  statusCode?: number;
  reason?: string;
};

type ServerTransactionEntry = {
  processing: boolean;
  response: string | null;
  timer: ReturnType<typeof setTimeout> | null;
};

const SIP_T1_MS = 500;
const SIP_T2_MS = 4000;
const SIP_TRANSACTION_LIFETIME_MS = 64 * SIP_T1_MS;
const SIP_REGISTER_RETRY_DELAY_MS = 5000;
const LOOPBACK_SIP_HOST = "127.0.0.1";
const SIP_ALLOWED_METHODS = ["REGISTER", "INVITE", "CANCEL", "ACK", "BYE", "INFO"];

function randomTag(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

function isWildcardHost(host: string): boolean {
  return String(host || "").trim() === OPTION_DEFAULTS.sip.bindIp;
}

function normalizeSipBindIp(value: unknown): string {
  const bindIp = String(value || "").trim();
  return bindIp || OPTION_DEFAULTS.sip.bindIp;
}

function normalizeOptionalBindPort(value: unknown, fallback: number): number {
  if (value == null || value === "") {
    return fallback;
  }
  const port = Number(value);
  return Number.isFinite(port) ? port : fallback;
}

function pickListenerValue(...sources: unknown[]): unknown {
  for (const value of sources) {
    if (value == null) {
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      continue;
    }
    return value;
  }
  return undefined;
}

type SipListenerSettings = {
  transport: string;
  bindIp: string;
  bindPort: number;
  advertisedIp: string;
  realm: string;
};

function prepareSipListenerSettings(input: {
  scope: "trunk" | "extensions";
  transport: unknown;
  localBindIp: unknown;
  localBindPort: unknown;
  advertisedIp: unknown;
  realm: unknown;
  defaultBindPort: number;
  defaultRealm: string;
}): SipListenerSettings {
  const transport = String(input.transport || OPTION_DEFAULTS.sip.transport).trim().toLowerCase();
  if (transport !== OPTION_DEFAULTS.sip.transport) {
    const label = input.scope === "trunk" ? "Trunk trigger" : "Extensions trigger";
    throw daemonError("unsupported_transport", `${label} transport ${transport} is not implemented`);
  }
  const bindIp = normalizeSipBindIp(input.localBindIp);
  const bindPort = normalizeOptionalBindPort(input.localBindPort, input.defaultBindPort);
  const advertisedIp = normalizeSipAdvertisedHost(input.advertisedIp, bindIp);
  const realm = String(input.realm || advertisedIp || input.defaultRealm).trim() || input.defaultRealm;
  return { transport, bindIp, bindPort, advertisedIp, realm };
}

function getDefaultAdvertisedSipHost(): string {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== "IPv4" || entry.internal || !entry.address) {
        continue;
      }
      return String(entry.address);
    }
  }
  return LOOPBACK_SIP_HOST;
}

function normalizeSipAdvertisedHost(preferred: unknown, fallback?: unknown): string {
  const preferredHost = String(preferred || "").trim();
  if (preferredHost && !isWildcardHost(preferredHost)) {
    return preferredHost;
  }
  const fallbackHost = String(fallback || "").trim();
  if (fallbackHost && !isWildcardHost(fallbackHost)) {
    return fallbackHost;
  }
  return getDefaultAdvertisedSipHost();
}

function normalizeAuthorizationUsernamePrefix(value: unknown): string {
  return String(value || "").trim();
}

function normalizeStaticCredentials(value: unknown): Array<{ username: string; password: string; extension: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return (value as Array<Record<string, unknown>>).map((entry) => ({
    username: String(entry.username || "").trim(),
    password: String(entry.password || "").trim(),
    extension: String(entry.extension || "").trim(),
  }));
}

function normalizeDialDestinationUser(target: string): string {
  const raw = String(target || "").trim();
  if (!raw) {
    return "";
  }
  if (/^sips?:/i.test(raw)) {
    return String(parseSipUri(raw)?.user || "").trim();
  }
  const atIndex = raw.indexOf("@");
  if (atIndex > 0) {
    return raw.slice(0, atIndex).trim();
  }
  return raw;
}

function buildOutboundRequestUri(destinationUser: string, domainHost: string, domainPort: number): string {
  const normalizedUser = String(destinationUser || "").trim();
  const normalizedHost = String(domainHost || "").trim();
  if (!normalizedUser || !normalizedHost) {
    return "";
  }
  const portSuffix = domainPort > 0 ? `:${domainPort}` : "";
  return `sip:${encodeURIComponent(normalizedUser)}@${normalizedHost}${portSuffix}`;
}

function normalizeLocalEndpointHost(host: string): string {
  const resolvedHost = String(host || "").trim();
  if (!resolvedHost || isWildcardHost(resolvedHost)) {
    return LOOPBACK_SIP_HOST;
  }
  return resolvedHost;
}

function waitForUdpBind(socket: dgram.Socket, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      socket.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      socket.off("error", onError);
      resolve(socket.address() as AddressInfo);
    };
    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind(port, host);
  });
}

function canReuseUdpEndpointForSameRef(existing: { bindIp: string; bindPort: number }, bindIp: string, bindPort: number): boolean {
  return existing.bindIp === bindIp && (bindPort === 0 || existing.bindPort === bindPort);
}

function trunkRegistrationIdentity(credentials: Record<string, unknown>): string {
  return [
    credentials.sipServer,
    credentials.port,
    credentials.username,
    credentials.publicDomain,
    credentials.proxyServer,
  ].map((value) => String(value || "").trim()).join("|");
}

function normalizeTrunkRegisterMode(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  const text = String(value || "").trim().toLowerCase();
  if (!text) {
    return OPTION_DEFAULTS.trigger.trunk.registerMode === "register";
  }
  if (text === "register" || text === "true" || text === "1" || text === "yes" || text === "on") {
    return true;
  }
  if (text === "auth" || text === "none" || text === "false" || text === "0" || text === "no" || text === "off") {
    return false;
  }
  return OPTION_DEFAULTS.trigger.trunk.registerMode === "register";
}

function sendUdp(socket: dgram.Socket, payload: string, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(Buffer.from(payload, "utf8"), port, host, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export class SipTransportService {
  private readonly legService: LegService;
  private readonly extensionService: ExtensionHost;
  private readonly trunkService: TrunkClient;
  private readonly authService: InteractiveAuthService;
  private readonly trunkAuthBridge: Pick<TriggerAuthBridge, "createRequest">;
  private readonly ensureMediaTransportEndpoint: (legId: string) => Promise<Record<string, unknown>>;
  private readonly onAttemptRinging: (legId: string) => void;
  private readonly onAttemptProgress: (legId: string) => void;
  private readonly onAttemptAnswered: (legId: string) => void;
  private readonly onAttemptRejected: (legId: string, reason: string) => void;
  private readonly onInboundDtmf: (legId: string, digits: string) => void;
  private readonly extensionsHosts = new Map<string, ExtensionsHost>();
  private readonly trunkHosts = new Map<string, TrunkHost>();
  private readonly udpListeners = new Map<string, SipUdpListener>();
  private readonly inboundSessions = new Map<string, InboundSipSession>();
  private readonly outboundStartups = new Map<string, PendingOutboundSipStartup>();
  private readonly outboundSessions = new Map<string, OutboundSipSession>();
  private readonly outboundTransactions = new Map<string, OutboundSipTransaction>();
  private readonly serverTransactions = new Map<string, ServerTransactionEntry>();
  private readonly legCoordinator: LegCoordinator;
  private readonly extensionsDigestNonces = new SipDigestNonceRegistry();

  constructor(input: {
    legService: LegService;
    extensionService: ExtensionHost;
    trunkService: TrunkClient;
    authService: InteractiveAuthService;
    trunkAuthBridge?: Pick<TriggerAuthBridge, "createRequest">;
    ensureMediaTransportEndpoint?: (legId: string) => Promise<Record<string, unknown>>;
    onAttemptRinging: (legId: string) => void;
    onAttemptProgress: (legId: string) => void;
    onAttemptAnswered: (legId: string) => void;
    onAttemptRejected: (legId: string, reason: string) => void;
    onInboundDtmf?: (legId: string, digits: string) => void;
    legCoordinator?: LegCoordinator;
  }) {
    this.legService = input.legService;
    this.extensionService = input.extensionService;
    this.trunkService = input.trunkService;
    this.authService = input.authService;
    this.trunkAuthBridge = input.trunkAuthBridge || ({
      createRequest: () => {
        throw daemonError("invalid_trigger", "No active trunk trigger for inbound auth");
      },
    });
    this.ensureMediaTransportEndpoint = input.ensureMediaTransportEndpoint || (async () => ({}));
    this.onAttemptRinging = input.onAttemptRinging;
    this.onAttemptProgress = input.onAttemptProgress;
    this.onAttemptAnswered = input.onAttemptAnswered;
    this.onAttemptRejected = input.onAttemptRejected;
    this.onInboundDtmf = input.onInboundDtmf || (() => undefined);
    this.legCoordinator = input.legCoordinator || new LegCoordinator();
  }

  async activateExtensionsTrigger(config: Record<string, unknown>): Promise<void> {
    const ref = String(config.ref || "").trim();
    const publicRef = String(config.publicRef || ref || "").trim();
    if (!ref) {
      throw daemonError("invalid_trigger", "Trigger ref is required");
    }
    const transports = Array.isArray(config.transports)
      ? (config.transports as unknown[]).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
      : [String(config.transport || OPTION_DEFAULTS.sip.transport).trim().toLowerCase()].filter(Boolean);
    const normalizedTransports = transports.length > 0 ? Array.from(new Set(transports)) : [...OPTION_DEFAULTS.trigger.extensions.transports];
    const unsupportedTransports = normalizedTransports.filter((transport) => transport !== OPTION_DEFAULTS.sip.transport);
    if (unsupportedTransports.length > 0) {
      throw daemonError("unsupported_transport", `Extensions trigger transports ${unsupportedTransports.join(", ")} are not implemented`);
    }
    const listener = prepareSipListenerSettings({
      scope: "extensions",
      transport: normalizedTransports[0],
      localBindIp: config.localBindIp,
      localBindPort: config.localBindPort,
      advertisedIp: config.advertisedIp,
      realm: config.realm,
      defaultBindPort: OPTION_DEFAULTS.trigger.extensions.localBindPort,
      defaultRealm: "extensions.local",
    });
    const existing = this.extensionsHosts.get(ref);
    if (existing && canReuseUdpEndpointForSameRef(existing, listener.bindIp, listener.bindPort)) {
      this.assertSharedRealmCompatible(existing.bindIp, existing.bindPort, listener.realm);
      existing.publicRef = publicRef;
      existing.advertisedIp = listener.advertisedIp;
      existing.realm = listener.realm;
      existing.authMode = String(config.authMode || OPTION_DEFAULTS.trigger.extensions.authMode);
      existing.authorizationUsernamePrefix = normalizeAuthorizationUsernamePrefix(config.authorizationUsernamePrefix);
      existing.continueTraversalOnAuthReject = config.continueTraversalOnAuthReject === true;
      existing.staticCredentials = normalizeStaticCredentials(config.staticCredentials);
      return;
    }
    if (listener.bindPort > 0) {
      this.assertSharedRealmCompatible(listener.bindIp, listener.bindPort, listener.realm);
    }
    await this.deactivateExtensionsTrigger(ref);
    const acquired = await this.getOrCreateUdpListener(listener.bindIp, listener.bindPort);
    const advertisedIp = normalizeSipAdvertisedHost(config.advertisedIp, acquired.bindIp);
    const host: ExtensionsHost = {
      ref,
      publicRef,
      socket: acquired.socket,
      bindIp: acquired.bindIp,
      bindPort: acquired.bindPort,
      advertisedIp,
      realm: String(config.realm || advertisedIp || "extensions.local") || "extensions.local",
      authMode: String(config.authMode || OPTION_DEFAULTS.trigger.extensions.authMode),
      authorizationUsernamePrefix: normalizeAuthorizationUsernamePrefix(config.authorizationUsernamePrefix),
      continueTraversalOnAuthReject: config.continueTraversalOnAuthReject === true,
      staticCredentials: normalizeStaticCredentials(config.staticCredentials),
    };
    this.extensionsHosts.set(ref, host);
  }

  async deactivateExtensionsTrigger(ref: string): Promise<void> {
    const host = this.extensionsHosts.get(ref);
    if (!host) {
      return;
    }
    this.extensionsHosts.delete(ref);
    if (!this.hasActiveHostsForEndpoint(host.bindIp, host.bindPort)) {
      this.closeUdpListener(host.bindIp, host.bindPort);
    }
  }

  async activateTrunkTrigger(config: Record<string, unknown>): Promise<void> {
    const ref = String(config.ref || "").trim();
    const publicRef = String(config.publicRef || ref || "").trim();
    if (!ref) {
      throw daemonError("invalid_trigger", "Trigger ref is required");
    }
    const credentials = (config.sipCredentials && typeof config.sipCredentials === "object")
      ? { ...(config.sipCredentials as Record<string, unknown>) }
      : {};
    const registerMode = normalizeTrunkRegisterMode(config.trunkRegisterMode);
    const listener = prepareSipListenerSettings({
      scope: "trunk",
      transport: pickListenerValue(config.transport, credentials.transport),
      localBindIp: pickListenerValue(config.localBindIp, credentials.localBindIp),
      localBindPort: pickListenerValue(config.localBindPort, credentials.localBindPort),
      advertisedIp: pickListenerValue(config.advertisedIp, credentials.publicDomain),
      realm: config.realm,
      defaultBindPort: 0,
      defaultRealm: "trunk.local",
    });
    const authTimeoutMs = Math.max(0, Math.round(Number(config.authTimeoutSeconds || OPTION_DEFAULTS.trigger.trunk.authTimeoutSeconds) * 1000));
    const existing = this.trunkHosts.get(ref);
    if (existing && canReuseUdpEndpointForSameRef(existing, listener.bindIp, listener.bindPort)) {
      const replaceRegistration = Boolean(
        existing.registration
        && trunkRegistrationIdentity(existing.credentials) !== trunkRegistrationIdentity(credentials),
      );
      if (!registerMode) {
        this.assertSharedRealmCompatible(existing.bindIp, existing.bindPort, listener.realm);
      }
      this.clearTrunkRegistrationTimer(existing);
      if (existing.registration && (!registerMode || replaceRegistration)) {
        try {
          await this.sendTrunkRegister(existing, null, { expiresSeconds: 0 });
        } catch (error) {
          console.error(
            `[sip-pbx:signaling] trunk unregister during trigger reuse failed; ref=${ref}; error=${this.errorMessage(error)}`,
          );
        }
        existing.registration = null;
      }
      existing.credentials = credentials;
      existing.publicRef = publicRef;
      existing.registerMode = registerMode;
      existing.advertisedIp = listener.advertisedIp;
      existing.realm = listener.realm;
      existing.authTimeoutMs = authTimeoutMs;
      existing.continueTraversalOnAuthReject = config.continueTraversalOnAuthReject === true;
      existing.registrationExpires = Number(config.registrationExpires || OPTION_DEFAULTS.sip.registrationExpiresSeconds);
      existing.registerHeaders = this.normalizeHeaderEntries(config.registerHeaders);
      if (existing.registerMode) {
        await this.sendTrunkRegister(existing);
      }
      return;
    }
    if (listener.bindPort > 0 && !registerMode) {
      this.assertSharedRealmCompatible(listener.bindIp, listener.bindPort, listener.realm);
    }
    await this.deactivateTrunkTrigger(ref);
    const acquired = await this.getOrCreateUdpListener(listener.bindIp, listener.bindPort);
    const host: TrunkHost = {
      ref,
      publicRef,
      routeToken: randomTag("route"),
      socket: acquired.socket,
      bindIp: acquired.bindIp,
      bindPort: acquired.bindPort,
      advertisedIp: normalizeSipAdvertisedHost(pickListenerValue(config.advertisedIp, credentials.publicDomain), acquired.bindIp),
      realm: listener.realm,
      credentials,
      registerMode,
      authTimeoutMs,
      continueTraversalOnAuthReject: config.continueTraversalOnAuthReject === true,
      registrationExpires: Number(config.registrationExpires || OPTION_DEFAULTS.sip.registrationExpiresSeconds),
      registerHeaders: this.normalizeHeaderEntries(config.registerHeaders),
      registrationTimer: null,
      registration: null,
    };
    this.trunkHosts.set(ref, host);
    if (host.registerMode) {
      await this.sendTrunkRegister(host);
    }
  }

  async deactivateTrunkTrigger(ref: string): Promise<void> {
    const host = this.trunkHosts.get(ref);
    if (!host) {
      return;
    }
    this.clearTrunkRegistrationTimer(host);
    this.trunkHosts.delete(ref);
    if (host.registration) {
      try {
        await this.sendTrunkRegister(host, null, { expiresSeconds: 0 });
      } catch (error) {
        console.error(
          `[sip-pbx:signaling] trunk unregister during trigger deactivate failed; ref=${ref}; error=${this.errorMessage(error)}`,
        );
      }
    }
    host.registration = null;
    if (!this.hasActiveHostsForEndpoint(host.bindIp, host.bindPort)) {
      this.closeUdpListener(host.bindIp, host.bindPort);
    }
  }

  async startAttempt(dial: SignalingDialView, legId: string, target: DialTarget): Promise<void> {
    if (dial.mode === "websocket") {
      return;
    }
    const resolved = await this.resolveOutboundTarget(dial, target);
    if (!resolved) {
      this.onAttemptRejected(legId, "target_unavailable");
      return;
    }
    const socket = resolved.socket || dgram.createSocket("udp4");
    if (!resolved.socket) {
      await waitForUdpBind(socket, resolved.localBindPort, resolved.localBindIp);
    }
    const address = socket.address() as AddressInfo;
    const localHost = String(resolved.publicHost || address.address || resolved.localBindIp);
    const callId = `${randomTag("call")}@${localHost}`;
    const localTag = randomTag("tag");
    const from = `<sip:${resolved.callerUser}@${localHost}>;tag=${localTag}`;
    const to = `<${resolved.requestUri}>`;
    const contactUri = `sip:${resolved.callerUser}@${localHost}:${address.port}`;
    const viaHost = `${localHost}:${address.port}`;
    const startup: PendingOutboundSipStartup = {
      legId,
      dialId: dial.dialId,
      socket,
      ownsSocket: resolved.ownsSocket,
      cancelledReason: null,
    };

    const started = await this.withLegLock(legId, async () => {
      const leg = this.legService.getLeg(legId);
      if (!leg || leg.status === LEG_STATUS_ENDED) {
        return false;
      }
      this.outboundStartups.set(legId, startup);
      this.legService.updateSignalingDetails(legId, {
        ...(this.legService.requireLeg(legId).signalingDetails || {}),
        callId,
        from,
        to,
        localRtpBindIp: resolved.localBindIp,
        localRtpAdvertisedIp: resolved.publicHost,
        remoteRtpHost: null,
        remoteRtpPort: 0,
      });
      return true;
    });
    if (!started) {
      this.finalizePendingOutboundStartup(startup);
      return;
    }

    let transportDetails: Record<string, unknown>;
    try {
      transportDetails = await this.ensureMediaTransportEndpoint(legId);
    } catch (error) {
      await this.withLegLock(legId, async () => {
        if (this.outboundStartups.get(legId) === startup) {
          this.outboundStartups.delete(legId);
        }
      });
      this.finalizePendingOutboundStartup(startup);
      throw error;
    }

    let session: OutboundSipSession | null = null;
    await this.withLegLock(legId, async () => {
      const currentStartup = this.outboundStartups.get(legId) || null;
      if (currentStartup !== startup) {
        return;
      }
      this.outboundStartups.delete(legId);
      if (startup.cancelledReason) {
        return;
      }
      const localSdp = this.buildInitialOutboundSdp(
        String(transportDetails.localRtpHost || resolved.publicHost || address.address || resolved.localBindIp),
        Number(transportDetails.localRtpPort || 0),
      );
      session = {
        legId,
        dialId: dial.dialId,
        socket,
        ownsSocket: resolved.ownsSocket,
        remoteAddress: resolved.remoteAddress,
        remotePort: resolved.remotePort,
        requestUri: resolved.requestUri,
        callId,
        cseq: 1,
        from,
        to,
        localTag,
        contactUri,
        viaHost,
        localSdp,
        inviteHeaders: resolved.headers,
        authUsername: resolved.authUsername,
        authPassword: resolved.authPassword,
        authChallenge: null,
        authorizationHeaderName: null,
        lastAuthNonce: null,
        authNonceCount: 0,
        authAttempts: 0,
        inviteBranch: "",
        state: "inviting",
      };
      this.outboundSessions.set(legId, session);
      if (session.ownsSocket) {
        socket.on("message", (message, rinfo) => {
          void this.handleOutboundPacket(session, message, rinfo).catch((error) => {
            console.error(
              `[sip-pbx:signaling] outbound packet handling failed; leg=${legId}; error=${this.errorMessage(error)}`,
            );
          });
        });
        socket.on("error", () => {
          if (!this.outboundSessions.has(legId)) {
            return;
          }
          this.clearTransactionsForCallId(session.callId);
          this.outboundSessions.delete(legId);
          socket.close();
          this.onAttemptRejected(legId, "transport_error");
        });
      }
    });
    if (!session) {
      this.finalizePendingOutboundStartup(startup);
      return;
    }
    await this.sendOutboundInvite(session, {
      onTimeout: () => this.handleOutboundInviteTimeout(session, "transaction_timeout"),
    });
  }

  ringInboundLeg(legId: string): void {
    const session = this.inboundSessions.get(legId);
    if (!session || session.answered) {
      return;
    }
    void this.sendInboundResponse(session, 180, "Ringing");
  }

  progressInboundLeg(legId: string): void {
    const session = this.inboundSessions.get(legId);
    if (!session || session.answered) {
      return;
    }
    const localSdp = this.buildLocalSdpForLeg(legId);
    if (!localSdp) {
      return;
    }
    void this.sendInboundResponse(session, 183, "Session Progress", {
      Contact: `<${session.contactUri}>`,
      "Content-Type": "application/sdp",
    }, localSdp).catch((error) => {
      const details = error instanceof Error ? (error.stack || error.message) : String(error);
      console.error(`[sip-transport:sip] progress handler failed leg=${legId}: ${details}`);
    });
  }

  async answerInboundLeg(legId: string): Promise<boolean> {
    const session = this.inboundSessions.get(legId);
    if (!session) {
      return false;
    }
    if (session.answered) {
      return true;
    }
    let localSdp = this.buildLocalSdpForLeg(legId);
    if (!localSdp) {
      await this.ensureMediaTransportEndpoint(legId);
      localSdp = this.buildLocalSdpForLeg(legId);
    }
    session.answered = true;
    try {
      await this.sendInboundResponse(session, 200, "OK", {
        Contact: `<${session.contactUri}>`,
        "Content-Type": localSdp ? "application/sdp" : undefined,
      }, localSdp);
    } catch (error) {
      session.answered = false;
      this.clearInboundInviteSuccessRetransmission(session);
      throw error;
    }
    return true;
  }

  async rejectOrHangupLeg(legId: string, reason: string): Promise<void> {
    await this.withLegLock(legId, async () => {
      const inbound = this.inboundSessions.get(legId);
      if (inbound) {
        this.clearInboundSession(legId);
        if (inbound.answered) {
          await this.sendInDialogRequest(inbound.socket, {
            method: "BYE",
            requestUri: inbound.requestUri,
            remoteAddress: inbound.remoteAddress,
            remotePort: inbound.remotePort,
            viaHost: this.viaHostFromContactUri(inbound.contactUri),
            from: this.toHeaderWithTag(inbound.to, inbound.localTag),
            to: inbound.from,
            callId: inbound.callId,
            cseq: inbound.cseq + 1,
            contactUri: inbound.contactUri,
          }).catch((error) => {
            console.error(
              `[sip-pbx:signaling] inbound BYE send failed; leg=${legId}; error=${this.errorMessage(error)}`,
            );
          });
        } else {
          await this.sendInboundResponse(inbound, 603, this.reasonPhraseFromHangup(reason)).catch((error) => {
            console.error(
              `[sip-pbx:signaling] inbound reject response failed; leg=${legId}; reason=${reason}; error=${this.errorMessage(error)}`,
            );
          });
        }
        return;
      }
      const pendingStartup = this.outboundStartups.get(legId) || null;
      if (pendingStartup) {
        pendingStartup.cancelledReason = reason;
        return;
      }
      const outbound = this.outboundSessions.get(legId);
      if (!outbound) {
        return;
      }
      if (outbound.state === "answered") {
        outbound.state = "terminated";
        this.clearTransactionsForCallId(outbound.callId);
        this.outboundSessions.delete(legId);
        outbound.cseq += 1;
        await this.sendInDialogRequest(outbound.socket, {
          method: "BYE",
          requestUri: outbound.requestUri,
          remoteAddress: outbound.remoteAddress,
          remotePort: outbound.remotePort,
          viaHost: this.viaHostFromContactUri(outbound.contactUri),
          from: outbound.from,
          to: outbound.to,
          callId: outbound.callId,
          cseq: outbound.cseq,
          contactUri: outbound.contactUri,
          onTimeout: () => {
            this.clearTransactionsForCallId(outbound.callId);
            this.finalizeOutboundSocket(outbound);
          },
          onFinal: () => {
            this.finalizeOutboundSocket(outbound);
          },
        }).catch((error) => {
          console.error(
            `[sip-pbx:signaling] outbound BYE failed; leg=${legId}; error=${this.errorMessage(error)}`,
          );
          this.clearTransactionsForCallId(outbound.callId);
          this.finalizeOutboundSocket(outbound);
        });
      } else if (outbound.state === "inviting") {
        outbound.state = "cancelling";
        await this.sendOutboundCancel(outbound).catch((error) => {
          console.error(
            `[sip-pbx:signaling] outbound CANCEL failed; leg=${legId}; error=${this.errorMessage(error)}`,
          );
          this.clearTransactionsForCallId(outbound.callId);
          this.finalizeOutboundSocket(outbound);
        });
      }
    });
  }

  async sendDtmf(legId: string, digits: string, method: string): Promise<boolean> {
    const normalizedMethod = String(method || OPTION_DEFAULTS.sendDtmf.method);
    if (normalizedMethod !== OPTION_DEFAULTS.sendDtmf.method && normalizedMethod !== "info") {
      return false;
    }
    if (!digits) {
      return false;
    }
    const inbound = this.inboundSessions.get(legId);
    if (inbound && inbound.answered) {
      inbound.cseq += 1;
      await this.sendInDialogRequest(inbound.socket, {
        method: "INFO",
        requestUri: inbound.requestUri,
        remoteAddress: inbound.remoteAddress,
        remotePort: inbound.remotePort,
        viaHost: this.viaHostFromContactUri(inbound.contactUri),
        from: this.toHeaderWithTag(inbound.to, inbound.localTag),
        to: inbound.from,
        callId: inbound.callId,
        cseq: inbound.cseq,
        contactUri: inbound.contactUri,
        extraHeaders: {
          "Content-Type": "application/dtmf-relay",
        },
        body: this.buildDtmfRelayBody(digits),
      });
      return true;
    }
    const outbound = this.outboundSessions.get(legId);
    if (outbound && outbound.state === "answered") {
      outbound.cseq += 1;
      await this.sendInDialogRequest(outbound.socket, {
        method: "INFO",
        requestUri: outbound.requestUri,
        remoteAddress: outbound.remoteAddress,
        remotePort: outbound.remotePort,
        viaHost: this.viaHostFromContactUri(outbound.contactUri),
        from: outbound.from,
        to: outbound.to,
        callId: outbound.callId,
        cseq: outbound.cseq,
        contactUri: outbound.contactUri,
        extraHeaders: {
          "Content-Type": "application/dtmf-relay",
        },
        body: this.buildDtmfRelayBody(digits),
      });
      return true;
    }
    return false;
  }

  async handleLegEnded(legId: string): Promise<void> {
    await this.withLegLock(legId, async () => {
      this.clearInboundSession(legId);
      const pendingStartup = this.outboundStartups.get(legId) || null;
      if (pendingStartup) {
        return;
      }
      const outbound = this.outboundSessions.get(legId);
      if (!outbound) {
        return;
      }
      if (outbound.state === "inviting" || outbound.state === "cancelling") {
        return;
      }
      this.finalizeOutboundSession(outbound);
    });
  }

  private finalizeOutboundSession(session: OutboundSipSession): void {
    session.state = "terminated";
    this.clearTransactionsForCallId(session.callId);
    this.outboundSessions.delete(session.legId);
    this.finalizeOutboundSocket(session);
  }

  private finalizeOutboundSocket(session: OutboundSipSession): void {
    if (session.ownsSocket) {
      session.socket.close();
    }
  }

  private finalizePendingOutboundStartup(startup: PendingOutboundSipStartup): void {
    if (startup.ownsSocket) {
      startup.socket.close();
    }
  }

  private handleOutboundInviteTimeout(session: OutboundSipSession, reason: string): void {
    if (!this.outboundSessions.has(session.legId)) {
      return;
    }
    this.clearTransactionsForCallId(session.callId);
    this.outboundSessions.delete(session.legId);
    try {
      if (session.ownsSocket) {
        session.socket.close();
      }
    } catch (error) {
      console.error(
        `[sip-pbx:signaling] outbound attempt socket close failed on timeout; leg=${session.legId}; error=${this.errorMessage(error)}`,
      );
    }
    this.onAttemptRejected(session.legId, reason);
  }

  private async withLegLock<T>(legId: string, callback: () => Promise<T> | T): Promise<T> {
    return await this.legCoordinator.withLeg(legId, callback);
  }

  closeAll(): void {
    for (const ref of Array.from(this.extensionsHosts.keys())) {
      void this.deactivateExtensionsTrigger(ref);
    }
    for (const ref of Array.from(this.trunkHosts.keys())) {
      void this.deactivateTrunkTrigger(ref);
    }
    for (const session of this.outboundSessions.values()) {
      this.clearTransactionsForCallId(session.callId);
      if (session.ownsSocket) {
        session.socket.close();
      }
    }
    for (const startup of this.outboundStartups.values()) {
      this.finalizePendingOutboundStartup(startup);
    }
    this.outboundStartups.clear();
    this.outboundSessions.clear();
    for (const legId of Array.from(this.inboundSessions.keys())) {
      this.clearInboundSession(legId);
    }
    for (const key of Array.from(this.serverTransactions.keys())) {
      this.clearServerTransaction(key);
    }
  }

  getExtensionsEndpoint(ref: string): { host: string; port: number } | null {
    return this.getHostEndpoint(this.extensionsHosts, ref);
  }

  getTrunkEndpoint(ref: string): { host: string; port: number } | null {
    return this.getHostEndpoint(this.trunkHosts, ref);
  }

  private getHostEndpoint<H extends SipHostBase>(map: Map<string, H>, ref: string): { host: string; port: number } | null {
    const host = map.get(ref);
    if (!host) {
      return null;
    }
    return { host: normalizeLocalEndpointHost(host.bindIp), port: host.bindPort };
  }

  private assertSharedRealmCompatible(bindIp: string, bindPort: number, realm: string): void {
    const sharedRealm = this.getSharedAuthRealm(bindIp, bindPort);
    if (sharedRealm && sharedRealm !== realm) {
      throw daemonError("configuration_error", "SIP triggers sharing a listener must use the same realm");
    }
  }

  private getSharedAuthRealm(bindIp: string, bindPort: number): string | null {
    const extensionRealm = this.listExtensionsHostsForEndpoint(bindIp, bindPort)[0]?.realm || null;
    if (extensionRealm) {
      return extensionRealm;
    }
    return this.listTrunkHostsForEndpoint(bindIp, bindPort)
      .find((candidate) => !candidate.registerMode)
      ?.realm || null;
  }

  private listenerKey(bindIp: string, bindPort: number): string {
    return `${bindIp}:${bindPort}`;
  }

  private async getOrCreateUdpListener(bindIp: string, bindPort: number): Promise<SipUdpListener> {
    if (bindPort > 0) {
      const existing = this.udpListeners.get(this.listenerKey(bindIp, bindPort));
      if (existing) {
        return existing;
      }
    }
    const socket = dgram.createSocket("udp4");
    const address = await waitForUdpBind(socket, bindPort, bindIp);
    const listener: SipUdpListener = {
      socket,
      bindIp: String(address.address || bindIp),
      bindPort: Number(address.port || bindPort),
    };
    this.udpListeners.set(this.listenerKey(listener.bindIp, listener.bindPort), listener);
    socket.on("message", (message, rinfo) => {
      void this.handleEndpointDatagram(listener, message, rinfo).catch((error) => {
        console.error(
          `[sip-pbx:signaling] udp listener packet handler failed; bind=${listener.bindIp}:${listener.bindPort}; error=${this.errorMessage(error)}`,
        );
      });
    });
    return listener;
  }

  private hasActiveHostsForEndpoint(bindIp: string, bindPort: number): boolean {
    return this.listTrunkHostsForEndpoint(bindIp, bindPort).length > 0
      || this.listExtensionsHostsForEndpoint(bindIp, bindPort).length > 0;
  }

  private closeUdpListener(bindIp: string, bindPort: number): void {
    const key = this.listenerKey(bindIp, bindPort);
    const listener = this.udpListeners.get(key);
    if (!listener) {
      return;
    }
    this.udpListeners.delete(key);
    this.clearTransactionsForSocket(listener.socket);
    listener.socket.close();
  }

  private async handleExtensionsPacket(host: ExtensionsHost, rawMessage: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    await this.handleEndpointDatagram(host, rawMessage, rinfo);
  }

  private async handleTrunkPacket(host: TrunkHost, rawMessage: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    await this.handleEndpointDatagram(host, rawMessage, rinfo);
  }

  private async handleEndpointDatagram(
    source: { socket: dgram.Socket; bindIp: string; bindPort: number },
    rawMessage: Buffer,
    rinfo: dgram.RemoteInfo,
  ): Promise<void> {
    const message = parseSipMessage(rawMessage);
    if (!message) {
      return;
    }
    await this.handleEndpointPacket(source.socket, source.bindIp, source.bindPort, message, rinfo);
  }

  private async handleEndpointPacket(
    socket: dgram.Socket,
    bindIp: string,
    bindPort: number,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
  ): Promise<void> {
    const extensionsHost = this.listExtensionsHostsForEndpoint(bindIp, bindPort)[0] || null;
    const trunkHosts = this.listTrunkHostsForEndpoint(bindIp, bindPort);
    const fallbackAdvertisedHost = extensionsHost?.advertisedIp
      || trunkHosts[0]?.advertisedIp
      || normalizeSipAdvertisedHost("", bindIp);
    try {
      if (message.statusCode) {
        const outboundSession = this.findOutboundSession(socket, message);
        if (outboundSession) {
          await this.handleOutboundSessionMessage(outboundSession, message, rinfo);
          return;
        }
        this.noteOutboundTransactionResponse(message);
        for (const candidate of trunkHosts) {
          if (await this.handleTrunkRegisterResponse(candidate, message, rinfo)) {
            return;
          }
        }
        return;
      }
      if (!message.method) {
        return;
      }
      if (message.method === "REGISTER") {
        if (await this.handleDirectInboundTrunkByEndpoint(bindIp, bindPort, message, rinfo, "register")) {
          return;
        }
        if (extensionsHost) {
          await this.handleExtensionsRequest(extensionsHost, message, rinfo, "register");
          return;
        }
        await this.sendNotImplementedResponse(socket, message, rinfo, fallbackAdvertisedHost, bindPort);
        return;
      }
      if (message.method === "INVITE") {
        const outboundSession = this.findOutboundSession(socket, message);
        if (outboundSession) {
          await this.handleOutboundSessionMessage(outboundSession, message, rinfo);
          return;
        }
        if (await this.handleOrderedTrunkInviteByEndpoint(bindIp, bindPort, message, rinfo)) {
          return;
        }
        if (extensionsHost) {
          await this.handleExtensionsRequest(extensionsHost, message, rinfo, "invite");
          return;
        }
        await this.sendStatelessResponse(socket, message, rinfo, 404, "Not Found", fallbackAdvertisedHost, bindPort);
        return;
      }
      if (message.method === "CANCEL") {
        await this.handleInboundCancel(socket, fallbackAdvertisedHost, bindPort, message, rinfo);
        return;
      }
      if (message.method === "ACK") {
        this.handleInboundAck(message);
        return;
      }
      if (message.method === "BYE") {
        const outboundSession = this.findOutboundSession(socket, message);
        if (outboundSession) {
          await this.handleOutboundSessionMessage(outboundSession, message, rinfo);
          return;
        }
        await this.handleInDialogBye(socket, fallbackAdvertisedHost, bindPort, message, rinfo);
        return;
      }
      if (message.method === "INFO") {
        const outboundSession = this.findOutboundSession(socket, message);
        if (outboundSession) {
          await this.handleOutboundSessionMessage(outboundSession, message, rinfo);
          return;
        }
        await this.handleInDialogInfo(message, rinfo);
        return;
      }
      await this.sendNotImplementedResponse(socket, message, rinfo, fallbackAdvertisedHost, bindPort);
    } catch (error) {
      this.reportSipPacketError(trunkHosts.length > 0 ? "trunk" : "extensions", message, error);
      if (!message.statusCode) {
        await this.sendInternalErrorResponse(socket, message, rinfo, fallbackAdvertisedHost, bindPort);
      }
    }
  }

  private async handleExtensionsRequest(
    host: ExtensionsHost,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
    requestType: SipAuthRequestKind,
  ): Promise<void> {
    if (await this.replayServerTransaction(host.socket, message, rinfo)) {
      return;
    }
    const transactionKey = this.beginServerTransaction(message);
    try {
      const endpointExtension = this.extractEndpointExtension(message);
      const authorization = parseSipAuthorization(getSipHeader(message, "authorization"));
      let fallbackRejectResponse: SipAuthOutcome | null = null;
      for (const candidate of this.listExtensionsHostsForEndpoint(host.bindIp, host.bindPort)) {
        const authResponse = await this.resolveExtensionsAuth(candidate, message, requestType, endpointExtension, authorization, rinfo);
        if (authResponse.notApplicable) {
          continue;
        }
        if (!authResponse.allow) {
          if (this.shouldContinueExtensionsTraversalOnAuthReject(candidate, authResponse)) {
            fallbackRejectResponse = authResponse;
            continue;
          }
          await this.sendExtensionsAuthFailure(host, message, rinfo, authResponse);
          return;
        }
        const extensionFallback = requestType === "register" ? endpointExtension : "";
        const extensionNumber = String(authResponse.extension || extensionFallback || "").trim();
        if (!extensionNumber) {
          await this.sendExtensionsAuthFailure(host, message, rinfo, { statusCode: 403, reasonPhrase: "Missing Extension" });
          return;
        }
        if (requestType === "register") {
          await this.completeExtensionsRegister(candidate, message, rinfo, extensionNumber);
        } else {
          await this.startInboundExtensionInvite(candidate, message, rinfo, extensionNumber);
        }
        return;
      }
      if (fallbackRejectResponse) {
        await this.sendExtensionsAuthFailure(host, message, rinfo, fallbackRejectResponse);
        return;
      }
      await this.sendStatelessResponse(host.socket, message, rinfo, 404, "Not Found", host.advertisedIp, host.bindPort);
    } catch (error) {
      this.clearServerTransaction(transactionKey);
      throw error;
    }
  }

  private async completeExtensionsRegister(
    candidate: ExtensionsHost,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
    extensionNumber: string,
  ): Promise<void> {
    const contact = parseContactHeader(getSipHeader(message, "contact"));
    const expires = this.resolveRegisterExpires(message, contact.parameters);
    if (expires <= 0) {
      this.extensionService.unregisterEndpoint(candidate.ref, extensionNumber, {
        contactUri: contact.uri,
        sourceIp: rinfo.address,
        sourcePort: rinfo.port,
      });
    } else {
      this.extensionService.registerEndpoint({
        ref: candidate.ref,
        extensionNumber,
        contactUri: contact.uri,
        sourceIp: rinfo.address,
        sourcePort: rinfo.port,
        expiresAt: Date.now() + (expires * 1000),
      });
    }
    await this.sendStatelessResponse(candidate.socket, message, rinfo, 200, "OK", candidate.advertisedIp, candidate.bindPort, {
      Contact: contact.uri ? `<${contact.uri}>;expires=${Math.max(0, expires)}` : undefined,
    });
  }

  private async handleOutboundPacket(session: OutboundSipSession, rawMessage: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    const message = parseSipMessage(rawMessage);
    if (!message) {
      return;
    }
    if (message.statusCode) {
      if (this.outboundSessions.get(session.legId) === session) {
        await this.handleOutboundSessionMessage(session, message, rinfo);
      } else {
        this.noteOutboundTransactionResponse(message);
      }
      return;
    }
    if (this.outboundSessions.get(session.legId) !== session) {
      return;
    }
    await this.handleOutboundSessionMessage(session, message, rinfo);
  }

  private findOutboundSession(socket: dgram.Socket, message: SipMessage): OutboundSipSession | null {
    const callId = String(getSipHeader(message, "call-id") || "").trim();
    if (!callId) {
      return null;
    }
    for (const session of this.outboundSessions.values()) {
      if (session.socket === socket && session.callId === callId) {
        return session;
      }
    }
    return null;
  }

  private async handleOutboundSessionMessage(session: OutboundSipSession, message: SipMessage, rinfo: dgram.RemoteInfo): Promise<void> {
    if (this.outboundSessions.get(session.legId) !== session) {
      return;
    }
    if (message.statusCode) {
      this.noteOutboundTransactionResponse(message);
      const cseq = parseCseq(getSipHeader(message, "cseq"));
      if (message.statusCode < 200) {
        if (cseq.method !== "INVITE") {
          return;
        }
        if (message.statusCode === 180) {
          this.onAttemptRinging(session.legId);
        } else if (message.statusCode === 183) {
          session.remoteAddress = rinfo.address;
          session.remotePort = rinfo.port;
          session.to = this.ensureToTag(session.to, getSipHeader(message, "to"));
          const sdp = parseSipSdp(message.body || "");
          if (sdp.remoteRtpHost || sdp.remoteRtpPort || sdp.payloadTypes.length > 0) {
            this.legService.updateSignalingDetails(
              session.legId,
              this.buildRenegotiatedSignalingDetails(session.legId, sdp, rinfo.address),
            );
            await this.ensureMediaTransportEndpoint(session.legId);
          }
          this.onAttemptProgress(session.legId);
        }
        return;
      }
      if (message.statusCode >= 200 && message.statusCode < 300) {
        if (cseq.method === "BYE") {
          this.finalizeOutboundSession(session);
          return;
        }
        if (cseq.method !== "INVITE") {
          return;
        }
        session.state = "answered";
        session.remoteAddress = rinfo.address;
        session.remotePort = rinfo.port;
        session.to = this.ensureToTag(session.to, getSipHeader(message, "to"));
        const sdp = parseSipSdp(message.body || "");
        this.legService.updateSignalingDetails(
          session.legId,
          this.buildRenegotiatedSignalingDetails(session.legId, sdp, rinfo.address),
        );
        await this.ensureMediaTransportEndpoint(session.legId);
        const contact = parseContactHeader(getSipHeader(message, "contact"));
        if (contact.uri) {
          session.requestUri = contact.uri;
        }
        await this.sendInDialogRequest(session.socket, {
          method: "ACK",
          requestUri: session.requestUri,
          remoteAddress: rinfo.address,
          remotePort: rinfo.port,
          viaHost: this.viaHostFromContactUri(session.contactUri),
          from: session.from,
          to: session.to,
          callId: session.callId,
          cseq: session.cseq,
          contactUri: session.contactUri,
        });
        this.onAttemptAnswered(session.legId);
        return;
      }
      if (cseq.method === "BYE") {
        this.finalizeOutboundSession(session);
        return;
      }
      if (cseq.method !== "INVITE") {
        return;
      }
      try {
        await this.sendOutboundInviteAck(session, message, rinfo);
      } catch (error) {
        console.error(
          `[sip-pbx:signaling] outbound INVITE ACK failed; leg=${session.legId}; error=${this.errorMessage(error)}`,
        );
      }
      const sessionState = session.state;
      if (sessionState !== "cancelling" && (message.statusCode === 401 || message.statusCode === 407)) {
        const headerName = message.statusCode === 407 ? "proxy-authenticate" : "www-authenticate";
        const authHeaderName = message.statusCode === 407 ? "proxy-authorization" : "authorization";
        const challenge = parseSipDigestChallenge(getSipHeader(message, headerName));
        const nonce = String(challenge?.params.nonce || "").trim();
        if (
          challenge
          && session.authUsername
          && session.authPassword
          && (session.authAttempts < 2)
          && !(session.lastAuthNonce && session.lastAuthNonce === nonce && session.authAttempts > 0)
        ) {
          session.remoteAddress = rinfo.address;
          session.remotePort = rinfo.port;
          session.cseq += 1;
          session.authChallenge = challenge;
          session.authorizationHeaderName = authHeaderName;
          session.authAttempts += 1;
          await this.sendOutboundInvite(session, {
            onTimeout: () => this.handleOutboundInviteTimeout(session, "transaction_timeout"),
          });
          return;
        }
      }
      this.finalizeOutboundSession(session);
      if (sessionState !== "cancelling") {
        this.onAttemptRejected(session.legId, `sip_${message.statusCode}`);
      }
      return;
    }
    if (message.method === "INFO") {
      if (await this.replayServerTransaction(session.socket, message, rinfo)) {
        return;
      }
      await this.handleOutboundInfo(session, message, rinfo);
      return;
    }
    if (message.method === "INVITE") {
      if (await this.replayServerTransaction(session.socket, message, rinfo)) {
        return;
      }
      await this.handleOutboundReinvite(session, message, rinfo);
      return;
    }
    if (message.method === "ACK") {
      return;
    }
    if (message.method === "BYE") {
      if (await this.replayServerTransaction(session.socket, message, rinfo)) {
        return;
      }
      this.beginServerTransaction(message);
      await this.sendStatelessResponse(session.socket, message, rinfo, 200, "OK", "127.0.0.1", 0);
      this.finalizeOutboundSession(session);
      if (this.legService.getLeg(session.legId)) {
        this.legService.hangupLeg(session.legId, "remote_bye");
      }
    }
  }

  private async handleInDialogBye(
    socket: dgram.Socket,
    advertisedHost: string,
    bindPort: number,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
  ): Promise<void> {
    const inboundSession = this.findInboundSessionByCallId(getSipHeader(message, "call-id"));
    if (inboundSession && await this.replayServerTransaction(inboundSession.socket, message, rinfo)) {
      return;
    }
    const transactionKey = this.beginServerTransaction(message);
    const callId = getSipHeader(message, "call-id");
    if (!callId) {
      await this.sendStatelessResponse(socket, message, rinfo, 481, "Call/Transaction Does Not Exist", advertisedHost, bindPort);
      this.clearServerTransaction(transactionKey);
      return;
    }
    for (const [legId, session] of this.inboundSessions.entries()) {
      if (session.callId !== callId) {
        continue;
      }
      await this.sendStatelessResponse(socket, message, rinfo, 200, "OK", advertisedHost, bindPort);
      this.clearInboundSession(legId);
      if (this.legService.getLeg(legId)) {
        this.legService.hangupLeg(legId, "remote_bye");
      }
      return;
    }
    await this.sendStatelessResponse(socket, message, rinfo, 481, "Call/Transaction Does Not Exist", advertisedHost, bindPort);
    this.clearServerTransaction(transactionKey);
  }

  private async handleInboundCancel(
    socket: dgram.Socket,
    advertisedHost: string,
    bindPort: number,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
  ): Promise<void> {
    if (await this.replayServerTransaction(socket, message, rinfo)) {
      return;
    }
    const transactionKey = this.beginServerTransaction(message);
    try {
      const callId = getSipHeader(message, "call-id");
      const cseq = parseCseq(getSipHeader(message, "cseq"));
      const session = this.findInboundSessionByInvite(callId, cseq.sequence);
      if (!session) {
        await this.sendStatelessResponse(socket, message, rinfo, 481, "Call/Transaction Does Not Exist", advertisedHost, bindPort);
        return;
      }
      await this.sendStatelessResponse(socket, message, rinfo, 200, "OK", advertisedHost, bindPort);
      if (session.answered) {
        return;
      }
      await this.sendInboundResponse(session, 487, "Request Terminated");
      this.clearInboundSession(session.legId);
      if (this.legService.getLeg(session.legId)) {
        this.legService.hangupLeg(session.legId, "remote_cancel");
      }
    } catch (error) {
      this.clearServerTransaction(transactionKey);
      throw error;
    }
  }

  private async handleInDialogInfo(message: SipMessage, rinfo: dgram.RemoteInfo): Promise<void> {
    const inboundSession = this.findInboundSessionByCallId(getSipHeader(message, "call-id"));
    if (inboundSession && await this.replayServerTransaction(inboundSession.socket, message, rinfo)) {
      return;
    }
    const transactionKey = this.beginServerTransaction(message);
    const callId = getSipHeader(message, "call-id");
    if (!callId) {
      this.clearServerTransaction(transactionKey);
      return;
    }
    const digits = this.parseDtmfRelayBody(message.body || "");
    for (const [legId, session] of this.inboundSessions.entries()) {
      if (session.callId !== callId) {
        continue;
      }
      const contact = parseSipUri(session.contactUri);
      await this.sendStatelessResponse(session.socket, message, rinfo, 200, "OK", contact?.host || "127.0.0.1", Number(contact?.port || 0));
      if (digits) {
        this.onInboundDtmf(legId, digits);
      }
      return;
    }
    this.clearServerTransaction(transactionKey);
  }

  private async handleOutboundInfo(session: OutboundSipSession, message: SipMessage, rinfo: dgram.RemoteInfo): Promise<void> {
    this.beginServerTransaction(message);
    const digits = this.parseDtmfRelayBody(message.body || "");
    const contact = parseSipUri(session.contactUri);
    await this.sendStatelessResponse(session.socket, message, rinfo, 200, "OK", contact?.host || "127.0.0.1", Number(contact?.port || 0));
    if (digits) {
      this.onInboundDtmf(session.legId, digits);
    }
  }

  private async sendTrunkRegister(
    host: TrunkHost,
    challengeInput?: {
      challenge: SipDigestAuthorization | null;
      headerName: "authorization" | "proxy-authorization";
      remoteAddress: string;
      remotePort: number;
    } | null,
    options?: { expiresSeconds?: number },
  ): Promise<void> {
    const server = String(host.credentials.proxyServer || host.credentials.sipServer || "").trim();
    if (!server) {
      return;
    }
    const username = String(host.credentials.username || "n8n").trim() || "n8n";
    const password = String(host.credentials.password || "");
    const remotePort = Number(host.credentials.port || OPTION_DEFAULTS.sip.port);
    const domain = String(host.credentials.publicDomain || host.credentials.sipServer || server);
    const registration = host.registration;
    const expiresSeconds = Math.max(0, Number(options?.expiresSeconds ?? host.registrationExpires) || 0);
    const localHost = registration?.localHost || normalizeSipAdvertisedHost(host.credentials.publicDomain, host.bindIp);
    const requestUri = registration?.requestUri || `sip:${server}${remotePort ? `:${remotePort}` : ""}`;
    const effectiveRemoteAddress = challengeInput?.remoteAddress || registration?.remoteAddress || server;
    const effectiveRemotePort = challengeInput?.remotePort || registration?.remotePort || remotePort;
    const callId = registration?.callId || `${randomTag("reg")}@${domain}`;
    const from = registration?.from || `<sip:${username}@${domain}>;tag=${randomTag("tag")}`;
    const to = registration?.to || `<sip:${username}@${domain}>`;
    const contactUri = registration?.contactUri || `sip:${username}@${localHost}:${host.bindPort};n8n-route=${encodeURIComponent(host.routeToken)}`;
    const nextCseq = (registration?.cseq || 0) + 1;
    const challenge = challengeInput?.challenge || registration?.lastChallenge || null;
    const authorizationHeaderName = challengeInput?.headerName || registration?.authorizationHeaderName || null;
    const nonce = String(challenge?.params.nonce || "").trim() || null;
    const nonceCount = challenge
      ? ((registration?.lastNonce && registration.lastNonce === nonce ? registration.nonceCount : 0) + 1)
      : 0;
    const authHeader = challenge
      ? buildSipDigestAuthorization({
          challenge,
          method: "REGISTER",
          requestUri,
          username,
          password,
          nc: Number(nonceCount || 1).toString(16).padStart(8, "0"),
        })
      : null;
    if (challenge && !authHeader) {
      return;
    }
    host.registration = {
      requestUri,
      remoteAddress: effectiveRemoteAddress,
      remotePort: effectiveRemotePort,
      callId,
      cseq: nextCseq,
      from,
      to,
      contactUri,
      localHost,
      lastChallenge: challenge,
      authorizationHeaderName,
      lastNonce: nonce,
      nonceCount,
      authAttempts: challenge ? (registration?.authAttempts || 0) + 1 : 0,
    };
    const registerRequest = formatSipRequest({
      method: "REGISTER",
      requestUri,
      headers: {
        Via: `SIP/2.0/UDP ${localHost}:${host.bindPort};branch=z9hG4bK-${randomTag("branch")}`,
        "Max-Forwards": 70,
        From: from,
        To: to,
        "Call-ID": callId,
        CSeq: `${nextCseq} REGISTER`,
        Expires: expiresSeconds,
        Contact: `<${contactUri}>;expires=${expiresSeconds}`,
        ...(authorizationHeaderName === "authorization" ? { Authorization: authHeader || undefined } : {}),
        ...(authorizationHeaderName === "proxy-authorization" ? { "Proxy-Authorization": authHeader || undefined } : {}),
      },
      extraHeaders: host.registerHeaders,
    });
    try {
      await this.sendTrackedRequest(host.socket, registerRequest, effectiveRemoteAddress, effectiveRemotePort, {
        onTimeout: () => {
          this.scheduleTrunkRegistrationRetry(host, SIP_REGISTER_RETRY_DELAY_MS);
        },
      });
    } catch (error) {
      this.scheduleTrunkRegistrationRetry(host, SIP_REGISTER_RETRY_DELAY_MS);
      throw error;
    }
  }

  private async handleTrunkRegisterResponse(host: TrunkHost, message: SipMessage, rinfo: dgram.RemoteInfo): Promise<boolean> {
    const cseq = parseCseq(getSipHeader(message, "cseq"));
    if (cseq.method !== "REGISTER") {
      return false;
    }
    const callId = String(getSipHeader(message, "call-id") || "").trim();
    if (!host.registerMode || !host.registration || !callId || host.registration.callId !== callId) {
      return false;
    }
    const statusCode = Number(message.statusCode || 0);
    if (statusCode >= 200 && statusCode < 300) {
      const contact = parseContactHeader(getSipHeader(message, "contact"));
      const expires = this.resolveRegisterExpires(message, contact.parameters);
      if (host.registration) {
        host.registration.authAttempts = 0;
      }
      this.scheduleTrunkRegistrationRefresh(host, expires > 0 ? expires : host.registrationExpires);
      return true;
    }
    if (statusCode === 423) {
      const minExpires = Number(getSipHeader(message, "min-expires") || NaN);
      if (Number.isFinite(minExpires) && minExpires > 0) {
        host.registrationExpires = minExpires;
        await this.sendTrunkRegister(host);
      } else {
        this.scheduleTrunkRegistrationRetry(host, SIP_REGISTER_RETRY_DELAY_MS);
      }
      return true;
    }
    if (statusCode !== 401 && statusCode !== 407) {
      this.scheduleTrunkRegistrationRetry(host, this.resolveRetryAfterMs(message, SIP_REGISTER_RETRY_DELAY_MS));
      return true;
    }
    const headerName = statusCode === 407 ? "proxy-authenticate" : "www-authenticate";
    const authHeaderName = statusCode === 407 ? "proxy-authorization" : "authorization";
    const challenge = parseSipDigestChallenge(getSipHeader(message, headerName));
    const nonce = String(challenge?.params.nonce || "").trim();
    if (!challenge || !String(host.credentials.username || "").trim() || !String(host.credentials.password || "")) {
      return true;
    }
    if (host.registration?.lastNonce && host.registration.lastNonce === nonce && host.registration.authAttempts > 0) {
      return true;
    }
    if ((host.registration?.authAttempts || 0) >= 2) {
      this.scheduleTrunkRegistrationRetry(host, SIP_REGISTER_RETRY_DELAY_MS);
      return true;
    }
    await this.sendTrunkRegister(host, {
      challenge,
      headerName: authHeaderName,
      remoteAddress: rinfo.address,
      remotePort: rinfo.port,
    });
    return true;
  }

  private scheduleTrunkRegistrationTask(host: TrunkHost, delayMs: number, label: string): void {
    this.clearTrunkRegistrationTimer(host);
    if (!Number.isFinite(delayMs) || delayMs <= 0 || !host.registerMode) {
      return;
    }
    host.registrationTimer = setTimeout(() => {
      host.registrationTimer = null;
      if (!this.trunkHosts.has(host.ref) || !host.registerMode) {
        return;
      }
      void this.sendTrunkRegister(host).catch((error) => {
        console.error(
          `[sip-pbx:signaling] trunk registration ${label} failed; ref=${host.ref}; error=${this.errorMessage(error)}`,
        );
      });
    }, delayMs);
    (host.registrationTimer as unknown as { unref?: () => void }).unref?.();
  }

  private scheduleTrunkRegistrationRefresh(host: TrunkHost, expiresSeconds: number): void {
    const expiresMs = Math.max(1000, Math.floor(Number(expiresSeconds || 0) * 1000));
    if (!Number.isFinite(expiresMs) || expiresMs <= 0) {
      this.clearTrunkRegistrationTimer(host);
      return;
    }
    const refreshMs = Math.max(250, Math.min(expiresMs - 250, Math.floor(expiresMs * 0.85)));
    this.scheduleTrunkRegistrationTask(host, refreshMs > 0 ? refreshMs : expiresMs, "refresh");
  }

  private scheduleTrunkRegistrationRetry(host: TrunkHost, delayMs: number): void {
    const resolvedDelayMs = Math.max(250, Math.floor(Number(delayMs || SIP_REGISTER_RETRY_DELAY_MS)));
    this.scheduleTrunkRegistrationTask(host, resolvedDelayMs, "retry");
  }

  private clearTrunkRegistrationTimer(host: TrunkHost): void {
    if (!host.registrationTimer) {
      return;
    }
    clearTimeout(host.registrationTimer);
    host.registrationTimer = null;
  }

  private resolveRetryAfterMs(message: SipMessage, fallbackMs: number): number {
    const retryAfter = Number(getSipHeader(message, "retry-after") || NaN);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      return Math.max(250, Math.floor(retryAfter * 1000));
    }
    return fallbackMs;
  }

  private verifyHostDigestAuthorization(
    host: SipHostBase,
    scopeKey: string,
    message: SipMessage,
    authorization: ReturnType<typeof parseSipAuthorization>,
    username: string,
    password: string,
  ): { ok: true; stale: false; invalidNonce: false } | { ok: false; stale: boolean; invalidNonce: boolean } {
    const nonceValidation = this.extensionsDigestNonces.validate(scopeKey, host.realm, authorization);
    if (!nonceValidation.ok) {
      return { ok: false, stale: nonceValidation.stale, invalidNonce: true };
    }
    const ok = verifySipDigestAuthorization({
      authorization,
      method: String(message.method || "REGISTER"),
      requestUri: String(message.requestUri || ""),
      username,
      realm: host.realm,
      password,
    });
    if (!ok) {
      return { ok: false, stale: false, invalidNonce: false };
    }
    return { ok: true, stale: false, invalidNonce: false };
  }

  private resolvePublicHostAuthorization(
    host: SipHostBase,
    scopeKey: string,
    authorization: ReturnType<typeof parseSipAuthorization>,
  ): { authorization: ReturnType<typeof parseSipAuthorization> | null; stale: boolean } {
    if (!authorization || String(authorization.scheme || "").toLowerCase() !== "digest") {
      return { authorization: null, stale: false };
    }
    if (String(authorization.params?.realm || "").trim() !== String(host.realm || "").trim()) {
      return { authorization: null, stale: false };
    }
    const nonceValidation = this.extensionsDigestNonces.validate(scopeKey, host.realm, authorization);
    if (!nonceValidation.ok) {
      return { authorization: null, stale: nonceValidation.stale === true };
    }
    return { authorization, stale: false };
  }

  private resolveHostChallengeStale(
    host: SipHostBase,
    scopeKey: string,
    authorization: ReturnType<typeof parseSipAuthorization>,
    prevalidatedAuthorizationStale = false,
  ): boolean {
    if (prevalidatedAuthorizationStale) {
      return true;
    }
    if (!authorization) {
      return false;
    }
    const nonceValidation = this.extensionsDigestNonces.validate(scopeKey, host.realm, authorization);
    return !nonceValidation.ok && nonceValidation.stale === true;
  }

  private async sendHostAuthFailure(
    host: SipHostBase,
    scopeKey: string,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
    response: { statusCode?: number; reasonPhrase?: string; stale?: boolean; challenge?: boolean },
  ): Promise<void> {
    const statusCode = Number(response.statusCode || 401);
    const challengeNonce = response.challenge === true && (statusCode === 401 || statusCode === 407)
      ? this.extensionsDigestNonces.issue(scopeKey, host.realm)
      : null;
    await this.sendStatelessResponse(host.socket, message, rinfo, statusCode, String(response.reasonPhrase || "Unauthorized"), host.advertisedIp, host.bindPort, {
      "WWW-Authenticate": challengeNonce ? buildSipDigestChallenge(host.realm, challengeNonce, { stale: Boolean(response.stale) }) : undefined,
    });
  }

  private buildAuthRequestContext(input: {
    host: SipHostBase;
    message: SipMessage;
    requestType: SipAuthRequestKind;
    username: string;
    endpointExtension: string;
    publicAuthorization: ReturnType<typeof parseSipAuthorization> | null;
    authorization: ReturnType<typeof parseSipAuthorization>;
    rinfo: dgram.RemoteInfo;
  }) {
    const method = String(input.message.method || "").toUpperCase();
    return {
      requestType: input.requestType,
      method,
      username: input.username,
      externalUsername: input.username,
      endpointExtension: input.endpointExtension,
      realm: input.host.realm,
      hasAuthorization: Boolean(input.authorization),
      authorization: input.publicAuthorization || undefined,
      sourceIp: String(input.rinfo.address || ""),
      clientPort: Number(input.rinfo.port || 0),
      transport: OPTION_DEFAULTS.sip.transport,
      localIp: String(input.host.bindIp || ""),
      localPort: Number(input.host.bindPort || 0),
      raw: {
        startLine: input.message.startLine,
        method,
        requestUri: String(input.message.requestUri || ""),
        headers: Object.fromEntries(Object.entries(input.message.headers).map(([name, values]) => [name, values.join(", ")])),
        body: input.message.body || "",
      },
    };
  }

  private async resolveExtensionsAuth(
    host: ExtensionsHost,
    message: SipMessage,
    requestType: SipAuthRequestKind,
    endpointExtension: string,
    authorization: ReturnType<typeof parseSipAuthorization>,
    rinfo: dgram.RemoteInfo,
  ): Promise<SipAuthOutcome> {
    const scopeKey = this.extensionNonceScope(host);
    const normalizedAuthorizationUsername = this.resolveNormalizedAuthorizationUsername(host, authorization);
    if (authorization && host.authMode !== "raw" && !normalizedAuthorizationUsername.applicable) {
      return { allow: false, notApplicable: true };
    }
    const username = authorization
      ? normalizedAuthorizationUsername.username
      : String(endpointExtension || "");
    const publicAuthorizationState = this.resolvePublicHostAuthorization(host, scopeKey, authorization);
    if (host.authMode === "static") {
      return this.resolveStaticAuth(host, message, endpointExtension, authorization, normalizedAuthorizationUsername.username);
    }
    if (host.authMode === "digest-first" && !authorization) {
      return { allow: false, statusCode: 401, reasonPhrase: "Unauthorized", challenge: true };
    }
    const requestContext = this.buildAuthRequestContext({
      host,
      message,
      requestType,
      username,
      endpointExtension,
      publicAuthorization: publicAuthorizationState.authorization,
      authorization,
      rinfo,
    });
    const request = this.extensionService.createAuthRequest({
      ref: host.ref,
      publicRef: host.publicRef || host.ref,
      requestContext,
    });
    const response = await this.authService.waitForResolution(request.authRequestId);
    return this.applyInteractiveAuthResponse(
      host,
      scopeKey,
      message,
      authorization,
      response,
      {
        verifyUsername: String((authorization && authorization.params?.username) || "").trim() || normalizedAuthorizationUsername.username,
        extensionFallback: normalizedAuthorizationUsername.username,
        requiresExtension: true,
        prevalidatedStale: publicAuthorizationState.stale,
      },
    );
  }

  private resolveNormalizedAuthorizationUsername(
    host: ExtensionsHost,
    authorization: ReturnType<typeof parseSipAuthorization>,
  ): { applicable: boolean; username: string } {
    const rawUsername = String((authorization && authorization.params?.username) || "").trim();
    if (!authorization || !rawUsername || host.authMode === "raw") {
      return { applicable: true, username: rawUsername };
    }
    const prefix = String(host.authorizationUsernamePrefix || "").trim();
    if (!prefix) {
      return { applicable: true, username: rawUsername };
    }
    if (!rawUsername.startsWith(prefix)) {
      return { applicable: false, username: rawUsername };
    }
    const strippedUsername = rawUsername.slice(prefix.length).trim();
    if (!strippedUsername) {
      return { applicable: false, username: rawUsername };
    }
    return { applicable: true, username: strippedUsername };
  }

  private resolveStaticAuth(
    host: ExtensionsHost,
    message: SipMessage,
    endpointExtension: string,
    authorization: ReturnType<typeof parseSipAuthorization>,
    normalizedAuthorizationUsername: string,
  ): SipAuthOutcome {
    if (!authorization) {
      return { allow: false, statusCode: 401, reasonPhrase: "Unauthorized", challenge: true };
    }
    const username = String(normalizedAuthorizationUsername || endpointExtension || "").trim();
    const verificationUsername = String((authorization && authorization.params?.username) || "").trim();
    const credential = host.staticCredentials.find((entry) => entry.username === username || entry.extension === endpointExtension);
    if (!credential) {
      return { allow: false, notApplicable: true };
    }
    const verified = this.verifyHostDigestAuthorization(
      host,
      this.extensionNonceScope(host),
      message,
      authorization,
      verificationUsername || credential.username || username,
      credential.password,
    );
    if (!verified.ok) {
      return verified.invalidNonce
        ? { allow: false, statusCode: 401, reasonPhrase: "Unauthorized", stale: verified.stale, challenge: true }
        : { allow: false, statusCode: 403, reasonPhrase: "Forbidden" };
    }
    return { allow: true, extension: credential.extension || endpointExtension || credential.username };
  }

  private applyInteractiveAuthResponse(
    host: SipHostBase,
    scopeKey: string,
    message: SipMessage,
    authorization: ReturnType<typeof parseSipAuthorization>,
    response: SipInteractiveAuthDecision,
    options: {
      verifyUsername: string;
      extensionFallback?: string;
      requiresExtension?: boolean;
      prevalidatedStale?: boolean;
    },
  ): SipAuthOutcome {
    const extensionFallback = String(options.extensionFallback || "").trim();
    const resolveExtension = (): SipAuthOutcome => {
      if (!options.requiresExtension) {
        return { allow: true };
      }
      const extension = String(response.extension || extensionFallback || "").trim();
      if (!extension) {
        return { allow: false, statusCode: 403, reasonPhrase: "Missing Extension" };
      }
      return { allow: true, extension };
    };
    if (response.action === "allow") {
      return resolveExtension();
    }
    if (response.action === "verify_password") {
      if (!authorization) {
        return { allow: false, statusCode: 401, reasonPhrase: "Unauthorized", challenge: true };
      }
      const password = String(response.password || "");
      const verified = this.verifyHostDigestAuthorization(host, scopeKey, message, authorization, options.verifyUsername, password);
      if (verified.ok) {
        return resolveExtension();
      }
      return verified.invalidNonce
        ? { allow: false, statusCode: 401, reasonPhrase: "Unauthorized", stale: verified.stale, challenge: true }
        : { allow: false, statusCode: 403, reasonPhrase: "Forbidden" };
    }
    if (response.action === "deny") {
      return {
        allow: false,
        statusCode: Number(response.statusCode || 403),
        reasonPhrase: String(response.reason || "Forbidden"),
      };
    }
    if (response.action === "not_applicable") {
      return { allow: false, notApplicable: true };
    }
    return {
      allow: false,
      statusCode: Number(response.statusCode || 401),
      reasonPhrase: "Unauthorized",
      challenge: response.action === "challenge",
      stale: response.action === "challenge"
        ? this.resolveHostChallengeStale(host, scopeKey, authorization, options.prevalidatedStale)
        : false,
    };
  }

  private shouldContinueExtensionsTraversalOnAuthReject(
    host: ExtensionsHost,
    response: SipAuthOutcome,
  ): boolean {
    return host.continueTraversalOnAuthReject === true
      && !response.allow
      && !response.notApplicable
      && response.challenge !== true;
  }

  private sendExtensionsAuthFailure(
    host: ExtensionsHost,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
    response: { statusCode?: number; reasonPhrase?: string; stale?: boolean; challenge?: boolean },
  ): Promise<void> {
    return this.sendHostAuthFailure(host, this.extensionNonceScope(host), message, rinfo, response);
  }

  private sendTrunkAuthFailure(
    host: TrunkHost,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
    response: { statusCode?: number; reasonPhrase?: string; stale?: boolean; challenge?: boolean },
  ): Promise<void> {
    return this.sendHostAuthFailure(host, this.trunkNonceScope(host), message, rinfo, response);
  }

  private shouldContinueTrunkTraversalOnAuthReject(
    host: TrunkHost,
    response: SipAuthOutcome,
  ): boolean {
    return host.continueTraversalOnAuthReject === true
      && !response.allow
      && !response.notApplicable
      && response.challenge !== true;
  }

  private async sendNotImplementedResponse(
    socket: dgram.Socket,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
    advertisedHost: string,
    bindPort: number,
  ): Promise<void> {
    if (await this.replayServerTransaction(socket, message, rinfo)) {
      return;
    }
    const transactionKey = this.beginServerTransaction(message);
    try {
      await this.sendStatelessResponse(socket, message, rinfo, 501, "Not Implemented", advertisedHost, bindPort, {
        Allow: SIP_ALLOWED_METHODS.join(", "),
      });
    } catch (error) {
      this.clearServerTransaction(transactionKey);
      throw error;
    }
  }

  private async sendInternalErrorResponse(
    socket: dgram.Socket,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
    advertisedHost: string,
    bindPort: number,
  ): Promise<void> {
    if (!message.method || message.method === "ACK") {
      return;
    }
    if (await this.replayServerTransaction(socket, message, rinfo)) {
      return;
    }
    const transactionKey = this.beginServerTransaction(message);
    try {
      await this.sendStatelessResponse(socket, message, rinfo, 500, "Server Internal Error", advertisedHost, bindPort);
    } catch (error) {
      this.clearServerTransaction(transactionKey);
      throw error;
    }
  }

  private reportSipPacketError(scope: "extensions" | "trunk", message: SipMessage, error: unknown): void {
    const method = String(message.method || "");
    const callId = getSipHeader(message, "call-id");
    const details = error instanceof Error ? (error.stack || error.message) : String(error);
    console.error(`[sip-transport:${scope}] ${method || "response"} handler failed${callId ? ` call-id=${callId}` : ""}: ${details}`);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error || "unknown");
  }

  private async processInboundServerTransaction(
    socket: dgram.Socket,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
    callback: () => Promise<void>,
  ): Promise<boolean> {
    if (await this.replayServerTransaction(socket, message, rinfo)) {
      return true;
    }
    const transactionKey = this.beginServerTransaction(message);
    try {
      await callback();
      return true;
    } catch (error) {
      this.clearServerTransaction(transactionKey);
      throw error;
    }
  }

  private async startInboundTrunkInvite(host: TrunkHost, message: SipMessage, rinfo: dgram.RemoteInfo): Promise<void> {
    const invite = this.createInboundInvite(host.ref, host.publicRef || host.ref, message, "sip");
    const result = this.trunkService.emitInboundInvite(invite);
    this.prepareInboundRtpSession(result.legId, host.bindIp, host.advertisedIp, message, rinfo);
    this.inboundSessions.set(
      result.legId,
      this.createInboundSession(host.socket, result.legId, message, rinfo, host.advertisedIp, host.bindPort),
    );
    await this.sendStatelessResponse(host.socket, message, rinfo, 100, "Trying", host.advertisedIp, host.bindPort);
  }

  private async startInboundExtensionInvite(
    host: ExtensionsHost,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
    authenticatedExtensionNumber: string,
  ): Promise<void> {
    const contact = parseContactHeader(getSipHeader(message, "contact"));
    const invite = this.createInboundInvite(
      host.ref,
      host.publicRef || host.ref,
      message,
      "sip",
      authenticatedExtensionNumber,
      this.extensionService.resolveEndpointIdForTriggerLeg(host.ref, authenticatedExtensionNumber, {
        contactUri: contact.uri,
        sourceIp: rinfo.address,
        sourcePort: rinfo.port,
      }),
    );
    const result = this.extensionService.emitInboundInvite(invite);
    this.prepareInboundRtpSession(result.legId, host.bindIp, host.advertisedIp, message, rinfo);
    this.inboundSessions.set(
      result.legId,
      this.createInboundSession(host.socket, result.legId, message, rinfo, host.advertisedIp, host.bindPort),
    );
    await this.sendStatelessResponse(host.socket, message, rinfo, 100, "Trying", host.advertisedIp, host.bindPort);
  }

  private createInboundInvite(
    ref: string,
    publicRef: string,
    message: SipMessage,
    transportType: "sip" | "websocket",
    extensionNumber?: string,
    endpointId?: string,
  ): InboundSipInvite {
    const from = parseSipNameAddress(getSipHeader(message, "from"));
    const to = parseSipNameAddress(getSipHeader(message, "to"));
    const normalizedHeaders = Object.fromEntries(Object.entries(message.headers).map(([name, values]) => [name, values.join(", ")]));
    const normalizedExtensionNumber = String(extensionNumber || "").trim()
      || String(parseSipUri(to.uri || "")?.user || "").trim();
    const callerNumber = String(parseSipUri(from.uri || "")?.user || "").trim();
    return {
      ref,
      publicRef,
      transportType,
      from: from.uri || getSipHeader(message, "from"),
      callerName: from.displayName || "",
      callerNumber,
      to: to.uri || getSipHeader(message, "to"),
      callId: getSipHeader(message, "call-id"),
      extensionNumber: normalizedExtensionNumber,
      endpointId: String(endpointId || "").trim(),
      headers: normalizedHeaders,
      raw: {
        callId: getSipHeader(message, "call-id"),
        from: from.uri || getSipHeader(message, "from"),
        callerName: from.displayName || "",
        callerNumber,
        to: to.uri || getSipHeader(message, "to"),
        extension: normalizedExtensionNumber,
        startLine: message.startLine,
        method: message.method || "",
        requestUri: message.requestUri || "",
        headers: normalizedHeaders,
        body: message.body || "",
      },
    };
  }

  private createInboundSession(
    socket: dgram.Socket,
    legId: string,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
    advertisedHost: string,
    bindPort: number,
  ): InboundSipSession {
    const requestUri = String(message.requestUri || "");
    const user = parseSipUri(requestUri)?.user || "n8n";
    return {
      legId,
      socket,
      remoteAddress: rinfo.address,
      remotePort: rinfo.port,
      transactionKey: this.buildTransactionKey(message),
      callId: getSipHeader(message, "call-id"),
      cseq: parseCseq(getSipHeader(message, "cseq")).sequence,
      requestUri,
      from: getSipHeader(message, "from"),
      to: getSipHeader(message, "to"),
      via: getSipHeader(message, "via"),
      localTag: randomTag("uas"),
      answered: false,
      contactUri: `sip:${user}@${advertisedHost}:${bindPort}`,
      inviteSuccessResponse: null,
      inviteSuccessRetransmitTimer: null,
      inviteSuccessIntervalMs: SIP_T1_MS,
    };
  }

  private async sendInboundResponse(
    session: InboundSipSession,
    statusCode: number,
    reasonPhrase: string,
    extraHeaders?: Record<string, string | undefined>,
    body?: string,
  ): Promise<void> {
    const response = formatSipResponse({
      statusCode,
      reasonPhrase,
      headers: {
        Via: session.via,
        From: session.from,
        To: this.toHeaderWithTag(session.to, session.localTag),
        "Call-ID": session.callId,
        CSeq: `${session.cseq} INVITE`,
        ...(extraHeaders || {}),
      },
      body: body || "",
    });
    await sendUdp(session.socket, response, session.remotePort, session.remoteAddress);
    this.storeServerTransactionResponse(session.transactionKey, response);
    if (statusCode >= 200) {
      if (statusCode < 300) {
        session.inviteSuccessResponse = response;
        session.inviteSuccessIntervalMs = SIP_T1_MS;
        this.armInboundInviteSuccessRetransmission(session);
      } else {
        this.clearInboundInviteSuccessRetransmission(session);
      }
    }
  }

  private async sendStatelessResponse(
    socket: dgram.Socket,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
    statusCode: number,
    reasonPhrase: string,
    advertisedHost: string,
    bindPort: number,
    extraHeaders?: Record<string, string | undefined>,
    body?: string,
  ): Promise<void> {
    const toValue = getSipHeader(message, "to");
    const payload = String(body || "");
    const response = formatSipResponse({
      statusCode,
      reasonPhrase,
      headers: {
        Via: getSipHeader(message, "via"),
        From: getSipHeader(message, "from"),
        To: this.ensureToTag(toValue, toValue.includes(";tag=") ? toValue : `${toValue};tag=${randomTag("uas")}`),
        "Call-ID": getSipHeader(message, "call-id"),
        CSeq: getSipHeader(message, "cseq"),
        Contact: bindPort > 0 ? `<sip:n8n@${advertisedHost}:${bindPort}>` : undefined,
        ...(extraHeaders || {}),
      },
      body: payload,
    });
    await sendUdp(socket, response, rinfo.port, rinfo.address);
    this.storeServerTransactionResponse(this.buildTransactionKey(message), response);
  }

  private async sendInDialogRequest(socket: dgram.Socket, input: {
    method: string;
    requestUri: string;
    remoteAddress: string;
    remotePort: number;
    viaHost: string;
    from: string;
    to: string;
    callId: string;
    cseq: number;
    contactUri: string;
    extraHeaders?: Record<string, string | undefined>;
    body?: string;
    onTimeout?: (() => void) | null;
    onFinal?: (() => void) | null;
  }): Promise<void> {
    const request = formatSipRequest({
      method: input.method,
      requestUri: input.requestUri,
      headers: {
        Via: `SIP/2.0/UDP ${input.viaHost};branch=z9hG4bK-${randomTag("branch")}`,
        "Max-Forwards": 70,
        From: input.from,
        To: input.to,
        "Call-ID": input.callId,
        CSeq: `${input.cseq} ${input.method}`,
        Contact: `<${input.contactUri}>`,
        ...(input.extraHeaders || {}),
      },
      body: String(input.body || ""),
    });
    await this.sendTrackedRequest(socket, request, input.remoteAddress, input.remotePort, {
      onTimeout: input.onTimeout || null,
      onFinal: input.onFinal || null,
    });
  }

  private async sendOutboundCancel(session: OutboundSipSession): Promise<void> {
    const branch = String(session.inviteBranch || "").trim() || `z9hG4bK-${randomTag("branch")}`;
    const request = formatSipRequest({
      method: "CANCEL",
      requestUri: session.requestUri,
      headers: {
        Via: `SIP/2.0/UDP ${session.viaHost};branch=${branch}`,
        "Max-Forwards": 70,
        From: session.from,
        To: session.to,
        "Call-ID": session.callId,
        CSeq: `${session.cseq} CANCEL`,
        Contact: `<${session.contactUri}>`,
      },
      body: "",
    });
    await this.sendTrackedRequest(session.socket, request, session.remoteAddress, session.remotePort);
  }

  private async sendOutboundInvite(
    session: OutboundSipSession,
    options?: { onTimeout?: (() => void) | null },
  ): Promise<void> {
    let authorizationHeader: string | null = null;
    if (session.authChallenge) {
      if (!session.authUsername || !session.authPassword) {
        throw daemonError("sip_auth_missing", "Outbound SIP credentials are required for digest challenge");
      }
      const nonce = String(session.authChallenge.params.nonce || "").trim() || null;
      const nonceCount = nonce
        ? (session.lastAuthNonce === nonce ? session.authNonceCount + 1 : 1)
        : 1;
      authorizationHeader = buildSipDigestAuthorization({
        challenge: session.authChallenge,
        method: "INVITE",
        requestUri: session.requestUri,
        username: session.authUsername,
        password: session.authPassword,
        nc: Number(nonceCount).toString(16).padStart(8, "0"),
      });
      if (!authorizationHeader) {
        throw daemonError("sip_auth_invalid", "Failed to build outbound SIP digest authorization");
      }
      session.lastAuthNonce = nonce;
      session.authNonceCount = nonceCount;
    }
    const inviteBranch = `z9hG4bK-${randomTag("branch")}`;
    session.inviteBranch = inviteBranch;
    const invite = formatSipRequest({
      method: "INVITE",
      requestUri: session.requestUri,
      headers: {
        Via: `SIP/2.0/UDP ${session.viaHost};branch=${inviteBranch}`,
        "Max-Forwards": 70,
        From: session.from,
        To: session.to,
        "Call-ID": session.callId,
        CSeq: `${session.cseq} INVITE`,
        Contact: `<${session.contactUri}>`,
        "Content-Type": "application/sdp",
        ...(session.authorizationHeaderName === "authorization" ? { Authorization: authorizationHeader || undefined } : {}),
        ...(session.authorizationHeaderName === "proxy-authorization" ? { "Proxy-Authorization": authorizationHeader || undefined } : {}),
      },
      extraHeaders: session.inviteHeaders,
      body: session.localSdp,
    });
    await this.sendTrackedRequest(session.socket, invite, session.remoteAddress, session.remotePort, {
      onTimeout: options?.onTimeout || null,
    });
  }

  private async sendOutboundInviteAck(
    session: OutboundSipSession,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
  ): Promise<void> {
    await this.sendInDialogRequest(session.socket, {
      method: "ACK",
      requestUri: session.requestUri,
      remoteAddress: rinfo.address,
      remotePort: rinfo.port,
      viaHost: session.viaHost,
      from: session.from,
      to: this.ensureToTag(session.to, getSipHeader(message, "to")),
      callId: session.callId,
      cseq: session.cseq,
      contactUri: session.contactUri,
    });
  }

  private buildDtmfRelayBody(digits: string): string {
    return String(digits || "")
      .split("")
      .filter(Boolean)
      .map((digit) => `Signal=${digit}\r\nDuration=160`)
      .join("\r\n");
  }

  private parseDtmfRelayBody(body: string): string {
    return Array.from(String(body || "").matchAll(/Signal\s*=\s*([0-9A-D#*])/gi))
      .map((match) => String(match[1] || "").toUpperCase())
      .join("");
  }

  private buildInitialOutboundSdp(connectionIp: string, rtpPort: number): string {
    const localAudio = buildLocalAudioSdpDescription(rtpPort);
    if (!localAudio) {
      return "";
    }
    return buildLocalSipSdp({
      connectionIp,
      audioLines: localAudio.lines.slice(),
    });
  }

  private buildRenegotiatedSignalingDetails(
    legId: string,
    sdp: ReturnType<typeof parseSipSdp>,
    remoteAddress: string,
  ): Record<string, unknown> {
    const details = { ...(this.legService.requireLeg(legId).signalingDetails || {}) };
    delete details.audioCodecName;
    delete details.audioPayloadType;
    delete details.dtmfPayloadType;
    delete details.localSdpAudioLines;
    return {
      ...details,
      remoteRtpHost: sdp.remoteRtpHost || remoteAddress,
      remoteRtpPort: sdp.remoteRtpPort || 0,
      payloadTypes: sdp.payloadTypes,
      payloadCodecs: sdp.payloadCodecs,
    };
  }

  private prepareInboundRtpSession(
    legId: string,
    bindIp: string,
    advertisedIp: string,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
  ): void {
    const sdp = parseSipSdp(message.body || "");
    this.legService.updateSignalingDetails(legId, {
      ...(this.legService.requireLeg(legId).signalingDetails || {}),
      localRtpBindIp: bindIp,
      localRtpAdvertisedIp: advertisedIp,
      remoteRtpHost: sdp.remoteRtpHost || rinfo.address,
      remoteRtpPort: sdp.remoteRtpPort || 0,
      payloadTypes: sdp.payloadTypes,
      payloadCodecs: sdp.payloadCodecs,
    });
  }

  private buildLocalSdpForLeg(legId: string): string {
    const details = this.legService.requireLeg(legId).signalingDetails || {};
    const connectionIp = String(details.localRtpHost || details.localRtpAdvertisedIp || "").trim();
    const rtpPort = Number(details.localRtpPort || 0);
    if (!connectionIp || !rtpPort) {
      return "";
    }
    return buildLocalSipSdp({
      connectionIp,
      audioLines: this.readLocalSdpAudioLines(details.localSdpAudioLines),
    });
  }

  private async handleOutboundReinvite(
    session: OutboundSipSession,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
  ): Promise<void> {
    const transactionKey = this.beginServerTransaction(message);
    try {
      session.remoteAddress = rinfo.address;
      session.remotePort = rinfo.port;
      session.to = this.ensureToTag(session.to, getSipHeader(message, "from"));
      const sdp = parseSipSdp(message.body || "");
      this.legService.updateSignalingDetails(
        session.legId,
        this.buildRenegotiatedSignalingDetails(session.legId, sdp, rinfo.address),
      );
      await this.ensureMediaTransportEndpoint(session.legId);
      const contact = parseContactHeader(getSipHeader(message, "contact"));
      if (contact.uri) {
        session.requestUri = contact.uri;
      }
      const localSdp = this.buildLocalSdpForLeg(session.legId);
      await this.sendStatelessResponse(session.socket, message, rinfo, 200, "OK", "127.0.0.1", 0, {
        Contact: `<${session.contactUri}>`,
        "Content-Type": localSdp ? "application/sdp" : undefined,
      }, localSdp);
    } catch (error) {
      this.clearServerTransaction(transactionKey);
      throw error;
    }
  }

  private handleInboundAck(message: SipMessage): void {
    const callId = getSipHeader(message, "call-id");
    const session = this.findInboundSessionByCallId(callId);
    if (!session) {
      return;
    }
    this.clearInboundInviteSuccessRetransmission(session);
  }

  private armInboundInviteSuccessRetransmission(session: InboundSipSession): void {
    this.clearInboundInviteSuccessRetransmitTimer(session);
    if (!session.inviteSuccessResponse) {
      return;
    }
    session.inviteSuccessRetransmitTimer = setTimeout(() => {
      const live = this.inboundSessions.get(session.legId);
      if (!live || !live.inviteSuccessResponse) {
        return;
      }
      void sendUdp(live.socket, live.inviteSuccessResponse, live.remotePort, live.remoteAddress).catch((error) => {
        console.error(
          `[sip-pbx:signaling] inbound 200 OK retransmit failed; leg=${live.legId}; error=${this.errorMessage(error)}`,
        );
      });
      live.inviteSuccessIntervalMs = Math.min(live.inviteSuccessIntervalMs * 2, SIP_T2_MS);
      this.armInboundInviteSuccessRetransmission(live);
    }, session.inviteSuccessIntervalMs);
    (session.inviteSuccessRetransmitTimer as unknown as { unref?: () => void }).unref?.();
  }

  private clearInboundInviteSuccessRetransmission(session: InboundSipSession): void {
    this.clearInboundInviteSuccessRetransmitTimer(session);
    session.inviteSuccessResponse = null;
    session.inviteSuccessIntervalMs = SIP_T1_MS;
  }

  private clearInboundInviteSuccessRetransmitTimer(session: InboundSipSession): void {
    if (session.inviteSuccessRetransmitTimer) {
      clearTimeout(session.inviteSuccessRetransmitTimer);
      session.inviteSuccessRetransmitTimer = null;
    }
  }

  private clearInboundSession(legId: string): void {
    const session = this.inboundSessions.get(legId);
    if (!session) {
      return;
    }
    this.clearInboundInviteSuccessRetransmission(session);
    this.inboundSessions.delete(legId);
  }

  private readLocalSdpAudioLines(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.map((line) => String(line || "").trim()).filter(Boolean);
  }

  private async resolveOutboundTarget(dial: SignalingDialView, target: DialTarget): Promise<{
    socket: dgram.Socket | null;
    ownsSocket: boolean;
    requestUri: string;
    remoteAddress: string;
    remotePort: number;
    localBindIp: string;
    localBindPort: number;
    publicHost: string;
    callerUser: string;
    authUsername: string;
    authPassword: string;
    headers: SipHeaderEntry[];
  } | null> {
    const headers = this.normalizeHeaderEntries(dial.metadata.customSipHeaders);
    const destinationUser = normalizeDialDestinationUser(target.kind === "opaque" ? target.value : target.extensionNumber);
    if (dial.mode === "extension") {
      const extensionTarget: ExtensionDialTarget = target.kind === "extension"
        ? target
        : {
          kind: "extension",
          ref: String(dial.metadata.ref || "").trim(),
          extensionNumber: target.kind === "opaque" ? String(target.value || "").trim() : "",
          endpointId: "",
        };
      const ref = extensionTarget.ref.trim();
      const extensionNumber = extensionTarget.extensionNumber.trim();
      const endpointId = extensionTarget.endpointId.trim();
      const registration = this.extensionService.getRegistration(ref, extensionNumber, endpointId || undefined);
      if (!registration) {
        return null;
      }
      const configHost = this.extensionsHosts.get(ref);
      if (!configHost) {
        return null;
      }
      const contactUri = String(registration.contactUri || "").trim();
      const contact = parseSipUri(contactUri);
      const remoteAddress = String(registration.sourceIp || (contact && contact.host) || "").trim();
      const remotePort = Number(registration.sourcePort || (contact && contact.port) || OPTION_DEFAULTS.sip.port);
      return {
        socket: configHost.socket,
        ownsSocket: false,
        requestUri: contactUri || `sip:${extensionNumber}@${remoteAddress}:${remotePort}`,
        remoteAddress,
        remotePort,
        localBindIp: configHost.bindIp,
        localBindPort: configHost.bindPort,
        publicHost: normalizeSipAdvertisedHost(configHost.advertisedIp, configHost.bindIp),
        callerUser: String(dial.metadata.callerNumber || "n8n"),
        authUsername: "",
        authPassword: "",
        headers,
      };
    }
    const trunkHost = dial.mode === "trunk"
      ? this.trunkHosts.get(String(dial.metadata.ref || "").trim()) || null
      : null;
    const credentials = trunkHost
      ? trunkHost.credentials
      : ((dial.metadata.sipCredentials && typeof dial.metadata.sipCredentials === "object")
        ? (dial.metadata.sipCredentials as Record<string, unknown>)
        : {});
    const remoteAddress = String(credentials.proxyServer || credentials.sipServer || "").trim();
    if (!remoteAddress) {
      return null;
    }
    const remotePort = Number(credentials.port || OPTION_DEFAULTS.sip.port);
    const requestDomain = String(credentials.sipServer || remoteAddress).trim();
    const requestUri = buildOutboundRequestUri(destinationUser, requestDomain, remotePort);
    if (!requestUri) {
      return null;
    }
    const localBindIp = trunkHost ? trunkHost.bindIp : normalizeSipBindIp(credentials.localBindIp);
    return {
      socket: trunkHost ? trunkHost.socket : null,
      ownsSocket: !trunkHost,
      requestUri,
      remoteAddress,
      remotePort,
      localBindIp,
      localBindPort: trunkHost ? trunkHost.bindPort : Number(credentials.localBindPort || 0),
      publicHost: normalizeSipAdvertisedHost(credentials.publicDomain, localBindIp),
      callerUser: String(dial.metadata.callerNumber || credentials.username || "n8n"),
      authUsername: String(credentials.username || "").trim(),
      authPassword: String(credentials.password || ""),
      headers,
    };
  }

  private normalizeHeaderEntries(value: unknown): SipHeaderEntry[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const entries: SipHeaderEntry[] = [];
    for (const raw of value) {
      if (raw && typeof raw === "object" && Object.prototype.hasOwnProperty.call(raw as Record<string, unknown>, "name")) {
        const name = String((raw as Record<string, unknown>).name || "").trim();
        if (name) {
          entries.push({ name, value: String((raw as Record<string, unknown>).value ?? "") });
        }
        continue;
      }
      const line = String(raw || "");
      const separator = line.indexOf(":");
      if (separator < 0) {
        continue;
      }
      const name = line.slice(0, separator).trim();
      if (name) {
        entries.push({ name, value: line.slice(separator + 1).trim() });
      }
    }
    return entries;
  }

  private hasValidTrunkRouteToken(host: TrunkHost, message: SipMessage): boolean {
    const requestUri = parseSipUri(String(message.requestUri || ""));
    return Boolean(requestUri && requestUri.parameters["n8n-route"] === host.routeToken);
  }

  private trunkNonceScope(host: TrunkHost): string {
    return `trunk:${host.bindIp}:${host.bindPort}`;
  }

  private extensionNonceScope(host: ExtensionsHost): string {
    return `${host.bindIp}:${host.bindPort}`;
  }

  private listHostsForEndpoint<H extends SipHostBase>(map: Map<string, H>, bindIp: string, bindPort: number): H[] {
    return Array.from(map.values())
      .filter((candidate) => candidate.bindIp === bindIp && candidate.bindPort === bindPort)
      .sort((left, right) => {
        const byPublicRef = String(left.publicRef || left.ref).localeCompare(String(right.publicRef || right.ref));
        return byPublicRef !== 0 ? byPublicRef : String(left.ref).localeCompare(String(right.ref));
      });
  }

  private listExtensionsHostsForEndpoint(bindIp: string, bindPort: number): ExtensionsHost[] {
    return this.listHostsForEndpoint(this.extensionsHosts, bindIp, bindPort);
  }

  private listTrunkHostsForEndpoint(bindIp: string, bindPort: number): TrunkHost[] {
    return this.listHostsForEndpoint(this.trunkHosts, bindIp, bindPort);
  }

  private extractTrunkRequestUser(message: SipMessage): string {
    const requestUser = String(parseSipUri(String(message.requestUri || ""))?.user || "").trim();
    if (requestUser) {
      return requestUser;
    }
    const toUser = String(parseSipUri(parseSipNameAddress(getSipHeader(message, "to")).uri || "")?.user || "").trim();
    if (toUser) {
      return toUser;
    }
    return String(parseSipUri(parseSipNameAddress(getSipHeader(message, "from")).uri || "")?.user || "").trim();
  }

  private async resolveTrunkAuth(
    host: TrunkHost,
    message: SipMessage,
    requestType: SipAuthRequestKind,
    authorization: ReturnType<typeof parseSipAuthorization>,
    rinfo: dgram.RemoteInfo,
  ): Promise<SipAuthOutcome> {
    if (host.registerMode) {
      return { allow: false, notApplicable: true };
    }
    const scopeKey = this.trunkNonceScope(host);
    const publicAuthorizationState = this.resolvePublicHostAuthorization(host, scopeKey, authorization);
    const username = String((authorization && authorization.params?.username) || this.extractTrunkRequestUser(message) || "").trim();
    const requestContext = this.buildAuthRequestContext({
      host,
      message,
      requestType,
      username,
      endpointExtension: "",
      publicAuthorization: publicAuthorizationState.authorization,
      authorization,
      rinfo,
    });
    const request = this.trunkAuthBridge.createRequest({
      ref: host.ref,
      publicRef: host.publicRef || host.ref,
      requestContext,
      timeout: host.authTimeoutMs,
    });
    const response = await this.authService.waitForResolution(request.authRequestId);
    return this.applyInteractiveAuthResponse(
      host,
      scopeKey,
      message,
      authorization,
      response,
      {
        verifyUsername: String(authorization?.params?.username || this.extractTrunkRequestUser(message) || "").trim(),
        prevalidatedStale: publicAuthorizationState.stale,
      },
    );
  }

  private async handleDirectInboundTrunkByEndpoint(
    bindIp: string,
    bindPort: number,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
    requestType: SipAuthRequestKind,
  ): Promise<boolean> {
    const authorization = parseSipAuthorization(getSipHeader(message, "authorization"));
    let fallbackRejectResponse: SipAuthOutcome | null = null;
    let fallbackRejectHost: TrunkHost | null = null;
    for (const candidate of this.listTrunkHostsForEndpoint(bindIp, bindPort)) {
      const authResponse = await this.resolveTrunkAuth(candidate, message, requestType, authorization, rinfo);
      if (authResponse.notApplicable) {
        continue;
      }
      if (!authResponse.allow) {
        if (this.shouldContinueTrunkTraversalOnAuthReject(candidate, authResponse)) {
          fallbackRejectResponse = authResponse;
          fallbackRejectHost = candidate;
          continue;
        }
        return await this.processInboundServerTransaction(candidate.socket, message, rinfo, async () => {
          await this.sendTrunkAuthFailure(candidate, message, rinfo, authResponse);
        });
      }
      return await this.processInboundServerTransaction(candidate.socket, message, rinfo, async () => {
        if (requestType === "register") {
          const contact = parseContactHeader(getSipHeader(message, "contact"));
          const expires = this.resolveRegisterExpires(message, contact.parameters);
          await this.sendStatelessResponse(candidate.socket, message, rinfo, 200, "OK", candidate.advertisedIp, candidate.bindPort, {
            Contact: contact.uri ? `<${contact.uri}>;expires=${Math.max(0, expires)}` : undefined,
          });
        } else {
          await this.startInboundTrunkInvite(candidate, message, rinfo);
        }
      });
    }
    if (fallbackRejectResponse && fallbackRejectHost) {
      return await this.processInboundServerTransaction(fallbackRejectHost.socket, message, rinfo, async () => {
        await this.sendTrunkAuthFailure(fallbackRejectHost, message, rinfo, fallbackRejectResponse);
      });
    }
    return false;
  }

  private async handleOrderedTrunkInviteByEndpoint(
    bindIp: string,
    bindPort: number,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
  ): Promise<boolean> {
    const candidates = this.listTrunkHostsForEndpoint(bindIp, bindPort);
    const routeMatched = candidates.find((candidate) => candidate.registerMode && this.hasValidTrunkRouteToken(candidate, message)) || null;
    if (routeMatched) {
      return await this.processInboundServerTransaction(routeMatched.socket, message, rinfo, async () => {
        await this.startInboundTrunkInvite(routeMatched, message, rinfo);
      });
    }
    return await this.handleDirectInboundTrunkByEndpoint(bindIp, bindPort, message, rinfo, "invite");
  }

  private resolveRegisterExpires(message: SipMessage, contactParameters: Record<string, string>): number {
    const contactExpires = Number(contactParameters.expires || NaN);
    if (Number.isFinite(contactExpires)) {
      return contactExpires;
    }
    const headerExpires = Number(getSipHeader(message, "expires") || NaN);
    if (Number.isFinite(headerExpires)) {
      return headerExpires;
    }
    return OPTION_DEFAULTS.sip.registrationExpiresSeconds;
  }

  private extractEndpointExtension(message: SipMessage): string {
    const toUri = parseSipNameAddress(getSipHeader(message, "to")).uri;
    return String(parseSipUri(toUri || "")?.user || "").trim();
  }

  private ensureToTag(originalTo: string, updatedTo: string): string {
    if (updatedTo && updatedTo.includes(";tag=")) {
      return updatedTo;
    }
    if (originalTo.includes(";tag=")) {
      return originalTo;
    }
    return `${originalTo};tag=${randomTag("uas")}`;
  }

  private toHeaderWithTag(value: string, tag: string): string {
    if (value.includes(";tag=")) {
      return value;
    }
    return `${value};tag=${tag}`;
  }

  private viaHostFromContactUri(contactUri: string): string {
    return contactUri.replace(/^sip:[^@]+@/, "");
  }

  private buildTransactionKey(message: SipMessage): string {
    const via = getSipHeader(message, "via");
    const branch = this.extractViaBranch(via);
    const cseq = parseCseq(getSipHeader(message, "cseq"));
    const callId = getSipHeader(message, "call-id");
    const method = cseq.method || String(message.method || "").toUpperCase();
    if (!branch || !callId || !method) {
      return "";
    }
    return `${branch}|${method}|${callId}`;
  }

  private extractViaBranch(via: string): string {
    const match = String(via || "").match(/;branch=([^;\s]+)/i);
    return match ? String(match[1] || "").trim() : "";
  }

  private async sendTrackedRequest(
    socket: dgram.Socket,
    request: string,
    remoteAddress: string,
    remotePort: number,
    options?: { onTimeout?: (() => void) | null; onFinal?: (() => void) | null },
  ): Promise<void> {
    const message = parseSipMessage(request);
    const method = String(message?.method || "").toUpperCase();
    let transactionKey = "";
    if (message && method && method !== "ACK") {
      transactionKey = this.createOutboundTransaction({
        socket,
        request,
        remoteAddress,
        remotePort,
        message,
        onTimeout: options?.onTimeout || null,
        onFinal: options?.onFinal || null,
      });
    }
    try {
      await sendUdp(socket, request, remotePort, remoteAddress);
    } catch (error) {
      if (transactionKey) {
        this.clearOutboundTransaction(transactionKey);
      }
      throw error;
    }
  }

  private createOutboundTransaction(input: {
    socket: dgram.Socket;
    request: string;
    remoteAddress: string;
    remotePort: number;
    message: SipMessage;
    onTimeout?: (() => void) | null;
    onFinal?: (() => void) | null;
  }): string {
    const key = this.buildTransactionKey(input.message);
    const method = parseCseq(getSipHeader(input.message, "cseq")).method || String(input.message.method || "").toUpperCase();
    if (!key || !method) {
      return "";
    }
    this.clearOutboundTransaction(key);
    const isInvite = method === "INVITE";
    const transaction: OutboundSipTransaction = {
      key,
      socket: input.socket,
      request: input.request,
      remoteAddress: input.remoteAddress,
      remotePort: input.remotePort,
      method,
      isInvite,
      state: isInvite ? "calling" : "trying",
      intervalMs: SIP_T1_MS,
      timeoutTimer: null,
      retransmitTimer: null,
      onTimeout: input.onTimeout || null,
      onFinal: input.onFinal || null,
    };
    transaction.timeoutTimer = setTimeout(() => {
      this.clearOutboundTransaction(transaction.key);
      try {
        transaction.onTimeout?.();
      } catch (error) {
        console.error(
          `[sip-pbx:signaling] outbound transaction timeout callback failed; key=${transaction.key}; error=${this.errorMessage(error)}`,
        );
      }
    }, SIP_TRANSACTION_LIFETIME_MS);
    (transaction.timeoutTimer as unknown as { unref?: () => void }).unref?.();
    this.outboundTransactions.set(transaction.key, transaction);
    this.armOutboundRetransmission(transaction);
    return key;
  }

  private armOutboundRetransmission(transaction: OutboundSipTransaction): void {
    if (transaction.retransmitTimer) {
      clearTimeout(transaction.retransmitTimer);
      transaction.retransmitTimer = null;
    }
    const delay = transaction.intervalMs;
    transaction.retransmitTimer = setTimeout(() => {
      const live = this.outboundTransactions.get(transaction.key);
      if (!live) {
        return;
      }
      if (live.isInvite && live.state !== "calling") {
        return;
      }
      if (!live.isInvite && !["trying", "proceeding"].includes(live.state)) {
        return;
      }
      void sendUdp(live.socket, live.request, live.remotePort, live.remoteAddress).catch((error) => {
        console.error(
          `[sip-pbx:signaling] outbound transaction retransmit failed; key=${live.key}; error=${this.errorMessage(error)}`,
        );
      });
      if (live.isInvite) {
        live.intervalMs = Math.min(live.intervalMs * 2, SIP_TRANSACTION_LIFETIME_MS);
      } else if (live.state === "trying") {
        live.intervalMs = Math.min(live.intervalMs * 2, SIP_T2_MS);
      } else {
        live.intervalMs = SIP_T2_MS;
      }
      this.armOutboundRetransmission(live);
    }, delay);
    (transaction.retransmitTimer as unknown as { unref?: () => void }).unref?.();
  }

  private noteOutboundTransactionResponse(message: SipMessage): void {
    const key = this.buildTransactionKey(message);
    if (!key) {
      return;
    }
    const transaction = this.outboundTransactions.get(key);
    if (!transaction) {
      return;
    }
    const statusCode = Number(message.statusCode || 0);
    if (statusCode >= 100 && statusCode < 200) {
      if (transaction.isInvite) {
        transaction.state = "proceeding";
        if (transaction.retransmitTimer) {
          clearTimeout(transaction.retransmitTimer);
          transaction.retransmitTimer = null;
        }
      } else {
        transaction.state = "proceeding";
        transaction.intervalMs = SIP_T2_MS;
        this.armOutboundRetransmission(transaction);
      }
      return;
    }
    try {
      transaction.onFinal?.();
    } catch (error) {
      console.error(
        `[sip-pbx:signaling] outbound transaction final callback failed; key=${transaction.key}; error=${this.errorMessage(error)}`,
      );
    }
    this.clearOutboundTransaction(key);
  }

  private clearOutboundTransaction(key: string): void {
    const transaction = this.outboundTransactions.get(key);
    if (!transaction) {
      return;
    }
    if (transaction.timeoutTimer) {
      clearTimeout(transaction.timeoutTimer);
    }
    if (transaction.retransmitTimer) {
      clearTimeout(transaction.retransmitTimer);
    }
    this.outboundTransactions.delete(key);
  }

  private clearTransactionsForSocket(socket: dgram.Socket): void {
    for (const [key, transaction] of this.outboundTransactions.entries()) {
      if (transaction.socket !== socket) {
        continue;
      }
      this.clearOutboundTransaction(key);
    }
  }

  private clearTransactionsForCallId(callId: string): void {
    const normalizedCallId = String(callId || "").trim();
    if (!normalizedCallId) {
      return;
    }
    for (const [key] of this.outboundTransactions.entries()) {
      if (!key.endsWith(`|${normalizedCallId}`)) {
        continue;
      }
      this.clearOutboundTransaction(key);
    }
  }

  private beginServerTransaction(message: SipMessage): string {
    const key = this.buildTransactionKey(message);
    if (!key || this.serverTransactions.has(key)) {
      return key;
    }
    const timer = setTimeout(() => {
      this.clearServerTransaction(key);
    }, SIP_TRANSACTION_LIFETIME_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.serverTransactions.set(key, {
      processing: true,
      response: null,
      timer,
    });
    return key;
  }

  private async replayServerTransaction(
    socket: dgram.Socket,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
  ): Promise<boolean> {
    const key = this.buildTransactionKey(message);
    if (!key) {
      return false;
    }
    const transaction = this.serverTransactions.get(key);
    if (!transaction) {
      return false;
    }
    if (transaction.response) {
      await sendUdp(socket, transaction.response, rinfo.port, rinfo.address);
    }
    return true;
  }

  private storeServerTransactionResponse(key: string, response: string): void {
    if (!key) {
      return;
    }
    let transaction = this.serverTransactions.get(key);
    if (!transaction) {
      const timer = setTimeout(() => {
        this.clearServerTransaction(key);
      }, SIP_TRANSACTION_LIFETIME_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
      transaction = {
        processing: false,
        response,
        timer,
      };
      this.serverTransactions.set(key, transaction);
      return;
    }
    transaction.processing = false;
    transaction.response = response;
  }

  private clearServerTransaction(key: string): void {
    const transaction = this.serverTransactions.get(key);
    if (!transaction) {
      return;
    }
    if (transaction.timer) {
      clearTimeout(transaction.timer);
    }
    this.serverTransactions.delete(key);
  }

  private findInboundSessionByCallId(callId: string): InboundSipSession | null {
    if (!callId) {
      return null;
    }
    for (const session of this.inboundSessions.values()) {
      if (session.callId === callId) {
        return session;
      }
    }
    return null;
  }

  private findInboundSessionByInvite(callId: string, cseqSequence: number): InboundSipSession | null {
    if (!callId || !Number.isFinite(cseqSequence) || cseqSequence <= 0) {
      return null;
    }
    for (const session of this.inboundSessions.values()) {
      if (session.callId === callId && session.cseq === cseqSequence) {
        return session;
      }
    }
    return null;
  }

  private reasonPhraseFromHangup(reason: string): string {
    if (reason === "busy") {
      return "Busy Here";
    }
    if (reason === "rejected") {
      return "Decline";
    }
    return "Decline";
  }
}

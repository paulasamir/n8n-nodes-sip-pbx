import dgram from "dgram";
import { randomBytes } from "crypto";
import os from "os";
import type { AddressInfo } from "net";
import { OPTION_DEFAULTS } from "../../../shared/option-defaults";
import { LEG_STATUS_ENDED } from "../../../shared/result-events";
import { LegCoordinator } from "../../legs/leg-coordinator";
import { daemonError } from "../../core/daemon-error";
import { InteractiveAuthService } from "../../extensions-auth/interactive-auth-service";
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

type ExtensionsHost = {
  ref: string;
  publicRef: string;
  socket: dgram.Socket;
  bindIp: string;
  bindPort: number;
  advertisedIp: string;
  realm: string;
  authMode: string;
  authorizationUsernamePrefix: string;
  continueTraversalOnAuthReject: boolean;
  staticCredentials: Array<{ username: string; password: string; extension: string }>;
};

type TrunkHost = {
  ref: string;
  publicRef: string;
  routeToken: string;
  socket: dgram.Socket;
  bindIp: string;
  bindPort: number;
  credentials: Record<string, unknown>;
  registerOnStart: boolean;
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

type ExtensionsAuthResolution = {
  allow: boolean;
  extension?: string;
  statusCode?: number;
  reasonPhrase?: string;
  stale?: boolean;
  notApplicable?: boolean;
  challenge?: boolean;
};

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

function normalizeExtensionsBindPort(value: unknown): number {
  if (value == null || value === "") {
    return OPTION_DEFAULTS.trigger.extensions.localBindPort;
  }
  const port = Number(value);
  return Number.isFinite(port) ? port : OPTION_DEFAULTS.trigger.extensions.localBindPort;
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

function canShareUdpEndpoint(existing: { bindIp: string; bindPort: number }, bindIp: string, bindPort: number): boolean {
  return existing.bindIp === bindIp && bindPort > 0 && existing.bindPort === bindPort;
}

function trunkRegistrationIdentity(credentials: Record<string, unknown>): string {
  return [
    credentials.sipServer,
    credentials.port,
    credentials.username,
    credentials.publicDomain,
    credentials.realm,
    credentials.proxyServer,
  ].map((value) => String(value || "").trim()).join("|");
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
  private readonly ensureMediaTransportEndpoint: (legId: string) => Promise<Record<string, unknown>>;
  private readonly onAttemptRinging: (legId: string) => void;
  private readonly onAttemptProgress: (legId: string) => void;
  private readonly onAttemptAnswered: (legId: string) => void;
  private readonly onAttemptRejected: (legId: string, reason: string) => void;
  private readonly onInboundDtmf: (legId: string, digits: string) => void;
  private readonly extensionsHosts = new Map<string, ExtensionsHost>();
  private readonly trunkHosts = new Map<string, TrunkHost>();
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
    const transports = Array.isArray(config.extensionTransports)
      ? (config.extensionTransports as unknown[]).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
      : [String(config.transport || OPTION_DEFAULTS.sip.transport).trim().toLowerCase()].filter(Boolean);
    const normalizedTransports = transports.length > 0 ? Array.from(new Set(transports)) : [...OPTION_DEFAULTS.trigger.extensions.transports];
    const unsupportedTransports = normalizedTransports.filter((transport) => transport !== OPTION_DEFAULTS.sip.transport);
    if (unsupportedTransports.length > 0) {
      throw daemonError("unsupported_transport", `Extensions trigger transports ${unsupportedTransports.join(", ")} are not implemented`);
    }
    const bindIp = normalizeSipBindIp(config.extensionsLocalBindIp);
    const bindPort = normalizeExtensionsBindPort(config.extensionsLocalBindPort);
    const existing = this.extensionsHosts.get(ref);
    if (existing && canReuseUdpEndpointForSameRef(existing, bindIp, bindPort)) {
      existing.publicRef = publicRef;
      existing.advertisedIp = normalizeSipAdvertisedHost(config.advertisedIp, existing.bindIp);
      existing.realm = String(config.realm || existing.advertisedIp || "extensions.local");
      existing.authMode = String(config.authMode || OPTION_DEFAULTS.trigger.extensions.authMode);
      existing.authorizationUsernamePrefix = normalizeAuthorizationUsernamePrefix(config.authorizationUsernamePrefix);
      existing.continueTraversalOnAuthReject = config.continueTraversalOnAuthReject === true;
      existing.staticCredentials = Array.isArray(config.staticCredentials)
        ? (config.staticCredentials as Array<Record<string, unknown>>).map((entry) => ({
            username: String(entry.username || "").trim(),
            password: String(entry.password || "").trim(),
            extension: String(entry.extension || "").trim(),
          }))
        : [];
      return;
    }
    const shared = Array.from(this.extensionsHosts.values()).find((candidate) => canShareUdpEndpoint(candidate, bindIp, bindPort)) || null;
    if (shared) {
      const advertisedIp = normalizeSipAdvertisedHost(config.advertisedIp, shared.bindIp);
      const realm = String(config.realm || advertisedIp || "extensions.local");
      if (shared.realm !== realm) {
        throw daemonError("configuration_error", "Extensions triggers sharing a SIP listener must use the same realm");
      }
      await this.deactivateExtensionsTrigger(ref);
      this.extensionsHosts.set(ref, {
        ref,
        publicRef,
        socket: shared.socket,
        bindIp: shared.bindIp,
        bindPort: shared.bindPort,
        advertisedIp,
        realm,
        authMode: String(config.authMode || OPTION_DEFAULTS.trigger.extensions.authMode),
        authorizationUsernamePrefix: normalizeAuthorizationUsernamePrefix(config.authorizationUsernamePrefix),
        continueTraversalOnAuthReject: config.continueTraversalOnAuthReject === true,
        staticCredentials: Array.isArray(config.staticCredentials)
          ? (config.staticCredentials as Array<Record<string, unknown>>).map((entry) => ({
              username: String(entry.username || "").trim(),
              password: String(entry.password || "").trim(),
              extension: String(entry.extension || "").trim(),
            }))
          : [],
      });
      return;
    }
    await this.deactivateExtensionsTrigger(ref);
    const socket = dgram.createSocket("udp4");
    const address = await waitForUdpBind(socket, bindPort, bindIp);
    const advertisedIp = normalizeSipAdvertisedHost(config.advertisedIp, address.address || bindIp);
    const host: ExtensionsHost = {
      ref,
      publicRef,
      socket,
      bindIp: String(address.address || bindIp),
      bindPort: Number(address.port || bindPort),
      advertisedIp,
      realm: String(config.realm || advertisedIp || "extensions.local"),
      authMode: String(config.authMode || OPTION_DEFAULTS.trigger.extensions.authMode),
      authorizationUsernamePrefix: normalizeAuthorizationUsernamePrefix(config.authorizationUsernamePrefix),
      continueTraversalOnAuthReject: config.continueTraversalOnAuthReject === true,
      staticCredentials: Array.isArray(config.staticCredentials)
        ? (config.staticCredentials as Array<Record<string, unknown>>).map((entry) => ({
            username: String(entry.username || "").trim(),
            password: String(entry.password || "").trim(),
            extension: String(entry.extension || "").trim(),
          }))
        : [],
    };
    socket.on("message", (message, rinfo) => {
      void this.handleExtensionsPacket(host, message, rinfo).catch((error) => {
        console.error(
          `[sip-pbx:signaling] extensions packet handling failed; ref=${host.ref}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
        );
      });
    });
    this.extensionsHosts.set(ref, host);
  }

  async deactivateExtensionsTrigger(ref: string): Promise<void> {
    const host = this.extensionsHosts.get(ref);
    if (!host) {
      return;
    }
    this.extensionsHosts.delete(ref);
    const listenerStillUsed = Array.from(this.extensionsHosts.values()).some((candidate) => candidate.socket === host.socket);
    if (!listenerStillUsed) {
      this.clearTransactionsForSocket(host.socket);
      host.socket.close();
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
    const transport = String(credentials.transport || OPTION_DEFAULTS.sip.transport).toLowerCase();
    if (transport !== OPTION_DEFAULTS.sip.transport) {
      throw daemonError("unsupported_transport", `Trunk trigger transport ${transport} is not implemented`);
    }
    const bindIp = normalizeSipBindIp(credentials.localBindIp);
    const bindPort = Number(credentials.localBindPort || 0);
    const existing = this.trunkHosts.get(ref);
    if (existing && canReuseUdpEndpointForSameRef(existing, bindIp, bindPort)) {
      const nextRegisterOnStart = Boolean(config.registerOnStart);
      const replaceRegistration = Boolean(
        existing.registration
        && trunkRegistrationIdentity(existing.credentials) !== trunkRegistrationIdentity(credentials),
      );
      this.clearTrunkRegistrationTimer(existing);
      if (existing.registration && (!nextRegisterOnStart || replaceRegistration)) {
        try {
          await this.sendTrunkRegister(existing, { expiresSeconds: 0 });
        } catch (error) {
          console.error(
            `[sip-pbx:signaling] trunk unregister during trigger reuse failed; ref=${ref}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
          );
        }
        existing.registration = null;
      }
      existing.credentials = credentials;
      existing.registerOnStart = nextRegisterOnStart;
      existing.registrationExpires = Number(config.registrationExpires || OPTION_DEFAULTS.sip.registrationExpiresSeconds);
      existing.registerHeaders = this.normalizeHeaderEntries(config.registerHeaders);
      if (existing.registerOnStart) {
        await this.sendTrunkRegister(existing);
      }
      return;
    }
    await this.deactivateTrunkTrigger(ref);
    const socket = dgram.createSocket("udp4");
    const address = await waitForUdpBind(socket, bindPort, bindIp);
    const host: TrunkHost = {
      ref,
      publicRef,
      routeToken: randomTag("route"),
      socket,
      bindIp: String(address.address || bindIp),
      bindPort: Number(address.port || bindPort),
      credentials,
      registerOnStart: Boolean(config.registerOnStart),
      registrationExpires: Number(config.registrationExpires || OPTION_DEFAULTS.sip.registrationExpiresSeconds),
      registerHeaders: this.normalizeHeaderEntries(config.registerHeaders),
      registrationTimer: null,
      registration: null,
    };
    socket.on("message", (message, rinfo) => {
      void this.handleTrunkPacket(host, message, rinfo).catch((error) => {
        console.error(
          `[sip-pbx:signaling] trunk packet handler failed; ref=${host.ref}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
        );
      });
    });
    this.trunkHosts.set(ref, host);
    if (host.registerOnStart) {
      await this.sendTrunkRegister(host);
    }
  }

  async deactivateTrunkTrigger(ref: string): Promise<void> {
    const host = this.trunkHosts.get(ref);
    if (!host) {
      return;
    }
    host.registerOnStart = false;
    this.clearTrunkRegistrationTimer(host);
    this.trunkHosts.delete(ref);
    if (host.registration) {
      try {
        await this.sendTrunkRegister(host, { expiresSeconds: 0 });
      } catch (error) {
        console.error(
          `[sip-pbx:signaling] trunk unregister during trigger deactivate failed; ref=${ref}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
        );
      }
    }
    host.registration = null;
    this.clearTransactionsForSocket(host.socket);
    host.socket.close();
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
              `[sip-pbx:signaling] outbound packet handling failed; leg=${legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
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
      onTimeout: () => {
        if (!this.outboundSessions.has(legId)) {
          return;
        }
        this.clearTransactionsForCallId(session.callId);
        this.outboundSessions.delete(legId);
        try {
          if (session.ownsSocket) {
            socket.close();
          }
        } catch (error) {
          console.error(
            `[sip-pbx:signaling] outbound attempt socket close failed on timeout; leg=${legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
          );
        }
        this.onAttemptRejected(legId, "transaction_timeout");
      },
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
            viaHost: inbound.contactUri.replace(/^sip:[^@]+@/, ""),
            from: this.toHeaderWithTag(inbound.to, inbound.localTag),
            to: inbound.from,
            callId: inbound.callId,
            cseq: inbound.cseq + 1,
            contactUri: inbound.contactUri,
          }).catch((error) => {
            console.error(
              `[sip-pbx:signaling] inbound BYE send failed; leg=${legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
            );
          });
        } else {
          await this.sendInboundResponse(inbound, 603, this.reasonPhraseFromHangup(reason)).catch((error) => {
            console.error(
              `[sip-pbx:signaling] inbound reject response failed; leg=${legId}; reason=${reason}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
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
          viaHost: outbound.contactUri.replace(/^sip:[^@]+@/, ""),
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
            `[sip-pbx:signaling] outbound BYE failed; leg=${legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
          );
          this.clearTransactionsForCallId(outbound.callId);
          this.finalizeOutboundSocket(outbound);
        });
      } else if (outbound.state === "inviting") {
        outbound.state = "cancelling";
        await this.sendOutboundCancel(outbound).catch((error) => {
          console.error(
            `[sip-pbx:signaling] outbound CANCEL failed; leg=${legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
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
        viaHost: inbound.contactUri.replace(/^sip:[^@]+@/, ""),
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
        viaHost: outbound.contactUri.replace(/^sip:[^@]+@/, ""),
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

  private async withLegLock<T>(legId: string, callback: () => Promise<T> | T): Promise<T> {
    return await this.legCoordinator.withLeg(legId, callback);
  }

  closeAll(): void {
    const activeLegIds = new Set<string>([
      ...this.inboundSessions.keys(),
      ...this.outboundStartups.keys(),
      ...this.outboundSessions.keys(),
    ]);
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
    const host = this.extensionsHosts.get(ref);
    if (!host) {
      return null;
    }
    return { host: normalizeLocalEndpointHost(host.bindIp), port: host.bindPort };
  }

  getTrunkEndpoint(ref: string): { host: string; port: number } | null {
    const host = this.trunkHosts.get(ref);
    if (!host) {
      return null;
    }
    return { host: normalizeLocalEndpointHost(host.bindIp), port: host.bindPort };
  }

  private getTrunkAdvertisedHost(host: TrunkHost): string {
    return normalizeSipAdvertisedHost(host.credentials.publicDomain, host.bindIp);
  }

  private async handleExtensionsPacket(host: ExtensionsHost, rawMessage: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    const message = parseSipMessage(rawMessage);
    if (!message) {
      return;
    }
    if (message.statusCode) {
      const outboundSession = this.findOutboundSession(host.socket, message);
      if (outboundSession) {
        await this.handleOutboundSessionMessage(outboundSession, message, rinfo);
        return;
      }
      this.noteOutboundTransactionResponse(message);
      return;
    }
    if (!message.method) {
      return;
    }
    try {
      if (message.method === "REGISTER") {
        await this.handleExtensionsRegister(host, message, rinfo);
        return;
      }
      if (message.method === "INVITE") {
        const outboundSession = this.findOutboundSession(host.socket, message);
        if (outboundSession) {
          await this.handleOutboundSessionMessage(outboundSession, message, rinfo);
          return;
        }
        await this.handleExtensionsInvite(host, message, rinfo);
        return;
      }
      if (message.method === "CANCEL") {
        await this.handleInboundCancel(host.socket, host.advertisedIp, host.bindPort, message, rinfo);
        return;
      }
      if (message.method === "ACK") {
        this.handleInboundAck(message);
        return;
      }
      if (message.method === "BYE") {
        const outboundSession = this.findOutboundSession(host.socket, message);
        if (outboundSession) {
          await this.handleOutboundSessionMessage(outboundSession, message, rinfo);
          return;
        }
        await this.handleInDialogBye(host.socket, host.advertisedIp, host.bindPort, message, rinfo);
        return;
      }
      if (message.method === "INFO") {
        const outboundSession = this.findOutboundSession(host.socket, message);
        if (outboundSession) {
          await this.handleOutboundSessionMessage(outboundSession, message, rinfo);
          return;
        }
        await this.handleInDialogInfo(message, rinfo);
        return;
      }
      await this.sendNotImplementedResponse(host.socket, message, rinfo, host.advertisedIp, host.bindPort, ["REGISTER", "INVITE", "CANCEL", "ACK", "BYE", "INFO"]);
    } catch (error) {
      this.reportSipPacketError("extensions", message, error);
      await this.sendInternalErrorResponse(host.socket, message, rinfo, host.advertisedIp, host.bindPort);
    }
  }

  private async handleTrunkPacket(host: TrunkHost, rawMessage: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    const message = parseSipMessage(rawMessage);
    if (!message) {
      return;
    }
    try {
      if (message.statusCode) {
        const outboundSession = this.findOutboundSession(host.socket, message);
        if (outboundSession) {
          await this.handleOutboundSessionMessage(outboundSession, message, rinfo);
          return;
        }
        this.noteOutboundTransactionResponse(message);
        if (await this.handleTrunkRegisterResponse(host, message, rinfo)) {
          return;
        }
        return;
      }
      if (message.method === "INVITE") {
        const outboundSession = this.findOutboundSession(host.socket, message);
        if (outboundSession) {
          await this.handleOutboundSessionMessage(outboundSession, message, rinfo);
          return;
        }
        const advertisedHost = this.getTrunkAdvertisedHost(host);
        if (!this.hasValidTrunkRouteToken(host, message)) {
          await this.sendStatelessResponse(host.socket, message, rinfo, 404, "Not Found", advertisedHost, host.bindPort);
          return;
        }
        if (await this.replayServerTransaction(host.socket, message, rinfo)) {
          return;
        }
        const transactionKey = this.beginServerTransaction(message);
        try {
          const invite = this.createInboundInvite(host.ref, host.publicRef || host.ref, message, "sip");
          const result = this.trunkService.emitInboundInvite(invite);
          this.prepareInboundRtpSession(result.legId, host.bindIp, advertisedHost, message, rinfo);
          this.inboundSessions.set(result.legId, this.createInboundSession(host.socket, result.legId, message, rinfo, advertisedHost, host.bindPort));
          await this.sendStatelessResponse(host.socket, message, rinfo, 100, "Trying", advertisedHost, host.bindPort);
        } catch (error) {
          this.clearServerTransaction(transactionKey);
          throw error;
        }
        return;
      }
      if (message.method === "CANCEL") {
        await this.handleInboundCancel(host.socket, this.getTrunkAdvertisedHost(host), host.bindPort, message, rinfo);
        return;
      }
      if (message.method === "ACK") {
        this.handleInboundAck(message);
        return;
      }
      if (message.method === "BYE") {
        const outboundSession = this.findOutboundSession(host.socket, message);
        if (outboundSession) {
          await this.handleOutboundSessionMessage(outboundSession, message, rinfo);
          return;
        }
        await this.handleInDialogBye(host.socket, this.getTrunkAdvertisedHost(host), host.bindPort, message, rinfo);
        return;
      }
      if (message.method === "INFO") {
        const outboundSession = this.findOutboundSession(host.socket, message);
        if (outboundSession) {
          await this.handleOutboundSessionMessage(outboundSession, message, rinfo);
          return;
        }
        await this.handleInDialogInfo(message, rinfo);
        return;
      }
      await this.sendNotImplementedResponse(host.socket, message, rinfo, this.getTrunkAdvertisedHost(host), host.bindPort, ["INVITE", "CANCEL", "ACK", "BYE", "INFO"]);
    } catch (error) {
      this.reportSipPacketError("trunk", message, error);
      if (!message.statusCode) {
        await this.sendInternalErrorResponse(host.socket, message, rinfo, this.getTrunkAdvertisedHost(host), host.bindPort);
      }
    }
  }

  private async handleExtensionsRegister(host: ExtensionsHost, message: SipMessage, rinfo: dgram.RemoteInfo): Promise<void> {
    if (await this.replayServerTransaction(host.socket, message, rinfo)) {
      return;
    }
    const transactionKey = this.beginServerTransaction(message);
    try {
      const endpointExtension = this.extractEndpointExtension(message);
      const authorization = parseSipAuthorization(getSipHeader(message, "authorization"));
      let fallbackRejectResponse: ExtensionsAuthResolution | null = null;
      for (const candidate of this.listExtensionsHostsForListener(host)) {
        const authResponse = await this.resolveExtensionsAuth(candidate, message, "register", endpointExtension, authorization, rinfo);
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
        const extensionNumber = String(authResponse.extension || endpointExtension || "").trim();
        if (!extensionNumber) {
          await this.sendExtensionsAuthFailure(host, message, rinfo, { statusCode: 403, reasonPhrase: "Missing Extension" });
          return;
        }
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

  private async handleExtensionsInvite(host: ExtensionsHost, message: SipMessage, rinfo: dgram.RemoteInfo): Promise<void> {
    if (await this.replayServerTransaction(host.socket, message, rinfo)) {
      return;
    }
    const transactionKey = this.beginServerTransaction(message);
    try {
      const endpointExtension = this.extractEndpointExtension(message);
      const authorization = parseSipAuthorization(getSipHeader(message, "authorization"));
      let fallbackRejectResponse: ExtensionsAuthResolution | null = null;
      for (const candidate of this.listExtensionsHostsForListener(host)) {
        const authResponse = await this.resolveExtensionsAuth(candidate, message, "invite", endpointExtension, authorization, rinfo);
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
        const authenticatedExtensionNumber = String(authResponse.extension || "").trim();
        if (!authenticatedExtensionNumber) {
          await this.sendExtensionsAuthFailure(host, message, rinfo, { statusCode: 403, reasonPhrase: "Missing Extension" });
          return;
        }
        const contact = parseContactHeader(getSipHeader(message, "contact"));
        const invite = this.createInboundInvite(
          candidate.ref,
          candidate.publicRef || candidate.ref,
          message,
          "sip",
          authenticatedExtensionNumber,
          this.extensionService.resolveEndpointIdForTriggerLeg(candidate.ref, authenticatedExtensionNumber, {
            contactUri: contact.uri,
            sourceIp: rinfo.address,
            sourcePort: rinfo.port,
          }),
        );
        const result = this.extensionService.emitInboundInvite(invite);
        this.prepareInboundRtpSession(result.legId, candidate.bindIp, candidate.advertisedIp, message, rinfo);
        this.inboundSessions.set(result.legId, this.createInboundSession(candidate.socket, result.legId, message, rinfo, candidate.advertisedIp, candidate.bindPort));
        await this.sendStatelessResponse(candidate.socket, message, rinfo, 100, "Trying", candidate.advertisedIp, candidate.bindPort);
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
          viaHost: session.contactUri.replace(/^sip:[^@]+@/, ""),
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
        if (cseq.method === "CANCEL") {
          return;
        }
        return;
      }
      try {
        await this.sendOutboundInviteAck(session, message, rinfo);
      } catch (error) {
        console.error(
          `[sip-pbx:signaling] outbound INVITE ACK failed; leg=${session.legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
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
            onTimeout: () => {
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
                  `[sip-pbx:signaling] outbound auth retry socket close failed on timeout; leg=${session.legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
                );
              }
              this.onAttemptRejected(session.legId, "transaction_timeout");
            },
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

  private async sendTrunkRegister(host: TrunkHost, options?: {
    expiresSeconds?: number;
  }): Promise<void> {
    await this.sendTrunkRegisterRequest(host, null, options);
  }

  private async sendTrunkRegisterRequest(
    host: TrunkHost,
    challengeInput: {
      challenge: SipDigestAuthorization | null;
      headerName: "authorization" | "proxy-authorization";
      remoteAddress: string;
      remotePort: number;
    } | null,
    options?: {
      expiresSeconds?: number;
    },
  ): Promise<void> {
    const server = String(host.credentials.proxyServer || host.credentials.sipServer || "").trim();
    if (!server) {
      return;
    }
    const username = String(host.credentials.username || "n8n").trim() || "n8n";
    const password = String(host.credentials.password || "");
    const remotePort = Number(host.credentials.port || OPTION_DEFAULTS.sip.port);
    const domain = String(host.credentials.publicDomain || host.credentials.realm || host.credentials.sipServer || server);
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
    await this.sendTrunkRegisterRequest(host, {
      challenge,
      headerName: authHeaderName,
      remoteAddress: rinfo.address,
      remotePort: rinfo.port,
    });
    return true;
  }

  private scheduleTrunkRegistrationRefresh(host: TrunkHost, expiresSeconds: number): void {
    this.clearTrunkRegistrationTimer(host);
    const expiresMs = Math.max(1000, Math.floor(Number(expiresSeconds || 0) * 1000));
    if (!Number.isFinite(expiresMs) || expiresMs <= 0 || !host.registerOnStart) {
      return;
    }
    const refreshMs = Math.max(250, Math.min(expiresMs - 250, Math.floor(expiresMs * 0.85)));
    host.registrationTimer = setTimeout(() => {
      host.registrationTimer = null;
      if (!this.trunkHosts.has(host.ref) || !host.registerOnStart) {
        return;
      }
      void this.sendTrunkRegister(host).catch((error) => {
        console.error(
          `[sip-pbx:signaling] trunk registration refresh failed; ref=${host.ref}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
        );
      });
    }, refreshMs > 0 ? refreshMs : expiresMs);
    (host.registrationTimer as unknown as { unref?: () => void }).unref?.();
  }

  private scheduleTrunkRegistrationRetry(host: TrunkHost, delayMs: number): void {
    this.clearTrunkRegistrationTimer(host);
    const resolvedDelayMs = Math.max(250, Math.floor(Number(delayMs || SIP_REGISTER_RETRY_DELAY_MS)));
    if (!Number.isFinite(resolvedDelayMs) || !host.registerOnStart) {
      return;
    }
    host.registrationTimer = setTimeout(() => {
      host.registrationTimer = null;
      if (!this.trunkHosts.has(host.ref) || !host.registerOnStart) {
        return;
      }
      void this.sendTrunkRegister(host).catch((error) => {
        console.error(
          `[sip-pbx:signaling] trunk registration retry failed; ref=${host.ref}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
        );
      });
    }, resolvedDelayMs);
    (host.registrationTimer as unknown as { unref?: () => void }).unref?.();
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

  private verifyExtensionsDigestAuthorization(
    host: ExtensionsHost,
    message: SipMessage,
    authorization: ReturnType<typeof parseSipAuthorization>,
    username: string,
    password: string,
  ): { ok: true; stale: false; invalidNonce: false } | { ok: false; stale: boolean; invalidNonce: boolean } {
    const nonceValidation = this.extensionsDigestNonces.validate(this.extensionNonceScope(host), host.realm, authorization);
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

  private async resolveExtensionsAuth(
    host: ExtensionsHost,
    message: SipMessage,
    requestType: "register" | "invite",
    endpointExtension: string,
    authorization: ReturnType<typeof parseSipAuthorization>,
    rinfo: dgram.RemoteInfo,
  ): Promise<ExtensionsAuthResolution> {
    const method = String(message.method || "").toUpperCase();
    const normalizedAuthorizationUsername = this.resolveNormalizedAuthorizationUsername(host, authorization);
    if (authorization && host.authMode !== "raw" && !normalizedAuthorizationUsername.applicable) {
      return { allow: false, notApplicable: true };
    }
    const username = authorization
      ? normalizedAuthorizationUsername.username
      : String(endpointExtension || "");
    const publicAuthorizationState = this.resolvePublicExtensionsAuthorization(host, authorization);
    const publicAuthorization = publicAuthorizationState.authorization || undefined;
    const requestContext = {
      requestType,
      method,
      username,
      externalUsername: username,
      endpointExtension,
      realm: host.realm,
      hasAuthorization: Boolean(authorization),
      authorization: publicAuthorization,
      sourceIp: String(rinfo.address || ""),
      clientPort: Number(rinfo.port || 0),
      transport: OPTION_DEFAULTS.sip.transport,
      localIp: String(host.bindIp || ""),
      localPort: Number(host.bindPort || 0),
      raw: {
        startLine: message.startLine,
        method,
        requestUri: String(message.requestUri || ""),
        headers: Object.fromEntries(Object.entries(message.headers).map(([name, values]) => [name, values.join(", ")])),
        body: message.body || "",
      },
    };
    if (host.authMode === "static") {
      return this.resolveStaticAuth(host, message, endpointExtension, authorization, normalizedAuthorizationUsername.username);
    }
    if (host.authMode === "digest-first" && !authorization) {
      return { allow: false, statusCode: 401, reasonPhrase: "Unauthorized", challenge: true };
    }
    const request = this.extensionService.createAuthRequest({
      ref: host.ref,
      publicRef: host.publicRef || host.ref,
      requestContext,
    });
    const response = await this.authService.waitForResolution(request.authRequestId);
    return this.applyInteractiveAuthResponse(
      host,
      message,
      authorization,
      response,
      publicAuthorizationState.stale,
      normalizedAuthorizationUsername.username,
    );
  }

  private resolvePublicExtensionsAuthorization(
    host: ExtensionsHost,
    authorization: ReturnType<typeof parseSipAuthorization>,
  ): { authorization: ReturnType<typeof parseSipAuthorization> | null; stale: boolean } {
    if (!authorization || String(authorization.scheme || "").toLowerCase() !== "digest") {
      return { authorization: null, stale: false };
    }
    if (String(authorization.params?.realm || "").trim() !== String(host.realm || "").trim()) {
      return { authorization: null, stale: false };
    }
    const nonceValidation = this.extensionsDigestNonces.validate(this.extensionNonceScope(host), host.realm, authorization);
    if (!nonceValidation.ok) {
      return { authorization: null, stale: nonceValidation.stale === true };
    }
    return { authorization, stale: false };
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
  ): ExtensionsAuthResolution {
    if (!authorization) {
      return { allow: false, statusCode: 401, reasonPhrase: "Unauthorized", challenge: true };
    }
    const username = String(normalizedAuthorizationUsername || endpointExtension || "").trim();
    const verificationUsername = String((authorization && authorization.params?.username) || "").trim();
    const credential = host.staticCredentials.find((entry) => entry.username === username || entry.extension === endpointExtension);
    if (!credential) {
      return { allow: false, notApplicable: true };
    }
    const verified = this.verifyExtensionsDigestAuthorization(
      host,
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
    host: ExtensionsHost,
    message: SipMessage,
    authorization: ReturnType<typeof parseSipAuthorization>,
    response: SipInteractiveAuthDecision,
    prevalidatedAuthorizationStale = false,
    normalizedAuthorizationUsername = "",
  ): ExtensionsAuthResolution {
    if (response.action === "allow") {
      const extension = String(response.extension || normalizedAuthorizationUsername || "").trim();
      if (!extension) {
        return { allow: false, statusCode: 403, reasonPhrase: "Missing Extension" };
      }
      return { allow: true, extension };
    }
    if (response.action === "verify_password") {
      if (!authorization) {
        return { allow: false, statusCode: 401, reasonPhrase: "Unauthorized", challenge: true };
      }
      const username = String(normalizedAuthorizationUsername || "").trim();
      const verificationUsername = String((authorization.params?.username) || "").trim();
      const password = String(response.password || "");
      const verified = this.verifyExtensionsDigestAuthorization(
        host,
        message,
        authorization,
        verificationUsername || username,
        password,
      );
      if (verified.ok) {
        const extension = String(response.extension || username || "").trim();
        if (!extension) {
          return { allow: false, statusCode: 403, reasonPhrase: "Missing Extension" };
        }
        return { allow: true, extension };
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
        ? this.resolveInteractiveChallengeStale(host, authorization, prevalidatedAuthorizationStale)
        : false,
    };
  }

  private resolveInteractiveChallengeStale(
    host: ExtensionsHost,
    authorization: ReturnType<typeof parseSipAuthorization>,
    prevalidatedAuthorizationStale = false,
  ): boolean {
    if (prevalidatedAuthorizationStale) {
      return true;
    }
    if (!authorization) {
      return false;
    }
    const nonceValidation = this.extensionsDigestNonces.validate(this.extensionNonceScope(host), host.realm, authorization);
    return !nonceValidation.ok && nonceValidation.stale === true;
  }

  private shouldContinueExtensionsTraversalOnAuthReject(
    host: ExtensionsHost,
    response: ExtensionsAuthResolution,
  ): boolean {
    return host.continueTraversalOnAuthReject === true
      && !response.allow
      && !response.notApplicable
      && response.challenge !== true;
  }

  private async sendExtensionsAuthFailure(
    host: ExtensionsHost,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
    response: { statusCode?: number; reasonPhrase?: string; stale?: boolean; challenge?: boolean },
  ): Promise<void> {
    const statusCode = Number(response.statusCode || 401);
    const challengeNonce = response.challenge === true && (statusCode === 401 || statusCode === 407)
      ? this.extensionsDigestNonces.issue(this.extensionNonceScope(host), host.realm)
      : null;
    await this.sendStatelessResponse(host.socket, message, rinfo, statusCode, String(response.reasonPhrase || "Unauthorized"), host.advertisedIp, host.bindPort, {
      "WWW-Authenticate": challengeNonce ? buildSipDigestChallenge(host.realm, challengeNonce, { stale: Boolean(response.stale) }) : undefined,
    });
  }

  private async sendNotImplementedResponse(
    socket: dgram.Socket,
    message: SipMessage,
    rinfo: dgram.RemoteInfo,
    advertisedHost: string,
    bindPort: number,
    allowMethods: string[],
  ): Promise<void> {
    if (await this.replayServerTransaction(socket, message, rinfo)) {
      return;
    }
    const transactionKey = this.beginServerTransaction(message);
    try {
      await this.sendStatelessResponse(socket, message, rinfo, 501, "Not Implemented", advertisedHost, bindPort, {
        Allow: allowMethods.join(", "),
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
          `[sip-pbx:signaling] inbound 200 OK retransmit failed; leg=${live.legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
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
    const destinationUser = normalizeDialDestinationUser(target.kind === "opaque" ? target.value : target.extensionNumber);
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

  private extensionNonceScope(host: ExtensionsHost): string {
    return `${host.bindIp}:${host.bindPort}`;
  }

  private listExtensionsHostsForListener(host: ExtensionsHost): ExtensionsHost[] {
    return Array.from(this.extensionsHosts.values())
      .filter((candidate) => candidate.socket === host.socket)
      .sort((left, right) => String(left.publicRef || left.ref).localeCompare(String(right.publicRef || right.ref)));
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
          `[sip-pbx:signaling] outbound transaction timeout callback failed; key=${transaction.key}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
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
          `[sip-pbx:signaling] outbound transaction retransmit failed; key=${live.key}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
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
        `[sip-pbx:signaling] outbound transaction final callback failed; key=${transaction.key}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
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

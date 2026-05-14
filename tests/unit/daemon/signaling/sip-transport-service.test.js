"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("outbound SIP attempt serializes leg-end cleanup with startup and suppresses dialog creation before INVITE", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");

  let leg = {
    legId: "leg-race",
    status: "created",
    signalingDetails: {},
  };
  let socketClosed = 0;
  let inviteSent = 0;
  let cancelSent = 0;
  let ensureResolve;
  let ensureEnteredResolve = null;
  const ensureEntered = new Promise((resolve) => {
    ensureEnteredResolve = resolve;
  });

  const fakeSocket = {
    close() {
      socketClosed += 1;
    },
    on() {},
    address() {
      return { address: "127.0.0.1", port: 5090 };
    },
  };

  const service = new SipTransportService({
    legService: {
      getLeg(currentLegId) {
        return leg && leg.legId === currentLegId ? leg : null;
      },
      requireLeg(currentLegId) {
        if (!leg || leg.legId !== currentLegId) {
          throw new Error("missing leg");
        }
        return leg;
      },
      updateSignalingDetails(_legId, details) {
        leg = { ...leg, signalingDetails: { ...(details || {}) } };
        return leg;
      },
      hangupLeg() {},
    },
    extensionService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        return { action: "not_applicable" };
      },
    },
    ensureMediaTransportEndpoint() {
      ensureEnteredResolve();
      return new Promise((resolve) => {
        ensureResolve = resolve;
      });
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  service.resolveOutboundTarget = async () => ({
    socket: fakeSocket,
    ownsSocket: false,
    localBindIp: "127.0.0.1",
    localBindPort: 5090,
    publicHost: "127.0.0.1",
    remoteAddress: "185.185.41.30",
    remotePort: 5060,
    requestUri: "sip:n8n-user@185.185.41.30:5060",
    callerUser: "n8n",
    headers: {},
    authUsername: null,
    authPassword: null,
  });
  service.sendOutboundInvite = async () => {
    inviteSent += 1;
  };
  service.sendOutboundCancel = async () => {
    cancelSent += 1;
  };

  const startPromise = service.startAttempt(
    { dialId: "dial-race", mode: "extension", strategy: "parallel", metadata: {} },
    "leg-race",
    { kind: "extension", ref: "office-ext", extensionNumber: "100", endpointId: "contact:sip:n8n-user@185.185.41.30:5060" },
  );

  await ensureEntered;
  leg = { ...leg, status: "ended" };
  const teardownPromise = (async () => {
    await service.rejectOrHangupLeg("leg-race", "queue_entry_removed");
    await service.handleLegEnded("leg-race");
  })();
  ensureResolve({
    localRtpHost: "51.178.16.122",
    localRtpPort: 40000,
  });
  await Promise.all([startPromise, teardownPromise]);

  assert.strictEqual(inviteSent, 0);
  assert.strictEqual(cancelSent, 0);
  assert.strictEqual(service.outboundSessions.has("leg-race"), false);
  assert.strictEqual(socketClosed, 0);
});

test("extensions interactive auth exposes public auth only for listener-issued nonce and matching realm", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const {
    formatSipRequest,
    parseSipMessage,
    getSipHeader,
  } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");
  const {
    parseSipDigestChallenge,
    buildSipDigestAuthorization,
  } = require("../../../../build-src/daemon/signaling/sip/digest-auth.js");

  let lastSentPayload = "";
  const capturedRequestContexts = [];
  const fakeSocket = {
    send(buffer, _port, _host, callback) {
      lastSentPayload = Buffer.from(buffer).toString("utf8");
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails() {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      emitInboundInvite() {
        return { legId: "unused" };
      },
      createAuthRequest(input) {
        capturedRequestContexts.push(input.requestContext);
        return { authRequestId: `auth-${capturedRequestContexts.length}` };
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        return { action: "not_applicable" };
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  const host = {
    ref: "office-ext",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "office.test",
    authMode: "digest-first",
    authorizationUsernamePrefix: "",
    staticCredentials: [],
  };
  service.extensionsHosts.set(host.ref, host);

  const unauthenticatedRegister = formatSipRequest({
    method: "REGISTER",
    requestUri: "sip:office.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-auth-1",
      From: "<sip:401@office.test>;tag=auth-1",
      To: "<sip:401@office.test>",
      "Call-ID": "auth-call-1",
      CSeq: "1 REGISTER",
      Contact: "<sip:401@127.0.0.1:5070>",
      Expires: "600",
      "Content-Length": "0",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    host,
    Buffer.from(unauthenticatedRegister, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(unauthenticatedRegister) },
  );

  const challengeMessage = parseSipMessage(lastSentPayload);
  const challenge = parseSipDigestChallenge(getSipHeader(challengeMessage, "www-authenticate"));
  assert.ok(challenge);
  const nonce = String(challenge.params.nonce || "");
  assert.ok(nonce);

  const invalidRealmRegister = formatSipRequest({
    method: "REGISTER",
    requestUri: "sip:office.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-auth-2",
      From: "<sip:401@office.test>;tag=auth-2",
      To: "<sip:401@office.test>",
      "Call-ID": "auth-call-2",
      CSeq: "2 REGISTER",
      Contact: "<sip:401@127.0.0.1:5070>",
      Expires: "600",
      Authorization: `Digest username="401", realm="evil.test", nonce="${nonce}", uri="sip:office.test", response="deadbeef", algorithm=MD5, qop=auth, nc=00000001, cnonce="clientcnonce"`,
      "Content-Length": "0",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    host,
    Buffer.from(invalidRealmRegister, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(invalidRealmRegister) },
  );

  assert.equal(capturedRequestContexts.length, 1);
  assert.equal(capturedRequestContexts[0].authorization, undefined);

  const validAuthorization = buildSipDigestAuthorization({
    challenge,
    method: "REGISTER",
    requestUri: "sip:office.test",
    username: "401",
    password: "secret",
    nc: "00000001",
    cnonce: "clientcnonce",
  });
  assert.ok(validAuthorization);

  const validRealmRegister = formatSipRequest({
    method: "REGISTER",
    requestUri: "sip:office.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-auth-3",
      From: "<sip:401@office.test>;tag=auth-3",
      To: "<sip:401@office.test>",
      "Call-ID": "auth-call-3",
      CSeq: "3 REGISTER",
      Contact: "<sip:401@127.0.0.1:5070>",
      Expires: "600",
      Authorization: validAuthorization,
      "Content-Length": "0",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    host,
    Buffer.from(validRealmRegister, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(validRealmRegister) },
  );

  assert.equal(capturedRequestContexts.length, 2);
  assert.equal(capturedRequestContexts[1].authorization.params.username, "401");
  assert.equal(capturedRequestContexts[1].authorization.params.realm, "office.test");
  assert.equal(capturedRequestContexts[1].authorization.params.nonce, nonce);
});

test("extensions interactive challenge adds stale=true for expired listener-issued nonce", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const {
    formatSipRequest,
    parseSipMessage,
    getSipHeader,
  } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");
  const {
    parseSipDigestChallenge,
    buildSipDigestAuthorization,
  } = require("../../../../build-src/daemon/signaling/sip/digest-auth.js");

  let lastSentPayload = "";
  const fakeSocket = {
    send(buffer, _port, _host, callback) {
      lastSentPayload = Buffer.from(buffer).toString("utf8");
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails() {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      emitInboundInvite() {
        return { legId: "unused" };
      },
      createAuthRequest() {
        return { authRequestId: "auth-stale" };
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        return { action: "challenge", statusCode: 401 };
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  const host = {
    ref: "office-ext",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "office.test",
    authMode: "digest-first",
    authorizationUsernamePrefix: "",
    staticCredentials: [],
  };
  service.extensionsHosts.set(host.ref, host);

  const unauthenticatedRegister = formatSipRequest({
    method: "REGISTER",
    requestUri: "sip:office.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-stale-1",
      From: "<sip:401@office.test>;tag=stale-1",
      To: "<sip:401@office.test>",
      "Call-ID": "stale-call-1",
      CSeq: "1 REGISTER",
      Contact: "<sip:401@127.0.0.1:5070>",
      Expires: "600",
      "Content-Length": "0",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    host,
    Buffer.from(unauthenticatedRegister, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(unauthenticatedRegister) },
  );

  const challengeMessage = parseSipMessage(lastSentPayload);
  const challenge = parseSipDigestChallenge(getSipHeader(challengeMessage, "www-authenticate"));
  assert.ok(challenge);

  const originalNow = Date.now;
  Date.now = () => originalNow() + (10 * 60 * 1000);
  try {
    const expiredAuthorization = buildSipDigestAuthorization({
      challenge,
      method: "REGISTER",
      requestUri: "sip:office.test",
      username: "401",
      password: "secret",
      nc: "00000001",
      cnonce: "stalecnonce",
    });
    assert.ok(expiredAuthorization);

    const expiredRegister = formatSipRequest({
      method: "REGISTER",
      requestUri: "sip:office.test",
      headers: {
        Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-stale-2",
        From: "<sip:401@office.test>;tag=stale-2",
        To: "<sip:401@office.test>",
        "Call-ID": "stale-call-2",
        CSeq: "2 REGISTER",
        Contact: "<sip:401@127.0.0.1:5070>",
        Expires: "600",
        Authorization: expiredAuthorization,
        "Content-Length": "0",
      },
      body: "",
    });

    await service.handleEndpointDatagram(
      host,
      Buffer.from(expiredRegister, "utf8"),
      { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(expiredRegister) },
    );
  } finally {
    Date.now = originalNow;
  }

  const staleResponse = parseSipMessage(lastSentPayload);
  const wwwAuthenticate = getSipHeader(staleResponse, "www-authenticate");
  assert.match(wwwAuthenticate, /\bstale=true\b/i);
});

test("extensions static auth strips authorization username prefix for credential lookup but verifies digest with the original username", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { formatSipRequest } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");
  const { parseSipDigestChallenge, buildSipDigestChallenge, buildSipDigestAuthorization } = require("../../../../build-src/daemon/signaling/sip/digest-auth.js");

  let lastSentPayload = "";
  const fakeSocket = {
    send(buffer, _port, _host, callback) {
      lastSentPayload = Buffer.from(buffer).toString("utf8");
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails() {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      registerEndpoint() {},
      emitInboundInvite() {
        return { legId: "unused" };
      },
      createAuthRequest() {
        throw new Error("unused");
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        throw new Error("unused");
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  const host = {
    ref: "office-ext",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "office.test",
    authMode: "static",
    authorizationUsernamePrefix: "office-",
    staticCredentials: [
      { username: "401", password: "secret", extension: "401" },
    ],
  };
  service.extensionsHosts.set(host.ref, host);

  const challenge = parseSipDigestChallenge(
    buildSipDigestChallenge(host.realm, service.extensionsDigestNonces.issue(service.extensionNonceScope(host), host.realm)),
  );
  const authorization = buildSipDigestAuthorization({
    challenge,
    method: "REGISTER",
    requestUri: "sip:office.test",
    username: "office-401",
    password: "secret",
    nc: "00000001",
    cnonce: "staticprefix",
  });
  assert.ok(authorization);

  const register = formatSipRequest({
    method: "REGISTER",
    requestUri: "sip:office.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-static-prefix",
      From: "<sip:401@office.test>;tag=static-prefix",
      To: "<sip:401@office.test>",
      "Call-ID": "static-prefix-call",
      CSeq: "1 REGISTER",
      Contact: "<sip:401@127.0.0.1:5070>",
      Expires: "600",
      Authorization: authorization,
      "Content-Length": "0",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    host,
    Buffer.from(register, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(register) },
  );

  assert.match(lastSentPayload, /^SIP\/2\.0 200 OK/m);
});

test("extensions static auth challenges unauthenticated requests before credential matching and then accepts prefixed usernames", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { formatSipRequest, parseSipMessage, getSipHeader } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");
  const { parseSipDigestChallenge, buildSipDigestAuthorization } = require("../../../../build-src/daemon/signaling/sip/digest-auth.js");

  let lastSentPayload = "";
  const fakeSocket = {
    send(buffer, _port, _host, callback) {
      lastSentPayload = Buffer.from(buffer).toString("utf8");
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails() {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      registerEndpoint() {},
      emitInboundInvite() {
        return { legId: "unused" };
      },
      createAuthRequest() {
        throw new Error("unused");
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        throw new Error("unused");
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  const host = {
    ref: "office-ext",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "office.test",
    authMode: "static",
    authorizationUsernamePrefix: "n8n-",
    staticCredentials: [
      { username: "user", password: "secret", extension: "100" },
    ],
  };
  service.extensionsHosts.set(host.ref, host);

  const unauthenticatedRegister = formatSipRequest({
    method: "REGISTER",
    requestUri: "sip:office.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-static-first-1",
      From: "\"Test n8n\" <sip:n8n-user@office.test>;tag=static-first-1",
      To: "\"Test n8n\" <sip:n8n-user@office.test>",
      "Call-ID": "static-first-call-1",
      CSeq: "1 REGISTER",
      Contact: "<sip:n8n-user@127.0.0.1:5070>",
      Expires: "600",
      "Content-Length": "0",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    host,
    Buffer.from(unauthenticatedRegister, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(unauthenticatedRegister) },
  );

  assert.match(lastSentPayload, /^SIP\/2\.0 401 Unauthorized/m);
  const challengeMessage = parseSipMessage(lastSentPayload);
  const challenge = parseSipDigestChallenge(getSipHeader(challengeMessage, "www-authenticate"));
  assert.ok(challenge);

  const authorization = buildSipDigestAuthorization({
    challenge,
    method: "REGISTER",
    requestUri: "sip:office.test",
    username: "n8n-user",
    password: "secret",
    nc: "00000001",
    cnonce: "staticfirst",
  });
  assert.ok(authorization);

  const authenticatedRegister = formatSipRequest({
    method: "REGISTER",
    requestUri: "sip:office.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-static-first-2",
      From: "\"Test n8n\" <sip:n8n-user@office.test>;tag=static-first-2",
      To: "\"Test n8n\" <sip:n8n-user@office.test>",
      "Call-ID": "static-first-call-2",
      CSeq: "2 REGISTER",
      Contact: "<sip:n8n-user@127.0.0.1:5070>",
      Expires: "600",
      Authorization: authorization,
      "Content-Length": "0",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    host,
    Buffer.from(authenticatedRegister, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(authenticatedRegister) },
  );

  assert.match(lastSentPayload, /^SIP\/2\.0 200 OK/m);
});

test("extensions digest-first skips non-matching username-prefix listeners and keeps public auth.username raw while retaining raw authorization", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { formatSipRequest } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");
  const { parseSipDigestChallenge, buildSipDigestChallenge, buildSipDigestAuthorization } = require("../../../../build-src/daemon/signaling/sip/digest-auth.js");

  let lastSentPayload = "";
  const capturedRequests = [];
  const fakeSocket = {
    send(buffer, _port, _host, callback) {
      lastSentPayload = Buffer.from(buffer).toString("utf8");
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails() {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      registerEndpoint() {},
      emitInboundInvite() {
        return { legId: "unused" };
      },
      createAuthRequest(input) {
        capturedRequests.push(input);
        return { authRequestId: `auth-${capturedRequests.length}` };
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        return { action: "verify_password", password: "secret" };
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  const firstHost = {
    ref: "a-sales",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "office.test",
    authMode: "digest-first",
    authorizationUsernamePrefix: "sales-",
    staticCredentials: [],
  };
  const secondHost = {
    ref: "b-support",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "office.test",
    authMode: "digest-first",
    authorizationUsernamePrefix: "support-",
    staticCredentials: [],
  };
  service.extensionsHosts.set(firstHost.ref, firstHost);
  service.extensionsHosts.set(secondHost.ref, secondHost);

  const challenge = parseSipDigestChallenge(
    buildSipDigestChallenge(secondHost.realm, service.extensionsDigestNonces.issue(service.extensionNonceScope(secondHost), secondHost.realm)),
  );
  const authorization = buildSipDigestAuthorization({
    challenge,
    method: "REGISTER",
    requestUri: "sip:office.test",
    username: "support-401",
    password: "secret",
    nc: "00000001",
    cnonce: "digestprefix",
  });
  assert.ok(authorization);

  const register = formatSipRequest({
    method: "REGISTER",
    requestUri: "sip:office.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-digest-prefix",
      From: "<sip:401@office.test>;tag=digest-prefix",
      To: "<sip:401@office.test>",
      "Call-ID": "digest-prefix-call",
      CSeq: "1 REGISTER",
      Contact: "<sip:401@127.0.0.1:5070>",
      Expires: "600",
      Authorization: authorization,
      "Content-Length": "0",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    firstHost,
    Buffer.from(register, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(register) },
  );

  assert.equal(capturedRequests.length, 1);
  assert.equal(capturedRequests[0].ref, secondHost.ref);
  assert.equal(capturedRequests[0].requestContext.authorization.params.username, "support-401");
  assert.match(String(capturedRequests[0].requestContext.raw.headers.authorization || ""), /username="support-401"/);
  assert.match(lastSentPayload, /^SIP\/2\.0 200 OK/m);
});

test("extensions auth traversal returns the last remembered reject instead of 404 when later listeners are not applicable", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { formatSipRequest } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");

  let lastSentPayload = "";
  const fakeSocket = {
    send(buffer, _port, _host, callback) {
      lastSentPayload = Buffer.from(buffer).toString("utf8");
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails() {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      registerEndpoint() {},
      emitInboundInvite() {
        return { legId: "unused" };
      },
      createAuthRequest(input) {
        return { authRequestId: `auth:${input.ref}` };
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution(authRequestId) {
        if (authRequestId === "auth:a-first") {
          return { action: "deny", statusCode: 403, reason: "Forbidden A" };
        }
        return { action: "not_applicable" };
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  const firstHost = {
    ref: "a-first",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "office.test",
    authMode: "raw",
    authorizationUsernamePrefix: "",
    continueTraversalOnAuthReject: true,
    staticCredentials: [],
  };
  const secondHost = {
    ref: "b-second",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "office.test",
    authMode: "raw",
    authorizationUsernamePrefix: "",
    continueTraversalOnAuthReject: true,
    staticCredentials: [],
  };
  service.extensionsHosts.set(firstHost.ref, firstHost);
  service.extensionsHosts.set(secondHost.ref, secondHost);

  const register = formatSipRequest({
    method: "REGISTER",
    requestUri: "sip:office.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-reject-memory-1",
      From: "<sip:401@office.test>;tag=reject-memory-1",
      To: "<sip:401@office.test>",
      "Call-ID": "reject-memory-call-1",
      CSeq: "1 REGISTER",
      Contact: "<sip:401@127.0.0.1:5070>",
      Expires: "600",
      "Content-Length": "0",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    firstHost,
    Buffer.from(register, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(register) },
  );

  assert.match(lastSentPayload, /^SIP\/2\.0 403 Forbidden A/m);
});

test("extensions auth traversal updates the remembered reject when a later listener also rejects", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { formatSipRequest } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");

  let lastSentPayload = "";
  const fakeSocket = {
    send(buffer, _port, _host, callback) {
      lastSentPayload = Buffer.from(buffer).toString("utf8");
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails() {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      registerEndpoint() {},
      emitInboundInvite() {
        return { legId: "unused" };
      },
      createAuthRequest(input) {
        return { authRequestId: `auth:${input.ref}` };
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution(authRequestId) {
        if (authRequestId === "auth:a-first") {
          return { action: "deny", statusCode: 403, reason: "Forbidden A" };
        }
        return { action: "deny", statusCode: 488, reason: "Not Acceptable Here" };
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  const firstHost = {
    ref: "a-first",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "office.test",
    authMode: "raw",
    authorizationUsernamePrefix: "",
    continueTraversalOnAuthReject: true,
    staticCredentials: [],
  };
  const secondHost = {
    ref: "b-second",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "office.test",
    authMode: "raw",
    authorizationUsernamePrefix: "",
    continueTraversalOnAuthReject: true,
    staticCredentials: [],
  };
  service.extensionsHosts.set(firstHost.ref, firstHost);
  service.extensionsHosts.set(secondHost.ref, secondHost);

  const register = formatSipRequest({
    method: "REGISTER",
    requestUri: "sip:office.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-reject-memory-2",
      From: "<sip:401@office.test>;tag=reject-memory-2",
      To: "<sip:401@office.test>",
      "Call-ID": "reject-memory-call-2",
      CSeq: "1 REGISTER",
      Contact: "<sip:401@127.0.0.1:5070>",
      Expires: "600",
      "Content-Length": "0",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    firstHost,
    Buffer.from(register, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(register) },
  );

  assert.match(lastSentPayload, /^SIP\/2\.0 488 Not Acceptable Here/m);
});

test("extensions explicit deny 401 stays a reject and does not inject digest challenge headers", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { formatSipRequest } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");

  let lastSentPayload = "";
  const fakeSocket = {
    send(buffer, _port, _host, callback) {
      lastSentPayload = Buffer.from(buffer).toString("utf8");
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails() {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      registerEndpoint() {},
      emitInboundInvite() {
        return { legId: "unused" };
      },
      createAuthRequest(input) {
        return { authRequestId: `auth:${input.ref}` };
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        return { action: "deny", statusCode: 401, reason: "Explicit Reject" };
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  const host = {
    ref: "ext",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "office.test",
    authMode: "raw",
    authorizationUsernamePrefix: "",
    continueTraversalOnAuthReject: false,
    staticCredentials: [],
  };
  service.extensionsHosts.set(host.ref, host);

  const register = formatSipRequest({
    method: "REGISTER",
    requestUri: "sip:office.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-explicit-deny-401",
      From: "<sip:401@office.test>;tag=explicit-deny-401",
      To: "<sip:401@office.test>",
      "Call-ID": "explicit-deny-401",
      CSeq: "1 REGISTER",
      Contact: "<sip:401@127.0.0.1:5070>",
      Expires: "600",
      "Content-Length": "0",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    host,
    Buffer.from(register, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(register) },
  );

  assert.match(lastSentPayload, /^SIP\/2\.0 401 Explicit Reject/m);
  assert.doesNotMatch(lastSentPayload, /^WWW-Authenticate:/mi);
});

test("extensions immediate auth failure responds with listener-owned advertised identity, not candidate-owned identity", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { formatSipRequest } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");

  let lastSentPayload = "";
  const fakeSocket = {
    send(buffer, _port, _host, callback) {
      lastSentPayload = Buffer.from(buffer).toString("utf8");
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails() {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      registerEndpoint() {},
      emitInboundInvite() {
        return { legId: "unused" };
      },
      createAuthRequest(input) {
        return { authRequestId: `auth:${input.ref}` };
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution(authRequestId) {
        if (authRequestId === "auth:a-first") {
          return { action: "not_applicable" };
        }
        return { action: "deny", statusCode: 403, reason: "Forbidden B" };
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  const firstHost = {
    ref: "a-first",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "listener.example.test",
    realm: "office.test",
    authMode: "raw",
    authorizationUsernamePrefix: "",
    continueTraversalOnAuthReject: false,
    staticCredentials: [],
  };
  const secondHost = {
    ref: "b-second",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "candidate.example.test",
    realm: "office.test",
    authMode: "raw",
    authorizationUsernamePrefix: "",
    continueTraversalOnAuthReject: false,
    staticCredentials: [],
  };
  service.extensionsHosts.set(firstHost.ref, firstHost);
  service.extensionsHosts.set(secondHost.ref, secondHost);

  const register = formatSipRequest({
    method: "REGISTER",
    requestUri: "sip:office.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-listener-owned-reject",
      From: "<sip:401@office.test>;tag=listener-owned-reject",
      To: "<sip:401@office.test>",
      "Call-ID": "listener-owned-reject",
      CSeq: "1 REGISTER",
      Contact: "<sip:401@127.0.0.1:5070>",
      Expires: "600",
      "Content-Length": "0",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    firstHost,
    Buffer.from(register, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(register) },
  );

  assert.match(lastSentPayload, /^SIP\/2\.0 403 Forbidden B/m);
  assert.match(lastSentPayload, /Contact: <sip:n8n@listener\.example\.test:5060>/m);
  assert.doesNotMatch(lastSentPayload, /candidate\.example\.test/);
});

test("extensions listener accepts 200 OK for a locally generated BYE transaction", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { parseSipMessage, getSipHeader, formatSipResponse } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");

  let lastSentPayload = "";
  const fakeSocket = {
    send(buffer, port, host, callback) {
      lastSentPayload = Buffer.from(buffer).toString("utf8");
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails(_legId, _details) {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      emitInboundInvite() {
        return { legId: "unused" };
      },
      createAuthRequest() {
        return { authRequestId: "unused" };
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        throw new Error("unused");
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  await service.sendInDialogRequest(fakeSocket, {
    method: "BYE",
    requestUri: "sip:100@pub.sip.tg",
    remoteAddress: "127.0.0.1",
    remotePort: 5060,
    viaHost: "127.0.0.1:5060",
    from: "<sip:100@pub.sip.tg>;tag=uas-test",
    to: "\"Test n8n\" <sip:qwe@pub.sip.tg>;tag=remote-test",
    callId: "call-test-bye-1",
    cseq: 2,
    contactUri: "sip:100@127.0.0.1:5060",
  });

  const byeRequest = parseSipMessage(lastSentPayload);
  assert.ok(byeRequest);
  assert.strictEqual(byeRequest.method, "BYE");
  assert.strictEqual(service.outboundTransactions.size, 1);

  const okResponse = formatSipResponse({
    statusCode: 200,
    reasonPhrase: "OK",
    headers: {
      Via: getSipHeader(byeRequest, "via"),
      From: getSipHeader(byeRequest, "from"),
      To: getSipHeader(byeRequest, "to"),
      "Call-ID": getSipHeader(byeRequest, "call-id"),
      CSeq: getSipHeader(byeRequest, "cseq"),
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    {
      ref: "ext",
      socket: fakeSocket,
      bindIp: "127.0.0.1",
      bindPort: 5060,
      advertisedIp: "127.0.0.1",
      realm: "127.0.0.1",
      authMode: "digest-first",
      authorizationUsernamePrefix: "",
      staticCredentials: [],
    },
    Buffer.from(okResponse, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5060, size: Buffer.byteLength(okResponse) },
  );

  assert.strictEqual(service.outboundTransactions.size, 0);
});

test("extension outbound target reuses the extensions listener socket", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");

  const fakeSocket = {
    address() {
      return { address: "127.0.0.1", family: "udp4", port: 5060 };
    },
    on() {},
    send(_buffer, _port, _host, callback) {
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails(_legId, _details) {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      getRegistration() {
        return {
          ref: "sales",
          extensionNumber: "101",
          contactUri: "sip:101@192.0.2.10:5070",
          sourceIp: "192.0.2.10",
          sourcePort: 5070,
          metadata: {},
        };
      },
      emitInboundInvite() {
        return { legId: "unused" };
      },
      createAuthRequest() {
        return { authRequestId: "unused" };
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        throw new Error("unused");
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  service.extensionsHosts.set("sales", {
    ref: "sales",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "pbx.example.test",
    authMode: "digest-first",
    authorizationUsernamePrefix: "",
    staticCredentials: [],
  });

  const resolved = await service.resolveOutboundTarget(
    {
      dialId: "dial-1",
      mode: "extension",
      strategy: "parallel",
      targets: [{
        kind: "extension",
        ref: "sales",
        extensionNumber: "101",
        endpointId: "",
      }],
      metadata: { customSipHeaders: [] },
      attemptLegIds: [],
      activeAttemptLegIds: [],
      pendingTargets: [],
      totalAttemptCount: 0,
      finalized: false,
      winnerLegId: null,
      status: "dialing",
      reason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      endedAt: null,
      sequentialAttemptTimeoutSeconds: 0,
      sequentialGapSeconds: 0,
    },
    {
      kind: "extension",
      ref: "sales",
      extensionNumber: "101",
      endpointId: "",
    },
  );

  assert.ok(resolved);
  assert.strictEqual(resolved.socket, fakeSocket);
  assert.strictEqual(resolved.ownsSocket, false);
  assert.strictEqual(resolved.localBindIp, "127.0.0.1");
  assert.strictEqual(resolved.localBindPort, 5060);
});

test("extensions listener routes SIP responses to active outbound extension sessions on the shared socket", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { formatSipResponse } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");

  const events = [];
  const fakeSocket = {
    send(_buffer, _port, _host, callback) {
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails(_legId, _details) {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      emitInboundInvite() {
        return { legId: "unused" };
      },
      createAuthRequest() {
        return { authRequestId: "unused" };
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        throw new Error("unused");
      },
    },
    onAttemptRinging(legId) {
      events.push(["ringing", legId]);
    },
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  service.outboundSessions.set("leg-ext-outbound-1", {
    legId: "leg-ext-outbound-1",
    dialId: "dial-ext-outbound-1",
    socket: fakeSocket,
    ownsSocket: false,
    remoteAddress: "192.0.2.10",
    remotePort: 5070,
    requestUri: "sip:101@192.0.2.10:5070",
    callId: "call-ext-outbound-1",
    cseq: 1,
    from: "<sip:n8n@pbx.example.test>;tag=local-tag",
    to: "<sip:101@192.0.2.10:5070>",
    localTag: "local-tag",
    contactUri: "sip:n8n@pbx.example.test:5060",
    viaHost: "pbx.example.test:5060",
    localSdp: "",
    inviteHeaders: [],
    authUsername: "",
    authPassword: "",
    authChallenge: null,
    authorizationHeaderName: null,
    lastAuthNonce: null,
    authNonceCount: 0,
    authAttempts: 0,
    inviteBranch: "z9hG4bK-branch-test",
    state: "inviting",
  });

  const ringingResponse = formatSipResponse({
    statusCode: 180,
    reasonPhrase: "Ringing",
    headers: {
      Via: "SIP/2.0/UDP pbx.example.test:5060;branch=z9hG4bK-test",
      From: "<sip:n8n@pbx.example.test>;tag=local-tag",
      To: "<sip:101@192.0.2.10:5070>;tag=remote-tag",
      "Call-ID": "call-ext-outbound-1",
      CSeq: "1 INVITE",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    {
      ref: "sales",
      socket: fakeSocket,
      bindIp: "127.0.0.1",
      bindPort: 5060,
      advertisedIp: "pbx.example.test",
      realm: "pbx.example.test",
      authMode: "digest-first",
      authorizationUsernamePrefix: "",
      staticCredentials: [],
    },
    Buffer.from(ringingResponse, "utf8"),
    { address: "192.0.2.10", family: "udp4", port: 5070, size: Buffer.byteLength(ringingResponse) },
  );

  assert.deepStrictEqual(events, [["ringing", "leg-ext-outbound-1"]]);
});

test("extensions listener enables early media transport for outbound 183 responses with SDP on the shared socket", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { formatSipResponse } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");

  const events = [];
  const fakeSocket = {
    send(_buffer, _port, _host, callback) {
      callback(null);
    },
    close() {},
  };

  let signalingDetails = {};
  let ensuredLegId = null;

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: { ...signalingDetails } };
      },
      updateSignalingDetails(_legId, details) {
        signalingDetails = { ...(details || {}) };
        return { signalingDetails: { ...signalingDetails } };
      },
      hangupLeg() {},
    },
    extensionService: {
      emitInboundInvite() {
        return { legId: "unused" };
      },
      createAuthRequest() {
        return { authRequestId: "unused" };
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        throw new Error("unused");
      },
    },
    ensureMediaTransportEndpoint: async (legId) => {
      ensuredLegId = legId;
      return {};
    },
    onAttemptRinging() {},
    onAttemptProgress(legId) {
      events.push(["progress", legId]);
    },
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  service.outboundSessions.set("leg-ext-early-media-1", {
    legId: "leg-ext-early-media-1",
    dialId: "dial-ext-early-media-1",
    socket: fakeSocket,
    ownsSocket: false,
    remoteAddress: "192.0.2.10",
    remotePort: 5070,
    requestUri: "sip:101@192.0.2.10:5070",
    callId: "call-ext-early-media-1",
    cseq: 1,
    from: "<sip:n8n@pbx.example.test>;tag=local-tag",
    to: "<sip:101@192.0.2.10:5070>",
    localTag: "local-tag",
    contactUri: "sip:n8n@pbx.example.test:5060",
    viaHost: "pbx.example.test:5060",
    localSdp: "",
    inviteHeaders: [],
    authUsername: "",
    authPassword: "",
    authChallenge: null,
    authorizationHeaderName: null,
    lastAuthNonce: null,
    authNonceCount: 0,
    authAttempts: 0,
    inviteBranch: "z9hG4bK-branch-test",
    state: "inviting",
  });

  const progressResponse = formatSipResponse({
    statusCode: 183,
    reasonPhrase: "Session Progress",
    headers: {
      Via: "SIP/2.0/UDP pbx.example.test:5060;branch=z9hG4bK-test",
      From: "<sip:n8n@pbx.example.test>;tag=local-tag",
      To: "<sip:101@192.0.2.10:5070>;tag=remote-tag",
      "Call-ID": "call-ext-early-media-1",
      CSeq: "1 INVITE",
      "Content-Type": "application/sdp",
    },
    body: [
      "v=0",
      "o=- 1 1 IN IP4 192.0.2.10",
      "s=-",
      "c=IN IP4 192.0.2.10",
      "t=0 0",
      "m=audio 4000 RTP/AVP 111 101",
      "a=rtpmap:111 opus/48000/2",
      "a=fmtp:111 useinbandfec=1",
      "a=rtpmap:101 telephone-event/8000",
      "a=fmtp:101 0-16",
      "",
    ].join("\r\n"),
  });

  await service.handleEndpointDatagram(
    {
      ref: "sales",
      socket: fakeSocket,
      bindIp: "127.0.0.1",
      bindPort: 5060,
      advertisedIp: "pbx.example.test",
      realm: "pbx.example.test",
      authMode: "digest-first",
      authorizationUsernamePrefix: "",
      staticCredentials: [],
    },
    Buffer.from(progressResponse, "utf8"),
    { address: "192.0.2.10", family: "udp4", port: 5070, size: Buffer.byteLength(progressResponse) },
  );

  assert.deepStrictEqual(events, [["progress", "leg-ext-early-media-1"]]);
  assert.strictEqual(ensuredLegId, "leg-ext-early-media-1");
  assert.strictEqual(signalingDetails.remoteRtpHost, "192.0.2.10");
  assert.strictEqual(signalingDetails.remoteRtpPort, 4000);
  assert.deepStrictEqual(signalingDetails.payloadTypes, [111, 101]);
});

test("extensions outbound cancel reuses the original INVITE branch and waits for final INVITE response to ACK and finalize", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { formatSipResponse, parseSipMessage } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");

  const sentMessages = [];
  const rejected = [];
  const fakeSocket = {
    send(buffer, _port, _host, callback) {
      sentMessages.push(Buffer.from(buffer).toString("utf8"));
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails(_legId, _details) {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      emitInboundInvite() {
        return { legId: "unused" };
      },
      createAuthRequest() {
        return { authRequestId: "unused" };
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        throw new Error("unused");
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected(legId, reason) {
      rejected.push([legId, reason]);
    },
  });

  service.outboundSessions.set("leg-ext-cancel-1", {
    legId: "leg-ext-cancel-1",
    dialId: "dial-ext-cancel-1",
    socket: fakeSocket,
    ownsSocket: false,
    remoteAddress: "192.0.2.10",
    remotePort: 5070,
    requestUri: "sip:101@192.0.2.10:5070",
    callId: "call-ext-cancel-1",
    cseq: 1,
    from: "<sip:n8n@pbx.example.test>;tag=local-tag",
    to: "<sip:101@192.0.2.10:5070>",
    localTag: "local-tag",
    contactUri: "sip:n8n@pbx.example.test:5060",
    viaHost: "pbx.example.test:5060",
    localSdp: "",
    inviteHeaders: [],
    authUsername: "",
    authPassword: "",
    authChallenge: null,
    authorizationHeaderName: null,
    lastAuthNonce: null,
    authNonceCount: 0,
    authAttempts: 0,
    inviteBranch: "z9hG4bK-branch-original-invite",
    state: "inviting",
  });
  service.outboundTransactions.set("z9hG4bK-branch-original-invite|INVITE|call-ext-cancel-1", {
    key: "z9hG4bK-branch-original-invite|INVITE|call-ext-cancel-1",
    socket: fakeSocket,
    request: "INVITE sip:101@192.0.2.10:5070 SIP/2.0\r\n\r\n",
    remoteAddress: "192.0.2.10",
    remotePort: 5070,
    method: "INVITE",
    isInvite: true,
    state: "proceeding",
    intervalMs: 500,
    timeoutTimer: null,
    retransmitTimer: null,
    onTimeout: null,
    onFinal: null,
  });

  await service.rejectOrHangupLeg("leg-ext-cancel-1", "call_break");
  await service.handleLegEnded("leg-ext-cancel-1");

  assert.equal(service.outboundSessions.has("leg-ext-cancel-1"), true);
  assert.equal(service.outboundTransactions.has("z9hG4bK-branch-original-invite|INVITE|call-ext-cancel-1"), true);
  assert.equal(sentMessages.length, 1);
  const cancelMessage = parseSipMessage(sentMessages[0]);
  assert.ok(cancelMessage);
  assert.equal(cancelMessage.method, "CANCEL");
  assert.match(String(cancelMessage.headers.via?.[0] || ""), /branch=z9hG4bK-branch-original-invite/);

  const extensionsHost = {
    ref: "sales",
    publicRef: "sales",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "pbx.example.test",
    authMode: "digest-first",
    authorizationUsernamePrefix: "",
    staticCredentials: [],
  };

  const cancelOk = formatSipResponse({
    statusCode: 200,
    reasonPhrase: "OK",
    headers: {
      Via: "SIP/2.0/UDP pbx.example.test:5060;branch=z9hG4bK-branch-original-invite",
      From: "<sip:n8n@pbx.example.test>;tag=local-tag",
      To: "<sip:101@192.0.2.10:5070>;tag=remote-tag",
      "Call-ID": "call-ext-cancel-1",
      CSeq: "1 CANCEL",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    extensionsHost,
    Buffer.from(cancelOk, "utf8"),
    { address: "192.0.2.10", family: "udp4", port: 5070, size: Buffer.byteLength(cancelOk) },
  );

  assert.equal(service.outboundSessions.has("leg-ext-cancel-1"), true);
  assert.deepStrictEqual(rejected, []);

  const invite487 = formatSipResponse({
    statusCode: 487,
    reasonPhrase: "Request Terminated",
    headers: {
      Via: "SIP/2.0/UDP pbx.example.test:5060;branch=z9hG4bK-branch-original-invite",
      From: "<sip:n8n@pbx.example.test>;tag=local-tag",
      To: "<sip:101@192.0.2.10:5070>;tag=remote-tag",
      "Call-ID": "call-ext-cancel-1",
      CSeq: "1 INVITE",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    extensionsHost,
    Buffer.from(invite487, "utf8"),
    { address: "192.0.2.10", family: "udp4", port: 5070, size: Buffer.byteLength(invite487) },
  );

  assert.equal(service.outboundSessions.has("leg-ext-cancel-1"), false);
  assert.equal(service.outboundTransactions.has("z9hG4bK-branch-original-invite|INVITE|call-ext-cancel-1"), false);
  assert.deepStrictEqual(rejected, []);
  assert.equal(sentMessages.length, 2);
  const ackMessage = parseSipMessage(sentMessages[1]);
  assert.ok(ackMessage);
  assert.equal(ackMessage.method, "ACK");
  assert.match(String(ackMessage.headers.cseq?.[0] || ""), /^1 ACK$/);
});

test("extensions INVITE uses the authenticated extension number for endpoint resolution and inbound leg metadata", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { formatSipRequest } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");

  let resolvedExtensionNumber = null;
  let emittedInvite = null;
  let lastSentPayload = "";
  const fakeSocket = {
    send(buffer, _port, _host, callback) {
      lastSentPayload = Buffer.from(buffer).toString("utf8");
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails(_legId, _details) {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      emitInboundInvite(invite) {
        emittedInvite = invite;
        return { legId: "leg-invite-auth-ext-1" };
      },
      resolveEndpointIdForTriggerLeg(_ref, extensionNumber) {
        resolvedExtensionNumber = extensionNumber;
        return "contact:sip:100@caller.local";
      },
      createAuthRequest() {
        return { authRequestId: "auth-invite-1" };
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        return { action: "allow", extension: "100" };
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  const host = {
    ref: "ext",
    publicRef: "ext",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "127.0.0.1",
    realm: "pbx.example.test",
    authMode: "raw",
    authorizationUsernamePrefix: "",
    staticCredentials: [],
  };
  service.extensionsHosts.set(host.ref, host);

  const inviteRequest = formatSipRequest({
    method: "INVITE",
    requestUri: "sip:outside@pbx.example.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-invite-auth-ext-1",
      From: "<sip:100@pbx.example.test>;tag=invite-auth-ext-1",
      To: "<sip:outside@pbx.example.test>",
      "Call-ID": "call-invite-auth-ext-1",
      CSeq: "1 INVITE",
      Contact: "<sip:100@caller.local>",
      "Content-Length": "0",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    host,
    Buffer.from(inviteRequest, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(inviteRequest) },
  );

  assert.equal(resolvedExtensionNumber, "100");
  assert.ok(emittedInvite);
  assert.equal(emittedInvite.extensionNumber, "100");
  assert.equal(emittedInvite.endpointId, "contact:sip:100@caller.local");
  assert.match(lastSentPayload, /^SIP\/2\.0 100 Trying/m);
});

test("extensions INVITE rejects allow response without explicit authenticated extension", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { formatSipRequest } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");

  let emittedInvite = null;
  let lastSentPayload = "";
  const fakeSocket = {
    send(buffer, _port, _host, callback) {
      lastSentPayload = Buffer.from(buffer).toString("utf8");
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails(_legId, _details) {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      emitInboundInvite(invite) {
        emittedInvite = invite;
        return { legId: "leg-invite-auth-missing-ext-1" };
      },
      resolveEndpointIdForTriggerLeg() {
        throw new Error("should not resolve endpoint without authenticated extension");
      },
      createAuthRequest() {
        return { authRequestId: "auth-invite-missing-ext-1" };
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        return { action: "allow" };
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  const host = {
    ref: "ext",
    publicRef: "ext",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "127.0.0.1",
    realm: "pbx.example.test",
    authMode: "raw",
    authorizationUsernamePrefix: "",
    staticCredentials: [],
  };
  service.extensionsHosts.set(host.ref, host);

  const inviteRequest = formatSipRequest({
    method: "INVITE",
    requestUri: "sip:outside@pbx.example.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-invite-auth-missing-ext-1",
      From: "<sip:100@pbx.example.test>;tag=invite-auth-missing-ext-1",
      To: "<sip:outside@pbx.example.test>",
      "Call-ID": "call-invite-auth-missing-ext-1",
      CSeq: "1 INVITE",
      Contact: "<sip:100@caller.local>",
      "Content-Length": "0",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    host,
    Buffer.from(inviteRequest, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(inviteRequest) },
  );

  assert.equal(emittedInvite, null);
  assert.match(lastSentPayload, /^SIP\/2\.0 403 Missing Extension/m);
});

test("inbound trunk answer uses advertised host for Contact and SDP instead of wildcard bind IP", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { formatSipRequest } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");

  let lastSentPayload = "";
  const legState = new Map();
  const fakeSocket = {
    send(buffer, _port, _host, callback) {
      lastSentPayload = Buffer.from(buffer).toString("utf8");
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg(legId) {
        if (!legState.has(legId)) {
          legState.set(legId, { signalingDetails: {} });
        }
        return legState.get(legId);
      },
      updateSignalingDetails(legId, details) {
        const current = this.requireLeg(legId);
        current.signalingDetails = { ...(current.signalingDetails || {}), ...(details || {}) };
        return current;
      },
      hangupLeg() {},
    },
    extensionService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    trunkService: {
      emitInboundInvite() {
        return { legId: "trunk-inbound-leg-1" };
      },
    },
    authService: {
      async waitForResolution() {
        throw new Error("unused");
      },
    },
    ensureMediaTransportEndpoint: async (legId) => {
      const current = legState.get(legId) || { signalingDetails: {} };
      current.signalingDetails = {
        ...(current.signalingDetails || {}),
        localRtpAdvertisedIp: "pbx.example.test",
        localRtpPort: 38418,
        localSdpAudioLines: [
          "m=audio 38418 RTP/AVP 107 101",
          "a=rtpmap:107 opus/48000/2",
          "a=fmtp:107 cbr=1;useinbandfec=1",
          "a=rtpmap:101 telephone-event/8000",
          "a=fmtp:101 0-16",
          "a=ptime:20",
          "a=sendrecv",
        ],
      };
      legState.set(legId, current);
      return { ...(current.signalingDetails || {}) };
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  const host = {
    ref: "trunk-a",
    publicRef: "trunk-a",
    routeToken: "route-1",
    socket: fakeSocket,
    bindIp: "0.0.0.0",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "pbx.example.test",
    credentials: {
      publicDomain: "pbx.example.test",
    },
    registerMode: true,
    authTimeoutMs: 5000,
    registrationExpires: 600,
    registerHeaders: [],
    registrationTimer: null,
    registration: null,
  };
  service.trunkHosts.set(host.ref, host);

  const invite = formatSipRequest({
    method: "INVITE",
    requestUri: "sip:42257@51.178.16.122;n8n-route=route-1",
    headers: {
      Via: "SIP/2.0/UDP 85.142.148.80:5060;branch=z9hG4bK-test-trunk-answer",
      From: "\"home\" <sip:100@ruvoip.net>;tag=test-from",
      To: "<sip:42257@51.178.16.122;n8n-route=route-1>",
      "Call-ID": "trunk-answer-call-1",
      CSeq: "1 INVITE",
      Contact: "<sip:100@85.142.148.80:5060>",
      "Content-Type": "application/sdp",
      "Content-Length": "148",
    },
    body: [
      "v=0",
      "o=- 1 1 IN IP4 85.142.148.80",
      "s=-",
      "c=IN IP4 85.142.148.80",
      "t=0 0",
      "m=audio 4000 RTP/AVP 107 101",
      "a=rtpmap:107 opus/48000/2",
      "a=rtpmap:101 telephone-event/8000",
    ].join("\r\n"),
  });

  await service.handleEndpointDatagram(
    host,
    Buffer.from(invite, "utf8"),
    { address: "85.142.148.80", family: "udp4", port: 5060, size: Buffer.byteLength(invite) },
  );

  await service.answerInboundLeg("trunk-inbound-leg-1");

  assert.match(lastSentPayload, /^SIP\/2\.0 200 OK/m);
  assert.match(lastSentPayload, /^Contact: <sip:42257@pbx\.example\.test:5060>$/m);
  assert.match(lastSentPayload, /^o=- .* IN IP4 pbx\.example\.test$/m);
  assert.match(lastSentPayload, /^c=IN IP4 pbx\.example\.test$/m);
  assert.doesNotMatch(lastSentPayload, /@0\.0\.0\.0:5060/);
  assert.doesNotMatch(lastSentPayload, /IN IP4 0\.0\.0\.0/);
});

test("trunk without register mode reuses the same UDP listener as extensions on the same endpoint", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");

  const fakeSocket = {
    on() {},
    send(_buffer, _port, _host, callback) {
      callback(null);
    },
    close() {},
  };
  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails() {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        return { action: "not_applicable" };
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });
  service.getOrCreateUdpListener = async (bindIp, bindPort) => ({
    socket: fakeSocket,
    bindIp,
    bindPort: bindPort || 5060,
  });
  service.closeUdpListener = () => {};

  try {
    await service.activateExtensionsTrigger({
      ref: "office-ext",
      localBindIp: "127.0.0.1",
      localBindPort: 5060,
      realm: "office.test",
      authMode: "raw",
    });
    const extensionsEndpoint = service.getExtensionsEndpoint("office-ext");
    assert.ok(extensionsEndpoint);

    await service.activateTrunkTrigger({
      ref: "carrier-trunk",
      trunkRegisterMode: "auth",
      realm: "office.test",
      sipCredentials: {
        transport: "udp",
        localBindIp: "127.0.0.1",
        localBindPort: extensionsEndpoint.port,
      },
    });

    const trunkEndpoint = service.getTrunkEndpoint("carrier-trunk");
    assert.deepStrictEqual(trunkEndpoint, extensionsEndpoint);
    assert.strictEqual(
      service.extensionsHosts.get("office-ext").socket,
      service.trunkHosts.get("carrier-trunk").socket,
    );
  } finally {
    await service.deactivateTrunkTrigger("carrier-trunk");
    await service.deactivateExtensionsTrigger("office-ext");
  }
});

test("register-mode trunk may share an extensions listener even with a different realm", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");

  const fakeSocket = {
    on() {},
    send(_buffer, _port, _host, callback) {
      callback(null);
    },
    close() {},
  };
  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails() {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        return { action: "not_applicable" };
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });
  service.getOrCreateUdpListener = async (bindIp, bindPort) => ({
    socket: fakeSocket,
    bindIp,
    bindPort: bindPort || 5060,
  });
  service.closeUdpListener = () => {};

  try {
    await service.activateExtensionsTrigger({
      ref: "office-ext",
      localBindIp: "127.0.0.1",
      localBindPort: 5060,
      realm: "office.test",
      authMode: "raw",
    });

    await service.activateTrunkTrigger({
      ref: "carrier-trunk",
      trunkRegisterMode: "register",
      sipCredentials: {
        transport: "udp",
        localBindIp: "127.0.0.1",
        localBindPort: 5060,
        realm: "carrier.test",
        sipServer: "carrier.test",
        username: "carrier-user",
        password: "carrier-secret",
      },
    });

    assert.strictEqual(
      service.extensionsHosts.get("office-ext").socket,
      service.trunkHosts.get("carrier-trunk").socket,
    );
  } finally {
    await service.deactivateTrunkTrigger("carrier-trunk");
    await service.deactivateExtensionsTrigger("office-ext");
  }
});

test("trunk without register mode rejects sharing a listener with a different extensions realm", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");

  const fakeSocket = {
    on() {},
    close() {},
  };
  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails() {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        return { action: "not_applicable" };
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });
  service.getOrCreateUdpListener = async (bindIp, bindPort) => ({
    socket: fakeSocket,
    bindIp,
    bindPort: bindPort || 5060,
  });
  service.closeUdpListener = () => {};

  try {
    await service.activateExtensionsTrigger({
      ref: "office-ext",
      localBindIp: "127.0.0.1",
      localBindPort: 5060,
      realm: "office.test",
      authMode: "raw",
    });

    await assert.rejects(
      service.activateTrunkTrigger({
        ref: "carrier-trunk",
        trunkRegisterMode: "auth",
        realm: "carrier.test",
        sipCredentials: {
          transport: "udp",
          localBindIp: "127.0.0.1",
          localBindPort: 5060,
          username: "carrier-user",
          password: "carrier-secret",
        },
      }),
      /same realm/,
    );
  } finally {
    await service.deactivateTrunkTrigger("carrier-trunk");
    await service.deactivateExtensionsTrigger("office-ext");
  }
});

test("endpoint REGISTER handling gives trunk without register mode first priority on a shared listener", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { formatSipRequest } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");

  let lastSentPayload = "";
  let registeredExtensions = 0;
  const fakeSocket = {
    send(buffer, _port, _host, callback) {
      lastSentPayload = Buffer.from(buffer).toString("utf8");
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails() {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
      registerEndpoint() {
        registeredExtensions += 1;
      },
      unregisterEndpoint() {
        registeredExtensions -= 1;
      },
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution() {
        return { action: "challenge" };
      },
    },
    trunkAuthBridge: {
      createRequest() {
        return { authRequestId: "auth-trunk-register-1" };
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  const extensionsHost = {
    ref: "office-ext",
    publicRef: "office-ext",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "office.test",
    authMode: "raw",
    authorizationUsernamePrefix: "",
    continueTraversalOnAuthReject: false,
    staticCredentials: [],
  };
  const trunkHost = {
    ref: "carrier-trunk",
    publicRef: "carrier-trunk",
    routeToken: "route-trunk-1",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "carrier.test",
    credentials: {
      username: "carrier-user",
      password: "carrier-secret",
    },
    registerMode: false,
    authTimeoutMs: 5000,
    registrationExpires: 600,
    registerHeaders: [],
    registrationTimer: null,
    registration: null,
  };
  service.extensionsHosts.set(extensionsHost.ref, extensionsHost);
  service.trunkHosts.set(trunkHost.ref, trunkHost);

  const registerRequest = formatSipRequest({
    method: "REGISTER",
    requestUri: "sip:carrier-user@carrier.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-trunk-accept-priority-1",
      From: "<sip:carrier-user@carrier.test>;tag=trunk-accept-priority-1",
      To: "<sip:carrier-user@carrier.test>",
      "Call-ID": "trunk-accept-priority-call-1",
      CSeq: "1 REGISTER",
      Contact: "<sip:carrier-user@127.0.0.1:5070>",
      Expires: "600",
      "Content-Length": "0",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    extensionsHost,
    Buffer.from(registerRequest, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(registerRequest) },
  );

  assert.strictEqual(registeredExtensions, 0);
  assert.match(lastSentPayload, /^SIP\/2\.0 401 Unauthorized/m);
  assert.match(lastSentPayload, /^WWW-Authenticate: Digest realm="carrier\.test"/m);
});

test("trunk auth traversal can continue after reject when Continue On Auth Reject is enabled", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { formatSipRequest } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");

  let lastSentPayload = "";
  const fakeSocket = {
    send(buffer, _port, _host, callback) {
      lastSentPayload = Buffer.from(buffer).toString("utf8");
      callback(null);
    },
    close() {},
  };

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails() {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
      registerEndpoint() {
        throw new Error("unused");
      },
      unregisterEndpoint() {},
    },
    trunkService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    authService: {
      async waitForResolution(authRequestId) {
        if (authRequestId === "auth:carrier-a") {
          return { action: "deny", statusCode: 403, reason: "Forbidden A" };
        }
        return { action: "allow" };
      },
    },
    trunkAuthBridge: {
      createRequest(input) {
        return { authRequestId: `auth:${input.ref}` };
      },
    },
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  const extensionsHost = {
    ref: "office-ext",
    publicRef: "office-ext",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "office.test",
    authMode: "raw",
    authorizationUsernamePrefix: "",
    continueTraversalOnAuthReject: false,
    staticCredentials: [],
  };
  service.extensionsHosts.set(extensionsHost.ref, extensionsHost);
  service.trunkHosts.set("carrier-a", {
    ref: "carrier-a",
    publicRef: "carrier-a",
    routeToken: "route-trunk-a",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "carrier.test",
    credentials: {},
    registerMode: false,
    authTimeoutMs: 5000,
    continueTraversalOnAuthReject: true,
    registrationExpires: 600,
    registerHeaders: [],
    registrationTimer: null,
    registration: null,
  });
  service.trunkHosts.set("carrier-b", {
    ref: "carrier-b",
    publicRef: "carrier-b",
    routeToken: "route-trunk-b",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "carrier.test",
    credentials: {},
    registerMode: false,
    authTimeoutMs: 5000,
    continueTraversalOnAuthReject: false,
    registrationExpires: 600,
    registerHeaders: [],
    registrationTimer: null,
    registration: null,
  });

  const registerRequest = formatSipRequest({
    method: "REGISTER",
    requestUri: "sip:carrier-user@carrier.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-trunk-continue-auth-reject-1",
      From: "<sip:carrier-user@carrier.test>;tag=trunk-continue-auth-reject-1",
      To: "<sip:carrier-user@carrier.test>",
      "Call-ID": "trunk-continue-auth-reject-call-1",
      CSeq: "1 REGISTER",
      Contact: "<sip:carrier-user@127.0.0.1:5070>",
      Expires: "600",
      "Content-Length": "0",
    },
    body: "",
  });

  await service.handleEndpointDatagram(
    extensionsHost,
    Buffer.from(registerRequest, "utf8"),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(registerRequest) },
  );

  assert.match(lastSentPayload, /^SIP\/2\.0 200 OK/m);
});

test("trunk inbound INVITE routing prefers register route token, then no-register trunk", async () => {
  const { SipTransportService } = require("../../../../build-src/daemon/signaling/sip/sip-transport-service.js");
  const { formatSipRequest } = require("../../../../build-src/daemon/signaling/sip/sip-message.js");

  const fakeSocket = {
    send(_buffer, _port, _host, callback) {
      callback(null);
    },
    close() {},
  };
  const emittedRefs = [];

  const service = new SipTransportService({
    legService: {
      requireLeg() {
        return { signalingDetails: {} };
      },
      updateSignalingDetails() {
        return { signalingDetails: {} };
      },
      hangupLeg() {},
    },
    extensionService: {
      emitInboundInvite() {
        throw new Error("unused");
      },
    },
    trunkService: {
      emitInboundInvite(invite) {
        emittedRefs.push(invite.ref);
        return { legId: `leg-${emittedRefs.length}` };
      },
    },
    authService: {
      async waitForResolution() {
        return { action: "allow" };
      },
    },
    trunkAuthBridge: {
      createRequest() {
        return { authRequestId: "auth-trunk-invite-1" };
      },
    },
    ensureMediaTransportEndpoint: async () => ({
      localRtpAdvertisedIp: "pbx.example.test",
      localRtpPort: 40000,
      localSdpAudioLines: [
        "m=audio 40000 RTP/AVP 107 101",
        "a=rtpmap:107 opus/48000/2",
        "a=rtpmap:101 telephone-event/8000",
      ],
    }),
    onAttemptRinging() {},
    onAttemptProgress() {},
    onAttemptAnswered() {},
    onAttemptRejected() {},
  });

  service.trunkHosts.set("carrier-register", {
    ref: "carrier-register",
    publicRef: "carrier-register",
    routeToken: "route-register-1",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "carrier.test",
    credentials: {},
    registerMode: true,
    authTimeoutMs: 5000,
    registrationExpires: 600,
    registerHeaders: [],
    registrationTimer: null,
    registration: null,
  });
  service.trunkHosts.set("carrier-none", {
    ref: "carrier-none",
    publicRef: "carrier-none",
    routeToken: "route-none-1",
    socket: fakeSocket,
    bindIp: "127.0.0.1",
    bindPort: 5060,
    advertisedIp: "pbx.example.test",
    realm: "carrier.test",
    credentials: {},
    registerMode: false,
    authTimeoutMs: 5000,
    registrationExpires: 600,
    registerHeaders: [],
    registrationTimer: null,
    registration: null,
  });

  const routeInvite = formatSipRequest({
    method: "INVITE",
    requestUri: "sip:ivr@pbx.example.test;n8n-route=route-register-1",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-route-invite",
      From: "<sip:caller@carrier.test>;tag=route-invite",
      To: "<sip:ivr@pbx.example.test>",
      "Call-ID": "route-invite-call-1",
      CSeq: "1 INVITE",
      Contact: "<sip:caller@127.0.0.1:5070>",
      "Content-Length": "0",
    },
    body: "",
  });
  await service.handleOrderedTrunkInviteByEndpoint(
    "127.0.0.1",
    5060,
    require("../../../../build-src/daemon/signaling/sip/sip-message.js").parseSipMessage(Buffer.from(routeInvite, "utf8")),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(routeInvite) },
  );

  const plainInvite = formatSipRequest({
    method: "INVITE",
    requestUri: "sip:ivr@pbx.example.test",
    headers: {
      Via: "SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-plain-invite",
      From: "<sip:caller@carrier.test>;tag=plain-invite",
      To: "<sip:ivr@pbx.example.test>",
      "Call-ID": "plain-invite-call-1",
      CSeq: "1 INVITE",
      Contact: "<sip:caller@127.0.0.1:5070>",
      "Content-Length": "0",
    },
    body: "",
  });
  await service.handleOrderedTrunkInviteByEndpoint(
    "127.0.0.1",
    5060,
    require("../../../../build-src/daemon/signaling/sip/sip-message.js").parseSipMessage(Buffer.from(plainInvite, "utf8")),
    { address: "127.0.0.1", family: "udp4", port: 5070, size: Buffer.byteLength(plainInvite) },
  );

  assert.deepStrictEqual(emittedRefs, ["carrier-register", "carrier-none"]);
});

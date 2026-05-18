import dgram from "dgram";
import type { AddressInfo } from "net";
import { OPTION_DEFAULTS } from "../../../shared/option-defaults";
import {
  allowsSipDtmfMethod,
  SIP_AUDIO_CODEC_ALAW,
  SIP_AUDIO_CODEC_G722,
  SIP_AUDIO_CODEC_G729,
  SIP_AUDIO_CODEC_MULAW,
  SIP_AUDIO_CODEC_OPUS,
  normalizeSipAudioCodecFilters,
  normalizeSipDtmfMethodFilters,
  type SipDtmfMethodFilter,
  SIP_DTMF_METHOD_INBAND,
  SIP_DTMF_METHOD_RFC2833,
} from "../../../shared/sip-media-filters";
import type { WorkerTransportOutputMessage } from "../worker/media-worker";
import { findPlayTonePreset, parseCanonicalToneSegments } from "../operations/play-tones-operation";
import { TransportAttachment, type MediaTransport, type MediaTransportDetails, type MediaTransportInputEvent } from "./media-transport";
import type { BufferReleasePool } from "../streams/media-stream";

/**
 * Optional pool the RTP transport can borrow PCM scratch buffers from. When
 * provided, every decoded inbound audio frame lands directly in a pool buffer
 * and the event carries its `releasePool`, letting Leg.handleTransportEvent
 * skip the per-packet defensive copy out of `decodeScratch`.
 */
export interface RtpDecodeBufferPool extends BufferReleasePool {
  acquire(bytes: number): Buffer;
}
import {
  type AudioCodec,
  type AudioCodecDescriptor,
  buildSelectedLocalAudioSdpDescription,
  type NegotiatedPayloadCodec,
  PCM_S16LE_MONO_8KHZ,
  createCodec,
  getImplementedCodecDescriptors,
  pickNegotiatedDtmfPayloadType,
  resolveCodecForPayloadType,
  resolveAudioCodecForPayloadType,
} from "../codecs/audio-codec";
import { InbandDtmfDetector } from "../dtmf/inband-dtmf-detector";

const WORKER_MESSAGE_KIND_TRANSPORT_INPUT = 4;
const WORKER_TRANSPORT_INPUT_OPCODE_RTP_PACKET = 1;
const WORKER_TRANSPORT_OUTPUT_OPCODE_RTP_PACKET = 1;

const EMPTY_BUFFER = Buffer.alloc(0);

export type RtpTransportInputEvent =
  | { type: "audio"; pcm: Buffer; bytes?: number; sampleRate: number; channels: number; durationMs: number; level: number; payloadType: number; releasePool?: BufferReleasePool | null }
  | { type: "dtmf"; digits: string; createdAt: number; payloadType: number }
  | { type: "transport"; state: "closed"; reason: string };

export type RtpTransportConfig = {
  localRtpBindIp?: string | null;
  localRtpAdvertisedIp?: string | null;
  localRtpHost?: string | null;
  localRtpPort?: number | null;
  remoteRtpHost?: string | null;
  remoteRtpPort?: number | null;
  audioCodecName?: string | null;
  audioPayloadType?: number | null;
  dtmfPayloadType?: number | null;
  payloadTypes?: number[] | null;
  payloadCodecs?: Record<number, NegotiatedPayloadCodec> | null;
  allowedAudioCodecs?: string[] | null;
  allowedDtmfMethods?: string[] | null;
  currentSequenceNumber?: number | null;
  currentTimestamp?: number | null;
  currentSsrc?: number | null;
};

type ParsedRtpPacket = {
  payloadType: number;
  marker: boolean;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  payloadOffset: number;
  payloadLength: number;
};


function writeUInt16Be(buffer: Buffer, offset: number, value: number): void {
  buffer[offset] = (value >> 8) & 0xff;
  buffer[offset + 1] = value & 0xff;
}

function writeUInt32Be(buffer: Buffer, offset: number, value: number): void {
  buffer[offset] = (value >>> 24) & 0xff;
  buffer[offset + 1] = (value >>> 16) & 0xff;
  buffer[offset + 2] = (value >>> 8) & 0xff;
  buffer[offset + 3] = value & 0xff;
}

function readUInt16Be(buffer: Buffer, offset: number): number {
  return ((buffer[offset] || 0) << 8) | (buffer[offset + 1] || 0);
}

function readUInt32Be(buffer: Buffer, offset: number): number {
  return (
    ((buffer[offset] || 0) * 0x1000000) +
    ((buffer[offset + 1] || 0) << 16) +
    ((buffer[offset + 2] || 0) << 8) +
    (buffer[offset + 3] || 0)
  ) >>> 0;
}

function createRtpPacket(input: {
  payloadType: number;
  marker?: boolean;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  payload: Buffer;
}): Buffer {
  const packet = Buffer.alloc(12 + input.payload.length);
  return writeRtpPacket(packet, input);
}

function writeRtpPacket(
  packet: Buffer,
  input: {
    payloadType: number;
    marker?: boolean;
    sequenceNumber: number;
    timestamp: number;
    ssrc: number;
    payload: Buffer;
  },
): Buffer {
  packet[0] = 0x80;
  packet[1] = (input.marker ? 0x80 : 0) | (input.payloadType & 0x7f);
  writeUInt16Be(packet, 2, input.sequenceNumber & 0xffff);
  writeUInt32Be(packet, 4, input.timestamp >>> 0);
  writeUInt32Be(packet, 8, input.ssrc >>> 0);
  input.payload.copy(packet, 12);
  return packet;
}

function writeRtpPacketHeader(
  packet: Buffer,
  input: {
    payloadType: number;
    marker?: boolean;
    sequenceNumber: number;
    timestamp: number;
    ssrc: number;
  },
): Buffer {
  packet[0] = 0x80;
  packet[1] = (input.marker ? 0x80 : 0) | (input.payloadType & 0x7f);
  writeUInt16Be(packet, 2, input.sequenceNumber & 0xffff);
  writeUInt32Be(packet, 4, input.timestamp >>> 0);
  writeUInt32Be(packet, 8, input.ssrc >>> 0);
  return packet;
}

function parseRtpPacket(buffer: Buffer): ParsedRtpPacket | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }
  const version = buffer[0] >> 6;
  const csrcCount = buffer[0] & 0x0f;
  const hasExtension = (buffer[0] & 0x10) !== 0;
  const hasPadding = (buffer[0] & 0x20) !== 0;
  if (version !== 2 || csrcCount !== 0 || hasExtension) {
    return null;
  }
  const payloadEnd = hasPadding ? buffer.length - buffer[buffer.length - 1] : buffer.length;
  if (payloadEnd <= 12) {
    return null;
  }
  return {
    payloadType: buffer[1] & 0x7f,
    marker: (buffer[1] & 0x80) !== 0,
    sequenceNumber: readUInt16Be(buffer, 2),
    timestamp: readUInt32Be(buffer, 4),
    ssrc: readUInt32Be(buffer, 8),
    payloadOffset: 12,
    payloadLength: payloadEnd - 12,
  };
}

function dispatchInboundRtpFrame<T>(
  listeners: Set<(event: T) => void>,
  event: T,
): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error(
        `[sip-pbx:media-worker] inbound RTP listener failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function writeRtpPayloadPacket(
  packet: Buffer,
  input: {
    payloadType: number;
    marker: boolean;
    sequenceNumber: number;
    timestamp: number;
    ssrc: number;
  },
  payload: Buffer,
  payloadOffset = 0,
  payloadLength = payload.length - payloadOffset,
): number {
  const normalizedPayloadLength = Math.max(0, Math.min(Number(payloadLength) || 0, Math.max(0, payload.length - payloadOffset)));
  const packetLength = 12 + normalizedPayloadLength;
  if (packet.length < packetLength) {
    return 0;
  }
  writeRtpPacketHeader(packet, input);
  if (normalizedPayloadLength > 0) {
    payload.copy(packet, 12, payloadOffset, payloadOffset + normalizedPayloadLength);
  }
  return packetLength;
}

const DTMF_FREQUENCIES: Record<string, [number, number]> = {
  "1": [697, 1209],
  "2": [697, 1336],
  "3": [697, 1477],
  A: [697, 1633],
  "4": [770, 1209],
  "5": [770, 1336],
  "6": [770, 1477],
  B: [770, 1633],
  "7": [852, 1209],
  "8": [852, 1336],
  "9": [852, 1477],
  C: [852, 1633],
  "*": [941, 1209],
  "0": [941, 1336],
  "#": [941, 1477],
  D: [941, 1633],
};

function createTonePattern(tone: string): { frequencies: number[]; onMs: number; offMs: number } {
  const preset = findPlayTonePreset(tone);
  const segments = parseCanonicalToneSegments(preset.customTone) || parseCanonicalToneSegments(findPlayTonePreset(OPTION_DEFAULTS.playTone.tone).customTone) || [];
  const onSegment = segments[0];
  const offSegment = segments[1];
  return {
    frequencies: onSegment?.frequencies?.slice() || [440, 480],
    onMs: Math.max(1, Number(onSegment?.durationMs || 2000)),
    offMs: Math.max(0, Number(offSegment?.durationMs || 4000)),
  };
}

function writeToneSample(buffer: Buffer, offset: number, value: number): void {
  const normalized = Math.max(-32768, Math.min(32767, Math.round(value)));
  const unsigned = normalized < 0 ? 0x10000 + normalized : normalized;
  buffer[offset] = unsigned & 0xff;
  buffer[offset + 1] = (unsigned >> 8) & 0xff;
}

function writeDigitPcmInto(target: Buffer, offset: number, digit: string, durationMs: number, sampleRate: number): number {
  const frequencies = DTMF_FREQUENCIES[String(digit || "").toUpperCase()] || null;
  const sampleCount = Math.max(1, Math.round((Math.max(20, durationMs) / 1000) * sampleRate));
  const bytes = sampleCount * 2;
  if (target.length < offset + bytes) {
    return 0;
  }
  if (!frequencies) {
    target.fill(0, offset, offset + bytes);
    return bytes;
  }
  const [low, high] = frequencies;
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const combined = (Math.sin(2 * Math.PI * low * time) + Math.sin(2 * Math.PI * high * time)) / 2;
    writeToneSample(target, offset + (index * 2), combined * 32767 * 0.2);
  }
  return bytes;
}

export function createInbandDtmfPcm(digits: string, durationMs = 160, gapMs = 40, sampleRate = 8000, channels = 1): Buffer {
  const normalizedDigits = Array.from(String(digits || ""));
  if (normalizedDigits.length === 0) {
    return Buffer.alloc(0);
  }
  const monoDigitBytes = Math.max(1, Math.round((Math.max(20, durationMs) / 1000) * sampleRate)) * 2;
  const digitBytes = monoDigitBytes * Math.max(1, channels);
  const gapBytes = Math.max(0, Math.round((gapMs / 1000) * sampleRate)) * 2 * Math.max(1, channels);
  const totalBytes = normalizedDigits.reduce((sum, _digit, index) => {
    return sum + digitBytes + (gapBytes && index < normalizedDigits.length - 1 ? gapBytes : 0);
  }, 0);
  const output = Buffer.allocUnsafe(totalBytes);
  let offset = 0;
  for (let index = 0; index < normalizedDigits.length; index += 1) {
    const digitOffset = offset;
    const digitLength = writeDigitPcmInto(output, digitOffset, normalizedDigits[index]!, durationMs, sampleRate);
    if (!digitLength) {
      continue;
    }
    if (channels > 1) {
      for (let sampleOffset = digitLength - 2; sampleOffset >= 0; sampleOffset -= 2) {
        const byteOffset = digitOffset + (sampleOffset * channels);
        const low = output[digitOffset + sampleOffset] || 0;
        const high = output[digitOffset + sampleOffset + 1] || 0;
        for (let channel = 0; channel < channels; channel += 1) {
          const channelOffset = byteOffset + (channel * 2);
          output[channelOffset] = low;
          output[channelOffset + 1] = high;
        }
      }
    }
    offset += digitBytes;
    if (gapBytes && index < normalizedDigits.length - 1) {
      output.fill(0, offset, offset + gapBytes);
      offset += gapBytes;
    }
  }
  return output;
}

export function createTonePcm(
  tone: string,
  durationMs: number,
  sampleRate = 8000,
  amplitude = 0.2,
): Buffer {
  const safeDurationMs = Math.max(20, durationMs);
  const sampleCount = Math.max(1, Math.round((safeDurationMs / 1000) * sampleRate));
  const pcm = Buffer.alloc(sampleCount * 2);
  const pattern = createTonePattern(String(tone || OPTION_DEFAULTS.playTone.tone));
  for (let index = 0; index < sampleCount; index += 1) {
    const elapsedMs = Math.floor((index / sampleRate) * 1000);
    const cycleMs = pattern.onMs + pattern.offMs;
    const inOnWindow = cycleMs <= 0 ? true : (elapsedMs % cycleMs) < pattern.onMs;
    if (!inOnWindow) {
      continue;
    }
    const time = index / sampleRate;
    const combined = pattern.frequencies.reduce((sum, frequency) => {
      return sum + Math.sin(2 * Math.PI * frequency * time);
    }, 0) / Math.max(1, pattern.frequencies.length);
    writeToneSample(pcm, index * 2, combined * 32767 * amplitude);
  }
  return pcm;
}

function waitForBind(socket: dgram.Socket, bindIp: string): Promise<AddressInfo> {
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
    socket.bind(0, bindIp);
  });
}

function bindUdpSocket(socket: dgram.Socket, port: number, host: string): Promise<AddressInfo> {
  return new Promise<AddressInfo>((resolve, reject) => {
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

function computePcmLevel(pcm: Buffer, offset = 0, length = pcm.length - offset): number {
  const normalizedOffset = Math.max(0, Math.min(Number(offset) || 0, pcm.length));
  const normalizedLength = Math.max(0, Math.min(Number(length) || 0, pcm.length - normalizedOffset));
  if (!normalizedLength) {
    return 0;
  }
  let max = 0;
  for (let current = normalizedOffset; current + 1 < normalizedOffset + normalizedLength; current += 2) {
    const value = ((pcm[current + 1] || 0) << 8) | (pcm[current] || 0);
    const sample = Math.abs(value & 0x8000 ? value - 0x10000 : value);
    if (sample > max) {
      max = sample;
    }
  }
  return max / 32767;
}

const TELEPHONE_EVENT_DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#", "A", "B", "C", "D"];

function parseTelephoneEvent(payload: Buffer, offset = 0, length = payload.length - offset): { digits: string; end: boolean } | null {
  const normalizedOffset = Math.max(0, Math.min(Number(offset) || 0, payload.length));
  const normalizedLength = Math.max(0, Math.min(Number(length) || 0, payload.length - normalizedOffset));
  if (!Buffer.isBuffer(payload) || normalizedLength < 4) {
    return null;
  }
  const eventCode = payload[normalizedOffset] || 0;
  const digit = TELEPHONE_EVENT_DIGITS[eventCode] || "";
  if (!digit) {
    return null;
  }
  return {
    digits: digit,
    end: (payload[normalizedOffset + 1] & 0x80) !== 0,
  };
}

function createTelephoneEventPayload(digit: string, end: boolean, duration: number): Buffer | null {
  const eventCode = TELEPHONE_EVENT_DIGITS.indexOf(String(digit || "").slice(0, 1));
  if (eventCode < 0) {
    return null;
  }
  const payload = Buffer.alloc(4);
  payload[0] = eventCode & 0xff;
  payload[1] = (end ? 0x80 : 0) | 0x0a;
  payload[2] = (duration >> 8) & 0xff;
  payload[3] = duration & 0xff;
  return payload;
}

function getDefaultAudioCodecDescriptor(): AudioCodecDescriptor {
  return (
    resolveAudioCodecForPayloadType(8)
    || resolveAudioCodecForPayloadType(0)
    || (getImplementedCodecDescriptors("audio")[0] as AudioCodecDescriptor | undefined)
    || (() => {
      throw new Error("No implemented RTP audio codecs available");
    })()
  );
}

function readOptionalInteger(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    return null;
  }
  return numeric;
}

export function createRtpTransportAttachment(input: {
  legId: string;
  onRemoteRtpSourceChanged?: (legId: string, remoteHost: string, remotePort: number) => void;
}): TransportAttachment {
  const legId = String(input.legId || "").trim();
  const onRemoteRtpSourceChanged = input.onRemoteRtpSourceChanged;
  return new (class extends TransportAttachment {
    private socket: dgram.Socket | null = null;
    private bindIp = "127.0.0.1";
    private localHost = "127.0.0.1";
    private localPort = 0;
    private advertisedHost = "127.0.0.1";
    private remoteHost: string | null = null;
    private remotePort = 0;
    private configuredRemoteHost: string | null = null;
    private configuredRemotePort = 0;
    private closing = false;
    private closeNotified = false;
    private firstPacketLogged = false;
    private sendErrorLogged = false;

    constructor() {
      super(legId, "sip");
    }

    async configure(config: Record<string, unknown>): Promise<Record<string, unknown>> {
      this.bindIp = String(config.localRtpBindIp || this.bindIp || "127.0.0.1").trim() || "127.0.0.1";
      this.advertisedHost = String(
        config.localRtpAdvertisedIp || config.localRtpHost || this.advertisedHost || this.bindIp,
      ).trim() || this.bindIp;
      const nextConfiguredRemoteHost = String(config.remoteRtpHost || "").trim() || null;
      const nextConfiguredRemotePort = Math.max(0, Number(config.remoteRtpPort || 0) || 0);
      const configuredRemoteChanged = nextConfiguredRemoteHost !== this.configuredRemoteHost
        || nextConfiguredRemotePort !== this.configuredRemotePort;
      this.configuredRemoteHost = nextConfiguredRemoteHost;
      this.configuredRemotePort = nextConfiguredRemotePort;
      if (configuredRemoteChanged || !this.remoteHost || !this.remotePort) {
        this.remoteHost = nextConfiguredRemoteHost;
        this.remotePort = nextConfiguredRemotePort;
      }
      const requestedPort = Math.max(0, Number(config.localRtpPort || this.localPort || 0) || 0);
      await this.ensureSocket(requestedPort);
      console.error(
        `[sip-pbx:media-worker] rtp attachment configured; leg=${legId}; local=${this.localHost}:${this.localPort}; remote=${this.remoteHost || "null"}:${this.remotePort || 0}; socket=${Boolean(this.socket)}`,
      );
      return {
        localRtpBindIp: this.bindIp,
        localRtpHost: this.localHost,
        localRtpPort: this.localPort,
        localRtpAdvertisedIp: this.advertisedHost,
        remoteRtpHost: this.remoteHost,
        remoteRtpPort: this.remotePort,
      };
    }

    async handleWorkerOutput(message: WorkerTransportOutputMessage): Promise<boolean> {
      if (message.opcode !== WORKER_TRANSPORT_OUTPUT_OPCODE_RTP_PACKET) {
        return false;
      }
      const socket = this.socket;
      const packet = message.payload.packet;
      const normalizedBytes = Math.max(0, Math.min(Number(message.payload.bytes ?? packet.length) || 0, packet.length));
      if (!socket || !this.remoteHost || !this.remotePort || !normalizedBytes) {
        console.error(
          `[sip-pbx:media-worker] rtp attachment dropped packet; leg=${this.legId}; hasSocket=${Boolean(socket)}; remote=${this.remoteHost || "null"}:${this.remotePort || 0}; packetBytes=${normalizedBytes}`,
        );
        return false;
      }
      try {
        socket.send(packet, 0, normalizedBytes, this.remotePort, this.remoteHost!, (error) => {
          if (error) {
            this.logSendError(error);
          }
        });
      } catch (error) {
        this.logSendError(error);
        return false;
      }
      return true;
    }

    async close(): Promise<void> {
      this.suspend();
      this.closing = true;
      const socket = this.socket;
      this.socket = null;
      if (!socket) {
        return;
      }
      console.error(`[sip-pbx:media-worker] rtp attachment close start; leg=${this.legId}; local=${this.localHost}:${this.localPort}; remote=${this.remoteHost || "null"}:${this.remotePort || 0}`);
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        try {
          socket.close();
        } catch (error) {
          console.error(
            `[sip-pbx:media-worker] rtp attachment close failed immediately; leg=${this.legId}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
          );
          resolve();
        }
      });
      console.error(`[sip-pbx:media-worker] rtp attachment close done; leg=${this.legId}; local=${this.localHost}:${this.localPort}`);
    }

    private async ensureSocket(requestedPort: number): Promise<void> {
      if (this.socket) {
        return;
      }
      const socket = dgram.createSocket("udp4");
      const address = await bindUdpSocket(socket, requestedPort, this.bindIp);
      this.socket = socket;
      this.localHost = String(address.address || this.bindIp || "127.0.0.1");
      this.localPort = Number(address.port || requestedPort || 0);
      if (!this.advertisedHost) {
        this.advertisedHost = this.localHost;
      }
      socket.on("message", (packet, rinfo) => {
        const nextRemoteHost = String(rinfo.address || "").trim() || null;
        const nextRemotePort = Math.max(0, Number(rinfo.port || 0) || 0);
        const remoteChanged = nextRemoteHost !== this.remoteHost || nextRemotePort !== this.remotePort;
        this.remoteHost = nextRemoteHost;
        this.remotePort = nextRemotePort;
        if (remoteChanged && this.remoteHost && this.remotePort > 0) {
          onRemoteRtpSourceChanged?.(this.legId, this.remoteHost, this.remotePort);
        }
        this.queueTransportInput({
          kind: WORKER_MESSAGE_KIND_TRANSPORT_INPUT,
          opcode: WORKER_TRANSPORT_INPUT_OPCODE_RTP_PACKET,
          payload: {
            legId: this.legId,
            packet,
          },
        });
      });
      socket.on("close", () => {
        this.socket = null;
        if (!this.closing && !this.closeNotified) {
          this.closeNotified = true;
          this.deliverTransportClosed("rtp_socket_closed");
        }
      });
      socket.on("error", () => {
        if (this.closing || this.closeNotified) {
          return;
        }
        this.closeNotified = true;
        this.deliverTransportClosed("rtp_socket_error");
        try {
          socket.close();
        } catch (error) {
          console.error(
            `[sip-pbx:media-worker] RTP socket close failed after error; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
          );
        }
      });
    }

    private logSendError(error: unknown): void {
      if (this.closing || this.sendErrorLogged) {
        return;
      }
      this.sendErrorLogged = true;
      const message = error instanceof Error ? error.message : String(error || "unknown");
      console.error(`[sip-pbx:media-worker] rtp attachment send failed; leg=${this.legId}; error=${message}`);
    }
  })();
}

export class RtpTransport implements MediaTransport {
  readonly transportType = "sip" as const;
  private readonly listeners = new Set<(event: MediaTransportInputEvent) => void>();
  private readonly externalSendPacketFn: ((packet: Buffer, bytes?: number) => boolean) | null;
  private codec: AudioCodec;
  private audioPayloadType: number;
  private audioCodecDescriptor: AudioCodecDescriptor;
  private dtmfPayloadType: number | null;
  private payloadTypes: number[];
  private payloadCodecs: Record<number, NegotiatedPayloadCodec>;
  private allowedDtmfMethods: SipDtmfMethodFilter[];
  private sequenceNumber: number;
  private timestamp: number;
  private ssrc: number;
  private packetScratch: Buffer;
  private decodeScratch: Buffer;
  private playbackSendChain: Promise<void> = Promise.resolve();
  private socket: dgram.Socket | null = null;
  private localBindIp = "127.0.0.1";
  private localHost = "127.0.0.1";
  private localPort = 0;
  private advertisedHost = "127.0.0.1";
  private remoteAddress: string | null = null;
  private remotePort = 0;
  private configuredRemoteAddress: string | null = null;
  private configuredRemotePort = 0;
  private firstInboundAudioLogged = false;
  private firstInboundAudioDecodeFailedLogged = false;
  private sendErrorLogged = false;
  private lastInboundDtmfKey = "";
  private readonly inbandDtmfDetector = new InbandDtmfDetector();

  private decodeBufferPool: RtpDecodeBufferPool | null = null;

  constructor(input?: {
    sendPacket?: (packet: Buffer, bytes?: number) => Promise<boolean> | boolean;
    codec?: AudioCodec;
    config?: RtpTransportConfig;
    decodeBufferPool?: RtpDecodeBufferPool | null;
  }) {
    this.externalSendPacketFn = input?.sendPacket
      ? (packet, bytes) => {
          try {
            const result = input.sendPacket?.(packet, bytes);
            if (result && typeof (result as Promise<boolean>).then === "function") {
              void (result as Promise<boolean>).catch((error) => this.logSendError(error));
              return true;
            }
            return Boolean(result);
          } catch (error) {
            this.logSendError(error);
            return false;
          }
        }
      : null;
    this.codec = input?.codec || createCodec("g711");
    const defaultAudioCodec = getDefaultAudioCodecDescriptor();
    this.audioPayloadType = defaultAudioCodec.payloadType;
    this.audioCodecDescriptor = defaultAudioCodec;
    this.dtmfPayloadType = 101;
    this.payloadTypes = [defaultAudioCodec.payloadType, 101];
    this.payloadCodecs = {};
    this.allowedDtmfMethods = [SIP_DTMF_METHOD_RFC2833];
    this.sequenceNumber = Math.floor(Math.random() * 0x10000);
    this.timestamp = Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.ssrc = Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.packetScratch = Buffer.allocUnsafe(512);
    this.decodeScratch = Buffer.allocUnsafe(2048);
    this.decodeBufferPool = input?.decodeBufferPool || null;
  }

  setDecodeBufferPool(pool: RtpDecodeBufferPool | null): void {
    this.decodeBufferPool = pool;
  }

  subscribe(listener: (event: MediaTransportInputEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async configure(config: RtpTransportConfig = {}, codec?: AudioCodec): Promise<MediaTransportDetails> {
    const nextCodec = codec || this.codec;
    this.localBindIp = String(config.localRtpBindIp || this.localBindIp || "127.0.0.1").trim() || "127.0.0.1";
    this.localHost = String(config.localRtpHost || this.localHost || this.localBindIp).trim() || this.localBindIp;
    this.localPort = Math.max(0, Number(config.localRtpPort || this.localPort || 0) || 0);
    this.advertisedHost = String(config.localRtpAdvertisedIp || this.advertisedHost || this.localBindIp).trim() || this.localBindIp;
    const nextConfiguredRemoteAddress = String(config.remoteRtpHost || "").trim() || null;
    const nextConfiguredRemotePort = Math.max(0, Number(config.remoteRtpPort || 0) || 0);
    const configuredRemoteChanged = nextConfiguredRemoteAddress !== this.configuredRemoteAddress
      || nextConfiguredRemotePort !== this.configuredRemotePort;
    this.configuredRemoteAddress = nextConfiguredRemoteAddress;
    this.configuredRemotePort = nextConfiguredRemotePort;
    if (configuredRemoteChanged || !this.remoteAddress || !this.remotePort) {
      this.remoteAddress = nextConfiguredRemoteAddress;
      this.remotePort = nextConfiguredRemotePort;
    }
    const requestedSequenceNumber = readOptionalInteger(config.currentSequenceNumber);
    const requestedTimestamp = readOptionalInteger(config.currentTimestamp);
    const requestedSsrc = readOptionalInteger(config.currentSsrc);
    const normalizedPayloadCodecs = { ...(config.payloadCodecs || {}) };
    const allowedAudioCodecs = normalizeSipAudioCodecFilters(config.allowedAudioCodecs);
    const allowedDtmfMethods = normalizeSipDtmfMethodFilters(config.allowedDtmfMethods);
    this.allowedDtmfMethods = allowedDtmfMethods;
    this.inbandDtmfDetector.reset();
    const normalizedPayloadTypes = Array.isArray(config.payloadTypes)
      ? config.payloadTypes
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0)
        .filter((value) => {
          const descriptor = resolveCodecForPayloadType(value, normalizedPayloadCodecs);
          if (!descriptor || !descriptor.implemented) {
            return false;
          }
          if (descriptor.kind === "dtmf") {
            return allowsSipDtmfMethod(allowedDtmfMethods, SIP_DTMF_METHOD_RFC2833);
          }
          if (!allowedAudioCodecs.length) {
            return true;
          }
          const codecName = String(descriptor.name || "").trim().toLowerCase();
          return (
            (codecName === "pcma" && allowedAudioCodecs.includes(SIP_AUDIO_CODEC_ALAW))
            || (codecName === "pcmu" && allowedAudioCodecs.includes(SIP_AUDIO_CODEC_MULAW))
            || (codecName === "g722" && allowedAudioCodecs.includes(SIP_AUDIO_CODEC_G722))
            || (codecName === "g729" && allowedAudioCodecs.includes(SIP_AUDIO_CODEC_G729))
            || (codecName === "opus" && allowedAudioCodecs.includes(SIP_AUDIO_CODEC_OPUS))
          );
        })
      : [];
    const requestedAudioPayloadType = readOptionalInteger(config.audioPayloadType);
    const requestedDtmfPayloadType = readOptionalInteger(config.dtmfPayloadType);
    const requestedAudioAllowed = requestedAudioPayloadType != null
      && (!normalizedPayloadTypes.length || normalizedPayloadTypes.includes(requestedAudioPayloadType));
    const requestedDescriptor = requestedAudioAllowed
      ? nextCodec.resolveDescriptor(requestedAudioPayloadType, normalizedPayloadCodecs)
      : null;
    const nextDescriptor = (
      requestedDescriptor
      || nextCodec.pickDescriptor(normalizedPayloadTypes, normalizedPayloadCodecs)
      || getDefaultAudioCodecDescriptor()
    );
    if (this.audioCodecDescriptor.name !== nextDescriptor.name || nextCodec !== this.codec) {
      this.codec.close();
    }
    this.codec = nextCodec;
    this.audioCodecDescriptor = nextDescriptor;
    this.audioPayloadType = requestedDescriptor
      ? requestedAudioPayloadType
      : nextDescriptor.payloadType;
    this.dtmfPayloadType = !allowsSipDtmfMethod(allowedDtmfMethods, SIP_DTMF_METHOD_RFC2833)
      ? null
      : requestedDtmfPayloadType != null
      && (
        !normalizedPayloadTypes.length
        || normalizedPayloadTypes.includes(requestedDtmfPayloadType)
        || String(normalizedPayloadCodecs[requestedDtmfPayloadType]?.codec || "").trim().toLowerCase() === "telephone-event"
      )
      ? requestedDtmfPayloadType
      : pickNegotiatedDtmfPayloadType(
        normalizedPayloadTypes,
        normalizedPayloadCodecs,
        nextDescriptor.clockRate,
        allowedDtmfMethods,
      )
        ?? (normalizedPayloadTypes.length ? null : 101);
    this.payloadTypes = this.dtmfPayloadType != null
      ? [this.audioPayloadType, this.dtmfPayloadType]
      : [this.audioPayloadType];
    this.payloadCodecs = normalizedPayloadCodecs;
    if (requestedSequenceNumber != null) {
      this.sequenceNumber = requestedSequenceNumber & 0xffff;
    }
    if (requestedTimestamp != null) {
      this.timestamp = requestedTimestamp >>> 0;
    }
    if (requestedSsrc != null) {
      this.ssrc = requestedSsrc >>> 0;
    }
    await this.ensureLocalSocket();
    return this.getDetails();
  }

  getDetails(): MediaTransportDetails {
    const localAudioSdp = buildSelectedLocalAudioSdpDescription(
      this.localPort,
      this.audioPayloadType,
      this.dtmfPayloadType,
      this.payloadCodecs,
      this.allowedDtmfMethods,
    );
    return {
      localRtpHost: this.advertisedHost,
      localRtpPort: this.localPort,
      remoteRtpHost: this.remoteAddress,
      remoteRtpPort: this.remotePort,
      audioCodecName: this.audioCodecDescriptor.name,
      audioPayloadType: this.audioPayloadType,
      dtmfPayloadType: this.dtmfPayloadType,
      payloadTypes: this.payloadTypes.slice(),
      payloadCodecs: { ...(this.payloadCodecs || {}) },
      localSdpAudioLines: localAudioSdp ? localAudioSdp.lines.slice() : [],
    };
  }

  handlePacket(packet: Buffer | Uint8Array, source?: { address?: string; port?: number } | null): void {
    if (source) {
      const sourceAddress = source.address;
      const sourcePort = source.port;
      if (sourceAddress && typeof sourcePort === "number" && sourcePort > 0) {
        this.remoteAddress = sourceAddress;
        this.remotePort = sourcePort;
      }
    }
    // dgram always hands us a Buffer; the Uint8Array branch is only hit by
    // tests that synthesise a raw view. Avoid a per-packet allocation in the
    // common case by using the input directly when it's already a Buffer.
    const normalizedPacket = Buffer.isBuffer(packet)
      ? packet
      : (packet instanceof Uint8Array
        ? Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength)
        : EMPTY_BUFFER);
    const parsed = parseRtpPacket(normalizedPacket);
    if (!parsed) {
      return;
    }
    if (this.dtmfPayloadType != null && parsed.payloadType === this.dtmfPayloadType) {
      const dtmf = parseTelephoneEvent(normalizedPacket, parsed.payloadOffset, parsed.payloadLength);
      if (!dtmf || !dtmf.end) {
        return;
      }
      const dtmfKey = `${parsed.ssrc}:${parsed.timestamp}:${dtmf.digits}`;
      if (dtmfKey === this.lastInboundDtmfKey) {
        return;
      }
      this.lastInboundDtmfKey = dtmfKey;
      this.inbandDtmfDetector.notifyExternalDtmf();
      this.dispatch({
        type: "dtmf",
        digits: dtmf.digits,
        createdAt: Date.now(),
        payloadType: parsed.payloadType,
      });
      return;
    }
    const descriptor = this.codec.resolveDescriptor(parsed.payloadType, this.payloadCodecs)
      || (parsed.payloadType === this.audioPayloadType ? this.audioCodecDescriptor : null)
      || resolveAudioCodecForPayloadType(parsed.payloadType, this.payloadCodecs);
    if (!descriptor) {
      return;
    }
    const estimatedDecodeBytes = Math.max(
      2048,
      Math.round((Math.max(1, Number(descriptor.pcmSampleRate || 8000)) / 50) * Math.max(1, Number(descriptor.channels || 1)) * 2),
      parsed.payloadLength * 8,
    );
    // Decode straight into a pool buffer when one is wired. Downstream
    // consumers (Leg.handleTransportEvent → recording / bridge / preroll)
    // hold their own references via the carried `releasePool` so the leg
    // can skip its defensive copy out of `decodeScratch`.
    const pool = this.decodeBufferPool;
    let decodeTarget: Buffer;
    let usingPoolBuffer = false;
    if (pool) {
      decodeTarget = pool.acquire(estimatedDecodeBytes);
      if (!decodeTarget.length || decodeTarget.length < estimatedDecodeBytes) {
        // Pool refused; fall back to scratch.
        if (decodeTarget.length) {
          pool.release(decodeTarget);
        }
        if (this.decodeScratch.length < estimatedDecodeBytes) {
          this.decodeScratch = Buffer.allocUnsafe(Math.max(estimatedDecodeBytes, this.decodeScratch.length * 2, 2048));
        }
        decodeTarget = this.decodeScratch;
      } else {
        usingPoolBuffer = true;
      }
    } else {
      if (this.decodeScratch.length < estimatedDecodeBytes) {
        this.decodeScratch = Buffer.allocUnsafe(Math.max(estimatedDecodeBytes, this.decodeScratch.length * 2, 2048));
      }
      decodeTarget = this.decodeScratch;
    }
    const pcmLength = this.decodePayload(descriptor, parsed.payloadType, normalizedPacket, parsed.payloadOffset, parsed.payloadLength, decodeTarget);
    if (!pcmLength) {
      if (usingPoolBuffer && pool) {
        pool.release(decodeTarget);
      }
      if (!this.firstInboundAudioDecodeFailedLogged) {
        this.firstInboundAudioDecodeFailedLogged = true;
        console.error(
          `[sip-pbx:media-worker] rtp inbound audio decode yielded no pcm; payloadType=${parsed.payloadType}; codec=${descriptor.name}; payloadBytes=${parsed.payloadLength}; remote=${this.remoteAddress || "null"}:${this.remotePort || 0}`,
        );
      }
      return;
    }
    const pcmSampleRate = Math.max(1, Number(descriptor.pcmSampleRate || 8000));
    const pcmChannels = 1;
    const durationMs = Math.max(
      1,
      Math.round(
        (pcmLength / (2 * pcmChannels) / pcmSampleRate) * 1000,
      ),
    );
    if (allowsSipDtmfMethod(this.allowedDtmfMethods, SIP_DTMF_METHOD_INBAND)) {
      const createdAt = Date.now();
      for (const digits of this.inbandDtmfDetector.feed({
        pcm: decodeTarget,
        bytes: pcmLength,
        sampleRate: pcmSampleRate,
        channels: pcmChannels,
        durationMs,
        nowMs: createdAt,
      })) {
        this.dispatch({
          type: "dtmf",
          digits,
          createdAt,
          payloadType: parsed.payloadType,
        });
      }
    }
    this.dispatch({
      type: "audio",
      pcm: decodeTarget,
      bytes: pcmLength,
      sampleRate: pcmSampleRate,
      channels: pcmChannels,
      durationMs,
      level: computePcmLevel(decodeTarget, 0, pcmLength),
      payloadType: parsed.payloadType,
      releasePool: usingPoolBuffer ? pool : null,
    });
    if (!this.firstInboundAudioLogged) {
      this.firstInboundAudioLogged = true;
      console.error(
        `[sip-pbx:media-worker] rtp inbound audio decoded; payloadType=${parsed.payloadType}; codec=${descriptor.name}; pcmBytes=${pcmLength}; level=${computePcmLevel(decodeTarget, 0, pcmLength).toFixed(6)}; remote=${this.remoteAddress || "null"}:${this.remotePort || 0}`,
      );
    }
  }

  handleClosed(reason: string): void {
    this.dispatch({
      type: "transport",
      state: "closed",
      reason: String(reason || "transport_closed"),
    });
  }

  async sendPlaybackPcm(pcm: Buffer, marker = false, bytes = pcm.length): Promise<boolean> {
    const task = this.playbackSendChain.then(async () => await this.sendPlaybackPcmInternal(pcm, marker, bytes));
    this.playbackSendChain = task.then(
      () => undefined,
      (error) => {
        this.logSendError(error);
      },
    );
    return await task;
  }

  private async sendPlaybackPcmInternal(pcm: Buffer, marker = false, bytes = pcm.length): Promise<boolean> {
    const normalizedBytes = Math.max(0, Math.min(Number(bytes) || 0, pcm.length));
    if (!normalizedBytes) {
      return false;
    }
    const channels = Math.max(1, Number(this.audioCodecDescriptor.channels || 1));
    const frameBytes = Math.max(
      2,
      Math.round((Math.max(1, Number(this.audioCodecDescriptor.pcmSampleRate || 8000)) / 50) * channels * 2),
    );
    let sent = false;
    let tailFrame: Buffer | null = null;
    for (let offset = 0; offset < normalizedBytes; offset += frameBytes) {
      const frameLength = Math.min(frameBytes, normalizedBytes - offset);
      const packetLength = 12 + frameLength;
      if (this.packetScratch.length < packetLength) {
        this.packetScratch = Buffer.allocUnsafe(Math.max(packetLength, this.packetScratch.length * 2, 512));
      }
      let frame = pcm;
      if (frameLength !== frameBytes) {
        tailFrame ||= Buffer.allocUnsafe(frameBytes);
        frame = tailFrame;
        pcm.copy(frame, 0, offset, offset + frameLength);
        frame.fill(0, frameLength);
      }
      const packet = this.packetScratch;
      const pcmOffset = frame === pcm ? offset : 0;
      const pcmBytes = frame === pcm ? frameLength : frameBytes;
      const encodedLength = this.encodeFrame(frame, packet, 12, pcmOffset, pcmBytes);
      if (!encodedLength) {
        continue;
      }
      writeRtpPacketHeader(packet, {
        payloadType: this.audioPayloadType,
        marker: marker && offset === 0,
        sequenceNumber: this.sequenceNumber,
        timestamp: this.timestamp,
        ssrc: this.ssrc,
      });
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
      const rtpSamples = Math.max(
        1,
        Math.round((Math.floor(pcmBytes / (2 * channels)) * this.audioCodecDescriptor.clockRate) / Math.max(1, Number(this.audioCodecDescriptor.pcmSampleRate || 8000))),
      );
      this.timestamp = (this.timestamp + rtpSamples) >>> 0;
      sent = this.sendPacket(packet, 12 + encodedLength) || sent;
      if (offset + frameBytes < normalizedBytes) {
        const frameDurationMs = Math.max(
          1,
          Math.round((Math.floor(pcmBytes / (2 * channels)) * 1000) / Math.max(1, Number(this.audioCodecDescriptor.pcmSampleRate || 8000))),
        );
        await sleep(frameDurationMs);
      }
    }
    return sent;
  }

  async sendDtmf(digits: string, method: string): Promise<boolean> {
    const normalizedMethod = String(method || OPTION_DEFAULTS.sendDtmf.method);
    if (normalizedMethod === "inband") {
      return await this.sendPlaybackPcm(
        createInbandDtmfPcm(
          digits,
          160,
          40,
          Math.max(1, Number(this.audioCodecDescriptor.pcmSampleRate || 8000)),
          Math.max(1, Number(this.audioCodecDescriptor.channels || 1)),
        ),
      );
    }
    if (normalizedMethod !== OPTION_DEFAULTS.sendDtmf.method && normalizedMethod !== "rfc2833") {
      return false;
    }
    const normalizedDigits = String(digits || "");
    if (this.dtmfPayloadType == null || !normalizedDigits) {
      return false;
    }
    let sent = false;
    for (const digit of normalizedDigits) {
      const startPayload = createTelephoneEventPayload(digit, false, 160);
      const endPayload = createTelephoneEventPayload(digit, true, 320);
      if (!startPayload || !endPayload) {
        continue;
      }
      const timestamp = this.timestamp;
      const startPacket = this.packetScratch;
      const startPacketLength = writeRtpPayloadPacket(startPacket, {
        payloadType: this.dtmfPayloadType,
        marker: true,
        sequenceNumber: this.sequenceNumber,
        timestamp,
        ssrc: this.ssrc,
      }, startPayload, 0, startPayload.length);
      if (!startPacketLength) {
        continue;
      }
      sent = this.sendPacket(startPacket, startPacketLength) || sent;
      const endPacket = this.packetScratch;
      const endPacketLength = writeRtpPayloadPacket(endPacket, {
        payloadType: this.dtmfPayloadType,
        marker: false,
        sequenceNumber: (this.sequenceNumber + 1) & 0xffff,
        timestamp,
        ssrc: this.ssrc,
      }, endPayload, 0, endPayload.length);
      if (!endPacketLength) {
        continue;
      }
      sent = this.sendPacket(endPacket, endPacketLength) || sent;
      this.sequenceNumber = (this.sequenceNumber + 2) & 0xffff;
      this.timestamp = (this.timestamp + 160) >>> 0;
    }
    return sent;
  }

  close(): void {
    this.listeners.clear();
    if (this.socket) {
      try {
        this.socket.close();
      } catch (error) {
        console.error(
          `[sip-pbx:media-worker] RTP socket close failed during transport close; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
        );
      }
      this.socket = null;
    }
    this.codec.close();
  }

  private async ensureLocalSocket(): Promise<void> {
    if (this.externalSendPacketFn || this.socket) {
      return;
    }
    const socket = dgram.createSocket("udp4");
    const address = await waitForBind(socket, this.localBindIp);
    this.socket = socket;
    this.localHost = String(address.address || this.localBindIp || "127.0.0.1");
    this.localPort = Number(address.port || 0);
    if (!this.advertisedHost) {
      this.advertisedHost = this.localHost;
    }
    socket.on("message", (buffer, rinfo) => {
      this.handlePacket(buffer, rinfo);
    });
    socket.on("error", () => undefined);
  }

  private sendPacket(packet: Buffer, bytes = packet.length): boolean {
    if (this.externalSendPacketFn) {
      return this.externalSendPacketFn(packet, bytes);
    }
    const socket = this.socket;
    const normalizedBytes = Math.max(0, Math.min(Number(bytes) || 0, packet.length));
    if (!socket || !this.remoteAddress || !this.remotePort || !normalizedBytes) {
      console.error(
        `[sip-pbx:media-worker] rtp.sendPacket skipped; hasSocket=${Boolean(socket)}; remote=${this.remoteAddress || "null"}:${this.remotePort || 0}; packetBytes=${normalizedBytes}`,
      );
      return false;
    }
    try {
      socket.send(packet, 0, normalizedBytes, this.remotePort, this.remoteAddress!, (error) => {
        if (error) {
          this.logSendError(error);
        }
      });
    } catch (error) {
      this.logSendError(error);
      return false;
    }
    return true;
  }

  private logSendError(error: unknown): void {
    if (this.sendErrorLogged) {
      return;
    }
    this.sendErrorLogged = true;
    const message = error instanceof Error ? error.message : String(error || "unknown");
    console.error(`[sip-pbx:media-worker] rtp.sendPacket failed; error=${message}`);
  }

  private dispatch(event: RtpTransportInputEvent): void {
    // Hot path (50 packets/sec/leg). Iterating the Set directly avoids a
    // per-packet array allocation. Listeners only mutate via subscribe/close,
    // both of which run outside the RTP receive callback, so concurrent
    // mutation during iteration isn't a concern.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(
          `[sip-pbx:media-worker] RTP transport listener failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
        );
      }
    }
  }

  private encodeFrame(
    pcmFrame: Buffer,
    target: Buffer,
    targetOffset = 0,
    pcmOffset = 0,
    pcmLength = pcmFrame.length - pcmOffset,
  ): number {
    return this.codec.encodeRtpPayload(
      this.audioCodecDescriptor,
      pcmFrame,
      this.audioCodecDescriptor.channels,
      target,
      targetOffset,
      pcmOffset,
      pcmLength,
    );
  }

  private decodePayload(descriptor: AudioCodecDescriptor, payloadType: number, payload: Buffer, payloadOffset: number, payloadLength: number, target: Buffer): number {
    return this.codec.decodeRtpPayload(descriptor, payloadType, payload, target, payloadOffset, payloadLength);
  }

  getHandoffState(): Record<string, unknown> {
    return {
      localRtpHost: this.localHost,
      localRtpPort: this.localPort,
      localRtpBindIp: this.localBindIp,
      localRtpAdvertisedIp: this.advertisedHost,
      remoteRtpHost: this.remoteAddress,
      remoteRtpPort: this.remotePort,
      audioPayloadType: this.audioPayloadType,
      dtmfPayloadType: this.dtmfPayloadType,
      payloadTypes: this.payloadTypes.slice(),
      payloadCodecs: { ...(this.payloadCodecs || {}) },
      currentSequenceNumber: this.sequenceNumber,
      currentTimestamp: this.timestamp,
      currentSsrc: this.ssrc,
    };
  }
}

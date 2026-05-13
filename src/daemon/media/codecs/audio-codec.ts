import * as path from "path";

export type CodecStreamContext = {
  encodeFrameInto?(input: Buffer, inputOffset: number, inputLength: number, output: Buffer, outputOffset?: number, outputLength?: number): number;
  decodeFrameInto?(input: Buffer, inputOffset: number, inputLength: number, output: Buffer, outputOffset?: number, outputLength?: number): number;
  convertInto?(input: Buffer, inputOffset: number, inputLength: number, output: Buffer, outputOffset?: number, outputLength?: number): number;
  estimateOutputBytes?(buffer: Buffer, offset?: number, length?: number): number;
  close(): void;
};

export type NegotiatedPayloadCodec = {
  codec?: string | null;
  clockRate?: number | null;
  channels?: number;
  fmtp?: string | null;
};

export type AudioCodecDescriptor = {
  kind: "audio";
  name: string;
  payloadType: number;
  rtpmap: string;
  clockRate: number;
  channels: number;
  pcmSampleRate: number;
  fmtp: string | null;
  implemented: boolean;
  createEncoder?: (channels?: number) => CodecStreamContext;
  createDecoder?: (channels?: number) => CodecStreamContext;
};

export type DtmfCodecDescriptor = {
  kind: "dtmf";
  name: "telephone-event";
  payloadType: number;
  rtpmap: string;
  clockRate: number;
  channels: number;
  pcmSampleRate: null;
  fmtp: string | null;
  implemented: true;
};

export type CodecDescriptor = AudioCodecDescriptor | DtmfCodecDescriptor;

export type AudioCodecName = "g711" | "g722" | "g729" | "opus";

export interface AudioCodec {
  readonly codecName: AudioCodecName;
  listDescriptors(): AudioCodecDescriptor[];
  resolveDescriptor(payloadType: number, payloadCodecs?: Record<number, NegotiatedPayloadCodec>): AudioCodecDescriptor | null;
  pickDescriptor(payloadTypes?: number[], payloadCodecs?: Record<number, NegotiatedPayloadCodec>): AudioCodecDescriptor | null;
  encodeRtpPayload(
    descriptor: AudioCodecDescriptor,
    pcmFrame: Buffer,
    pcmChannels: number | undefined,
    target: Buffer,
    targetOffset?: number,
    pcmOffset?: number,
    pcmLength?: number,
  ): number;
  decodeRtpPayload(
    descriptor: AudioCodecDescriptor,
    payloadType: number,
    payload: Buffer,
    target: Buffer,
    payloadOffset?: number,
    payloadLength?: number,
  ): number;
  close(): void;
}

export type PcmFormat = {
  sampleRate: number;
  channels: number;
  bytesPerSample: 2;
};

export const PCM_S16LE_MONO_8KHZ: PcmFormat = {
  sampleRate: 8000,
  channels: 1,
  bytesPerSample: 2,
};

export type AudioCodecRuntimeState = {
  encoderContext: CodecStreamContext | null;
  decoderContexts: Map<number, CodecStreamContext>;
  encoderPcmConverters: Map<string, CodecStreamContext>;
  decoderPcmConverters: Map<string, CodecStreamContext>;
  encodeScratch: Buffer;
  decodeScratch: Buffer;
};

function clampPcm16(sample: number): number {
  if (sample > 32767) {
    return 32767;
  }
  if (sample < -32768) {
    return -32768;
  }
  return sample | 0;
}

function readPcm16Sample(buffer: Buffer, offset: number): number {
  const low = buffer[offset] || 0;
  const high = buffer[offset + 1] || 0;
  const value = (high << 8) | low;
  return value & 0x8000 ? value - 0x10000 : value;
}

function writePcm16Sample(buffer: Buffer, offset: number, value: number): void {
  const normalized = clampPcm16(value);
  const unsigned = normalized < 0 ? 0x10000 + normalized : normalized;
  buffer[offset] = unsigned & 0xff;
  buffer[offset + 1] = (unsigned >> 8) & 0xff;
}

function toPcm16View(buffer: Buffer): Int16Array | null {
  if (buffer.length < 2 || (buffer.byteOffset & 1) !== 0) {
    return null;
  }
  return new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 2));
}

function ensureBuffer(buffer: Buffer, bytes: number): Buffer {
  if (buffer.length >= bytes) {
    return buffer;
  }
  return Buffer.allocUnsafe(Math.max(bytes, buffer.length * 2, 256));
}

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const ALAW_SEG_END = [
  0x1f,
  0x3f,
  0x7f,
  0xff,
  0x1ff,
  0x3ff,
  0x7ff,
  0xfff,
];
const MULAW_EXP_LUT = [
  0, 1, 2, 2, 3, 3, 3, 3,
  4, 4, 4, 4, 4, 4, 4, 4,
  5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5,
  6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6,
  7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7,
];

function linearToMulawSample(sample: number): number {
  let pcm = clampPcm16(sample);
  const sign = (pcm >> 8) & 0x80;
  if (sign) {
    pcm = -pcm;
  }
  if (pcm > MULAW_CLIP) {
    pcm = MULAW_CLIP;
  }
  pcm += MULAW_BIAS;
  const exponent = MULAW_EXP_LUT[(pcm >> 7) & 0xff];
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function mulawToLinearSample(value: number): number {
  const mulaw = (~value) & 0xff;
  const sign = mulaw & 0x80;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return clampPcm16(sign ? -sample : sample);
}

function linearToAlawSample(sample: number): number {
  let pcm = clampPcm16(sample);
  let mask = 0xd5;
  if (pcm < 0) {
    mask = 0x55;
    pcm = -pcm - 8;
    if (pcm < 0) {
      pcm = 0;
    }
  }
  let exponent = 0;
  while (exponent < ALAW_SEG_END.length && pcm > ALAW_SEG_END[exponent]) {
    exponent += 1;
  }
  if (exponent >= ALAW_SEG_END.length) {
    return (0x7f ^ mask) & 0xff;
  }
  const mantissa = exponent === 0
    ? ((pcm >> 4) & 0x0f)
    : ((pcm >> (exponent + 3)) & 0x0f);
  return (((exponent << 4) | mantissa) ^ mask) & 0xff;
}

function alawToLinearSample(value: number): number {
  const alaw = value ^ 0x55;
  const sign = alaw & 0x80;
  const exponent = (alaw & 0x70) >> 4;
  const mantissa = alaw & 0x0f;
  let sample = exponent === 0
    ? ((mantissa << 4) + 8)
    : (((mantissa << 4) + 0x108) << (exponent - 1));
  if (!sign) {
    sample = -sample;
  }
  return clampPcm16(sample);
}

const PCM16_TO_MULAW = new Uint8Array(0x10000);
const PCM16_TO_ALAW = new Uint8Array(0x10000);
const MULAW_TO_PCM16 = new Int16Array(0x100);
const ALAW_TO_PCM16 = new Int16Array(0x100);

for (let sample = -32768; sample <= 32767; sample += 1) {
  const index = sample + 32768;
  PCM16_TO_MULAW[index] = linearToMulawSample(sample);
  PCM16_TO_ALAW[index] = linearToAlawSample(sample);
}

for (let value = 0; value <= 255; value += 1) {
  MULAW_TO_PCM16[value] = mulawToLinearSample(value);
  ALAW_TO_PCM16[value] = alawToLinearSample(value);
}

function encodePcmToMulawInto(pcm: Buffer, target: Buffer, targetOffset = 0, pcmOffset = 0, pcmLength = pcm.length - pcmOffset): number {
  const outputLength = Math.floor(pcmLength / 2);
  if (target.length < targetOffset + outputLength) {
    return 0;
  }
  const pcmView = toPcm16View(pcm);
  if (pcmView) {
    for (let index = 0; index < outputLength; index += 1) {
      target[targetOffset + index] = PCM16_TO_MULAW[(pcmView[(pcmOffset / 2) + index] || 0) + 32768];
    }
    return outputLength;
  }
  for (let index = 0; index < outputLength; index += 1) {
    target[targetOffset + index] = PCM16_TO_MULAW[readPcm16Sample(pcm, pcmOffset + (index * 2)) + 32768];
  }
  return outputLength;
}

function encodePcmToAlawInto(pcm: Buffer, target: Buffer, targetOffset = 0, pcmOffset = 0, pcmLength = pcm.length - pcmOffset): number {
  const outputLength = Math.floor(pcmLength / 2);
  if (target.length < targetOffset + outputLength) {
    return 0;
  }
  const pcmView = toPcm16View(pcm);
  if (pcmView) {
    for (let index = 0; index < outputLength; index += 1) {
      target[targetOffset + index] = PCM16_TO_ALAW[(pcmView[(pcmOffset / 2) + index] || 0) + 32768];
    }
    return outputLength;
  }
  for (let index = 0; index < outputLength; index += 1) {
    target[targetOffset + index] = PCM16_TO_ALAW[readPcm16Sample(pcm, pcmOffset + (index * 2)) + 32768];
  }
  return outputLength;
}

function decodeMulawToPcmInto(payload: Buffer, target: Buffer, payloadOffset = 0, payloadLength = payload.length - payloadOffset): number {
  if (target.length < payloadLength * 2) {
    return 0;
  }
  const targetView = toPcm16View(target);
  if (targetView) {
    for (let index = 0; index < payloadLength; index += 1) {
      targetView[index] = MULAW_TO_PCM16[payload[payloadOffset + index]];
    }
    return payloadLength * 2;
  }
  for (let index = 0; index < payloadLength; index += 1) {
    writePcm16Sample(target, index * 2, MULAW_TO_PCM16[payload[payloadOffset + index]]);
  }
  return payloadLength * 2;
}

function decodeAlawToPcmInto(payload: Buffer, target: Buffer, payloadOffset = 0, payloadLength = payload.length - payloadOffset): number {
  if (target.length < payloadLength * 2) {
    return 0;
  }
  const targetView = toPcm16View(target);
  if (targetView) {
    for (let index = 0; index < payloadLength; index += 1) {
      targetView[index] = ALAW_TO_PCM16[payload[payloadOffset + index]];
    }
    return payloadLength * 2;
  }
  for (let index = 0; index < payloadLength; index += 1) {
    writePcm16Sample(target, index * 2, ALAW_TO_PCM16[payload[payloadOffset + index]]);
  }
  return payloadLength * 2;
}

function getEstimatedCodecOutputBytes(
  context: CodecStreamContext,
  input: Buffer,
  fallbackBytes: number,
  offset = 0,
  length = input.length - offset,
): number {
  const normalizedOffset = Math.max(0, Math.min(Number(offset) || 0, input.length));
  const normalizedLength = Math.max(0, Math.min(Number(length) || 0, input.length - normalizedOffset));
  if (typeof context.estimateOutputBytes === "function") {
    const estimated = Number(context.estimateOutputBytes(input, normalizedOffset, normalizedLength) || 0);
    if (Number.isFinite(estimated) && estimated > 0) {
      return estimated;
    }
  }
  return Math.max(1, fallbackBytes);
}

export function createCodecRuntimeState(): AudioCodecRuntimeState {
  return {
    encoderContext: null,
    decoderContexts: new Map<number, CodecStreamContext>(),
    encoderPcmConverters: new Map<string, CodecStreamContext>(),
    decoderPcmConverters: new Map<string, CodecStreamContext>(),
    encodeScratch: Buffer.allocUnsafe(512),
    decodeScratch: Buffer.allocUnsafe(512),
  };
}

export function closeCodecRuntimeState(runtime: AudioCodecRuntimeState): void {
  try {
    runtime.encoderContext?.close();
  } catch (error) {
    console.error(
      `[sip-pbx:media] codec encoder context close failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
    );
  }
  runtime.encoderContext = null;
  for (const context of Array.from(runtime.decoderContexts.values())) {
    try {
      context.close();
    } catch (error) {
      console.error(
        `[sip-pbx:media] codec decoder context close failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    }
  }
  runtime.decoderContexts.clear();
  for (const context of Array.from(runtime.encoderPcmConverters.values())) {
    try {
      context.close();
    } catch (error) {
      console.error(
        `[sip-pbx:media] encoder PCM converter close failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    }
  }
  runtime.encoderPcmConverters.clear();
  for (const context of Array.from(runtime.decoderPcmConverters.values())) {
    try {
      context.close();
    } catch (error) {
      console.error(
        `[sip-pbx:media] decoder PCM converter close failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    }
  }
  runtime.decoderPcmConverters.clear();
}

export abstract class AudioCodecBase implements AudioCodec {
  readonly runtime = createCodecRuntimeState();

  protected constructor(readonly codecName: AudioCodecName) {}

  abstract listDescriptors(): AudioCodecDescriptor[];

  resolveDescriptor(payloadType: number, payloadCodecs: Record<number, NegotiatedPayloadCodec> = {}): AudioCodecDescriptor | null {
    return resolveDescriptorForAudioCodec(this.codecName, payloadType, payloadCodecs);
  }

  pickDescriptor(payloadTypes: number[] = [], payloadCodecs: Record<number, NegotiatedPayloadCodec> = {}): AudioCodecDescriptor | null {
    return pickDescriptorForAudioCodec(this.codecName, payloadTypes, payloadCodecs);
  }

  encodeRtpPayload(
    descriptor: AudioCodecDescriptor,
    pcmFrame: Buffer,
    pcmChannels: number | undefined,
    target: Buffer,
    targetOffset = 0,
    pcmOffset = 0,
    pcmLength = pcmFrame.length - pcmOffset,
  ): number {
    return encodeRtpPayloadWithCodec(this.runtime, descriptor, pcmFrame, pcmChannels, target, targetOffset, pcmOffset, pcmLength);
  }

  decodeRtpPayload(
    descriptor: AudioCodecDescriptor,
    payloadType: number,
    payload: Buffer,
    target: Buffer,
    payloadOffset = 0,
    payloadLength = payload.length - payloadOffset,
  ): number {
    return decodeRtpPayloadWithCodec(this.runtime, descriptor, payloadType, payload, target, payloadOffset, payloadLength);
  }

  close(): void {
    closeCodecRuntimeState(this.runtime);
  }
}

export function encodeRtpPayloadWithCodec(
  runtime: AudioCodecRuntimeState,
  descriptor: AudioCodecDescriptor,
  pcmFrame: Buffer,
  pcmChannels = descriptor.channels,
  target: Buffer,
  targetOffset = 0,
  pcmOffset = 0,
  pcmLength = pcmFrame.length - pcmOffset,
): number {
  let codecBuffer = pcmFrame;
  let codecOffset = pcmOffset;
  let codecLength = pcmLength;
  if (pcmChannels !== descriptor.channels) {
    const converterKey = `encode:${descriptor.name}:${descriptor.pcmSampleRate}:${pcmChannels}->${descriptor.channels}`;
    const converter = getOrCreateRuntimeContext(
      runtime.encoderPcmConverters,
      converterKey,
      () => createNativePcm16Converter(descriptor.pcmSampleRate, pcmChannels, descriptor.pcmSampleRate, descriptor.channels),
    );
    const estimatedBytes = getEstimatedCodecOutputBytes(
      converter,
      pcmFrame,
      estimatePcm16ChannelConvertedBytes(pcmLength, pcmChannels, descriptor.channels),
      pcmOffset,
      pcmLength,
    );
    runtime.encodeScratch = ensureBuffer(runtime.encodeScratch, estimatedBytes);
    const codecScratch = runtime.encodeScratch;
    const convertedBytes = convertPcm16IntoRuntime(converter, pcmFrame, pcmOffset, pcmLength, codecScratch);
    if (!convertedBytes) {
      return 0;
    }
    codecBuffer = codecScratch;
    codecOffset = 0;
    codecLength = convertedBytes;
  }
  if (!codecLength) {
    return 0;
  }
  if (descriptor.name === "pcma") {
    return encodePcmToAlawInto(codecBuffer, target, targetOffset, codecOffset, codecLength);
  }
  if (descriptor.name === "pcmu") {
    return encodePcmToMulawInto(codecBuffer, target, targetOffset, codecOffset, codecLength);
  }
  if (!descriptor.createEncoder) {
    return 0;
  }
  const context = runtime.encoderContext || descriptor.createEncoder(descriptor.channels);
  runtime.encoderContext = context;
  if (typeof context.encodeFrameInto !== "function") {
    throw new Error(`Codec encoder direct API is unavailable: ${descriptor.name}`);
  }
  return Number(context.encodeFrameInto(
    codecBuffer,
    codecOffset,
    codecLength,
    target,
    targetOffset,
    Math.max(0, target.length - targetOffset),
  ) || 0);
}

export function decodeRtpPayloadWithCodec(
  runtime: AudioCodecRuntimeState,
  descriptor: AudioCodecDescriptor,
  payloadType: number,
  payload: Buffer,
  target: Buffer,
  payloadOffset = 0,
  payloadLength = payload.length - payloadOffset,
): number {
  if (!payloadLength) {
    return 0;
  }
  if (descriptor.name === "pcma") {
    return decodeAlawToPcmInto(payload, target, payloadOffset, payloadLength);
  } else if (descriptor.name === "pcmu") {
    return decodeMulawToPcmInto(payload, target, payloadOffset, payloadLength);
  } else {
    if (!descriptor.createDecoder) {
      return 0;
    }
    const context = runtime.decoderContexts.get(payloadType) || descriptor.createDecoder(descriptor.channels);
    runtime.decoderContexts.set(payloadType, context);
    if (descriptor.channels <= 1) {
      if (typeof context.decodeFrameInto !== "function") {
        throw new Error(`Codec decoder direct API is unavailable: ${descriptor.name}`);
      }
      return Number(context.decodeFrameInto(payload, payloadOffset, payloadLength, target, 0, target.length) || 0);
    }
    if (typeof context.decodeFrameInto !== "function") {
      throw new Error(`Codec decoder direct API is unavailable: ${descriptor.name}`);
    }
    const estimatedOutputBytes = getEstimatedCodecOutputBytes(context, payload, Math.max(payloadLength * 8, 512), payloadOffset, payloadLength);
    runtime.decodeScratch = ensureBuffer(runtime.decodeScratch, estimatedOutputBytes);
    const codecScratch = runtime.decodeScratch;
    const codecWritten = Number(context.decodeFrameInto(payload, payloadOffset, payloadLength, codecScratch, 0, codecScratch.length) || 0);
    if (!codecWritten) {
      return 0;
    }
    const estimatedBytes = estimatePcm16ChannelConvertedBytes(codecWritten, descriptor.channels, 1);
    if (target.length < estimatedBytes) {
      return 0;
    }
    const converterKey = `decode:${payloadType}:${descriptor.pcmSampleRate}:${descriptor.channels}->1`;
    const converter = getOrCreateRuntimeContext(
      runtime.decoderPcmConverters,
      converterKey,
      () => createNativePcm16Converter(descriptor.pcmSampleRate, descriptor.channels, descriptor.pcmSampleRate, 1),
    );
    return convertPcm16IntoRuntime(converter, codecScratch, 0, codecWritten, target);
  }
}

export type NativeStreamCodecInstance = {
  encodeFrameInto?(input: Buffer, inputOffset: number, inputLength: number, output: Buffer, outputOffset?: number, outputLength?: number): number;
  decodeFrameInto?(input: Buffer, inputOffset: number, inputLength: number, output: Buffer, outputOffset?: number, outputLength?: number): number;
  convertInto?(input: Buffer, inputOffset: number, inputLength: number, output: Buffer, outputOffset?: number, outputLength?: number): number;
  estimateOutputBytes?(buffer: Buffer, offset?: number, length?: number): number;
  close(): void;
};

export type Pcm16Converter = NativeStreamCodecInstance;

type NativeCodecConstructor<T extends NativeStreamCodecInstance = NativeStreamCodecInstance> = new (...args: unknown[]) => T;

export type NativeCodecBindings = {
  G722Encoder?: NativeCodecConstructor;
  G722Decoder?: NativeCodecConstructor;
  G729Encoder?: NativeCodecConstructor;
  G729Decoder?: NativeCodecConstructor;
  OpusEncoder?: NativeCodecConstructor;
  OpusDecoder?: NativeCodecConstructor;
  Pcm16Converter?: NativeCodecConstructor;
  SetThreadName?: (name: string) => void;
};

export type LocalAudioSdpDescription = {
  lines: string[];
  descriptors: CodecDescriptor[];
  primaryAudioPayloadType: number;
  dtmfPayloadType: number | null;
};

const PREFERRED_AUDIO_CODEC_ORDER = ["opus", "g722", "pcma", "pcmu", "g729"] as const;

const PCMU_CODEC_DESCRIPTOR: AudioCodecDescriptor = {
  kind: "audio",
  name: "pcmu",
  payloadType: 0,
  rtpmap: "PCMU/8000",
  clockRate: 8000,
  channels: 1,
  pcmSampleRate: 8000,
  fmtp: null,
  implemented: true,
};

const PCMA_CODEC_DESCRIPTOR: AudioCodecDescriptor = {
  kind: "audio",
  name: "pcma",
  payloadType: 8,
  rtpmap: "PCMA/8000",
  clockRate: 8000,
  channels: 1,
  pcmSampleRate: 8000,
  fmtp: null,
  implemented: true,
};

const TELEPHONE_EVENT_CODEC_DESCRIPTOR: DtmfCodecDescriptor = {
  kind: "dtmf",
  name: "telephone-event",
  payloadType: 101,
  rtpmap: "telephone-event/8000",
  clockRate: 8000,
  channels: 1,
  pcmSampleRate: null,
  fmtp: "0-16",
  implemented: true,
};

type NativeCodecAddonModule = NativeCodecBindings & {
  ffaudioAbiVersion?: number;
};

let cachedBindings: NativeCodecBindings | null | undefined;

function getPackageRoot(): string {
  return path.join(__dirname, "..", "..", "..", "..");
}

export function loadNativeCodecBindings(): NativeCodecBindings | null {
  if (cachedBindings !== undefined) {
    return cachedBindings;
  }
  try {
    const { loadBundledNativeAddon } = require("../../../../scripts/install-native.js") as {
      loadBundledNativeAddon: (dir: string) => Partial<NativeCodecAddonModule>;
    };
    const bindings = loadBundledNativeAddon(getPackageRoot()) as Partial<NativeCodecAddonModule>;
    if (Number(bindings.ffaudioAbiVersion || 0) !== 3) {
      cachedBindings = null;
      return cachedBindings;
    }
    cachedBindings = bindings as NativeCodecBindings;
    return cachedBindings;
  } catch (error) {
    console.error(
      `[sip-pbx:codec] native codec bindings load failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
    );
    cachedBindings = null;
    return cachedBindings;
  }
}

function createNativePcm16Converter(
  inputSampleRate: number,
  inputChannels: number,
  outputSampleRate: number,
  outputChannels: number,
): CodecStreamContext {
  const bindings = loadNativeCodecBindings();
  if (!bindings?.Pcm16Converter) {
    throw new Error("PCM converter backend is unavailable");
  }
  return new bindings.Pcm16Converter(
    Math.max(1, Math.round(Number(inputSampleRate || 0) || 0)),
    Math.max(1, Math.round(Number(inputChannels || 0) || 0)),
    Math.max(1, Math.round(Number(outputSampleRate || 0) || 0)),
    Math.max(1, Math.round(Number(outputChannels || 0) || 0)),
  );
}

export function createPcm16Converter(
  inputSampleRate: number,
  inputChannels: number,
  outputSampleRate: number,
  outputChannels: number,
): Pcm16Converter {
  return createNativePcm16Converter(inputSampleRate, inputChannels, outputSampleRate, outputChannels);
}

function getOrCreateRuntimeContext<T extends CodecStreamContext>(
  map: Map<string, CodecStreamContext>,
  key: string,
  factory: () => T,
): T {
  const existing = map.get(key) || null;
  if (existing) {
    return existing as T;
  }
  const created = factory();
  map.set(key, created);
  return created;
}

function estimatePcm16ChannelConvertedBytes(inputBytes: number, inputChannels: number, outputChannels: number): number {
  const normalizedInputChannels = Math.max(1, Math.round(Number(inputChannels || 0) || 0));
  const normalizedOutputChannels = Math.max(1, Math.round(Number(outputChannels || 0) || 0));
  const inputFrameBytes = normalizedInputChannels * 2;
  if (!Number.isFinite(inputBytes) || inputBytes <= 0 || inputFrameBytes <= 0) {
    return 0;
  }
  const inputFrames = Math.floor(inputBytes / inputFrameBytes);
  if (inputFrames <= 0) {
    return 0;
  }
  return inputFrames * normalizedOutputChannels * 2;
}

function convertPcm16IntoRuntime(
  context: CodecStreamContext,
  input: Buffer,
  inputOffset: number,
  inputLength: number,
  target: Buffer,
  targetOffset = 0,
): number {
  if (typeof context.convertInto !== "function") {
    throw new Error("PCM converter direct API is unavailable");
  }
  return Number(context.convertInto(
    input,
    inputOffset,
    inputLength,
    target,
    targetOffset,
    Math.max(0, target.length - targetOffset),
  ) || 0);
}

const PCM_TARGET_BUFFER_TOO_SMALL_ERROR = "Target buffer is smaller than converted PCM output";

export function convertPcm16(
  context: Pcm16Converter,
  input: Buffer,
  inputOffset: number,
  inputLength: number,
  target: Buffer,
  targetOffset = 0,
): number {
  return convertPcm16IntoRuntime(context, input, inputOffset, inputLength, target, targetOffset);
}

export function estimateConvertedPcm16Bytes(
  inputBytes: number,
  inputSampleRate: number,
  inputChannels: number,
  outputSampleRate: number,
  outputChannels: number,
): number {
  const normalizedInputChannels = Math.max(1, Math.round(Number(inputChannels || 0) || 0));
  const normalizedOutputChannels = Math.max(1, Math.round(Number(outputChannels || 0) || 0));
  const normalizedInputSampleRate = Math.max(1, Math.round(Number(inputSampleRate || 0) || 0));
  const normalizedOutputSampleRate = Math.max(1, Math.round(Number(outputSampleRate || 0) || 0));
  const inputSampleCount = Math.floor(Math.max(0, Math.round(Number(inputBytes || 0) || 0)) / (normalizedInputChannels * 2));
  if (inputSampleCount <= 0) {
    return 0;
  }
  const outputSampleCount = Math.max(
    1,
    Math.ceil((inputSampleCount * normalizedOutputSampleRate) / normalizedInputSampleRate),
  );
  return outputSampleCount * normalizedOutputChannels * 2;
}

export function isPcmTargetBufferTooSmallError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(PCM_TARGET_BUFFER_TOO_SMALL_ERROR);
}

function hasCodecPair(bindings: NativeCodecBindings | null, encoderName: keyof NativeCodecBindings, decoderName: keyof NativeCodecBindings): boolean {
  const encoder = bindings?.[encoderName];
  const decoder = bindings?.[decoderName];
  if (typeof encoder !== "function" || typeof decoder !== "function") {
    return false;
  }
  const encoderPrototype = encoder.prototype as Record<string, unknown>;
  const decoderPrototype = decoder.prototype as Record<string, unknown>;
  return (
    typeof encoderPrototype.encodeFrameInto === "function"
    && typeof decoderPrototype.decodeFrameInto === "function"
  );
}

export function hasNativeG722CodecSupport(): boolean {
  return hasCodecPair(loadNativeCodecBindings(), "G722Encoder", "G722Decoder");
}

export function hasNativeG729CodecSupport(): boolean {
  return hasCodecPair(loadNativeCodecBindings(), "G729Encoder", "G729Decoder");
}

export function hasNativeOpusCodecSupport(): boolean {
  return hasCodecPair(loadNativeCodecBindings(), "OpusEncoder", "OpusDecoder");
}

export function normalizeCodecKey(value?: string | null): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "mulaw" || normalized === "mu-law" || normalized === "g711u") {
    return "pcmu";
  }
  if (normalized === "alaw" || normalized === "a-law" || normalized === "g711a") {
    return "pcma";
  }
  return normalized;
}

export function codecOrderIndex(name?: string | null): number {
  const index = PREFERRED_AUDIO_CODEC_ORDER.indexOf(normalizeCodecKey(name) as (typeof PREFERRED_AUDIO_CODEC_ORDER)[number]);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function getG711Module(): typeof import("./g711-codec") {
  return require("./g711-codec") as typeof import("./g711-codec");
}

function getG722Module(): typeof import("./g722-codec") {
  return require("./g722-codec") as typeof import("./g722-codec");
}

function getG729Module(): typeof import("./g729-codec") {
  return require("./g729-codec") as typeof import("./g729-codec");
}

function getOpusModule(): typeof import("./opus-codec") {
  return require("./opus-codec") as typeof import("./opus-codec");
}

export function createCodec(codecName: AudioCodecName = "g711"): AudioCodec {
  switch (codecName) {
    case "g722":
      return new (getG722Module().G722Codec)();
    case "g729":
      return new (getG729Module().G729Codec)();
    case "opus":
      return new (getOpusModule().OpusCodec)();
    case "g711":
    default:
      return new (getG711Module().G711Codec)();
  }
}

export function mapDescriptorNameToAudioCodecName(descriptorName: string | null | undefined): AudioCodecName {
  const normalized = normalizeCodecKey(descriptorName || "");
  if (normalized === "g722") {
    return "g722";
  }
  if (normalized === "g729") {
    return "g729";
  }
  if (normalized === "opus") {
    return "opus";
  }
  return "g711";
}

export function getCodecDescriptorsForAudioCodec(codecName: AudioCodecName): AudioCodecDescriptor[] {
  const descriptors = getImplementedCodecDescriptors("audio") as AudioCodecDescriptor[];
  switch (codecName) {
    case "g722":
      return descriptors.filter((descriptor) => normalizeCodecKey(descriptor.name) === "g722");
    case "g729":
      return descriptors.filter((descriptor) => normalizeCodecKey(descriptor.name) === "g729");
    case "opus":
      return descriptors.filter((descriptor) => normalizeCodecKey(descriptor.name) === "opus");
    case "g711":
    default:
      return descriptors.filter((descriptor) => {
        const key = normalizeCodecKey(descriptor.name);
        return key === "pcma" || key === "pcmu";
      });
  }
}

export function resolveDescriptorForAudioCodec(
  codecName: AudioCodecName,
  payloadType: number,
  payloadCodecs: Record<number, NegotiatedPayloadCodec> = {},
): AudioCodecDescriptor | null {
  const descriptor = resolveAudioCodecForPayloadType(payloadType, payloadCodecs);
  if (!descriptor) {
    return null;
  }
  const supportedPayloadTypes = new Set(getCodecDescriptorsForAudioCodec(codecName).map((entry) => entry.payloadType));
  if (supportedPayloadTypes.has(descriptor.payloadType)) {
    return descriptor;
  }
  return mapDescriptorNameToAudioCodecName(descriptor.name) === codecName ? descriptor : null;
}

export function pickDescriptorForAudioCodec(
  codecName: AudioCodecName,
  payloadTypes: number[] = [],
  payloadCodecs: Record<number, NegotiatedPayloadCodec> = {},
): AudioCodecDescriptor | null {
  const supported = getCodecDescriptorsForAudioCodec(codecName);
  const supportedPayloadTypes = new Set(supported.map((entry) => entry.payloadType));
  const normalizedPayloadTypes = Array.isArray(payloadTypes)
    ? payloadTypes.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0)
    : [];
  for (const payloadType of normalizedPayloadTypes) {
    const descriptor = resolveDescriptorForAudioCodec(codecName, payloadType, payloadCodecs);
    if (descriptor) {
      return descriptor;
    }
  }
  if (supported.length > 0) {
    const preferred = supported.find((descriptor) => supportedPayloadTypes.has(descriptor.payloadType));
    return preferred || supported[0] || null;
  }
  return null;
}

export function getCodecDescriptors(): CodecDescriptor[] {
  const g711 = getG711Module();
  const g722 = getG722Module();
  const g729 = getG729Module();
  const opus = getOpusModule();
  return [
    PCMU_CODEC_DESCRIPTOR,
    PCMA_CODEC_DESCRIPTOR,
    g722.getG722CodecDescriptor(),
    opus.getOpusCodecDescriptor(),
    g729.getG729CodecDescriptor(),
    TELEPHONE_EVENT_CODEC_DESCRIPTOR,
  ].map((descriptor) => Object.freeze({ ...descriptor }));
}

export function getImplementedCodecDescriptors(kind?: CodecDescriptor["kind"]): CodecDescriptor[] {
  return getCodecDescriptors().filter((descriptor) => descriptor.implemented && (!kind || descriptor.kind === kind));
}

function normalizePayloadCodecs(payloadCodecs: Record<number, NegotiatedPayloadCodec> = {}): Record<number, NegotiatedPayloadCodec> {
  const output: Record<number, NegotiatedPayloadCodec> = {};
  for (const [rawPayloadType, rawValue] of Object.entries(payloadCodecs || {})) {
    const payloadType = Number(rawPayloadType);
    if (!Number.isInteger(payloadType) || payloadType < 0) {
      continue;
    }
    output[payloadType] = rawValue && typeof rawValue === "object" ? { ...rawValue } : {};
  }
  return output;
}

function resolveOpusChannels(descriptorChannels: number, explicit?: NegotiatedPayloadCodec | null): number {
  void descriptorChannels;
  const fmtp = String(explicit?.fmtp || "").trim().toLowerCase();
  if (/(?:^|;)\s*(?:stereo|sprop-stereo)\s*=\s*1(?:;|$)/i.test(fmtp)) {
    return 2;
  }
  return 1;
}

function getDescriptorByNormalizedKey(key: string, descriptors: CodecDescriptor[]): CodecDescriptor | null {
  return descriptors.find((descriptor) => normalizeCodecKey(descriptor.name) === key) || null;
}

export function resolveCodecForPayloadType(
  payloadType: number,
  payloadCodecs: Record<number, NegotiatedPayloadCodec> = {},
): CodecDescriptor | null {
  const descriptors = getCodecDescriptors();
  const normalizedPayloadType = Number(payloadType);
  if (!Number.isInteger(normalizedPayloadType) || normalizedPayloadType < 0) {
    return null;
  }
  const normalizedPayloadCodecs = normalizePayloadCodecs(payloadCodecs);
  const negotiated = normalizedPayloadCodecs[normalizedPayloadType];
  const explicitCodecKey = normalizeCodecKey(String(negotiated?.codec || ""));
  if (explicitCodecKey) {
    const descriptor = getDescriptorByNormalizedKey(explicitCodecKey, descriptors);
    if (!descriptor) {
      return null;
    }
    return Object.freeze({
      ...descriptor,
      payloadType: normalizedPayloadType,
      clockRate: Number.isFinite(Number(negotiated?.clockRate)) && Number(negotiated?.clockRate) > 0
        ? Number(negotiated?.clockRate)
        : descriptor.clockRate,
      channels: descriptor.name === "opus"
        ? resolveOpusChannels(descriptor.channels, negotiated)
        : (Number.isFinite(Number(negotiated?.channels)) && Number(negotiated?.channels) > 0
          ? Number(negotiated?.channels)
          : descriptor.channels),
      fmtp: negotiated?.fmtp == null ? descriptor.fmtp : String(negotiated.fmtp),
    });
  }
  const descriptor = descriptors.find((entry) => entry.payloadType === normalizedPayloadType) || null;
  if (!descriptor || descriptor.name !== "opus") {
    return descriptor;
  }
  return Object.freeze({
    ...descriptor,
    channels: resolveOpusChannels(descriptor.channels, negotiated),
  });
}

export function resolveAudioCodecForPayloadType(
  payloadType: number,
  payloadCodecs: Record<number, NegotiatedPayloadCodec> = {},
): AudioCodecDescriptor | null {
  const descriptor = resolveCodecForPayloadType(payloadType, payloadCodecs);
  if (!descriptor || descriptor.kind !== "audio" || !descriptor.implemented) {
    return null;
  }
  return descriptor;
}

export function pickPreferredAudioPayloadType(
  remotePayloadTypes: number[] = [],
  remotePayloadCodecs: Record<number, NegotiatedPayloadCodec> = {},
): number {
  const payloadTypes = Array.isArray(remotePayloadTypes)
    ? remotePayloadTypes.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0)
    : [];
  for (const payloadType of payloadTypes) {
    if (resolveAudioCodecForPayloadType(payloadType, remotePayloadCodecs)) {
      return payloadType;
    }
  }
  const fallback = getImplementedCodecDescriptors("audio")
    .find((descriptor) => descriptor.payloadType === 8)
    || getImplementedCodecDescriptors("audio")[0]
    || null;
  return fallback ? fallback.payloadType : 8;
}

export function buildCodecRtpMap(codec: CodecDescriptor): string {
  const codecToken = String(codec.rtpmap || codec.name || "").split("/")[0] || String(codec.name || "");
  const channelSuffix = normalizeCodecKey(codec.name) === "opus"
    ? "/2"
    : (Number(codec.channels || 1) > 1 ? `/${Number(codec.channels)}` : "");
  return `a=rtpmap:${codec.payloadType} ${codecToken}/${Number(codec.clockRate)}${channelSuffix}`;
}

function sortLocalCodecDescriptors(descriptors: CodecDescriptor[]): CodecDescriptor[] {
  return descriptors.slice().sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "audio" ? -1 : 1;
    }
    return codecOrderIndex(left.name) - codecOrderIndex(right.name);
  });
}

function buildNegotiatedCodecDescriptors(
  remotePayloadTypes: number[] = [],
  remotePayloadCodecs: Record<number, NegotiatedPayloadCodec> = {},
): CodecDescriptor[] {
  const payloadTypes = Array.isArray(remotePayloadTypes)
    ? remotePayloadTypes.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0)
    : [];
  if (!payloadTypes.length) {
    return [];
  }
  const seenPayloadTypes = new Set<number>();
  const descriptors: CodecDescriptor[] = [];
  for (const payloadType of payloadTypes) {
    if (seenPayloadTypes.has(payloadType)) {
      continue;
    }
    const descriptor = resolveCodecForPayloadType(payloadType, remotePayloadCodecs);
    if (!descriptor || !descriptor.implemented) {
      continue;
    }
    descriptors.push(descriptor);
    seenPayloadTypes.add(payloadType);
  }
  const audio = descriptors.filter((descriptor) => descriptor.kind === "audio");
  if (!audio.length) {
    return [];
  }
  return [
    ...audio,
    ...descriptors.filter((descriptor) => descriptor.kind === "dtmf"),
  ];
}

export function buildLocalAudioSdpDescription(
  rtpPort: number,
  remotePayloadTypes: number[] = [],
  remotePayloadCodecs: Record<number, NegotiatedPayloadCodec> = {},
): LocalAudioSdpDescription | null {
  const remotePayloadTypeList = Array.isArray(remotePayloadTypes)
    ? remotePayloadTypes.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0)
    : [];
  const negotiatedDescriptors = buildNegotiatedCodecDescriptors(remotePayloadTypeList, remotePayloadCodecs);
  if (remotePayloadTypeList.length && !negotiatedDescriptors.length) {
    return null;
  }
  const activeDescriptors = negotiatedDescriptors.length
    ? negotiatedDescriptors
    : sortLocalCodecDescriptors(getImplementedCodecDescriptors());
  const audioDescriptors = activeDescriptors.filter((descriptor) => descriptor.kind === "audio");
  if (!audioDescriptors.length) {
    return null;
  }
  const lines = [
    `m=audio ${rtpPort} RTP/AVP ${activeDescriptors.map((descriptor) => descriptor.payloadType).join(" ")}`,
  ];
  for (const descriptor of activeDescriptors) {
    lines.push(buildCodecRtpMap(descriptor));
    if (descriptor.fmtp) {
      lines.push(`a=fmtp:${descriptor.payloadType} ${descriptor.fmtp}`);
    }
  }
  lines.push("a=ptime:20");
  lines.push("a=sendrecv");
  return {
    lines,
    descriptors: activeDescriptors,
    primaryAudioPayloadType: remotePayloadTypeList.length
      ? pickPreferredAudioPayloadType(remotePayloadTypeList, remotePayloadCodecs)
      : audioDescriptors[0].payloadType,
    dtmfPayloadType: activeDescriptors.find((descriptor) => descriptor.kind === "dtmf")?.payloadType ?? null,
  };
}

export function pickNegotiatedDtmfPayloadType(
  remotePayloadTypes: number[] = [],
  remotePayloadCodecs: Record<number, NegotiatedPayloadCodec> = {},
  preferredClockRate?: number | null,
): number | null {
  const negotiatedDtmf = buildNegotiatedCodecDescriptors(remotePayloadTypes, remotePayloadCodecs)
    .filter((descriptor) => descriptor.kind === "dtmf");
  if (!negotiatedDtmf.length) {
    return null;
  }
  const normalizedClockRate = Number(preferredClockRate || 0);
  if (normalizedClockRate > 0) {
    const matching = negotiatedDtmf.find((descriptor) => Number(descriptor.clockRate || 0) === normalizedClockRate);
    if (matching) {
      return matching.payloadType;
    }
  }
  return negotiatedDtmf[0]?.payloadType ?? null;
}

export function buildSelectedLocalAudioSdpDescription(
  rtpPort: number,
  audioPayloadType: number,
  dtmfPayloadType: number | null,
  payloadCodecs: Record<number, NegotiatedPayloadCodec> = {},
): LocalAudioSdpDescription | null {
  const audioDescriptor = resolveAudioCodecForPayloadType(audioPayloadType, payloadCodecs);
  if (!audioDescriptor) {
    return null;
  }
  const descriptors: CodecDescriptor[] = [audioDescriptor];
  if (dtmfPayloadType != null) {
    const dtmfDescriptor = resolveCodecForPayloadType(dtmfPayloadType, payloadCodecs);
    if (dtmfDescriptor && dtmfDescriptor.kind === "dtmf" && dtmfDescriptor.implemented) {
      descriptors.push(dtmfDescriptor);
    }
  }
  const lines = [
    `m=audio ${rtpPort} RTP/AVP ${descriptors.map((descriptor) => descriptor.payloadType).join(" ")}`,
  ];
  for (const descriptor of descriptors) {
    lines.push(buildCodecRtpMap(descriptor));
    if (descriptor.fmtp) {
      lines.push(`a=fmtp:${descriptor.payloadType} ${descriptor.fmtp}`);
    }
  }
  lines.push("a=ptime:20");
  lines.push("a=sendrecv");
  return {
    lines,
    descriptors,
    primaryAudioPayloadType: audioDescriptor.payloadType,
    dtmfPayloadType: descriptors.find((descriptor) => descriptor.kind === "dtmf")?.payloadType ?? null,
  };
}

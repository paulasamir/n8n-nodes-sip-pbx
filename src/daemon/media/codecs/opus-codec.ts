import { AudioCodecBase, hasNativeOpusCodecSupport, loadNativeCodecBindings, type AudioCodecDescriptor } from "./audio-codec";

function normalizeOpusChannels(channels?: number): 1 | 2 {
  return Number(channels) === 2 ? 2 : 1;
}

const OPUS_APPLICATION_VOIP = 2048;
const OPUS_SIGNAL_VOICE = 3001;

export class OpusCodec extends AudioCodecBase {
  constructor() {
    super("opus");
  }

  listDescriptors(): AudioCodecDescriptor[] {
    return [getOpusCodecDescriptor()];
  }
}

export function getOpusCodecDescriptor(): AudioCodecDescriptor {
  const implemented = hasNativeOpusCodecSupport();
  return {
    kind: "audio",
    name: "opus",
    payloadType: 111,
    rtpmap: "opus/48000",
    clockRate: 48000,
    channels: 1,
    pcmSampleRate: 48000,
    fmtp: "useinbandfec=1",
    implemented,
    createEncoder: implemented
      ? (channels) => {
          const bindings = loadNativeCodecBindings();
          if (!bindings?.OpusEncoder) {
            throw new Error("Opus encoder backend is unavailable");
          }
          const normalizedChannels = normalizeOpusChannels(channels);
          const isStereo = normalizedChannels === 2;
          return new bindings.OpusEncoder(
            48000,
            normalizedChannels,
            OPUS_APPLICATION_VOIP,
            {
              bitrate: isStereo ? 80000 : 48000,
              complexity: 1,
              inbandFec: false,
              dtx: false,
              vbr: true,
              signal: OPUS_SIGNAL_VOICE,
            },
          );
        }
      : undefined,
    createDecoder: implemented
      ? (channels) => {
          const bindings = loadNativeCodecBindings();
          if (!bindings?.OpusDecoder) {
            throw new Error("Opus decoder backend is unavailable");
          }
          return new bindings.OpusDecoder(48000, normalizeOpusChannels(channels));
        }
      : undefined,
  };
}

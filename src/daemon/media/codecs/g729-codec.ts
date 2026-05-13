import { AudioCodecBase, hasNativeG729CodecSupport, loadNativeCodecBindings, type AudioCodecDescriptor } from "./audio-codec";

export class G729Codec extends AudioCodecBase {
  constructor() {
    super("g729");
  }

  listDescriptors(): AudioCodecDescriptor[] {
    return [getG729CodecDescriptor()];
  }
}

export function getG729CodecDescriptor(): AudioCodecDescriptor {
  const implemented = hasNativeG729CodecSupport();
  return {
    kind: "audio",
    name: "g729",
    payloadType: 18,
    rtpmap: "G729/8000",
    clockRate: 8000,
    channels: 1,
    pcmSampleRate: 8000,
    fmtp: "annexb=no",
    implemented,
    createEncoder: implemented
      ? () => {
          const bindings = loadNativeCodecBindings();
          if (!bindings?.G729Encoder) {
            throw new Error("G.729 encoder backend is unavailable");
          }
          return new bindings.G729Encoder(false);
        }
      : undefined,
    createDecoder: implemented
      ? () => {
          const bindings = loadNativeCodecBindings();
          if (!bindings?.G729Decoder) {
            throw new Error("G.729 decoder backend is unavailable");
          }
          return new bindings.G729Decoder();
        }
      : undefined,
  };
}

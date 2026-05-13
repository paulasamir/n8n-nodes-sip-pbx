import { AudioCodecBase, hasNativeG722CodecSupport, loadNativeCodecBindings, type AudioCodecDescriptor } from "./audio-codec";

export class G722Codec extends AudioCodecBase {
  constructor() {
    super("g722");
  }

  listDescriptors(): AudioCodecDescriptor[] {
    return [getG722CodecDescriptor()];
  }
}

export function getG722CodecDescriptor(): AudioCodecDescriptor {
  const implemented = hasNativeG722CodecSupport();
  return {
    kind: "audio",
    name: "g722",
    payloadType: 9,
    rtpmap: "G722/8000",
    clockRate: 8000,
    channels: 1,
    pcmSampleRate: 16000,
    fmtp: null,
    implemented,
    createEncoder: implemented
      ? () => {
          const bindings = loadNativeCodecBindings();
          if (!bindings?.G722Encoder) {
            throw new Error("G.722 encoder backend is unavailable");
          }
          return new bindings.G722Encoder(64000);
        }
      : undefined,
    createDecoder: implemented
      ? () => {
          const bindings = loadNativeCodecBindings();
          if (!bindings?.G722Decoder) {
            throw new Error("G.722 decoder backend is unavailable");
          }
          return new bindings.G722Decoder(64000);
        }
      : undefined,
  };
}

import { AudioCodecBase, type AudioCodecDescriptor } from "./audio-codec";

export class G711Codec extends AudioCodecBase {
  constructor() {
    super("g711");
  }

  listDescriptors(): AudioCodecDescriptor[] {
    return [getPcmuCodecDescriptor(), getPcmaCodecDescriptor()];
  }
}

export function getPcmuCodecDescriptor(): AudioCodecDescriptor {
  return {
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
}

export function getPcmaCodecDescriptor(): AudioCodecDescriptor {
  return {
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
}

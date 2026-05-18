import {
  SIP_AUDIO_CODEC_ALAW,
  SIP_AUDIO_CODEC_G722,
  SIP_AUDIO_CODEC_G729,
  SIP_AUDIO_CODEC_MULAW,
  SIP_AUDIO_CODEC_OPUS,
  SIP_DTMF_METHOD_INFO,
  SIP_DTMF_METHOD_RFC2833,
} from "./sip-media-filters";

const TRIGGER_RESPOND_TIMEOUT_SECONDS = 5;
const DIAL_WAIT_TIMEOUT_SECONDS = 30;
const TRIGGER_RESPONSE_TIMEOUT_DEFAULT = {
  responseTimeoutSeconds: TRIGGER_RESPOND_TIMEOUT_SECONDS,
} as const;
const TRIGGER_RECORD_RESPONSE_TIMEOUT_DEFAULT = {
  recordResponseTimeoutSeconds: TRIGGER_RESPOND_TIMEOUT_SECONDS,
} as const;
const TRIGGER_AUTH_RESPONSE_TIMEOUT_DEFAULT = {
  authTimeoutSeconds: TRIGGER_RESPOND_TIMEOUT_SECONDS,
} as const;
const TRIGGER_QUEUE_RESPONSE_TIMEOUT_DEFAULT = {
  responseTimeoutSeconds: DIAL_WAIT_TIMEOUT_SECONDS,
} as const;

export const OPTION_DEFAULTS = {
  common: {
    string: "",
    object: {} as Record<string, never>,
    array: [] as string[],
  },
  sip: {
    transport: "udp",
    bindIp: "0.0.0.0",
    localBindPort: 0,
    port: 5060,
    tlsPort: 5061,
    registrationExpiresSeconds: 600,
  },
  sipMedia: {
    codecs: [
      SIP_AUDIO_CODEC_OPUS,
      SIP_AUDIO_CODEC_G722,
      SIP_AUDIO_CODEC_ALAW,
      SIP_AUDIO_CODEC_MULAW,
      SIP_AUDIO_CODEC_G729,
    ] as string[],
    dtmfMethods: [
      SIP_DTMF_METHOD_RFC2833,
      SIP_DTMF_METHOD_INFO,
    ] as string[],
  },
  globalRecording: {
    active: true,
    fileFormat: "wav",
    wavSampleRate: 8000,
    wavBitDepth: 16,
    compressedSampleRate: 16000,
    compressedBitrateKbps: 32,
    splitChannels: false,
    waitForCompletion: false,
  },
  recordAudio: {
    fileFormat: "wav",
    wavSampleRate: 8000,
    wavBitDepth: 16,
    compressedSampleRate: 16000,
    compressedBitrateKbps: 32,
    outputType: "binary",
    binaryProperty: "data",
    maxDurationSeconds: 30,
    silenceThreshold: 0.01,
    silenceDurationMs: 300,
    httpMethod: "PUT",
    httpAuthentication: "none",
    httpCredentialSelection: null as null,
  },
  trigger: {
    trunk: {
      connectionMode: "fixed",
      useRegistration: true,
      authMode: "static",
      ...TRIGGER_AUTH_RESPONSE_TIMEOUT_DEFAULT,
      continueTraversalOnAuthReject: false,
      enableCallRecording: false,
      ...TRIGGER_RECORD_RESPONSE_TIMEOUT_DEFAULT,
    },
    extensions: {
      authMode: "static",
      ...TRIGGER_AUTH_RESPONSE_TIMEOUT_DEFAULT,
      ...TRIGGER_RECORD_RESPONSE_TIMEOUT_DEFAULT,
      enableCallRecording: false,
      continueTraversalOnAuthReject: false,
      transports: ["udp"] as string[],
      localBindPort: 5060,
      tlsBindPort: 5061,
    },
    queue: {
      ...TRIGGER_QUEUE_RESPONSE_TIMEOUT_DEFAULT,
      retryPauseSeconds: 30,
      retryAttempts: 3,
    },
    aiTool: {
      ...TRIGGER_RESPONSE_TIMEOUT_DEFAULT,
    },
  },
  action: {
    resource: "dial",
  },
  call: {
    relayDtmf: "auto",
    emitDtmfEvents: true,
    recordingControlAction: "pause",
    waitTimeoutSeconds: 30,
    interdigitTimeoutSeconds: 1,
    interruptReasons: [] as string[],
    clearDtmfBuffer: false,
    waitDtmfFallbackEnabled: false,
    waitDtmfMultiDigitFallbackEnabled: false,
    dtmfTerminatorDigit: "#",
  },
  dial: {
    extensionOnlyFreeEndpoints: true,
    strategy: "parallel",
    websocketStartMode: "immediate",
    sequentialAttemptTimeoutSeconds: 30,
    sequentialGapSeconds: 0,
    waitTimeoutSeconds: DIAL_WAIT_TIMEOUT_SECONDS,
    waitEventOutputs: [] as string[],
    breakReason: "broken",
    openaiRealtimeModel: "gpt-realtime",
    openaiRealtimeVoice: "marin",
    openaiRealtimeInputTranscriptionModel: "gpt-4o-transcribe",
    openaiRealtimeInstructions: "",
    openaiRealtimePromptId: "",
    openaiRealtimePromptVersion: "",
    openaiRealtimePromptVariablesJson: "{}",
    openaiRealtimeInputSampleRate: 24000,
    openaiRealtimeOutputSampleRate: 24000,
    geminiLiveModel: "gemini-3.1-flash-live-preview",
    geminiLiveVoice: "Puck",
    geminiLiveApiVersion: "v1beta",
    geminiLiveInstructions: "",
    websocketUrl: "",
    websocketHeadersJson: "{}",
    websocketInitialMessagesJson: "[]",
    geminiLiveInputSampleRate: 16000,
    geminiLiveOutputSampleRate: 24000,
    websocketAudioInputEventType: "input_audio",
    websocketAudioInputField: "audio",
    websocketAudioSampleRate: 48000,
    websocketAudioOutputEventTypesCsv: "audio_output",
    websocketAudioOutputField: "audio",
  },
  playAudio: {
    sourceType: "binary",
    binaryProperty: "data",
    httpMethod: "GET",
    httpAuthentication: "none",
    httpCredentialSelection: null as null,
    voiceThreshold: 0.02,
    voiceDurationMs: 150,
    duckingFactor: 1,
  },
  playTone: {
    tone: "ringback",
    repeatInfinite: false,
    presets: [
      {
        value: "ringback",
        displayName: "Ringback",
        customTone: "440+480/2000,0/4000",
        description: "US ringback: 440+480 Hz for 2 seconds, then 4 seconds of silence.",
      },
      {
        value: "busy",
        displayName: "Busy",
        customTone: "480+620/500,0/500",
        description: "US busy tone: 480+620 Hz for 500 ms, then 500 ms of silence.",
      },
      {
        value: "congestion",
        displayName: "Congestion",
        customTone: "480+620/250,0/250",
        description: "US congestion tone: 480+620 Hz for 250 ms, then 250 ms of silence.",
      },
    ] as const,
    voiceThreshold: 0.02,
    voiceDurationMs: 150,
    duckingFactor: 1,
  },
  mediaExecution: {
    mode: "blocking",
    stopOtherMedia: false,
  },
  stopMedia: {
    target: "mediaId",
  },
  waitMedia: {
    timeoutSeconds: 30,
  },
  sendDtmf: {
    method: "auto",
    durationMs: 200,
    gapMs: 100,
  },
  extensionsAction: {
    authAction: "not_applicable",
    statusCode: 401,
  },
  queueAction: {
    callbackEnabled: true,
    placement: "back",
    rejoinExisting: true,
    statsTarget: "ref",
  },
  aiTool: {
    parameterType: "string",
    parameterRequired: false,
  },
} as const;

export type PlayTonePreset = (typeof OPTION_DEFAULTS.playTone.presets)[number];

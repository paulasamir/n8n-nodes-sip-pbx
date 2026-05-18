import {
  BINARY_PROPERTY_HINT,
  buildExtensionDialOptionEntries,
  buildHeadersCollectionProperty,
  buildIdOption,
  buildInterruptPropertySet,
  buildInterruptOnProperty,
  buildOptionsCollectionProperty,
  buildSipCodecFilterOption,
  buildSipDialOptionEntries,
  buildSipDtmfMethodsFilterOption,
  DUCKING_FACTOR_HINT,
  PLAY_TONE_CUSTOM_HINT,
  PLAYBACK_FILE_PATH_HINT,
  PLAYBACK_HTTP_URL_HINT,
  REF_HINT,
  RECORD_FILE_PATH_HINT,
  RECORD_HTTP_URL_HINT,
  type UiProperty,
} from "./description-fragments";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import {
  INTERRUPT_REASON_CALL_BRIDGE_JOINED,
  INTERRUPT_REASON_CALL_BRIDGE_REMOVED_PEER_ENDED,
  INTERRUPT_REASON_CALL_BRIDGE_REMOVED_REBRIDGE,
  INTERRUPT_REASON_CALL_BRIDGE_REMOVED_ROLLBACK,
  INTERRUPT_REASON_CALL_BRIDGE_REMOVED_UNBRIDGE,
  INTERRUPT_REASON_CALL_QUEUE_PLACED,
  INTERRUPT_REASON_CALL_QUEUE_REMOVED,
} from "../../shared/interrupt-reasons";
import {
  INTERRUPT_SELECTION_DTMF,
  INTERRUPT_SELECTION_SILENCE,
  INTERRUPT_SELECTION_VOICE,
} from "../../shared/interrupt-selections";
import {
  SIP_DTMF_METHOD_INBAND,
  SIP_DTMF_METHOD_INFO,
  SIP_DTMF_METHOD_RFC2833,
} from "../../shared/sip-media-filters";
import {
  buildWebSocketDialProfileOptionCollections,
  buildWebSocketDialProfilePrimaryProperties,
  buildWebSocketDialTransportProfileProperty,
} from "../websocket-profiles";

function buildStopOtherMediaOption(): UiProperty {
  return {
    displayName: "Stop Other Media",
    name: "stopOtherMedia",
    type: "boolean",
    default: OPTION_DEFAULTS.mediaExecution.stopOtherMedia,
    description: "Stop other active media on the same leg before starting this one.",
  };
}

function buildMediaExecutionModeOption(): UiProperty {
  return {
    displayName: "Execution Mode",
    name: "mediaExecutionMode",
    type: "options",
    default: OPTION_DEFAULTS.mediaExecution.mode,
    options: [{ name: "Blocking", value: "blocking" }, { name: "Background", value: "background" }],
  };
}

function buildDuckingFactorOption(): UiProperty {
  return {
    displayName: "Ducking Factor",
    name: "duckingFactor",
    type: "number",
    default: OPTION_DEFAULTS.playAudio.duckingFactor,
    description: DUCKING_FACTOR_HINT,
  };
}

function buildVoiceInterruptOptionEntries(): UiProperty[] {
  return [
    { displayName: "Voice Threshold", name: "voiceThreshold", type: "number", default: OPTION_DEFAULTS.playAudio.voiceThreshold },
    { displayName: "Voice Duration (ms)", name: "voiceDurationMs", type: "number", default: OPTION_DEFAULTS.playAudio.voiceDurationMs },
  ];
}

function buildSilenceInterruptOptionEntries(): UiProperty[] {
  return [
    { displayName: "Silence Threshold", name: "silenceThreshold", type: "number", default: OPTION_DEFAULTS.recordAudio.silenceThreshold },
    { displayName: "Silence Duration (ms)", name: "silenceDurationMs", type: "number", default: OPTION_DEFAULTS.recordAudio.silenceDurationMs },
  ];
}

function buildPlaybackHttpMethodOption(): UiProperty {
  return {
    displayName: "HTTP Method",
    name: "playbackHttpMethod",
    type: "options",
    default: OPTION_DEFAULTS.playAudio.httpMethod,
    options: [{ name: "GET", value: "GET" }, { name: "POST", value: "POST" }, { name: "PUT", value: "PUT" }],
  };
}

function buildRecordHttpMethodOption(): UiProperty {
  return {
    displayName: "HTTP Method",
    name: "recordHttpMethod",
    type: "options",
    default: OPTION_DEFAULTS.recordAudio.httpMethod,
    options: [{ name: "POST", value: "POST" }, { name: "PUT", value: "PUT" }],
  };
}

function buildPlaybackOptions(input: { includeHttp: boolean }): UiProperty[] {
  const options: UiProperty[] = [
    buildIdOption("Leg ID", "legId"),
  ];
  if (input.includeHttp) {
    options.push(buildPlaybackHttpMethodOption(), buildHeadersCollectionProperty("HTTP Headers", "playbackHttpHeaders", {}));
  }
  options.push(buildStopOtherMediaOption(), buildDuckingFactorOption(), buildMediaExecutionModeOption());
  return options;
}

function buildRecordOptions(input: { includeHttp: boolean; fileFormat: "wav" | "compressed" }): UiProperty[] {
  const options: UiProperty[] = [
    buildIdOption("Leg ID", "legId"),
  ];
  if (input.includeHttp) {
    options.push(buildRecordHttpMethodOption(), buildHeadersCollectionProperty("HTTP Headers", "recordHttpHeaders", {}));
  }
  options.push(buildStopOtherMediaOption(), buildMediaExecutionModeOption());
  if (input.fileFormat === "wav") {
    options.push(
      { displayName: "WAV Sample Rate", name: "recordWavSampleRate", type: "number", default: OPTION_DEFAULTS.recordAudio.wavSampleRate },
      { displayName: "WAV Bit Depth", name: "recordWavBitDepth", type: "number", default: OPTION_DEFAULTS.recordAudio.wavBitDepth },
    );
  } else {
    options.push(
      { displayName: "Compressed Sample Rate", name: "recordCompressedSampleRate", type: "number", default: OPTION_DEFAULTS.recordAudio.compressedSampleRate },
      { displayName: "Compressed Bitrate", name: "recordCompressedBitrate", type: "number", default: OPTION_DEFAULTS.recordAudio.compressedBitrateKbps },
    );
  }
  return options;
}

function buildOperationProperty(resource: string, options: UiProperty["options"]): UiProperty {
  return {
    displayName: "Operation",
    name: "operation",
    type: "options",
    noDataExpression: true,
    required: true,
    default: OPTION_DEFAULTS.common.string,
    displayOptions: { show: { resource: [resource] } },
    options,
  };
}

function buildIdListProperty(input: {
  displayName: string;
  name: string;
  itemDisplayName: string;
  show: Record<string, unknown>;
  description: string;
}): UiProperty {
  return {
    displayName: input.displayName,
    name: input.name,
    type: "fixedCollection",
    typeOptions: { multipleValues: true },
    default: OPTION_DEFAULTS.common.object,
    description: input.description,
    displayOptions: { show: input.show },
    options: [
      {
        name: "item",
        displayName: input.itemDisplayName,
        values: [{ displayName: input.itemDisplayName, name: input.name.slice(0, -1), type: "string", default: OPTION_DEFAULTS.common.string, required: true }],
      },
    ],
  };
}

function buildHttpAuthProperties(input: {
  modeName: string;
  predefinedCredentialName: string;
  genericCredentialName: string;
  show: Record<string, unknown>;
}): UiProperty[] {
  return [
    {
      displayName: "HTTP Auth",
      name: input.modeName,
      type: "options",
      default:
        input.modeName === "playbackHttpAuthentication"
          ? OPTION_DEFAULTS.playAudio.httpAuthentication
          : OPTION_DEFAULTS.recordAudio.httpAuthentication,
      displayOptions: { show: input.show },
      options: [
        { name: "None", value: "none" },
        { name: "Predefined", value: "predefinedCredentialType" },
        { name: "Generic", value: "genericCredentialType" },
      ],
    },
    {
      displayName: "Credential Type",
      name: input.predefinedCredentialName,
      type: "credentialsSelect",
      credentialTypes: ["extends:oAuth2Api", "extends:oAuth1Api", "has:authenticate"],
      default:
        input.modeName === "playbackHttpAuthentication"
          ? OPTION_DEFAULTS.playAudio.httpCredentialSelection
          : OPTION_DEFAULTS.recordAudio.httpCredentialSelection,
      required: true,
      displayOptions: { show: { ...input.show, [input.modeName]: ["predefinedCredentialType"] } },
    },
    {
      displayName: "Generic Auth Type",
      name: input.genericCredentialName,
      type: "credentialsSelect",
      credentialTypes: ["has:genericAuth"],
      default:
        input.modeName === "playbackHttpAuthentication"
          ? OPTION_DEFAULTS.playAudio.httpCredentialSelection
          : OPTION_DEFAULTS.recordAudio.httpCredentialSelection,
      required: true,
      displayOptions: { show: { ...input.show, [input.modeName]: ["genericCredentialType"] } },
    },
  ];
}

function buildCallWaitPrimaryProperties(): UiProperty[] {
  return [
    {
      displayName: "Overall Timeout (Seconds)",
      name: "timeoutSeconds",
      type: "number",
      default: OPTION_DEFAULTS.call.waitTimeoutSeconds,
      description: "Maximum total wait time before the action takes the Timeout branch.",
      displayOptions: { show: { resource: ["call"], operation: ["call.wait"] } },
    },
    {
      displayName: "DTMF Rules",
      name: "rules",
      type: "fixedCollection",
      typeOptions: { multipleValues: true },
      default: OPTION_DEFAULTS.common.object,
      displayOptions: { show: { resource: ["call"], operation: ["call.wait"] } },
      options: [
        {
          name: "item",
          displayName: "Rule",
          values: [
            { displayName: "Pattern", name: "pattern", type: "string", default: OPTION_DEFAULTS.common.string, required: true },
            { displayName: "Label", name: "label", type: "string", default: OPTION_DEFAULTS.common.string, required: true },
          ],
        },
      ],
    },
    { displayName: "DTMF Fallback", name: "waitDtmfFallbackEnabled", type: "boolean", default: OPTION_DEFAULTS.call.waitDtmfFallbackEnabled, displayOptions: { show: { resource: ["call"], operation: ["call.wait"] } } },
    { displayName: "Multi-Digit DTMF Fallback", name: "waitDtmfMultiDigitFallbackEnabled", type: "boolean", default: OPTION_DEFAULTS.call.waitDtmfMultiDigitFallbackEnabled, displayOptions: { show: { resource: ["call"], operation: ["call.wait"], waitDtmfFallbackEnabled: [true] } } },
    {
      displayName: "Terminator Digit",
      name: "dtmfTerminatorDigit",
      type: "string",
      default: OPTION_DEFAULTS.call.dtmfTerminatorDigit,
      description: "Single DTMF digit that ends multi-digit fallback capture. If empty, fallback capture ends only when the interdigit timeout expires.",
      displayOptions: { show: { resource: ["call"], operation: ["call.wait"], waitDtmfFallbackEnabled: [true], waitDtmfMultiDigitFallbackEnabled: [true] } },
    },
    buildIdListProperty({
      displayName: "Leg IDs",
      name: "legIds",
      itemDisplayName: "Leg ID",
      show: { resource: ["call"], operation: ["call.wait"] },
      description: "Optional explicit wait target list. If empty, the node waits for the input legId, then input sipPbx.legId.",
    }),
  ];
}

function buildDialWaitPrimaryProperties(): UiProperty[] {
  return [
    { displayName: "Overall Timeout (Seconds)", name: "dialTimeoutSeconds", type: "number", default: OPTION_DEFAULTS.dial.waitTimeoutSeconds, displayOptions: { show: { resource: ["dial"], operation: ["dial.wait"] } } },
    {
      displayName: "Master Leg ID",
      name: "legId",
      type: "string",
      default: OPTION_DEFAULTS.common.string,
      description: "Optional leg to retain for the duration of the wait so it does not expire by TTL, and to subscribe for interrupt events on the leg.",
      displayOptions: { show: { resource: ["dial"], operation: ["dial.wait"] } },
    },
    buildInterruptOnProperty({
      show: { resource: ["dial"], operation: ["dial.wait"] },
      allowedSelections: [INTERRUPT_SELECTION_DTMF],
      description: "Interrupts the wait itself when the master leg receives one of the selected signals. It does not interrupt or stop the dial operation.",
    }),
    {
      displayName: "Additional Outputs",
      name: "waitEventOutputs",
      type: "multiOptions",
      default: [...OPTION_DEFAULTS.dial.waitEventOutputs],
      displayOptions: { show: { resource: ["dial"], operation: ["dial.wait"] } },
      options: [
        { name: "Ringing", value: "ringing" },
        { name: "Progress", value: "progress" },
        { name: "Rejected", value: "rejected" },
      ],
    },
    buildIdListProperty({
      displayName: "Dial IDs",
      name: "dialIds",
      itemDisplayName: "Dial ID",
      show: { resource: ["dial"], operation: ["dial.wait"] },
      description: "Optional explicit wait target list. If empty, the node waits for the input dialId, then input sipPbx.dialId.",
    }),
  ];
}

function buildPlayAudioPrimaryProperties(): UiProperty[] {
  return [
    {
      displayName: "Source Type",
      name: "sourceType",
      type: "options",
      default: OPTION_DEFAULTS.playAudio.sourceType,
      required: true,
      displayOptions: { show: { resource: ["media"], operation: ["media.playAudio"] } },
      options: [
        { name: "Binary", value: "binary" },
        { name: "File", value: "file" },
        { name: "HTTP", value: "http" },
      ],
    },
    { displayName: "Binary Property", name: "binaryProperty", type: "string", default: OPTION_DEFAULTS.playAudio.binaryProperty, description: BINARY_PROPERTY_HINT, displayOptions: { show: { resource: ["media"], operation: ["media.playAudio"], sourceType: ["binary"] } } },
    { displayName: "File Path", name: "filePath", type: "string", default: OPTION_DEFAULTS.common.string, required: true, description: PLAYBACK_FILE_PATH_HINT, displayOptions: { show: { resource: ["media"], operation: ["media.playAudio"], sourceType: ["file"] } } },
    { displayName: "URL", name: "playbackHttpUrl", type: "string", default: OPTION_DEFAULTS.common.string, required: true, description: PLAYBACK_HTTP_URL_HINT, displayOptions: { show: { resource: ["media"], operation: ["media.playAudio"], sourceType: ["http"] } } },
    ...buildHttpAuthProperties({
      modeName: "playbackHttpAuthentication",
      predefinedCredentialName: "playbackHttpNodeCredentialType",
      genericCredentialName: "playbackHttpGenericAuthType",
      show: { resource: ["media"], operation: ["media.playAudio"], sourceType: ["http"] },
    }),
  ];
}

function buildRecordAudioPrimaryProperties(): UiProperty[] {
  return [
    { displayName: "Max Duration (Seconds)", name: "maxDurationSeconds", type: "number", default: OPTION_DEFAULTS.recordAudio.maxDurationSeconds, displayOptions: { show: { resource: ["media"], operation: ["media.recordAudio"] } } },
    { displayName: "File Format", name: "recordFileFormat", type: "options", default: OPTION_DEFAULTS.recordAudio.fileFormat, displayOptions: { show: { resource: ["media"], operation: ["media.recordAudio"] } }, options: [{ name: "WAV", value: "wav" }, { name: "MP3", value: "mp3" }, { name: "Opus", value: "opus" }, { name: "OGG", value: "ogg" }] },
    { displayName: "Output Type", name: "recordOutputType", type: "options", default: OPTION_DEFAULTS.recordAudio.outputType, required: true, displayOptions: { show: { resource: ["media"], operation: ["media.recordAudio"] } }, options: [{ name: "Binary", value: "binary" }, { name: "File", value: "file" }, { name: "HTTP", value: "http" }] },
    { displayName: "Binary Property", name: "recordBinaryProperty", type: "string", default: OPTION_DEFAULTS.recordAudio.binaryProperty, description: BINARY_PROPERTY_HINT, displayOptions: { show: { resource: ["media"], operation: ["media.recordAudio"], recordOutputType: ["binary"] } } },
    { displayName: "File Path", name: "recordFilePath", type: "string", default: OPTION_DEFAULTS.common.string, required: true, description: RECORD_FILE_PATH_HINT, displayOptions: { show: { resource: ["media"], operation: ["media.recordAudio"], recordOutputType: ["file"] } } },
    { displayName: "URL", name: "recordHttpUrl", type: "string", default: OPTION_DEFAULTS.common.string, required: true, description: RECORD_HTTP_URL_HINT, displayOptions: { show: { resource: ["media"], operation: ["media.recordAudio"], recordOutputType: ["http"] } } },
    ...buildHttpAuthProperties({
      modeName: "recordHttpAuthentication",
      predefinedCredentialName: "recordHttpNodeCredentialType",
      genericCredentialName: "recordHttpGenericAuthType",
      show: { resource: ["media"], operation: ["media.recordAudio"], recordOutputType: ["http"] },
    }),
  ];
}

function buildGlobalRecordingPrimaryProperties(show: Record<string, unknown>, includeActive: boolean): UiProperty[] {
  const contentShow = includeActive ? { ...show, active: [true] } : show;
  const properties: UiProperty[] = [];
  if (includeActive) {
    properties.push({
      displayName: "Record the call",
      name: "active",
      type: "boolean",
      default: OPTION_DEFAULTS.globalRecording.active,
      description: "When enabled, starts global recording for the active leg. When disabled, the action returns without starting recording.",
      displayOptions: { show },
    });
  }
  properties.push(
    {
      displayName: "File Path",
      name: "recordFilePath",
      type: "string",
      default: OPTION_DEFAULTS.common.string,
      required: true,
      description: RECORD_FILE_PATH_HINT,
      displayOptions: { show: contentShow },
    },
    {
      displayName: "File Format",
      name: "recordFileFormat",
      type: "options",
      default: OPTION_DEFAULTS.globalRecording.fileFormat,
      displayOptions: { show: contentShow },
      options: [{ name: "WAV", value: "wav" }, { name: "MP3", value: "mp3" }, { name: "Opus", value: "opus" }, { name: "OGG", value: "ogg" }],
    },
    {
      displayName: "Split Channels",
      name: "recordSplitChannels",
      type: "boolean",
      default: OPTION_DEFAULTS.globalRecording.splitChannels,
      description: "When enabled, call recording writes inbound audio to channel 1 and outbound PBX audio to channel 2.",
      displayOptions: { show: contentShow },
    },
    {
      displayName: "Wait For Recording Completion",
      name: "waitForRecordingCompletion",
      type: "boolean",
      default: OPTION_DEFAULTS.globalRecording.waitForCompletion,
      displayOptions: { show: contentShow },
    },
  );
  return properties;
}

function buildGlobalRecordingOptionsCollections(
  show: Record<string, unknown>,
  idOption: UiProperty,
  includeActive: boolean,
): UiProperty[] {
  const result: UiProperty[] = [];

  if (includeActive) {
    result.push(buildOptionsCollectionProperty({ show: { ...show, active: [false] } }, [idOption]));
  }

  const baseShow = includeActive ? { ...show, active: [true] } : show;

  result.push(
    buildOptionsCollectionProperty({ show: { ...baseShow, recordFileFormat: ["wav"] } }, [
      idOption,
      { displayName: "WAV Sample Rate", name: "recordWavSampleRate", type: "number", default: OPTION_DEFAULTS.globalRecording.wavSampleRate },
      { displayName: "WAV Bit Depth", name: "recordWavBitDepth", type: "number", default: OPTION_DEFAULTS.globalRecording.wavBitDepth },
    ]),
  );

  result.push(
    buildOptionsCollectionProperty({ show: { ...baseShow, recordFileFormat: ["mp3", "opus", "ogg"] } }, [
      idOption,
      { displayName: "Compressed Sample Rate", name: "recordCompressedSampleRate", type: "number", default: OPTION_DEFAULTS.globalRecording.compressedSampleRate },
      { displayName: "Compressed Bitrate", name: "recordCompressedBitrate", type: "number", default: OPTION_DEFAULTS.globalRecording.compressedBitrateKbps },
    ]),
  );

  return result;
}

export function buildActionNodeProperties(): UiProperty[] {
  return [
    {
      displayName: "Resource",
      name: "resource",
      type: "options",
      noDataExpression: true,
      default: OPTION_DEFAULTS.action.resource,
      options: [
        { name: "Call", value: "call" },
        { name: "Dial", value: "dial" },
        { name: "Media", value: "media" },
        { name: "Queue", value: "queue" },
        { name: "Global recording", value: "recording" },
        { name: "AI", value: "ai" },
        { name: "Respond", value: "respond" },
      ],
    },
    buildOperationProperty("call", [
      { name: "Ringing", value: "call.ringing", action: "Ringing tones" },
      { name: "Answer", value: "call.answer", action: "Answer call" },
      { name: "Hangup", value: "call.hangup", action: "Hang up call" },
      { name: "Bridge", value: "call.bridge", action: "Bridge calls" },
      { name: "Unbridge", value: "call.unbridge", action: "Unbridge call" },
      { name: "Wait Event", value: "call.wait", action: "Wait call event" },
    ]),
    buildOperationProperty("dial", [
      { name: "Make Call", value: "dial.make", action: "Create dial" },
      { name: "Break", value: "dial.break", action: "Break dial" },
      { name: "Wait Event", value: "dial.wait", action: "Wait dial event" },
    ]),
    buildOperationProperty("media", [
      { name: "Play Audio", value: "media.playAudio", action: "Play audio" },
      { name: "Play Tone", value: "media.playTone", action: "Play tone" },
      { name: "Record Audio", value: "media.recordAudio", action: "Record audio" },
      { name: "Stop Media", value: "media.stopMedia", action: "Stop media" },
      { name: "Wait Media", value: "media.wait", action: "Wait media" },
      { name: "Send DTMF", value: "media.sendDtmf", action: "Send DTMF" },
    ]),
    buildOperationProperty("queue", [
      { name: "Put Leg In Queue", value: "queue.putLeg", action: "Put leg in queue" },
      { name: "Set Callback", value: "queue.setCallback", action: "Set queue callback" },
      { name: "Get Queue Stats", value: "queue.getStats", action: "Get queue stats" },
    ]),
    buildOperationProperty("recording", [
      { name: "Start recording", value: "recording.start", action: "Start recording" },
      { name: "Control recording", value: "recording.control", action: "Control recording" },
    ]),
    buildOperationProperty("ai", [
      { name: "Attach Voice Agent", value: "ai.attachVoiceAgent", action: "Attach voice agent" },
      { name: "Invoke AI Tool", value: "ai.invokeAiTool", action: "Invoke AI tool" },
    ]),
    buildOperationProperty("respond", [
      { name: "Respond to recording", value: "respond.toRecord", action: "Respond to recording" },
      { name: "Respond To Auth", value: "respond.toAuth", action: "Respond to auth" },
      { name: "Respond To AI Tool", value: "respond.toAiTool", action: "Respond to AI tool" },
    ]),

    {
      displayName: "AI Tool Ref",
      name: "ref",
      type: "string",
      default: OPTION_DEFAULTS.common.string,
      required: true,
      description: REF_HINT,
      displayOptions: { show: { resource: ["ai"], operation: ["ai.invokeAiTool"] } },
    },
    {
      displayName: "Function Description",
      name: "aiToolDescription",
      type: "string",
      default: OPTION_DEFAULTS.common.string,
      required: true,
      description: "Natural-language description of what this function does. This text is shown to the AI model to decide when to call it.",
      displayOptions: { show: { resource: ["ai"], operation: ["ai.invokeAiTool"] } },
    },
    {
      displayName: "Flow Parameters",
      name: "aiFlowParams",
      type: "fixedCollection",
      typeOptions: { multipleValues: true },
      default: OPTION_DEFAULTS.common.object,
      description: "Static or expression-based values from the current workflow context. They are passed to the AI trigger as one object named flowParams.",
      displayOptions: { show: { resource: ["ai"], operation: ["ai.invokeAiTool"] } },
      options: [
        {
          name: "item",
          displayName: "Flow Parameter",
          values: [
            { displayName: "Name", name: "name", type: "string", default: OPTION_DEFAULTS.common.string, required: true },
            { displayName: "Value", name: "value", type: "string", default: OPTION_DEFAULTS.common.string, required: true },
          ],
        },
      ],
    },
    {
      displayName: "Function Parameters",
      name: "aiToolParams",
      type: "fixedCollection",
      typeOptions: { multipleValues: true },
      default: OPTION_DEFAULTS.common.object,
      description: "Arguments the AI model is allowed to fill in when it calls this function. They are passed to the AI trigger as one object named toolParams.",
      displayOptions: { show: { resource: ["ai"], operation: ["ai.invokeAiTool"] } },
      options: [
        {
          name: "item",
          displayName: "Function Parameter",
          values: [
            { displayName: "Name", name: "name", type: "string", default: OPTION_DEFAULTS.common.string, required: true },
            {
              displayName: "Type",
              name: "type",
              type: "options",
              default: OPTION_DEFAULTS.aiTool.parameterType,
              required: true,
              options: [
                { name: "String", value: "string" },
                { name: "Number", value: "number" },
                { name: "Integer", value: "integer" },
                { name: "Boolean", value: "boolean" },
              ],
            },
            { displayName: "Description", name: "description", type: "string", default: OPTION_DEFAULTS.common.string, required: true },
            { displayName: "Required", name: "required", type: "boolean", default: OPTION_DEFAULTS.aiTool.parameterRequired },
          ],
        },
      ],
    },

    { displayName: "Leg A ID", name: "legAId", type: "string", default: OPTION_DEFAULTS.common.string, required: true, displayOptions: { show: { resource: ["call"], operation: ["call.bridge"] } } },
    { displayName: "Leg B ID", name: "legBId", type: "string", default: OPTION_DEFAULTS.common.string, required: true, displayOptions: { show: { resource: ["call"], operation: ["call.bridge"] } } },
    buildOptionsCollectionProperty({ show: { resource: ["ai"], operation: ["ai.attachVoiceAgent"] } }, [
      {
        displayName: "AI Leg ID",
        name: "legId",
        type: "string",
        default: OPTION_DEFAULTS.common.string,
        description: "Optional explicit websocket AI leg override. If empty, the action resolves aiLegId first, then legId, from the current item.",
      },
    ]),
    { displayName: "Action", name: "recordingControlAction", type: "options", default: OPTION_DEFAULTS.call.recordingControlAction, displayOptions: { show: { resource: ["recording"], operation: ["recording.control"] } }, options: [{ name: "Pause", value: "pause" }, { name: "Resume", value: "resume" }] },
    ...buildCallWaitPrimaryProperties(),
    buildOptionsCollectionProperty({ show: { resource: ["call"], operation: ["call.bridge"] } }, [
      { displayName: "Emit DTMF Events", name: "emitDtmfEvents", type: "boolean", default: OPTION_DEFAULTS.call.emitDtmfEvents },
      {
        displayName: "Relay DTMF",
        name: "relayDtmf",
        type: "options",
        default: OPTION_DEFAULTS.call.relayDtmf,
        options: [
          { name: "Disabled", value: "disabled" },
          { name: "Auto", value: "auto" },
          { name: "RFC2833", value: SIP_DTMF_METHOD_RFC2833 },
          { name: "SIP INFO", value: SIP_DTMF_METHOD_INFO },
          { name: "Inband", value: SIP_DTMF_METHOD_INBAND },
        ],
      },
    ]),
    buildOptionsCollectionProperty({ show: { resource: ["call"], operation: ["call.wait"] } }, [
      {
        displayName: "Interrupt On",
        name: "interruptReasons",
        type: "multiOptions",
        default: OPTION_DEFAULTS.call.interruptReasons,
        options: [
          { name: "Call: Bridge Joined", value: INTERRUPT_REASON_CALL_BRIDGE_JOINED },
          { name: "Call: Bridge Removed / Peer Ended", value: INTERRUPT_REASON_CALL_BRIDGE_REMOVED_PEER_ENDED },
          { name: "Call: Bridge Removed / Unbridge", value: INTERRUPT_REASON_CALL_BRIDGE_REMOVED_UNBRIDGE },
          { name: "Call: Bridge Removed / Rollback", value: INTERRUPT_REASON_CALL_BRIDGE_REMOVED_ROLLBACK },
          { name: "Call: Bridge Removed / Rebridge", value: INTERRUPT_REASON_CALL_BRIDGE_REMOVED_REBRIDGE },
          { name: "Call: Queue Placed", value: INTERRUPT_REASON_CALL_QUEUE_PLACED },
          { name: "Call: Queue Removed", value: INTERRUPT_REASON_CALL_QUEUE_REMOVED },
        ],
      },
      {
        displayName: "Clear Queued DTMF",
        name: "clearDtmfBuffer",
        type: "boolean",
        default: OPTION_DEFAULTS.call.clearDtmfBuffer,
        description: "Drops queued DTMF events before the wait starts, so only newly received digits can match.",
      },
      { displayName: "Interdigit Timeout (Seconds)", name: "interdigitTimeoutSeconds", type: "number", default: OPTION_DEFAULTS.call.interdigitTimeoutSeconds },
    ]),
    buildOptionsCollectionProperty({ show: { resource: ["call"], operation: ["call.ringing", "call.answer", "call.hangup", "call.unbridge"] } }, [buildIdOption("Leg ID", "legId")]),

    {
      displayName: "Mode",
      name: "callMode",
      type: "options",
      default: OPTION_DEFAULTS.common.string,
      required: true,
      displayOptions: { show: { resource: ["dial"], operation: ["dial.make"] } },
      options: [
        { name: "Trunk", value: "trunk" },
        { name: "Extension", value: "extension" },
        { name: "Direct", value: "direct" },
        { name: "WebSocket", value: "websocket" },
      ],
    },
    { displayName: "Trunk Ref", name: "ref", type: "string", default: OPTION_DEFAULTS.common.string, required: true, displayOptions: { show: { resource: ["dial"], operation: ["dial.make"], callMode: ["trunk"] } } },
    { displayName: "Destinations", name: "destination", type: "string", default: OPTION_DEFAULTS.common.string, required: true, description: "Comma-separated phone numbers or SIP users. Do not include server or auth data here; trunk/direct signaling server and authentication always come from the linked credentials.", displayOptions: { show: { resource: ["dial"], operation: ["dial.make"], callMode: ["trunk"] } } },
    {
      displayName: "SIP Connection",
      name: "sipPbxExternal",
      type: "credentials",
      default: OPTION_DEFAULTS.common.string,
      displayOptions: { show: { resource: ["dial"], operation: ["dial.make"], callMode: ["direct"] } },
    },
    { displayName: "Destinations", name: "destination", type: "string", default: OPTION_DEFAULTS.common.string, required: true, description: "Comma-separated phone numbers or SIP users. Do not include server or auth data here; trunk/direct signaling server and authentication always come from the linked credentials.", displayOptions: { show: { resource: ["dial"], operation: ["dial.make"], callMode: ["direct"] } } },
    { displayName: "Extensions", name: "extensionNumbers", type: "string", default: OPTION_DEFAULTS.common.string, required: true, description: "Comma-separated extension numbers. Calls every matching endpoint across all extensions refs in the current flow.", displayOptions: { show: { resource: ["dial"], operation: ["dial.make"], callMode: ["extension"] } } },
    buildOptionsCollectionProperty({ show: { resource: ["dial"], operation: ["dial.make"], callMode: ["trunk"] } }, buildSipDialOptionEntries()),
    buildOptionsCollectionProperty(
      { show: { resource: ["dial"], operation: ["dial.make"], callMode: ["direct"] } },
      [
        ...buildSipDialOptionEntries(),
        buildSipCodecFilterOption(),
        buildSipDtmfMethodsFilterOption(),
      ],
    ),
    buildOptionsCollectionProperty({ show: { resource: ["dial"], operation: ["dial.make"], callMode: ["extension"] } }, buildExtensionDialOptionEntries()),
    buildWebSocketDialTransportProfileProperty({ resource: ["dial"], operation: ["dial.make"], callMode: ["websocket"] }),
    ...buildWebSocketDialProfilePrimaryProperties({ resource: ["dial"], operation: ["dial.make"], callMode: ["websocket"] }),
    {
      displayName: "WebSocket Start Mode",
      name: "websocketStartMode",
      type: "options",
      default: OPTION_DEFAULTS.dial.websocketStartMode,
      description: "Immediate opens the AI provider session as soon as the websocket leg is ready. Deferred keeps the leg unstarted until Attach Voice Agent initializes memory and tools.",
      displayOptions: { show: { resource: ["dial"], operation: ["dial.make"], callMode: ["websocket"], transportProfile: ["openai_realtime", "gemini_live"] } },
      options: [
        { name: "Immediate", value: "immediate" },
        { name: "Deferred", value: "deferred" },
      ],
    },
    ...buildWebSocketDialProfileOptionCollections({ resource: ["dial"], operation: ["dial.make"], callMode: ["websocket"] }),
    ...buildDialWaitPrimaryProperties(),
    buildOptionsCollectionProperty({ show: { resource: ["dial"], operation: ["dial.break"] } }, [
      buildIdOption("Dial ID", "dialId"),
      { displayName: "Reason", name: "dialBreakReason", type: "string", default: OPTION_DEFAULTS.dial.breakReason },
    ]),
    ...buildPlayAudioPrimaryProperties(),
    { displayName: "Tone", name: "tone", type: "options", default: OPTION_DEFAULTS.playTone.tone, required: true, description: "Built-in tone preset or custom pattern.", displayOptions: { show: { resource: ["media"], operation: ["media.playTone"] } }, options: [...OPTION_DEFAULTS.playTone.presets.map((preset) => ({ name: preset.displayName, value: preset.value, description: preset.description })), { name: "Custom", value: "custom", description: "Provide a custom tone pattern manually." }] },
    { displayName: "Custom Tone", name: "customTone", type: "string", default: OPTION_DEFAULTS.common.string, required: true, description: PLAY_TONE_CUSTOM_HINT, displayOptions: { show: { resource: ["media"], operation: ["media.playTone"], tone: ["custom"] } } },
    { displayName: "Repeat Forever", name: "repeatInfinite", type: "boolean", default: OPTION_DEFAULTS.playTone.repeatInfinite, displayOptions: { show: { resource: ["media"], operation: ["media.playTone"] } } },
    ...buildInterruptPropertySet({
      interruptShow: { resource: ["media"], operation: ["media.playAudio", "media.playTone"] },
      allowedSelections: [INTERRUPT_SELECTION_DTMF, INTERRUPT_SELECTION_VOICE],
      dependentSelection: INTERRUPT_SELECTION_VOICE,
      dependentOptions: buildVoiceInterruptOptionEntries(),
      variants: [
        {
          show: { resource: ["media"], operation: ["media.playTone"] },
          baseOptions: buildPlaybackOptions({ includeHttp: false }),
        },
        {
          show: { resource: ["media"], operation: ["media.playAudio"], sourceType: ["binary", "file"] },
          baseOptions: buildPlaybackOptions({ includeHttp: false }),
        },
        {
          show: { resource: ["media"], operation: ["media.playAudio"], sourceType: ["http"] },
          baseOptions: buildPlaybackOptions({ includeHttp: true }),
        },
      ],
    }),
    ...buildRecordAudioPrimaryProperties(),
    ...buildGlobalRecordingPrimaryProperties({ resource: ["recording"], operation: ["recording.start"] }, false),
    ...buildGlobalRecordingPrimaryProperties({ resource: ["respond"], operation: ["respond.toRecord"] }, true),
    {
      displayName: "Action",
      name: "authAction",
      type: "options",
      default: OPTION_DEFAULTS.extensionsAction.authAction,
      required: true,
      displayOptions: { show: { resource: ["respond"], operation: ["respond.toAuth"] } },
      options: [
        { name: "Allow", value: "allow" },
        { name: "Verify Digest Password", value: "verify_password" },
        { name: "Not Applicable", value: "not_applicable" },
        { name: "Challenge", value: "challenge" },
        { name: "Deny", value: "deny" },
      ],
    },
    { displayName: "Password", name: "password", type: "string", typeOptions: { password: true }, default: OPTION_DEFAULTS.common.string, required: true, displayOptions: { show: { resource: ["respond"], operation: ["respond.toAuth"], authAction: ["verify_password"] } } },
    {
      displayName: "Extension",
      name: "extension",
      type: "string",
      default: OPTION_DEFAULTS.common.string,
      required: false,
      description: "Used for extension auth only. Leave empty for trunk dynamic address auth, or when the extension can be derived from the auth username.",
      displayOptions: { show: { resource: ["respond"], operation: ["respond.toAuth"], authAction: ["verify_password", "allow"] } },
    },
    { displayName: "Status Code", name: "statusCode", type: "number", default: OPTION_DEFAULTS.extensionsAction.statusCode, required: true, displayOptions: { show: { resource: ["respond"], operation: ["respond.toAuth"], authAction: ["challenge", "deny"] } } },
    { displayName: "Reason", name: "reason", type: "string", default: OPTION_DEFAULTS.common.string, required: true, displayOptions: { show: { resource: ["respond"], operation: ["respond.toAuth"], authAction: ["deny"] } } },
    {
      displayName: "Response Text",
      name: "outputText",
      type: "string",
      default: OPTION_DEFAULTS.common.string,
      required: true,
      description: "Text returned to the AI model as the function result.",
      displayOptions: { show: { resource: ["respond"], operation: ["respond.toAiTool"] } },
    },
    buildOptionsCollectionProperty({ show: { resource: ["respond"], operation: ["respond.toAuth", "respond.toAiTool"] } }, [buildIdOption("Request ID", "requestId")]),
    { displayName: "Target", name: "stopMediaTarget", type: "options", default: OPTION_DEFAULTS.stopMedia.target, required: true, displayOptions: { show: { resource: ["media"], operation: ["media.stopMedia"] } }, options: [{ name: "Media ID", value: "mediaId" }, { name: "Leg ID", value: "legId" }] },
    buildOptionsCollectionProperty({ show: { resource: ["media"], operation: ["media.stopMedia"], stopMediaTarget: ["mediaId"] } }, [
      buildIdOption("Media ID", "mediaId"),
    ]),
    buildOptionsCollectionProperty({ show: { resource: ["media"], operation: ["media.stopMedia"], stopMediaTarget: ["legId"] } }, [
      buildIdOption("Leg ID", "legId"),
    ]),
    { displayName: "Timeout (Seconds)", name: "waitMediaTimeoutSeconds", type: "number", default: OPTION_DEFAULTS.waitMedia.timeoutSeconds, displayOptions: { show: { resource: ["media"], operation: ["media.wait"] } } },
    {
      displayName: "Media IDs",
      name: "mediaIds",
      type: "fixedCollection",
      typeOptions: { multipleValues: true },
      default: OPTION_DEFAULTS.common.object,
      description: "Optional explicit wait target list. If empty, the node waits for the input mediaId, then input sipPbx.mediaId.",
      displayOptions: { show: { resource: ["media"], operation: ["media.wait"] } },
      options: [
        {
          name: "item",
          displayName: "Media ID",
          values: [{ displayName: "Media ID", name: "mediaId", type: "string", default: OPTION_DEFAULTS.common.string, required: true }],
        },
      ],
    },
    { displayName: "Digits", name: "dtmfDigits", type: "string", default: OPTION_DEFAULTS.common.string, required: true, displayOptions: { show: { resource: ["media"], operation: ["media.sendDtmf"] } } },
    ...buildInterruptPropertySet({
      interruptShow: { resource: ["media"], operation: ["media.recordAudio"] },
      allowedSelections: [INTERRUPT_SELECTION_DTMF, INTERRUPT_SELECTION_SILENCE],
      dependentSelection: INTERRUPT_SELECTION_SILENCE,
      dependentOptions: buildSilenceInterruptOptionEntries(),
      variants: [
        {
          show: { resource: ["media"], operation: ["media.recordAudio"], recordOutputType: ["binary", "file"], recordFileFormat: ["wav"] },
          baseOptions: buildRecordOptions({ includeHttp: false, fileFormat: "wav" }),
        },
        {
          show: { resource: ["media"], operation: ["media.recordAudio"], recordOutputType: ["http"], recordFileFormat: ["wav"] },
          baseOptions: buildRecordOptions({ includeHttp: true, fileFormat: "wav" }),
        },
        {
          show: { resource: ["media"], operation: ["media.recordAudio"], recordOutputType: ["binary", "file"], recordFileFormat: ["mp3", "opus", "ogg"] },
          baseOptions: buildRecordOptions({ includeHttp: false, fileFormat: "compressed" }),
        },
        {
          show: { resource: ["media"], operation: ["media.recordAudio"], recordOutputType: ["http"], recordFileFormat: ["mp3", "opus", "ogg"] },
          baseOptions: buildRecordOptions({ includeHttp: true, fileFormat: "compressed" }),
        },
      ],
    }),
    buildOptionsCollectionProperty({ show: { resource: ["media"], operation: ["media.sendDtmf"] } }, [
      buildIdOption("Leg ID", "legId"),
      { displayName: "Method", name: "dtmfMethod", type: "options", default: OPTION_DEFAULTS.sendDtmf.method, options: [{ name: "Auto", value: "auto" }, { name: "RFC2833", value: SIP_DTMF_METHOD_RFC2833 }, { name: "SIP INFO", value: SIP_DTMF_METHOD_INFO }, { name: "Inband", value: SIP_DTMF_METHOD_INBAND }] },
      { displayName: "Duration (ms)", name: "dtmfDurationMs", type: "number", default: OPTION_DEFAULTS.sendDtmf.durationMs },
      { displayName: "Gap (ms)", name: "dtmfGapMs", type: "number", default: OPTION_DEFAULTS.sendDtmf.gapMs },
    ]),
    { displayName: "Target", name: "queueStatsTarget", type: "options", default: OPTION_DEFAULTS.queueAction.statsTarget, required: true, displayOptions: { show: { resource: ["queue"], operation: ["queue.getStats"] } }, options: [{ name: "Queue Ref", value: "ref" }, { name: "Leg ID", value: "legId" }] },
    { displayName: "Queue Ref", name: "ref", type: "string", default: OPTION_DEFAULTS.common.string, required: true, displayOptions: { show: { resource: ["queue"], operation: ["queue.putLeg", "queue.getStats"] }, hide: { queueStatsTarget: ["legId"] } } },
    buildOptionsCollectionProperty({ show: { resource: ["queue"], operation: ["queue.putLeg"] } }, [
      buildIdOption("Leg ID", "legId"),
      { displayName: "Placement", name: "queuePlacement", type: "options", default: OPTION_DEFAULTS.queueAction.placement, options: [{ name: "Back", value: "back" }, { name: "Front", value: "front" }] },
      {
        displayName: "Rejoin Existing",
        name: "rejoinExisting",
        type: "boolean",
        default: OPTION_DEFAULTS.queueAction.rejoinExisting,
        description: "If a queue entry already exists for the same trunk and caller number and its original leg is gone, reuse it with the new leg instead of adding a separate entry. Typical use: caller hangs up while waiting, callback keeps the entry, caller calls back and lands on the same one.",
      },
      {
        displayName: "Retry Attempts",
        name: "retryAttempts",
        type: "number",
        default: OPTION_DEFAULTS.trigger.queue.retryAttempts,
        description: "Maximum number of retries after a failed dispatch before the entry goes to Offline branch.",
      },
      {
        displayName: "Retry Cooldown (Seconds)",
        name: "retryPauseSeconds",
        type: "number",
        default: OPTION_DEFAULTS.trigger.queue.retryPauseSeconds,
        description: "Delay between a failed dispatch and the next attempt.",
      },
      ...buildSipDialOptionEntries(),
    ]),
    {
      displayName: "Callback Enabled",
      name: "callbackEnabled",
      type: "boolean",
      default: OPTION_DEFAULTS.queueAction.callbackEnabled,
      description: "If enabled, when the caller hangs up the entry switches to callback mode and the next Dispatch arrives with mode=callback. If disabled, hanging up removes the entry from the queue.",
      displayOptions: { show: { resource: ["queue"], operation: ["queue.setCallback"] } },
    },
    buildOptionsCollectionProperty({ show: { resource: ["queue"], operation: ["queue.setCallback"] } }, [buildIdOption("Leg ID", "legId")]),
    buildOptionsCollectionProperty({ show: { resource: ["queue"], operation: ["queue.getStats"], queueStatsTarget: ["legId"] } }, [buildIdOption("Leg ID", "legId")]),
    buildOptionsCollectionProperty({ show: { resource: ["recording"], operation: ["recording.control"] } }, [buildIdOption("Leg ID", "legId")]),
    ...buildGlobalRecordingOptionsCollections({ resource: ["recording"], operation: ["recording.start"] }, buildIdOption("Leg ID", "legId"), false),
    ...buildGlobalRecordingOptionsCollections({ resource: ["respond"], operation: ["respond.toRecord"] }, buildIdOption("Request ID", "requestId"), true),
  ];
}

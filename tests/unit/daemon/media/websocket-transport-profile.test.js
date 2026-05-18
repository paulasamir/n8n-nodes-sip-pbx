"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("OpenAI websocket profile sends session.update and waits for session.updated", () => {
  const { createWebSocketTransportProfile } = require("../../../../build-src/daemon/media/transports/websocket-transport.js");

  const profile = createWebSocketTransportProfile({
    transportProfile: "openai_realtime",
    openaiRealtimeModel: "gpt-realtime",
    openaiRealtimeVoice: "marin",
    openaiRealtimeInstructions: "Be brief.",
    openaiRealtimePromptId: "pmpt_123",
    openaiRealtimePromptVersion: "7",
    openaiRealtimePromptVariablesJson: { caller: "100" },
  });

  assert.strictEqual(profile.name, "openai_realtime");
  assert.strictEqual(profile.inputSampleRate, 24000);
  assert.strictEqual(profile.outputSampleRate, 24000);

  const initialMessages = profile.buildInitialMessages();
  assert.strictEqual(initialMessages.length, 1);
  assert.deepStrictEqual(initialMessages[0], {
    type: "session.update",
    session: {
      type: "realtime",
      model: "gpt-realtime",
      output_modalities: ["audio"],
      audio: {
        input: {
          format: {
            type: "audio/pcm",
            rate: 24000,
          },
          turn_detection: {
            type: "server_vad",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          format: {
            type: "audio/pcm",
            rate: 24000,
          },
          voice: "marin",
        },
      },
      instructions: "Be brief.",
      prompt: {
        id: "pmpt_123",
        version: "7",
        variables: {
          caller: "100",
        },
      },
    },
  });

  assert.strictEqual(profile.isReadyEvent({ type: "session.created" }), false);
  assert.strictEqual(profile.isReadyEvent({ type: "session.updated" }), true);
  assert.strictEqual(profile.isReadyEvent({ type: "response.output_audio.delta" }), false);
  assert.deepStrictEqual(profile.handleEvent({ type: "response.audio.delta", delta: "AQID" }), [{
    type: "audio",
    audioBase64: "AQID",
    sampleRate: 24000,
    channels: 1,
    eventType: "response.audio.delta",
  }]);
});

test("OpenAI websocket profile enables input transcription only when a voice-agent transcript consumer requires it and extracts assistant transcript from response.done", () => {
  const { createWebSocketTransportProfile } = require("../../../../build-src/daemon/media/transports/websocket-transport.js");

  const profile = createWebSocketTransportProfile({
    transportProfile: "openai_realtime",
    openaiRealtimeModel: "gpt-realtime",
    openaiRealtimeVoice: "marin",
    openaiRealtimeInputTranscriptionModel: "gpt-realtime-whisper",
    voiceAgentNeedsInputTranscription: true,
  });

  assert.deepStrictEqual(profile.buildInitialMessages(), [{
    type: "session.update",
    session: {
      type: "realtime",
      model: "gpt-realtime",
      output_modalities: ["audio"],
      audio: {
        input: {
          format: {
            type: "audio/pcm",
            rate: 24000,
          },
          turn_detection: {
            type: "server_vad",
            create_response: true,
            interrupt_response: true,
          },
          transcription: {
            model: "gpt-realtime-whisper",
          },
        },
        output: {
          format: {
            type: "audio/pcm",
            rate: 24000,
          },
          voice: "marin",
        },
      },
    },
  }]);

  assert.deepStrictEqual(profile.handleVoiceAgentEvent({
    type: "response.done",
    response: {
      output: [{
        content: [{
          transcript: "The code word is KIWI-42.",
        }],
      }],
    },
  }), [{
    type: "assistant_transcript",
    eventType: "response.done",
    text: "The code word is KIWI-42.",
  }]);
  assert.deepStrictEqual(profile.handleVoiceAgentEvent({ type: "response.created" }), []);
  assert.deepStrictEqual(profile.handleVoiceAgentEvent({ type: "response.cancelled" }), []);

  const noTranscriptionProfile = createWebSocketTransportProfile({
    transportProfile: "openai_realtime",
    openaiRealtimeModel: "gpt-realtime",
    openaiRealtimeVoice: "marin",
    openaiRealtimeInputTranscriptionModel: "gpt-realtime-whisper",
    voiceAgentEnabled: true,
  });

  assert.deepStrictEqual(noTranscriptionProfile.buildInitialMessages(), [{
    type: "session.update",
    session: {
      type: "realtime",
      model: "gpt-realtime",
      output_modalities: ["audio"],
      audio: {
        input: {
          format: {
            type: "audio/pcm",
            rate: 24000,
          },
          turn_detection: {
            type: "server_vad",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          format: {
            type: "audio/pcm",
            rate: 24000,
          },
          voice: "marin",
        },
      },
    },
  }]);
});

test("Gemini Live websocket profile sends setup, maps audio output, and reports interruption", () => {
  const { createWebSocketTransportProfile } = require("../../../../build-src/daemon/media/transports/websocket-transport.js");

  const profile = createWebSocketTransportProfile({
    transportProfile: "gemini_live",
    geminiApiKey: "gemini-key",
    geminiLiveModel: "gemini-3.1-flash-live-preview",
    geminiLiveVoice: "Puck",
    geminiLiveInstructions: "Be brief.",
    geminiLiveApiVersion: "v1beta",
  });

  assert.strictEqual(profile.name, "gemini_live");
  assert.strictEqual(profile.resolveWebSocketUrl({ geminiLiveApiVersion: "v1beta" }), "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent");
  assert.deepStrictEqual(profile.resolveWebSocketHeaders({ geminiApiKey: "gemini-key" }), {
    "x-goog-api-key": "gemini-key",
  });
  const initialMessages = profile.buildInitialMessages();
  assert.strictEqual(initialMessages.length, 1);
  assert.ok(initialMessages[0].setup);
  assert.deepStrictEqual(profile.buildAudioAppendMessages("AQID"), [{
    realtimeInput: {
      audio: {
        mimeType: "audio/pcm;rate=16000",
        data: "AQID",
      },
    },
  }]);
  assert.strictEqual(profile.isReadyEvent({ setupComplete: {} }), true);
  assert.deepStrictEqual(profile.handleEvent({
    serverContent: {
      modelTurn: {
        parts: [{
          inlineData: {
            mimeType: "audio/pcm;rate=24000",
            data: "AQID",
          },
        }],
      },
    },
  }), [{
    type: "audio",
    audioBase64: "AQID",
    sampleRate: 24000,
    channels: 1,
    eventType: "serverContent.modelTurn.inlineData",
  }]);
  assert.deepStrictEqual(profile.handleEvent({
    serverContent: {
      interrupted: true,
    },
  }), [{
    type: "interrupt",
    reason: "media_voice",
    eventType: "serverContent.interrupted",
  }]);
});

test("Gemini Live websocket profile adds deferred voice-agent tools and transcript setup", () => {
  const { createWebSocketTransportProfile } = require("../../../../build-src/daemon/media/transports/websocket-transport.js");

  const profile = createWebSocketTransportProfile({
    transportProfile: "gemini_live",
    geminiLiveModel: "gemini-3.1-flash-live-preview",
    geminiLiveVoice: "Puck",
    geminiLiveInstructions: "Be brief.",
    voiceAgentEnabled: true,
    voiceAgentMemoryText: "Known profile: premium tier",
    voiceAgentToolsJson: [{
      name: "lookup_order",
      description: "Lookup order status",
      parameters: { type: "object", properties: { orderId: { type: "string" } } },
    }],
  });

  const initialMessages = profile.buildInitialMessages();
  assert.strictEqual(initialMessages.length, 1);
  assert.deepStrictEqual(initialMessages[0], {
    setup: {
      model: "models/gemini-3.1-flash-live-preview",
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Puck",
            },
          },
        },
      },
      systemInstruction: {
        parts: [{ text: "Be brief.\n\nMemory context:\nKnown profile: premium tier" }],
      },
      tools: [{
        functionDeclarations: [{
          name: "lookup_order",
          description: "Lookup order status",
          parameters: { type: "object", properties: { orderId: { type: "string" } } },
        }],
      }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  });
  assert.deepStrictEqual(profile.handleVoiceAgentEvent({
    toolCall: {
      functionCalls: [{
        id: "fc-1",
        name: "lookup_order",
        args: { orderId: "A-42" },
      }],
    },
  }), [{
    type: "tool_call",
    eventType: "toolCall.functionCalls",
    voiceAgentRequestId: "fc-1",
    toolName: "lookup_order",
    argumentsJson: "{\"orderId\":\"A-42\"}",
  }]);
  assert.deepStrictEqual(profile.handleVoiceAgentEvent({
    serverContent: {
      inputTranscription: { text: "Where is my order?" },
    },
  }), [{
    type: "user_transcript",
    eventType: "serverContent.inputTranscription",
    text: "Where is my order?",
  }]);
  assert.deepStrictEqual(profile.handleVoiceAgentEvent({
    serverContent: {
      outputTranscription: { text: "It is in transit." },
    },
  }), [{
    type: "assistant_transcript",
    eventType: "serverContent.outputTranscription",
    text: "It is in transit.",
  }]);
  assert.deepStrictEqual(profile.buildVoiceAgentToolResultMessages({
    voiceAgentRequestId: "fc-1",
    outputText: "{\"status\":\"in_transit\"}",
  }), [{
    toolResponse: {
      functionResponses: [{
        id: "fc-1",
        response: { status: "in_transit" },
      }],
    },
  }]);
  assert.deepStrictEqual(profile.buildVoiceAgentToolResultMessages({
    voiceAgentRequestId: "fc-2",
    outputText: "4",
  }), [{
    toolResponse: {
      functionResponses: [{
        id: "fc-2",
        response: { result: 4 },
      }],
    },
  }]);
});

test("websocket transport sendPlaybackPcm sends only requested bytes", async () => {
  const { WebSocketTransport } = require("../../../../build-src/daemon/media/transports/websocket-transport.js");

  const sentPayloads = [];
  const transport = new WebSocketTransport({
    async sendJson(payload) {
      sentPayloads.push(payload);
      return true;
    },
    config: {
      transportProfile: "generic",
      websocketConnected: true,
      websocketUrl: "wss://example.invalid/socket",
      websocketAudioInputEventType: "input_audio_buffer.append",
      websocketAudioInputField: "audio",
    },
  });

  await transport.configure({
    transportProfile: "generic",
    websocketConnected: true,
    websocketUrl: "wss://example.invalid/socket",
    websocketAudioInputEventType: "input_audio_buffer.append",
    websocketAudioInputField: "audio",
  });

  const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const sent = await transport.sendPlaybackPcm(pcm, false, 2);

  assert.equal(sent, true);
  assert.equal(sentPayloads.length, 1);
  assert.deepStrictEqual(sentPayloads[0], {
    type: "input_audio_buffer.append",
    audio: Buffer.from([0x01, 0x02]).toString("base64"),
  });
});

test("Gemini Live websocket profile forwards tool declarations as object JSON Schema", () => {
  const { createWebSocketTransportProfile } = require("../../../../build-src/daemon/media/transports/websocket-transport.js");

  const profile = createWebSocketTransportProfile({
    transportProfile: "gemini_live",
    geminiLiveModel: "gemini-3.1-flash-live-preview",
    geminiLiveVoice: "Puck",
    voiceAgentToolsJson: [{
      name: "Calculator",
      description: "Evaluate a basic arithmetic expression.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string" },
        },
        required: ["expression"],
        additionalProperties: false,
      },
    }],
  });

  assert.deepStrictEqual(profile.buildInitialMessages(), [{
    setup: {
      model: "models/gemini-3.1-flash-live-preview",
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Puck",
            },
          },
        },
      },
      tools: [{
        functionDeclarations: [{
          name: "Calculator",
          description: "Evaluate a basic arithmetic expression.",
          parameters: {
            type: "object",
            properties: {
              expression: { type: "string" },
            },
            required: ["expression"],
          },
        }],
      }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  }]);
});

test("Gemini Live websocket profile strips unsupported JSON Schema fields from tool declarations", () => {
  const { createWebSocketTransportProfile } = require("../../../../build-src/daemon/media/transports/websocket-transport.js");

  const profile = createWebSocketTransportProfile({
    transportProfile: "gemini_live",
    geminiLiveModel: "gemini-3.1-flash-live-preview",
    geminiLiveVoice: "Puck",
    voiceAgentToolsJson: [{
      name: "LookupOrder",
      description: "Lookup order status.",
      parameters: {
        type: "object",
        properties: {
          order: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        required: ["order"],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    }],
  });

  assert.deepStrictEqual(profile.buildInitialMessages(), [{
    setup: {
      model: "models/gemini-3.1-flash-live-preview",
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Puck",
            },
          },
        },
      },
      tools: [{
        functionDeclarations: [{
          name: "LookupOrder",
          description: "Lookup order status.",
          parameters: {
            type: "object",
            properties: {
              order: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
              },
            },
            required: ["order"],
          },
        }],
      }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  }]);
});

test("websocket transport does not auto-open deferred websocket sessions on playback", async () => {
  const { WebSocketTransport } = require("../../../../build-src/daemon/media/transports/websocket-transport.js");

  const sentPayloads = [];
  const transport = new WebSocketTransport({
    async sendJson(payload) {
      sentPayloads.push(payload);
      return true;
    },
    config: {
      transportProfile: "openai_realtime",
      websocketConnected: false,
      websocketUrl: "wss://api.openai.com/v1/realtime?model=gpt-realtime",
      websocketStartMode: "deferred",
      websocketSessionActivated: false,
    },
  });

  await transport.configure({
    transportProfile: "openai_realtime",
    websocketConnected: false,
    websocketUrl: "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    websocketStartMode: "deferred",
    websocketSessionActivated: false,
  });

  const sent = await transport.sendPlaybackPcm(Buffer.from([0x01, 0x02]), false, 2);

  assert.equal(sent, false);
  assert.deepStrictEqual(sentPayloads, []);
});

test("websocket transport flushes Uint8Array OpenAI audio delta into 20ms frames", async () => {
  const { WebSocketTransport } = require("../../../../build-src/daemon/media/transports/websocket-transport.js");

  const events = [];
  const transport = new WebSocketTransport({
    config: {
      transportProfile: "openai_realtime",
      websocketConnected: true,
      websocketUrl: "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    },
  });

  transport.subscribe((event) => {
    events.push(event);
  });

  const jsonBytes = new Uint8Array(Buffer.from(JSON.stringify({
    type: "response.output_audio.delta",
    delta: Buffer.from([0x01, 0x02, 0x03, 0x04]).toString("base64"),
  })));

  transport.ingestExternalPayload(jsonBytes);
  transport.ingestExternalPayload({ type: "response.done" });

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "audio");
  assert.deepStrictEqual(Array.from(events[0].pcm.subarray(0, 4)), [0x01, 0x02, 0x03, 0x04]);
  assert.equal(events[0].pcm.length, 960);
  assert.equal(events[0].bytes, 960);
  assert.equal(events[0].durationMs, 20);
  assert.equal(events[0].sampleRate, 24000);
  assert.equal(events[0].channels, 1);
  assert.equal(events[0].eventType, "response.output_audio.delta");
  assert.equal(typeof events[0].releasePool?.release, "function");
});

test("websocket transport drops queued OpenAI playback on response.cancelled", async () => {
  const { WebSocketTransport } = require("../../../../build-src/daemon/media/transports/websocket-transport.js");

  const events = [];
  const transport = new WebSocketTransport({
    config: {
      transportProfile: "openai_realtime",
      websocketConnected: true,
      websocketUrl: "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    },
  });

  transport.subscribe((event) => {
    events.push(event);
  });

  transport.ingestExternalPayload({
    type: "response.output_audio.delta",
    delta: Buffer.alloc(1920, 0x11).toString("base64"),
  });
  transport.ingestExternalPayload({ type: "response.cancelled" });

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(events.length, 0);
});

test("websocket transport splits OpenAI audio bursts into paced batches", async () => {
  const { WebSocketTransport } = require("../../../../build-src/daemon/media/transports/websocket-transport.js");

  const events = [];
  const transport = new WebSocketTransport({
    config: {
      transportProfile: "openai_realtime",
      websocketConnected: true,
      websocketUrl: "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    },
  });

  transport.subscribe((event) => {
    if (event.type === "audio") {
      events.push({ ...event, receivedAt: Date.now() });
    }
  });

  const frame = Buffer.alloc(960, 0x55);
  const burst = Buffer.concat([frame, frame, frame]);
  transport.ingestExternalPayload({
    type: "response.output_audio.delta",
    delta: burst.toString("base64"),
  });

  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(events.length, 2);
  assert.deepStrictEqual(events.map((event) => event.bytes), [1920, 960]);
  assert.ok(events[1].receivedAt - events[0].receivedAt >= 30);
});

test("websocket transport drops queued OpenAI playback immediately on speech_started", async () => {
  const { WebSocketTransport } = require("../../../../build-src/daemon/media/transports/websocket-transport.js");

  const audioEvents = [];
  const interruptEvents = [];
  const transport = new WebSocketTransport({
    config: {
      transportProfile: "openai_realtime",
      websocketConnected: true,
      websocketUrl: "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    },
  });

  transport.subscribe((event) => {
    if (event.type === "audio") {
      audioEvents.push(event);
      return;
    }
    if (event.type === "interrupt") {
      interruptEvents.push(event);
    }
  });

  const frame = Buffer.alloc(960, 0x55);
  const burst = Buffer.concat([frame, frame, frame]);
  transport.ingestExternalPayload({
    type: "response.output_audio.delta",
    delta: burst.toString("base64"),
  });
  transport.ingestExternalPayload({ type: "input_audio_buffer.speech_started" });

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(audioEvents.length, 0);
  assert.equal(interruptEvents.length, 1);
  assert.equal(interruptEvents[0].reason, "media_voice");
  assert.equal(interruptEvents[0].eventType, "input_audio_buffer.speech_started");
});

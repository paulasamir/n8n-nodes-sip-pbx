"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function loadAiActionsFresh() {
  const modulePath = require.resolve("../../../build-src/n8n/actions/ai-actions.js");
  delete require.cache[modulePath];
  return require(modulePath);
}

function loadSipPbxNodeFresh() {
  const modulePath = require.resolve("../../../build-src/n8n/nodes/SipPbx.node.js");
  delete require.cache[modulePath];
  return require(modulePath);
}

function writeMockLangChainPackage(baseDir, options) {
  const packageRoot = path.join(baseDir, "node_modules", "@langchain", "core");
  fs.mkdirSync(packageRoot, { recursive: true });
  const exportsField = {};
  if (options.messages) {
    exportsField["./messages"] = "./messages.js";
    fs.writeFileSync(path.join(packageRoot, "messages.js"), `
module.exports = {
  HumanMessage: class HumanMessage {
    constructor(fields) {
      this.kind = "human";
      this.kwargs = fields;
    }
  },
  AIMessage: class AIMessage {
    constructor(fields) {
      this.kind = "ai";
      this.kwargs = fields;
    }
  },
  ToolMessage: class ToolMessage {
    constructor(fields) {
      this.kind = "tool";
      this.kwargs = fields;
    }
  },
};
`.trimStart());
  }
  if (options.tools) {
    exportsField["./tools"] = "./tools.js";
    fs.writeFileSync(path.join(packageRoot, "tools.js"), `
module.exports = {
  DynamicStructuredTool: class DynamicStructuredTool {
    constructor(fields) {
      this.name = fields.name;
      this.description = fields.description;
      this.schema = fields.schema;
      this.func = fields.func;
    }
  },
};
`.trimStart());
  }
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@langchain/core",
      type: "commonjs",
      exports: exportsField,
    }, null, 2),
  );
}

async function withMockLangChainPackage(options, run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sip-pbx-langchain-"));
  const originalCwd = process.cwd();
  writeMockLangChainPackage(tempDir, options);
  process.chdir(tempDir);
  try {
    return await run();
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function withMockLangChainMessages(run) {
  return withMockLangChainPackage({ messages: true, tools: false }, run);
}

async function withMockLangChainTools(run) {
  return withMockLangChainPackage({ messages: false, tools: true }, run);
}

test("WebSocket transport profile UI exposes only active websocket profiles", async () => {
  const {
    applyWebSocketDialProfileInput,
    buildWebSocketDialTransportProfileProperty,
    buildWebSocketDialProfileProperties,
  } = require("../../../build-src/n8n/websocket-profiles/index.js");

  const property = buildWebSocketDialTransportProfileProperty({ resource: ["dial"], operation: ["dial.make"], callMode: ["websocket"] });
  const profileProperties = buildWebSocketDialProfileProperties({ resource: ["dial"], operation: ["dial.make"], callMode: ["websocket"] });
  const flatProperties = profileProperties.flatMap((entry) => Array.isArray(entry.options) ? entry.options : [entry]);

  assert.deepStrictEqual(
    property.options.map((option) => option.value),
    ["openai_realtime", "gemini_live", "generic"],
  );
  assert.ok(flatProperties.some((entry) => entry.name === "openAiApi" && entry.type === "credentials"));
  assert.ok(flatProperties.some((entry) => entry.name === "googlePalmApi" && entry.type === "credentials"));
});

test("SIP PBX node exposes dynamic loadOptions for OpenAI and Gemini model dropdowns", async () => {
  const { SipPbx } = loadSipPbxNodeFresh();
  const node = new SipPbx();
  const loadOptions = node.methods.loadOptions;

  const openAiRealtimeModels = await loadOptions.getOpenAiRealtimeModels.call({
    helpers: {
      httpRequestWithAuthentication: async (_credentialType, requestOptions) => {
        assert.equal(requestOptions.url, "https://api.openai.com/v1/models");
        return {
          data: [
            { id: "gpt-4.1-mini" },
            { id: "gpt-realtime" },
            { id: "gpt-4o-realtime-preview" },
            { id: "gpt-4o-mini-transcribe" },
          ],
        };
      },
    },
  });
  assert.deepStrictEqual(
    openAiRealtimeModels.map((option) => option.value),
    ["gpt-realtime", "gpt-4o-realtime-preview"],
  );

  const openAiTranscriptionModels = await loadOptions.getOpenAiRealtimeInputTranscriptionModels.call({
    helpers: {
      httpRequestWithAuthentication: async () => ({
        data: [
          { id: "gpt-realtime" },
          { id: "gpt-4o-transcribe" },
          { id: "gpt-4o-mini-transcribe" },
          { id: "whisper-1" },
        ],
      }),
    },
  });
  assert.deepStrictEqual(
    openAiTranscriptionModels.map((option) => option.value),
    ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"],
  );

  const geminiLiveModels = await loadOptions.getGeminiLiveModels.call({
    helpers: {
      httpRequestWithAuthentication: async (_credentialType, requestOptions) => {
        assert.equal(requestOptions.url, "https://generativelanguage.googleapis.com/v1beta/models");
        assert.deepStrictEqual(requestOptions.qs, { pageSize: 1000 });
        return {
          models: [
            { name: "models/gemini-3.1-flash", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-3.1-flash-live-preview", supportedGenerationMethods: ["bidiGenerateContent"] },
            { name: "models/gemini-2.5-flash-native-audio-preview-12-2025", supportedGenerationMethods: ["generateContent"] },
          ],
        };
      },
    },
  });
  assert.deepStrictEqual(
    geminiLiveModels.map((option) => option.value),
    ["gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-preview-12-2025"],
  );
});

test("WebSocket profile UI wires model fields to loadOptions dropdowns", async () => {
  const { buildWebSocketDialProfileProperties } = require("../../../build-src/n8n/websocket-profiles/index.js");
  const collections = buildWebSocketDialProfileProperties({ resource: ["dial"], operation: ["dial.make"], callMode: ["websocket"] });
  const properties = collections.flatMap((collection) => Array.isArray(collection.options) ? collection.options : []);
  const propertyByName = new Map(properties.map((property) => [property.name, property]));

  const openAiModel = propertyByName.get("openaiRealtimeModel");
  assert.equal(openAiModel.type, "options");
  assert.equal(openAiModel.typeOptions.loadOptionsMethod, "getOpenAiRealtimeModels");

  const openAiTranscriptionModel = propertyByName.get("openaiRealtimeInputTranscriptionModel");
  assert.equal(openAiTranscriptionModel.type, "options");
  assert.equal(openAiTranscriptionModel.typeOptions.loadOptionsMethod, "getOpenAiRealtimeInputTranscriptionModels");

  const geminiModel = propertyByName.get("geminiLiveModel");
  assert.equal(geminiModel.type, "options");
  assert.equal(geminiModel.typeOptions.loadOptionsMethod, "getGeminiLiveModels");
});

test("SIP PBX action node uses prefixed HTTP auth parameter names for media HTTP credentials", async () => {
  const { createSipPbxActionDescription } = require("../../../build-src/n8n/ui/action-description.js");
  const description = createSipPbxActionDescription();
  const properties = Array.isArray(description.properties) ? description.properties : [];

  const playbackAuthMode = properties.find((property) =>
    property.name === "playbackHttpAuthentication"
    && property.displayOptions?.show?.operation?.includes("media.playAudio")
    && property.displayOptions?.show?.sourceType?.includes("http"));
  const playbackPredefined = properties.find((property) =>
    property.name === "playbackHttpNodeCredentialType"
    && property.displayOptions?.show?.operation?.includes("media.playAudio")
    && property.displayOptions?.show?.sourceType?.includes("http")
    && property.displayOptions?.show?.playbackHttpAuthentication?.includes("predefinedCredentialType"));
  const playbackGeneric = properties.find((property) =>
    property.name === "playbackHttpGenericAuthType"
    && property.displayOptions?.show?.operation?.includes("media.playAudio")
    && property.displayOptions?.show?.sourceType?.includes("http")
    && property.displayOptions?.show?.playbackHttpAuthentication?.includes("genericCredentialType"));
  const recordAuthMode = properties.find((property) =>
    property.name === "recordHttpAuthentication"
    && property.displayOptions?.show?.operation?.includes("media.recordAudio")
    && property.displayOptions?.show?.recordOutputType?.includes("http"));
  const recordPredefined = properties.find((property) =>
    property.name === "recordHttpNodeCredentialType"
    && property.displayOptions?.show?.operation?.includes("media.recordAudio")
    && property.displayOptions?.show?.recordOutputType?.includes("http")
    && property.displayOptions?.show?.recordHttpAuthentication?.includes("predefinedCredentialType"));
  const recordGeneric = properties.find((property) =>
    property.name === "recordHttpGenericAuthType"
    && property.displayOptions?.show?.operation?.includes("media.recordAudio")
    && property.displayOptions?.show?.recordOutputType?.includes("http")
    && property.displayOptions?.show?.recordHttpAuthentication?.includes("genericCredentialType"));

  assert.ok(playbackAuthMode);
  assert.ok(playbackPredefined);
  assert.ok(playbackGeneric);
  assert.ok(recordAuthMode);
  assert.ok(recordPredefined);
  assert.ok(recordGeneric);
});

test("SIP PBX action node declares fixed direct and websocket credentials through description.credentials", async () => {
  const { createSipPbxActionDescription } = require("../../../build-src/n8n/ui/action-description.js");
  const description = createSipPbxActionDescription();
  const credentials = Array.isArray(description.credentials) ? description.credentials : [];

  const directCredential = credentials.find((entry) => entry.name === "sipPbxExternal");
  const openAiCredential = credentials.find((entry) => entry.name === "openAiApi");
  const geminiCredential = credentials.find((entry) => entry.name === "googlePalmApi");

  assert.ok(directCredential);
  assert.deepStrictEqual(directCredential.displayOptions?.show, {
    resource: ["dial"],
    operation: ["dial.make"],
    callMode: ["direct"],
  });

  assert.ok(openAiCredential);
  assert.deepStrictEqual(openAiCredential.displayOptions?.show, {
    resource: ["dial"],
    operation: ["dial.make"],
    callMode: ["websocket"],
    transportProfile: ["openai_realtime"],
  });

  assert.ok(geminiCredential);
  assert.deepStrictEqual(geminiCredential.displayOptions?.show, {
    resource: ["dial"],
    operation: ["dial.make"],
    callMode: ["websocket"],
    transportProfile: ["gemini_live"],
  });
});

test("WebSocket dial profile input rejects empty transportProfile instead of falling back implicitly", async () => {
  const { applyWebSocketDialProfileInput } = require("../../../build-src/n8n/websocket-profiles/index.js");

  const node = {
    getNodeParameter(name) {
      if (name === "transportProfile") return "";
      throw new Error(`Unexpected parameter ${name}`);
    },
  };

  await assert.rejects(
    () => applyWebSocketDialProfileInput(node, 0, {}),
    /Unsupported websocket transportProfile/,
  );
});

test("Make Call rejects empty callMode instead of falling back implicitly", async () => {
  const { executeMakeCall } = require("../../../build-src/n8n/actions/dial-actions.js");

  const node = {
    getNodeParameter(name) {
      if (name === "callMode") return "";
      throw new Error(`Unexpected parameter ${name}`);
    },
  };

  await assert.rejects(
    () => executeMakeCall(node, {}, 0),
    /callMode is required/,
  );
});

test("Make Call forwards websocketStartMode for websocket dials", async () => {
  const { executeMakeCall } = require("../../../build-src/n8n/actions/dial-actions.js");

  let capturedInput = null;
  const node = {
    getNodeParameter(name) {
      if (name === "callMode") return "websocket";
      if (name === "transportProfile") return "openai_realtime";
      if (name === "websocketStartMode") return "deferred";
      if (name === "dialOptions") {
        return {
          openaiRealtimeInputTranscriptionModel: "gpt-realtime-whisper",
        };
      }
      throw new Error(`Unexpected parameter ${name}`);
    },
    async getCredentials(name) {
      assert.strictEqual(name, "openAiApi");
      return {
        apiKey: "test-key",
      };
    },
  };

  const runtime = {
    async makeDial(input) {
      capturedInput = input;
      return { dialId: "dial-1", legId: "leg-1" };
    },
  };

  await executeMakeCall(node, runtime, 0);

  assert.equal(capturedInput.callMode, "websocket");
  assert.equal(capturedInput.transportProfile, "openai_realtime");
  assert.equal(capturedInput.websocketStartMode, "deferred");
  assert.equal(capturedInput.openaiRealtimeInputTranscriptionModel, "gpt-realtime-whisper");
});

test("Attach Voice Agent opens voiceAgent stream with memory and tools and handles stream events", async () => {
  const z = require("zod");
  await withMockLangChainMessages(async () => {
    const { executeAttachVoiceAgent } = loadAiActionsFresh();

    const savedMessageBatches = [];
    const toolExecutions = [];
    const respondedToolCalls = [];
    let capturedStreamConfig = null;
    const node = {
      getNodeParameter(name) {
        if (name === "legId") return "ws-leg-1";
        throw new Error(`Unexpected parameter ${name}`);
      },
      async getInputConnectionData(connectionType) {
        if (connectionType === "ai_memory") {
          return {
            chatHistory: {
              async addMessages(messages) {
                savedMessageBatches.push(messages);
              },
            },
            async loadMemoryVariables() {
              return {
                chat_history: [
                  { lc_kwargs: { type: "human", content: "Caller says they are premium." } },
                  { lc_kwargs: { type: "ai", content: "Acknowledge premium support routing." } },
                ],
              };
            },
          };
        }
        if (connectionType === "ai_tool") {
          return [{
            name: "lookup_order",
            description: "Lookup order status",
            schema: z.object({
              orderId: z.string(),
            }),
            async invoke(args) {
              toolExecutions.push(args);
              return { status: "in_transit" };
            },
          }];
        }
        return null;
      },
    };
    const runtime = {
      async openVoiceAgentStream(config, onEvent) {
        capturedStreamConfig = config;
        return {
          async close() {},
        };
      },
      async attachVoiceAgent() {
        await runtime._handler({
          branch: "ToolCall",
          payload: {
            legId: "ws-leg-1",
            voiceAgentRequestId: "tool-1",
            toolName: "lookup_order",
            argumentsJson: "{\"orderId\":\"A-42\"}",
          },
        });
        await runtime._handler({
          branch: "MemoryTurn",
          payload: {
            legId: "ws-leg-1",
            userText: "Where is order A-42?",
            assistantText: "I checked it for you.",
            toolCalls: [{
              voiceAgentRequestId: "tool-1",
              toolName: "lookup_order",
              argumentsJson: "{\"orderId\":\"A-42\"}",
              outputText: "{\"status\":\"in_transit\"}",
              isError: false,
            }],
          },
        });
        return { legId: "ws-leg-1", eventType: "ended" };
      },
      async respondVoiceAgentToolCall(input) {
        respondedToolCalls.push(input);
        return { voiceAgentRequestId: input.voiceAgentRequestId };
      },
      _handler: null,
    };
    runtime.openVoiceAgentStream = async (config, onEvent) => {
      capturedStreamConfig = config;
      runtime._handler = onEvent;
      return {
        async close() {},
      };
    };

    const result = await executeAttachVoiceAgent(node, runtime, { json: { legId: "ws-leg-1" } }, 0);

    assert.deepStrictEqual(capturedStreamConfig, {
      legId: "ws-leg-1",
      hasConnectedMemory: true,
      memoryText: "User: Caller says they are premium.\nAssistant: Acknowledge premium support routing.",
      needsInputTranscription: true,
      tools: [{
        name: "lookup_order",
        description: "Lookup order status",
        parameters: {
          type: "object",
          properties: {
            orderId: { type: "string" },
          },
          required: ["orderId"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
      }],
    });
    assert.deepStrictEqual(toolExecutions, [{ orderId: "A-42" }]);
    assert.deepStrictEqual(respondedToolCalls, [{
      voiceAgentRequestId: "tool-1",
      outputText: "{\"status\":\"in_transit\"}",
    }]);
    const normalizedSavedMessageBatches = savedMessageBatches.map((batch) => batch.map((message) => ({
      kind: message.kind,
      kwargs: message.kwargs,
    })));
    assert.deepStrictEqual(normalizedSavedMessageBatches, [
      [{
        kind: "human",
        kwargs: { content: "Where is order A-42?" },
      },
      {
        kind: "ai",
        kwargs: {
          content: "I checked it for you.",
          tool_calls: [{
            id: "tool-1",
            name: "lookup_order",
            args: { orderId: "A-42" },
            type: "tool_call",
          }],
        },
      },
      {
        kind: "tool",
        kwargs: {
          content: "{\"status\":\"in_transit\"}",
          tool_call_id: "tool-1",
          name: "lookup_order",
        },
      }],
    ]);
    assert.deepStrictEqual(result, {
      legId: "ws-leg-1",
      eventType: "ended",
    });
  });
});

test("Attach Voice Agent rejects more than one ai_memory connection", async () => {
  const { executeAttachVoiceAgent } = loadAiActionsFresh();

  const node = {
    getNodeParameter(name) {
      if (name === "legId") return "ws-leg-1";
      throw new Error(`Unexpected parameter ${name}`);
    },
    async getInputConnectionData(connectionType) {
      if (connectionType === "ai_memory") {
        return [
          { async loadMemoryVariables() { return { history: "A" }; } },
          { async loadMemoryVariables() { return { history: "B" }; } },
        ];
      }
      return null;
    },
  };
  const runtime = {
    async openVoiceAgentStream() {
      throw new Error("openVoiceAgentStream should not be called");
    },
  };

  await assert.rejects(
    () => executeAttachVoiceAgent(node, runtime, { json: { legId: "ws-leg-1" } }, 0),
    /at most one ai_memory connection/,
  );
});

test("Attach Voice Agent rejects ai_memory backends without native structured chat history support", async () => {
  await withMockLangChainMessages(async () => {
    const { executeAttachVoiceAgent } = loadAiActionsFresh();

    const node = {
      getNodeParameter(name) {
        if (name === "legId") return "ws-leg-1";
        throw new Error(`Unexpected parameter ${name}`);
      },
      async getInputConnectionData(connectionType) {
        if (connectionType === "ai_memory") {
          return {
            async loadMemoryVariables() {
              return { chat_history: [] };
            },
          };
        }
        return null;
      },
    };
    const runtime = {
      async openVoiceAgentStream() {
        throw new Error("openVoiceAgentStream should not be called");
      },
    };

    await assert.rejects(
      () => executeAttachVoiceAgent(node, runtime, { json: { legId: "ws-leg-1" } }, 0),
      /chatHistory\.addMessages/,
    );
  });
});

test("Attach Voice Agent declares ai_memory input with maxConnections=1 in node UI description", async () => {
  const { createSipPbxActionDescription } = require("../../../build-src/n8n/ui/action-description.js");

  const description = createSipPbxActionDescription();
  const inputsExpression = String(description.inputs || "");

  assert.match(inputsExpression, /type:\s*"ai_memory"/);
  assert.match(inputsExpression, /maxConnections:\s*1/);
});

test("AI actions expose optional AI Leg ID in Add Option collection", async () => {
  const { buildActionNodeProperties } = require("../../../build-src/n8n/ui/action-properties.js");

  const property = buildActionNodeProperties().find((entry) =>
    entry
    && entry.name === "aiOptions"
    && entry.displayOptions
    && entry.displayOptions.show
    && Array.isArray(entry.displayOptions.show.operation)
    && entry.displayOptions.show.operation.includes("ai.attachVoiceAgent"));

  assert.ok(property);
  assert.equal(property.displayName, "Options");
  assert.deepStrictEqual(property.options.map((option) => option.name), ["legId"]);
  assert.equal(property.options[0].displayName, "AI Leg ID");
  assert.equal(Boolean(property.options[0].required), false);
  assert.match(String(property.options[0].description || ""), /aiLegId first, then legId/i);
});

test("Attach Voice Agent does not stringify empty chat_history into memoryText", async () => {
  await withMockLangChainMessages(async () => {
    const { executeAttachVoiceAgent } = loadAiActionsFresh();

    let capturedStreamConfig = null;
    const node = {
      getNodeParameter(name) {
        if (name === "legId") return "ws-leg-1";
        throw new Error(`Unexpected parameter ${name}`);
      },
      async getInputConnectionData(connectionType) {
        if (connectionType === "ai_memory") {
          return {
            chatHistory: {
              async addMessages() {},
            },
            async loadMemoryVariables() {
              return { chat_history: [] };
            },
          };
        }
        return null;
      },
    };
    const runtime = {
      async openVoiceAgentStream(config) {
        capturedStreamConfig = config;
        return { async close() {} };
      },
      async attachVoiceAgent() {
        return { legId: "ws-leg-1", eventType: "ended" };
      },
    };

    await executeAttachVoiceAgent(node, runtime, { json: { legId: "ws-leg-1" } }, 0);

    assert.deepStrictEqual(capturedStreamConfig, {
      legId: "ws-leg-1",
      hasConnectedMemory: true,
      needsInputTranscription: true,
    });
  });
});

test("AI invokeTool supplies a structured AI tool and routes invocations through runtime.invokeAiTool", async () => {
  await withMockLangChainTools(async () => {
    const { supplyAiTool } = require("../../../build-src/n8n/actions/ai-actions.js");

    const invocations = [];
    const node = {
      getNodeParameter(name) {
        if (name === "ref") return "support_lookup";
        if (name === "aiToolDescription") return "Lookup support context";
        if (name === "aiFlowParams") {
          return {
            item: [
              { name: "tenantId", value: "t-1" },
              { name: "channel", value: "voice" },
            ],
          };
        }
        if (name === "aiToolParams") {
          return {
            item: [
              { name: "orderId", type: "string", description: "Order ID", required: true },
              { name: "priority", type: "boolean", description: "Priority lookup", required: false },
            ],
          };
        }
        throw new Error(`Unexpected parameter ${name}`);
      },
      getNode() {
        return { name: "Support Lookup" };
      },
    };
    const runtime = {
      async invokeAiTool(input) {
        invocations.push(input);
        return { outputText: "Lookup complete" };
      },
    };

    const supplied = await supplyAiTool(node, runtime, 0);

    assert.ok(supplied && supplied.response);
    assert.equal(supplied.response.name, "Support_Lookup");
    assert.equal(supplied.response.description, "Lookup support context");
    assert.equal(typeof supplied.response.invokeForSipPbx, "function");

    const result = await supplied.response.invokeForSipPbx(
      { orderId: "A-42", priority: true },
      { aiLegId: "ws-leg-1" },
    );

    assert.equal(result, "Lookup complete");
    assert.deepStrictEqual(invocations, [{
      ref: "support_lookup",
      aiLegId: "ws-leg-1",
      flowParams: {
        tenantId: "t-1",
        channel: "voice",
      },
      toolParams: {
        orderId: "A-42",
        priority: true,
      },
    }]);
  });
});

test("AI invokeTool rejects duplicate AI flow parameter names", async () => {
  await withMockLangChainTools(async () => {
    const { supplyAiTool } = require("../../../build-src/n8n/actions/ai-actions.js");

    const node = {
      getNodeParameter(name) {
        if (name === "ref") return "support_lookup";
        if (name === "aiToolDescription") return "Lookup support context";
        if (name === "aiFlowParams") {
          return {
            item: [
              { name: "tenantId", value: "t-1" },
              { name: "tenantId", value: "t-2" },
            ],
          };
        }
        if (name === "aiToolParams") return {};
        throw new Error(`Unexpected parameter ${name}`);
      },
      getNode() {
        return { name: "Support Lookup" };
      },
    };

    await assert.rejects(
      () => supplyAiTool(node, { invokeAiTool() { throw new Error("should not run"); } }, 0),
      /AI flow parameter names must be unique/i,
    );
  });
});

test("AI invokeTool rejects duplicate AI tool parameter names", async () => {
  await withMockLangChainTools(async () => {
    const { supplyAiTool } = require("../../../build-src/n8n/actions/ai-actions.js");

    const node = {
      getNodeParameter(name) {
        if (name === "ref") return "support_lookup";
        if (name === "aiToolDescription") return "Lookup support context";
        if (name === "aiFlowParams") return {};
        if (name === "aiToolParams") {
          return {
            item: [
              { name: "orderId", type: "string", description: "Order ID", required: true },
              { name: "orderId", type: "string", description: "Second Order ID", required: false },
            ],
          };
        }
        throw new Error(`Unexpected parameter ${name}`);
      },
      getNode() {
        return { name: "Support Lookup" };
      },
    };

    await assert.rejects(
      () => supplyAiTool(node, { invokeAiTool() { throw new Error("should not run"); } }, 0),
      /AI tool parameter names must be unique/i,
    );
  });
});

test("Attach Voice Agent unwraps SIP PBX ai_tool supplyData response wrappers", async () => {
  await withMockLangChainMessages(async () => {
    const { executeAttachVoiceAgent } = loadAiActionsFresh();

    let capturedStreamConfig = null;
    const invocations = [];
    const node = {
      getNodeParameter(name) {
        if (name === "legId") return "ws-leg-1";
        throw new Error(`Unexpected parameter ${name}`);
      },
      async getInputConnectionData(connectionType) {
        if (connectionType === "ai_tool") {
          return [{
            response: {
              name: "support_lookup",
              description: "Lookup support context",
              parameters: {
                type: "object",
                properties: {
                  orderId: { type: "string" },
                },
                required: ["orderId"],
              },
              async invokeForSipPbx(args, context) {
                invocations.push({ args, context });
                return "Lookup complete";
              },
            },
          }];
        }
        return null;
      },
    };
    const runtime = {
      async openVoiceAgentStream(config, onEvent) {
        capturedStreamConfig = config;
        runtime._handler = onEvent;
        return { async close() {} };
      },
      async attachVoiceAgent() {
        await runtime._handler({
          branch: "ToolCall",
          payload: {
            legId: "ws-leg-1",
            voiceAgentRequestId: "tool-1",
            toolName: "support_lookup",
            argumentsJson: "{\"orderId\":\"A-42\"}",
          },
        });
        return { legId: "ws-leg-1", eventType: "ended" };
      },
      async respondVoiceAgentToolCall() {
        return { voiceAgentRequestId: "tool-1" };
      },
      _handler: null,
    };

    await executeAttachVoiceAgent(node, runtime, { json: { legId: "ws-leg-1" } }, 0);

    assert.deepStrictEqual(capturedStreamConfig, {
      legId: "ws-leg-1",
      tools: [{
        name: "support_lookup",
        description: "Lookup support context",
        parameters: {
          type: "object",
          properties: {
            orderId: { type: "string" },
          },
          required: ["orderId"],
        },
      }],
    });
    assert.deepStrictEqual(invocations, [{
      args: { orderId: "A-42" },
      context: { aiLegId: "ws-leg-1" },
    }]);
  });
});

test("AI invokeTool action description is tool-only and AI tool trigger description exposes Request output", async () => {
  const { createSipPbxActionDescription } = require("../../../build-src/n8n/ui/action-description.js");
  const { createSipPbxTriggerDescription } = require("../../../build-src/n8n/ui/trigger-description.js");
  const { buildActionNodeProperties } = require("../../../build-src/n8n/ui/action-properties.js");
  const { buildTriggerNodeProperties } = require("../../../build-src/n8n/ui/trigger-properties.js");

  const actionDescription = createSipPbxActionDescription();
  const triggerDescription = createSipPbxTriggerDescription();
  const actionProperties = buildActionNodeProperties();
  const aiRefProperty = buildTriggerNodeProperties().find((entry) =>
    entry
    && entry.name === "ref"
    && entry.displayOptions
    && entry.displayOptions.show
    && Array.isArray(entry.displayOptions.show.triggerOn)
    && entry.displayOptions.show.triggerOn.includes("aiTool"));
  const resourceProperty = actionProperties.find((entry) => entry && entry.name === "resource");

  assert.equal(actionDescription.usableAsTool, true);
  assert.match(String(actionDescription.inputs || ""), /operation === "ai\.invokeAiTool"[\s\S]*return \[\]/);
  assert.match(String(actionDescription.outputs || ""), /operation === "ai\.invokeAiTool"[\s\S]*type:\s*"ai_tool"/);
  assert.match(String(triggerDescription.outputs || ""), /triggerOn === "aiTool"[\s\S]*displayName:\s*"Request"/);
  assert.ok(resourceProperty);
  assert.deepStrictEqual(resourceProperty.options.map((entry) => entry.value), ["call", "dial", "media", "queue", "ai", "respond"]);
  const aiOperationProperty = actionProperties.find((entry) =>
    entry
    && entry.name === "operation"
    && entry.displayOptions
    && entry.displayOptions.show
    && Array.isArray(entry.displayOptions.show.resource)
    && entry.displayOptions.show.resource.includes("ai"));
  assert.ok(aiOperationProperty);
  assert.ok(aiOperationProperty.options.some((entry) => entry.value === "ai.invokeAiTool"));
  assert.ok(aiRefProperty);
  assert.equal(aiRefProperty.displayName, "AI Tool Ref");
  assert.equal(aiRefProperty.required, true);
});

test("media action outputs always expose Interrupted for blocking media, with infinite tone as interrupt-only", async () => {
  const { createSipPbxActionDescription } = require("../../../build-src/n8n/ui/action-description.js");

  const actionDescription = createSipPbxActionDescription();
  const outputsExpression = String(actionDescription.outputs || "");

  assert.match(outputsExpression, /operation === "media\.playTone" && \$parameter\["repeatInfinite"\][\s\S]*displayName: "Interrupted"/);
  assert.match(outputsExpression, /operation === "media\.playAudio" \|\| operation === "media\.playTone" \|\| operation === "media\.recordAudio"/);
  assert.match(outputsExpression, /return \[\{ type: "main", displayName: "Interrupted" \}, \{ type: "main", displayName: "Completed" \}\];/);
  assert.doesNotMatch(outputsExpression, /const hasInterruptOutput = Boolean\(/);
  assert.doesNotMatch(outputsExpression, /\$parameter\["interruptOnDtmf"\]/);
  assert.doesNotMatch(outputsExpression, /\$parameter\["interruptOnVoice"\]/);
  assert.doesNotMatch(outputsExpression, /\$parameter\["interruptOnSilence"\]/);
});

test("extension dial options use distinct child property objects from trunk/direct dial options", async () => {
  const { buildActionNodeProperties } = require("../../../build-src/n8n/ui/action-properties.js");

  const actionProperties = buildActionNodeProperties();
  const trunkDirectDialOptions = actionProperties.find((entry) =>
    entry
    && entry.name === "dialOptions"
    && entry.displayOptions?.show
    && Array.isArray(entry.displayOptions.show.callMode)
    && entry.displayOptions.show.callMode.length === 2
    && entry.displayOptions.show.callMode.includes("trunk")
    && entry.displayOptions.show.callMode.includes("direct"));
  const extensionDialOptions = actionProperties.find((entry) =>
    entry
    && entry.name === "dialOptions"
    && entry.displayOptions?.show
    && Array.isArray(entry.displayOptions.show.callMode)
    && entry.displayOptions.show.callMode.length === 1
    && entry.displayOptions.show.callMode[0] === "extension");

  assert.ok(trunkDirectDialOptions);
  assert.ok(extensionDialOptions);
  assert.notStrictEqual(trunkDirectDialOptions.options, extensionDialOptions.options);
  assert.notStrictEqual(trunkDirectDialOptions.options[0], extensionDialOptions.options[0]);
  assert.notStrictEqual(trunkDirectDialOptions.options[1], extensionDialOptions.options[1]);
  assert.notStrictEqual(trunkDirectDialOptions.options[2], extensionDialOptions.options[2]);
});

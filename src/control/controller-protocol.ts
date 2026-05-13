export const ControllerMethod = {
  health: "health",
  stopDaemon: "stopDaemon",
  executeAction: "executeAction",
  invokeAiTool: "invokeAiTool",
  respondVoiceAgentToolCall: "respondVoiceAgentToolCall",
  getRetentionSnapshot: "getRetentionSnapshot",
} as const;

export type ControllerMethod = typeof ControllerMethod[keyof typeof ControllerMethod];

export const TriggerStreamKind = {
  trunk: "trunk",
  extensions: "extensions",
  queue: "queue",
  aiTool: "aiTool",
  voiceAgent: "voiceAgent",
} as const;

export type TriggerStreamKind = typeof TriggerStreamKind[keyof typeof TriggerStreamKind];

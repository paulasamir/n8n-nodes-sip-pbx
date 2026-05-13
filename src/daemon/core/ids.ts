let idCounter = 0;

function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function newDialId(): string {
  return newId("dial");
}

export function newLegId(): string {
  return newId("leg");
}

export function newMediaId(): string {
  return newId("media");
}

export function newAuthRequestId(): string {
  return newId("auth");
}

export function newRecordRequestId(): string {
  return newId("record");
}

export function newQueueEntryId(): string {
  return newId("queue_entry");
}

export function newQueueRequestId(): string {
  return newId("queue_request");
}

export function newAiToolRequestId(): string {
  return newId("ai_tool_request");
}

export function newTriggerKey(kind: string, ref: string): string {
  return newId(`${kind}_${ref || "trigger"}`);
}

export function newSocketId(): string {
  return newId("socket");
}

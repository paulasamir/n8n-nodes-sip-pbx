type OrderedTriggerStream = {
  kind: "trunk" | "extensions" | "queue";
  ref: string;
  triggerKey: string;
};

export function compareTriggerStreams(
  a: Pick<OrderedTriggerStream, "kind" | "ref" | "triggerKey">,
  b: Pick<OrderedTriggerStream, "kind" | "ref" | "triggerKey">,
): number {
  const kindCompare = String(a.kind).localeCompare(String(b.kind));
  if (kindCompare !== 0) {
    return kindCompare;
  }
  const refCompare = String(a.ref).localeCompare(String(b.ref));
  if (refCompare !== 0) {
    return refCompare;
  }
  return String(a.triggerKey).localeCompare(String(b.triggerKey));
}

/** Array → trimmed non-empty entries; anything else → split on commas, then same. */
export function normalizeStringList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value || "").trim()).filter(Boolean);
  }
  const text = String(raw || "").trim();
  if (!text) {
    return [];
  }
  return text.split(",").map((value) => value.trim()).filter(Boolean);
}

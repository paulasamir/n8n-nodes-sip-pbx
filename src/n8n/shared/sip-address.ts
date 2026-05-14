export function extractSipUser(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const uriMatch = raw.match(/<([^>]+)>/);
  const uri = String(uriMatch ? uriMatch[1] : raw).trim();
  const sipMatch = uri.match(/^sips?:([^@;>]+)/i);
  if (sipMatch) {
    return decodeURIComponent(String(sipMatch[1] || "").trim());
  }
  const atIndex = uri.indexOf("@");
  if (atIndex > 0) {
    return uri.slice(0, atIndex).trim();
  }
  return uri;
}

export function extractSipDisplayName(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const quoted = raw.match(/^"([^"]*)"\s*</);
  if (quoted) {
    return String(quoted[1] || "").trim();
  }
  const angleIndex = raw.indexOf("<");
  if (angleIndex > 0) {
    return raw.slice(0, angleIndex).trim();
  }
  return "";
}

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX32_RE = /([a-f0-9]{32})/;

function formatUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function extractPageId(input: string): string {
  const trimmed = input.trim();

  if (UUID_RE.test(trimmed)) {
    return trimmed;
  }

  const plain = trimmed.replace(/-/g, "");
  if (/^[a-f0-9]{32}$/.test(plain)) {
    return formatUuid(plain);
  }

  // Try extracting from URL — take the last 32 hex chars
  const urlClean = trimmed.split("?")[0].split("#")[0];
  const match = urlClean.match(HEX32_RE);
  if (match) {
    return formatUuid(match[1]);
  }

  throw new Error(`Cannot extract Notion page ID from: ${input}`);
}

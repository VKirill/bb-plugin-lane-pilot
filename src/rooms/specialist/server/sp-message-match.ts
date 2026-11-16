type Row = Record<string, unknown>;

export type MessageMatchResult = Row & {
  ok: true;
  min_score: number;
  mismatches: number;
  price_mismatch: boolean;
};

export function messageMatchSource(params: Row): { capturePath: string; args: Row } {
  const capturePath = typeof params.capture === "string" ? params.capture : "";
  const target = typeof params.target === "string" ? params.target : params.target === null || params.target === undefined ? "" : String(params.target);
  return {
    capturePath,
    args: {
      ads: params.ads,
      landing: capturePath || { url: target, h1: target, title: target, first_screen: target },
      threshold: typeof params.minLemmaOverlap === "number" ? params.minLemmaOverlap : 0.5,
    },
  };
}

export function parseMessageMatchCapture(storedCapture: string | null, capturePath: string): Row {
  let parsed: unknown;
  try {
    parsed = typeof storedCapture === "string" ? JSON.parse(storedCapture) : undefined;
  } catch {
    parsed = undefined;
  }
  const envelope = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Row) : null;
  const data = envelope?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`sp.message_match: persisted capture is not a valid data/text envelope (${capturePath})`);
  }
  const captureData = { ...(data as Row) };
  if (typeof captureData.first_screen !== "string" || !captureData.first_screen.trim()) {
    if (typeof envelope.text === "string" && envelope.text.trim()) captureData.first_screen = envelope.text;
  }
  return captureData;
}

export function parseMessageMatchResult(raw: Row): MessageMatchResult | null {
  if (
    raw.ok !== true ||
    typeof raw.min_score !== "number" ||
    typeof raw.mismatches !== "number" ||
    !Number.isInteger(raw.mismatches) ||
    typeof raw.price_mismatch !== "boolean"
  ) return null;
  return raw as MessageMatchResult;
}

export function requireMessageMatchResult(raw: Row): MessageMatchResult {
  const result = parseMessageMatchResult(raw);
  if (result) return result;
  const detail = typeof raw.error === "string" ? `: ${raw.error}` : "";
  throw new Error(`sp.message_match: script returned an invalid result${detail}`);
}

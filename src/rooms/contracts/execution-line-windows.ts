const WINDOW_RE = /L?~?(\d+)\s*[-–—]\s*L?~?(\d+)/gi;
const MAX_WINDOWS = 8;

export type LineWindow = { startLine: number; endLine: number };
export type PathWindows = { path: string; windows: LineWindow[] };

export function parseExecutionLineWindows(raw: string): PathWindows {
  const text = raw.trim();
  if (!text) return { path: "", windows: [] };
  // Line windows start after a separator («file.md:10-20», «file.md#L10-L20», «file.md 10-20»). Without one,
  // digits belong to the path: «.agents/plans/2026-10-02-cards.md» is a file, not «.agents/plans/» lines 2026-10.
  const start = /[:#\s]+(?=L?~?\d+\s*[-–—]\s*L?~?\d+)/i.exec(text);
  const path = start ? text.slice(0, start.index).trim() : text;
  const tail = start ? text.slice(start.index) : "";
  const windows: LineWindow[] = [];
  WINDOW_RE.lastIndex = 0;
  for (const match of tail.matchAll(WINDOW_RE)) {
    const startLine = Number(match[1]);
    const endLine = Number(match[2]);
    if (startLine < 1 || endLine < startLine) continue;
    windows.push({ startLine, endLine });
    if (windows.length === MAX_WINDOWS) break;
  }
  return { path: path.replace(/[,:;]+$/, ""), windows };
}

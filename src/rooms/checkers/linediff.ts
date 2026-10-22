/** Lines of a text (a trailing newline does not make an empty last line). */
export function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const MAX_CELLS = 4_000_000;

/**
 * The lines of `after` (1-based, inclusive ranges) that are not in `before`: common head and tail are trimmed, the middle is compared by
 * longest common subsequence. A middle too large for that counts as all changed. A new file is `[[1, n]]`.
 */
export function changedRanges(before: string | null, after: string): Array<[number, number]> {
  const b = before === null ? [] : linesOf(before), a = linesOf(after);
  let head = 0;
  while (head < b.length && head < a.length && b[head] === a[head]) head++;
  let tail = 0;
  while (tail < b.length - head && tail < a.length - head && b[b.length - 1 - tail] === a[a.length - 1 - tail]) tail++;
  const mb = b.slice(head, b.length - tail), ma = a.slice(head, a.length - tail);
  const kept = new Set<number>();
  if (mb.length && ma.length && mb.length * ma.length <= MAX_CELLS) {
    const width = ma.length + 1;
    const table = new Uint32Array((mb.length + 1) * width);
    for (let i = mb.length - 1; i >= 0; i--) for (let j = ma.length - 1; j >= 0; j--) {
      table[i * width + j] = mb[i] === ma[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
    for (let i = 0, j = 0; i < mb.length && j < ma.length;) {
      if (mb[i] === ma[j]) { kept.add(j); i++; j++; } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++; else j++;
    }
  }
  const ranges: Array<[number, number]> = [];
  for (let j = 0; j < ma.length; j++) {
    if (kept.has(j)) continue;
    const line = head + j + 1, last = ranges[ranges.length - 1];
    if (last && last[1] === line - 1) last[1] = line; else ranges.push([line, line]);
  }
  // A pure deletion leaves no new line: the line it sits at counts as changed (the same rule as plan-fact's diff reader).
  if (!ranges.length && before !== null && before !== after) {
    const at = Math.min(Math.max(head, 1), Math.max(a.length, 1));
    ranges.push([at, at]);
  }
  return ranges;
}

/** The numbers of the added lines (those in `changedRanges` that exist in `after`), in order. */
export function addedLineNumbers(before: string | null, after: string): number[] {
  if (before === after) return [];
  const count = linesOf(after).length, out: number[] = [];
  for (const [from, to] of changedRanges(before, after)) for (let line = from; line <= Math.min(to, count); line++) out.push(line);
  return out;
}

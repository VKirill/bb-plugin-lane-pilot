/**
 * Declared wires (SMA atlas D2-4: «wires», rule 2 «a setting that reaches nothing is a defect», «Declared wire inventory»). A task contract
 * may declare that a value travels a chain of identifiers (`wires: [{chain: ["ui.theme", "loadSettings", "ThemeProvider"]}]`). The
 * check is the same for every chain and needs no index: each pair of neighbours must meet in one source file of the finished work (a
 * file that names both), tests excluded, since a test that names both proves nothing about the product. The first hop that meets nowhere
 * is where the wire is broken.
 */
export type Wire = { chain: readonly string[]; why?: string | undefined };
export type WireHop = { from: string; to: string; file: string | null };
export type WireResult = { chain: string[]; why: string | null; hops: WireHop[]; broken: WireHop | null };

export const WIRE_MARK = "__lp_wire__";
const q = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
/** Paths a hop may not meet in: tests and specs. */
const EXCLUDE = ["*test*", "*spec*", "*__tests__*", "*fixtures*"].map((glob) => q(`:(exclude)${glob}`)).join(" ");

/** One shell command for every hop of every wire, run in the task's worktree: one marked line per hop with the first file both names are in. */
export function wiresCommand(wires: readonly Wire[]): string {
  const lines: string[] = [];
  wires.forEach((wire, index) => {
    for (let hop = 0; hop + 1 < wire.chain.length; hop++) {
      const from = wire.chain[hop]!, to = wire.chain[hop + 1]!;
      lines.push(`echo "${WIRE_MARK} ${index} ${hop} $(git grep --untracked -l -F -e ${q(from)} -- . ${EXCLUDE} 2>/dev/null | while IFS= read -r f; do grep -q -F -e ${q(to)} "$f" && { printf '%s' "$f"; break; }; done)"`);
    }
  });
  return lines.join("; ");
}

/** The result of each wire from the command's output; a hop with no line in the output counts as not met. */
export function readWires(wires: readonly Wire[], output: string): WireResult[] {
  const found = new Map<string, string>();
  for (const line of output.split("\n")) {
    const hit = new RegExp(`^${WIRE_MARK} (\\d+) (\\d+) ?(.*)$`).exec(line.trim());
    if (hit) found.set(`${hit[1]}:${hit[2]}`, hit[3]!.trim());
  }
  return wires.map((wire, index) => {
    const hops = wire.chain.slice(0, -1).map((from, hop): WireHop => ({ from, to: wire.chain[hop + 1]!, file: found.get(`${index}:${hop}`) || null }));
    return { chain: [...wire.chain], why: wire.why ?? null, hops, broken: hops.find((hop) => hop.file === null) ?? null };
  });
}

/** The refusal reason of the first broken wire, or null. */
export function brokenWireReason(results: readonly WireResult[]): string | null {
  const broken = results.find((result) => result.broken);
  if (!broken) return null;
  return `plan_fact_wire_broken: ${broken.chain.join(" -> ")} stops between «${broken.broken!.from}» and «${broken.broken!.to}» (no source file names both)`;
}

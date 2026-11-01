import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The owner's list is read by a person who does not program (the owner, 2026-11-01). A row's title (`what`) says what happened in words;
 * the ids of runs, ticks, branches, tasks and threads go into `evidence`, never into the title. This scans every `postOwnerItem` call.
 */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}
const ID_IN_TEMPLATE = /\$\{[^}]*(?:roadId|tickId|runId|taskId|threadId|attemptId|phaseId|\brow\.id\b|\brun\.id\b|\btick\.id\b|\bphase\.id\b|\.task_id\b|\.run_id\b)\b[^}]*\}/;

describe("the rows on «Ждут владельца»", () => {
  it("never carry an id in the title: ids are evidence", () => {
    const offenders: string[] = [];
    for (const file of sources("src")) {
      const text = readFileSync(file, "utf8");
      let at = text.indexOf("postOwnerItem(");
      while (at >= 0) {
        const call = text.slice(at, at + 1200);
        const what = /\bwhat:\s*([^\n]*)/.exec(call)?.[1] ?? "";
        if (ID_IN_TEMPLATE.test(what)) offenders.push(`${file}: ${what.slice(0, 140)}`);
        at = text.indexOf("postOwnerItem(", at + 1);
      }
    }
    expect(offenders).toEqual([]);
  });
});

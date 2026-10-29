import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// SMA block 4 (P0-3): the drill scenario memory_paths is red when any registered memory path does not deliver the planted token.
const drill = fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url));

const tokens = { note: "lpprobeab12cd34n", core: "lpprobeab12cd34c", rule: "lpprobeab12cd34r" };
const row = (path: string, patch: Record<string, unknown> = {}) => ({ path, found: true, negativeOk: true, latencyMs: 3, detail: "all found", ...patch });
const report = (results: unknown[]) => ({ ok: true, token: "ab12cd34", lpVersion: "0.1.265", tokens, problems: [], results, skipped: [], unanswered: { ownerRepeats: 0 } });

/** Runs scenario_memory_paths against a fake `bb` and `ssh`; `writerHas` is what the writer thread's log holds. */
function runScenario(probe: unknown, opts: { pmHas?: string; writerHas?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "lp-drill-memory-"));
  const script = (name: string, body: string) => { writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`); chmodSync(join(dir, name), 0o755); };
  script("bb", `case "$1 $2" in
  "lane-pilot memory-probe") case "$*" in *--clean*) echo '{"removed":3}' ;; *) cat <<'JSON'
${JSON.stringify(probe)}
JSON
  ;; esac ;;
  "lane-pilot dispatch-bb") echo '{"ok":true}' ;;
  "lane-pilot cancel") echo '{}' ;;
  "thread log") case "$3" in thr_pm) echo '${opts.pmHas ?? ""}' ;; thr_w) echo '${opts.writerHas ?? ""}' ;; esac ;;
  *) echo "unexpected: $*" >&2; exit 5 ;;
esac`);
  script("ssh", `echo '[{"id":"att1","task_id":"t","state":"running","reason":null,"thread_id":"thr_w","workspace_path":null,"environment_id":null,"holder_thread_id":null,"created_at":1}]'`);
  const code = `
import importlib.util, json, types
from pathlib import Path
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drill)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
ctx = types.SimpleNamespace(project="proj_x", run_id="lprun_x", pm="thr_pm", cwd="/tmp/x", dispatches={}, memory_probe=None)
ctx.dispatch = lambda s: True
ctx.rows = lambda ids: m.hubsql("x")
ctx.quiet = lambda: None
ctx.memory_probe = m.plant_memory_probe()
print(json.dumps(m.scenario_memory_paths(ctx)))
`;
  const res = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, BB_CLI: join(dir, "bb") } });
  const line = res.stdout.trim().split("\n").pop() ?? "";
  return { res, verdict: line.startsWith("{") ? JSON.parse(line) as { result: string; problems: string[] } : null };
}

const allTokens = `prompt ${tokens.note} ${tokens.core} ${tokens.rule}`;
const green = [row("writer.brief"), row("pm.start"), row("critic.code")];

describe("the drill's memory_paths scenario", () => {
  it("passes when every path delivers and the real PM prompt and writer brief carry the tokens", () => {
    const { verdict, res } = runScenario(report(green), { pmHas: tokens.rule, writerHas: allTokens });
    expect(verdict, res.stderr).not.toBeNull();
    expect(verdict!.problems).toEqual([]);
    expect(verdict!.result).toBe("pass");
  });

  it("fails naming the path whose delivery is gone (the probe's own table)", () => {
    const { verdict } = runScenario(report([row("writer.brief"), row("critic.code", { found: false, detail: "carries note+core: MISSING note" })]), { pmHas: tokens.rule, writerHas: allTokens });
    expect(verdict!.result).toBe("fail");
    expect(verdict!.problems).toEqual([expect.stringMatching(/path critic\.code does not deliver: .*MISSING note/)]);
  });

  it("fails a path that pulled our records for an unrelated query", () => {
    const { verdict } = runScenario(report([row("critic.code", { negativeOk: false, detail: "negative case pulled 2 record(s)" })]), { pmHas: tokens.rule, writerHas: allTokens });
    expect(verdict!.problems.join("\n")).toMatch(/critic\.code pulled our records for an unrelated query/);
  });

  it("fails when the real writer brief or the real PM prompt lacks what the table said it delivers", () => {
    const { verdict } = runScenario(report(green), { pmHas: "no rule here", writerHas: `only ${tokens.note}` });
    expect(verdict!.result).toBe("fail");
    expect(verdict!.problems.join("\n")).toMatch(/PM first prompt does not carry the probe rule/);
    expect(verdict!.problems.join("\n")).toMatch(/real writer's first prompt does not carry the probe core/);
    expect(verdict!.problems.join("\n")).toMatch(/real writer's first prompt does not carry the probe rule/);
  });

  it("fails, not passes, when the plugin has no memory-probe yet (no report)", () => {
    const { verdict } = runScenario({}, {});
    expect(verdict!.result).toBe("fail");
  });
});

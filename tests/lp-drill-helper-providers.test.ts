import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Audit 2026-10-08 round 3, P0-7: the drill starts one helper per provider in use and asserts each started and answered.
const drill = fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url));
const script = fileURLToPath(new URL("../scripts/lp-drill.sh", import.meta.url));

/** Runs scenario_helper_providers against a fake `bb` that answers `helper-probe <project> <run> <provider> <model>` from `answers`. */
function runScenario(providers: string, answers: Record<string, string | null>) {
  const dir = mkdtempSync(join(tmpdir(), "lp-drill-providers-"));
  const fake = join(dir, "bb");
  writeFileSync(fake, `#!/bin/sh
# argv: lane-pilot helper-probe <project> <run> <provider> <model>
case "$1 $2" in
  "lane-pilot helper-probe")
    case "$5" in
${Object.entries(answers).map(([provider, body]) => `      ${provider}) ${body === null ? "echo 'boom' >&2; exit 3" : `cat <<'JSON'\n${body}\nJSON\n        [ "$(printf '%s' '${body}' | grep -c '"ok": true')" = 1 ] || exit 1`} ;;`).join("\n")}
      *) echo "unexpected provider $5" >&2; exit 4 ;;
    esac ;;
  *) echo "unexpected: $*" >&2; exit 5 ;;
esac
`);
  chmodSync(fake, 0o755);
  const code = `
import importlib.util, json, types
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drill)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
ctx = types.SimpleNamespace(project="proj_x", run_id="lprun_x")
print(json.dumps(m.scenario_helper_providers(ctx)))
`;
  const res = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 60_000, env: { ...process.env, BB_CLI: fake, LP_DRILL_PROVIDERS: providers } });
  const line = res.stdout.trim().split("\n").pop() ?? "";
  return { res, verdict: line.startsWith("{") ? JSON.parse(line) as { result: string; problems: string[]; providers: Array<{ provider: string; model: string; ok: boolean; started: boolean; answered: boolean }> } : null };
}

const ok = (provider: string) => JSON.stringify({ ok: true, providerId: provider, started: true, answered: true, threadId: "thr_1", output: "OK", reason: null, ms: 900 });
const notStarted = JSON.stringify({ ok: false, started: false, answered: false, threadId: null, output: null, reason: "helper_probe_provider_unavailable:opencode2 requestedHostId", ms: 20 });
const noAnswer = JSON.stringify({ ok: false, started: true, answered: false, threadId: "thr_9", output: null, reason: "helper_probe_timeout", ms: 150000 });

describe("the drill's helper per provider", () => {
  it("passes when a helper on every provider in use started and answered", () => {
    const { verdict } = runScenario("claude-code=claude-sonnet-5-5,codex=gpt-6-luna,opencode2=zai-coding-plan/glm-5.3-flash,acp-cursor=auto", {
      "claude-code": ok("claude-code"), codex: ok("codex"), "opencode2": ok("opencode2"), "acp-cursor": ok("acp-cursor"),
    });
    expect(verdict!.result).toBe("pass");
    expect(verdict!.providers.map((item) => item.provider).sort()).toEqual(["acp-cursor", "claude-code", "codex", "opencode2"]);
    expect(verdict!.providers.every((item) => item.started && item.answered)).toBe(true);
  });

  it("fails naming the provider whose helper was refused (the 0.1.194 case), and one that started but did not answer", () => {
    const { verdict } = runScenario("claude-code=m,opencode2=o/m,codex=g", { "claude-code": ok("claude-code"), "opencode2": notStarted, codex: noAnswer });
    expect(verdict!.result).toBe("fail");
    expect(verdict!.problems).toHaveLength(2);
    expect(verdict!.problems.join("\n")).toMatch(/opencode2 \(o\/m\): a helper did not start: helper_probe_provider_unavailable/);
    expect(verdict!.problems.join("\n")).toMatch(/codex \(g\): a helper started but did not answer: helper_probe_timeout/);
  });

  it("fails a provider whose probe call dies without an answer, with what it printed", () => {
    const { verdict } = runScenario("codex=g", { codex: null });
    expect(verdict!.result).toBe("fail");
    expect(verdict!.problems[0]).toMatch(/codex \(g\): a helper did not start: boom/);
  });

  it("probes once more when only the host's thread start broke, and still fails a provider that breaks twice (0.1.406 deploy, 2026-10-31)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-drill-retry-"));
    const fake = join(dir, "bb");
    const broke = JSON.stringify({ ok: false, started: true, answered: false, threadId: "thr_9", output: null, reason: "helper_probe_timeout:error:thread_status_error:system_error:thread_command_failed:Command thread.start failed", ms: 20000 });
    // The first probe of each provider breaks; the second of «flaky» answers, «broken» breaks again.
    writeFileSync(fake, `#!/bin/sh
if [ -f "${dir}/$5" ] && [ "$5" = flaky ]; then echo '${ok("flaky")}'; exit 0; fi
touch "${dir}/$5"; echo '${broke}'; exit 1
`);
    chmodSync(fake, 0o755);
    const code = `
import importlib.util, json, types
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drill)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.scenario_helper_providers(types.SimpleNamespace(project="p", run_id="r"))))
`;
    const res = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 60_000, env: { ...process.env, BB_CLI: fake, LP_DRILL_PROVIDERS: "flaky=m,broken=m" } });
    const verdict = JSON.parse(res.stdout.trim().split("\n").pop()!) as { result: string; problems: string[] };
    expect(verdict.result).toBe("fail");
    expect(verdict.problems).toEqual([expect.stringMatching(/^broken \(m\): a helper started but did not answer: .*thread_command_failed/)]);
  });

  it("is part of --quick, after the guard check and the memory delivery check, before the three-task scenario", () => {
    const quick = spawnSync("bash", [script, "--quick", "--dry-run"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, BB_CLI: "/nonexistent/bb", LP_DRILL_SELECT: "0" } });
    expect(quick.stdout).toContain("scenarios: guard_hash, deferrals, checkers, memory_paths, helper_providers, parallel3");
  });
});

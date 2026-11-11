import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isPaid, PAID_PROVIDERS, priceOf } from "../../src/rooms/money";
import { consistentProvider } from "@lane-pilot/models";
import { resolveAgentModel } from "../../src/rooms/workflow/server/workflow-agent-model";

const drill = fileURLToPath(new URL("../../scripts/lp-drill.py", import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/**
 * Runs `body` against the drill module with a fake hub: `setup` installs the doubles (m.bb, m.hubsql, m.git, m.run,
 * m.setting_rpc, m.providers_in_use) before the body asks for a probe or the whole series_preparation.
 */
function drillPy(setup: string, body: string): unknown {
  const dir = mkdtempSync(join(tmpdir(), "lp-sma-j2-"));
  dirs.push(dir);
  const code = `
import importlib.util, json, os
os.environ["LP_DRILL_RECEIPT_DIR"] = ${JSON.stringify(dir)}
os.environ.pop("LP_DRILL_UI_URL", None)
os.environ.pop("LP_DRILL_UI_ACCESS_URL", None)
os.environ.pop("LP_DRILL_LIVE_PRESS", None)
os.environ.pop("LP_DRILL_PROVIDERS", None)
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drill)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.log = lambda *a, **k: None
m.git = lambda *a, **k: "deadbeef"
def fake_run(args, stdin=None, timeout=180, env=None):
    if args[1:3] == ["plugin", "list"]:
        return 0, "[]", ""
    return 0, "{}", ""
m.run = fake_run
m.hubsql = lambda sql: []
calls = []
def fake_bb(*args, timeout=180):
    calls.append(list(args))
    if args[:3] == ("lane-pilot", "capabilities", "--probe"):
        return 0, json.dumps(PROBE_OUT), ""
    if args[:2] == ("lane-pilot", "capabilities"):
        return CAP_RC, json.dumps({"table": CAP_TABLE}), ""
    if args[:3] == ("lane-pilot", "owner-presence", "--journal"):
        return 0, json.dumps(JOURNAL), ""
    if args[:2] == ("lane-pilot", "owner-presence"):
        return 0, json.dumps(MARKS), ""
    if args[:4] == ("lane-pilot", "coverage", "--json", "--strict"):
        return 0, json.dumps({"gaps": []}), ""
    if args[:3] == ("host", "list", "--json"):
        return 0, json.dumps(["host_7sea4qaad8"]), ""
    return 0, "{}", ""
${setup}
m.bb = fake_bb
def fake_rpc(method, payload):
    calls.append(["rpc", method])
    return {}
if DIGEST_ERROR:
    def bad_rpc(method, payload):
        raise RuntimeError(DIGEST_ERROR)
    m.setting_rpc = bad_rpc
else:
    m.setting_rpc = fake_rpc
${body}
print(json.dumps({"out": out, "calls": calls}))
`;
  const res = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 60_000 });
  if (res.status !== 0) throw new Error(res.stderr.slice(0, 1200));
  return JSON.parse(res.stdout.trim().split("\n").pop()!);
}

const GREEN = { table: [{ providerId: "claude-code", capabilities: { answers: "supported" } }, { providerId: "codex", capabilities: { answers: "supported" } }, { providerId: "opencode2", capabilities: { answers: "supported" } }] };
const HEALTHY = `CAP_TABLE = ${JSON.stringify(GREEN.table)}
CAP_RC = 0
PROBE_OUT = {"probed": []}
JOURNAL = [{"day": "2026-11-10", "threadId": "thr_x", "providerId": "claude-code", "hostId": "host_7sea4qaad8"}]
MARKS = []
DIGEST_ERROR = ""`;

describe("series preparation (SMA rl_prep)", () => {
  it("[sma:rl_prep] a healthy hub passes preparation and the checks name database, receipts, browser, accounts, limits, window and person", () => {
    const { out } = drillPy(HEALTHY, `out = m.series_preparation(["parallel3"])`) as { out: { problems: string[]; checks: { name: string; ok: boolean }[] } };
    expect(out.problems).toEqual([]);
    expect(out.checks.map((row) => row.name)).toEqual(["database", "receipts", "browser", "accounts", "limits", "window", "person"]);
    expect(out.checks.every((row) => row.ok)).toBe(true);
  });

  it("[sma:rl_prep] a window scene in the series and no browser machine and no window named refuses the preparation, with the scene named", () => {
    const { out } = drillPy(HEALTHY, `out = m.series_preparation(["skills_screen", "parallel3"])`) as { out: { problems: string[]; checks: { name: string; ok: boolean; detail: string }[] } };
    const browser = out.checks.find((row) => row.name === "browser")!;
    expect(browser.ok).toBe(false);
    expect(browser.detail).toContain("skills_screen");
    expect(out.problems.some((line) => line.startsWith("browser:"))).toBe(true);
  });

  it("[sma:rl_prep] the same missing browser machine does not refuse a series without a window scene", () => {
    const { out } = drillPy(HEALTHY, `out = m._browser_probe(["helper_providers", "parallel3"])`) as { out: [boolean, string] };
    expect(out[0]).toBe(true);
  });

  it("[sma:rl_prep] a provider in use whose answers receipt is red refuses the series and is named", () => {
    const table = [{ providerId: "claude-code", capabilities: { answers: "not_supported" } }, { providerId: "codex", capabilities: { answers: "supported" } }, { providerId: "opencode2", capabilities: { answers: "supported" } }];
    const { out } = drillPy(HEALTHY.replace(JSON.stringify(GREEN.table), JSON.stringify(table)) + "\nCAP_RC = 1", `out = m.series_preparation(["parallel3"])`) as { out: { problems: string[] } };
    expect(out.problems.some((line) => line.startsWith("accounts:") && line.includes("claude-code"))).toBe(true);
  });

  it("[sma:rl_prep] an unproven provider whose probe says the plan is exhausted refuses the series and is named", () => {
    const table = [{ providerId: "claude-code", capabilities: { answers: "unproven" } }, { providerId: "codex", capabilities: { answers: "supported" } }, { providerId: "opencode2", capabilities: { answers: "supported" } }];
    const setup = HEALTHY.replace(JSON.stringify(GREEN.table), JSON.stringify(table))
      .replace(`{"probed": []}`, JSON.stringify({ probed: [{ providerId: "claude-code", state: "not_probed", reason: "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-15" }] }));
    const { out } = drillPy(setup, `out = m.series_preparation(["parallel3"])`) as { out: { problems: string[] } };
    expect(out.problems.some((line) => line.startsWith("accounts:") && line.includes("claude-code") && /over its plan/i.test(line))).toBe(true);
  });

  it("[sma:rl_prep] a hub that never saw the owner and cannot reach him refuses the series", () => {
    const setup = HEALTHY.replace(`JOURNAL = [{"day": "2026-11-10", "threadId": "thr_x", "providerId": "claude-code", "hostId": "host_7sea4qaad8"}]`, `JOURNAL = []`)
      .replace(`DIGEST_ERROR = ""`, `DIGEST_ERROR = "unknown rpc method owner_waiting_digest"`);
    const { out } = drillPy(setup, `out = m.series_preparation(["parallel3"])`) as { out: { problems: string[] } };
    expect(out.problems.some((line) => line.startsWith("person:"))).toBe(true);
  });

  it("[sma:rl_prep] the owner is found through the 90-day journal (default path: nothing set, nothing fails)", () => {
    const { out } = drillPy(HEALTHY, `out = m._person_probe()`) as { out: [boolean, string] };
    expect(out[0]).toBe(true);
    expect(out[1]).toContain("2026-11-10");
  });
});

describe("vendors (SMA wr_vendors)", () => {
  it("[sma:wr_vendors] an api lane is its own paid vendor group while the subscription lanes are not paid", () => {
    expect(PAID_PROVIDERS.has("api")).toBe(true);
    expect(isPaid("api")).toBe(true);
    expect(isPaid("api-9router")).toBe(true);
    expect(isPaid("claude-code")).toBe(false);
    expect(isPaid("codex")).toBe(false);
    expect(priceOf("api", "some-model")).not.toBeNull();
    expect(priceOf("claude-code", "claude-opus-5-5")).toBeNull();
  });

  it("[sma:wr_vendors] an install with no setting resolves a writer to claude-code", () => {
    expect(resolveAgentModel({ role: "writer", settings: {}, pm: null }).providerId).toBe("claude-code");
    expect(consistentProvider(undefined, "claude-opus-5-5")).toBe("claude-code");
  });
});

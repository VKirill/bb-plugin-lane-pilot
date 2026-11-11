import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createMoney } from "../../src/rooms/money/server";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";
import { resolveTab } from "../../src/rooms/pages/tabs-model";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const script = join(process.cwd(), "scripts/hub-watchdog.sh");
const drill = fileURLToPath(new URL("../../scripts/lp-drill.py", import.meta.url));

/** Runs `body` (python) against the drill module and prints its result as JSON. */
function drillPy(body: string): unknown {
  const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drill)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}
`;
  const res = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 60_000 });
  if (res.status !== 0) throw new Error(res.stderr.slice(0, 800));
  return JSON.parse(res.stdout.trim());
}

function stub(dir: string, name: string, text: string): string {
  const path = join(dir, "bin", name);
  writeFileSync(path, `#!/bin/sh\n${text}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** curl stub: the first ${OK_FIRST} knocks answer 200 (the seen-200 marker), then ${CURL_RC} failures with a non-200 code. */
const OK_THEN_FAIL = `for a in "$@"; do
  case "$a" in *sendMessage*) exit "\${TG_RC:-0}" ;; esac
done
n=0; [ -f "$CURL_STATE" ] && n="$(cat "$CURL_STATE")"
echo $((n + 1)) > "$CURL_STATE"
if [ "$n" -lt "\${OK_FIRST:-1}" ]; then echo 200; exit 0; fi
echo 000; exit "\${CURL_RC:-7}"`;

/** curl stub: every knock fails the same way; after CURL_AFTER knocks the door answers 200. */
const CURL_STUB = `for a in "$@"; do
  case "$a" in *sendMessage*) exit "\${TG_RC:-0}" ;; esac
done
n=0; [ -f "$CURL_STATE" ] && n="$(cat "$CURL_STATE")"
echo $((n + 1)) > "$CURL_STATE"
if [ "$n" -ge "\${CURL_AFTER:-999999}" ]; then echo 200; exit 0; fi
echo "\${CURL_CODE:-000}"; exit "\${CURL_RC:-0}"`;

const dirs: string[] = [];
function tmp(): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "lp-sma-i3-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  const env: Record<string, string> = {
    LP_WATCH_STATE: dir,
    LP_WATCH_TG_ENV: join(dir, "no-telegram"),
    LP_WATCH_BB: join(dir, "bin", "bb-missing"),
    LP_WATCH_FIRST_SEC: "0",
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
  };
  return { dir, env };
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

async function outageWithin(extra: Record<string, string>, seconds: number, curl = CURL_STUB): Promise<string> {
  const { dir, env } = tmp();
  stub(dir, "curl", curl);
  const e = { ...process.env, ...env, LP_WATCH_DRY: "1", CURL_STATE: join(dir, "s"), LP_WATCH_KNOCK_SEC: "1", ...extra };
  const proc = spawn("bash", [script, "run"], { env: e, stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  proc.kill("SIGTERM");
  return read(join(dir, "outages.jsonl"));
}

describe("[sma:m_w_suspect] three refused knocks declare after the door's first 200; before it the eight-knock rule stands", () => {
  it("declares at 3 refused once a 200 was seen, at LP_WATCH_REFUSED_AFTER when set, never at 3 before the first 200, never at 7 timeouts", async () => {
    // door answered once, then refused: declared on the third refused knock
    const seen = await outageWithin({ CURL_RC: "7" }, 6, OK_THEN_FAIL);
    expect(seen).toContain('"event":"outage"');
    expect(seen).toContain("refused");
    // refused from the start (the door never answered): no fast declare — a slow start is not lifted
    const blind = await outageWithin({ CURL_AFTER: "999999", CURL_CODE: "000", CURL_RC: "7" }, 5);
    expect(blind).not.toContain('"event":"outage"');
    // the env override still names the refused count: 2 refused after a 200 declare
    const override = await outageWithin({ CURL_RC: "7", LP_WATCH_REFUSED_AFTER: "2" }, 5, OK_THEN_FAIL);
    expect(override).toContain('"event":"outage"');
    // timeouts keep the old count: seven in a row, then the door answers — no outage
    const timeouts = await outageWithin({ CURL_AFTER: "7", CURL_CODE: "000", CURL_RC: "28" }, 11);
    expect(timeouts).not.toContain('"event":"outage"');
  }, 40000);
});

const approveScenario = (env: Record<string, string>, rc = 0) => drillPy(`
import os, tempfile, pathlib
for k in ("LP_DRILL_LIVE_PRESS", "LP_DRILL_UI_URL", "BB_SERVER_URL"): os.environ.pop(k, None)
${Object.entries(env).map(([key, value]) => `os.environ[${JSON.stringify(key)}] = ${JSON.stringify(value)}`).join("\n")}
calls, runs, sent = [], [], []
m.owner_words = lambda ctx, v: ("off", 1)
m.restore_owner_words = lambda ctx, o, v: []
m.thread_text = lambda t: "waits for the owner's word before it lands"
m.time.sleep = lambda s: None
m.hubsql = lambda sql: []
m.latest_states = lambda rows: {}
m.summarize = lambda rows, tid, cwd, output=None: {"state": "blocked" if "red" in tid else "accepted", "states": [], "reason": ""}
m.setting_rpc = lambda method, payload: (calls.append(method), {"ok": True})[1]
m.run = lambda args, **k: (runs.append(args), (${rc}, "", ""))[1]
tmp = pathlib.Path(tempfile.mkdtemp())
class Ctx:
    project = "proj_x"; run_id = "run_abc"; pm = "thr"; cwd = str(tmp); tmp = tmp
    def dispatch(self, spec): sent.append(spec["id"]); return True
    def wait_ended(self, ids): return []
    def rows(self, ids): return []
out = m.scenario_live_word(Ctx())
scene = json.loads(next(tmp.glob("approve-*.json")).read_text()) if runs else None
print(json.dumps({"result": out["result"], "note": out.get("note"), "problems": out["problems"], "calls": calls, "pressed": len(runs), "sent": len(sent), "scene": scene}))
`) as { result: string; note?: string; problems: string[]; calls: string[]; pressed: number; sent: number; scene: { url: string; steps: Array<{ click?: string }> } | null };

describe("[sma:m_sd_approve] the approval drill presses the real Approve on the hub's window without a switch; =0 opts out", () => {
  it("unset env: the press runs on the window derived from BB_SERVER_URL, with the red branch in the same scene", () => {
    const out = approveScenario({ BB_SERVER_URL: "https://hub.example/" });
    expect(out.pressed).toBe(1);
    expect(out.sent).toBe(2);
    expect(out.scene!.url).toBe("https://hub.example/");
    const clicks = out.scene!.steps.map((step) => step.click).filter(Boolean);
    expect(clicks[0]).toBe('[data-testid="scope-nav-waiting"]');
    expect(clicks[1]).toBe('[data-testid^="owner-run-task-word:run_abc:"][data-testid$="-yes"]');
    expect(out.result).toBe("pass");
  });

  it("LP_DRILL_UI_URL still wins over the derived window; LP_DRILL_LIVE_PRESS=0 keeps the old RPC path", () => {
    const explicit = approveScenario({ BB_SERVER_URL: "https://hub.example", LP_DRILL_UI_URL: "http://win.example:4173/" });
    expect(explicit.scene!.url).toBe("http://win.example:4173/");
    const off = approveScenario({ LP_DRILL_LIVE_PRESS: "0" });
    expect(off.pressed).toBe(0);
    expect(off.sent).toBe(1);
    expect(off.calls).toEqual(["task_word"]);
    expect(off.result).toBe("pass");
  });

  it("a browser that cannot start skips the press («skipped: no browser») and the word still lands through the RPC", () => {
    const out = approveScenario({ BB_SERVER_URL: "https://hub.example" }, 2);
    expect(out.pressed).toBe(1);
    expect(out.note).toContain("skipped: no browser");
    expect(out.calls).toContain("task_word");
    expect(out.result).toBe("pass");
  });
});

const view = (names: string[] | null, value: unknown, version: number) => ({ catalog: { skills: [{ name: "a" }, { name: "b" }] }, roles: [{ role: "pm", key: "access_pm", version, value, groups: { skills: { names } } }] });
const skillsScenario = (env: Record<string, string>, views: unknown[]) => drillPy(`
import os, tempfile, pathlib
for k in ("LP_DRILL_UI_ACCESS_URL", "LP_DRILL_UI_URL", "BB_SERVER_URL"): os.environ.pop(k, None)
${Object.entries(env).map(([key, value]) => `os.environ[${JSON.stringify(key)}] = ${JSON.stringify(value)}`).join("\n")}
views = json.loads(${JSON.stringify(JSON.stringify(views))})
calls, runs, saved = [], [], []
def rpc(method, payload):
    calls.append(method)
    if method == "helper_access_view": return views.pop(0) if len(views) > 1 else views[0]
    saved.append(payload); return {"ok": True}
m.setting_rpc = rpc
m.run = lambda args, **k: (runs.append(args), (0, "", ""))[1]
tmp = pathlib.Path(tempfile.mkdtemp())
class Ctx: project = "proj_sb"; cwd = str(tmp); tmp = tmp
out = m.scenario_skills_screen(Ctx())
scene = json.loads(next(tmp.glob("skills-*.json")).read_text()) if runs else None
print(json.dumps({"out": out, "calls": calls, "pressed": len(runs), "saved": saved, "scene": scene}))
`) as { out: { result: string; problems: string[]; note?: string }; calls: string[]; pressed: number; saved: Array<{ keys?: string[]; key?: string }>; scene: { url: string } | null };

describe("[sma:m_sd_skills] the skills drill opens its own project's access page by address, derived from BB_SERVER_URL", () => {
  it("no env: the page address is the lane-pilot page's <project>/access route on the hub window, and «access» resolves to the team tab", () => {
    expect(resolveTab("access")).toEqual({ tab: "team" });
    const out = skillsScenario({ BB_SERVER_URL: "https://hub.example/" }, [view(null, null, 0), view(["a"], { skills: ["a"] }, 1)]);
    expect(out.pressed).toBe(1);
    expect(out.scene!.url).toBe("https://hub.example/plugins/lane-pilot/lane-pilot/proj_sb/access");
    expect(out.out.problems).toEqual([]);
    // the row it changed is put back (a row that did not exist is removed)
    expect(out.calls).toContain("reset_project_settings");
    expect(out.saved[0]!.keys).toEqual(["access_pm"]);
  });

  it("LP_DRILL_UI_ACCESS_URL with {project} still wins", () => {
    const out = skillsScenario({ LP_DRILL_UI_ACCESS_URL: "http://127.0.0.1:4173/p/{project}/access", BB_SERVER_URL: "https://hub.example" }, [view(null, null, 0), view(["a"], { skills: ["a"] }, 1)]);
    expect(out.scene!.url).toBe("http://127.0.0.1:4173/p/proj_sb/access");
  });
});

describe("[sma:m_mo_estimate] a silent paid-lane attempt is estimated by the median of its own lane's last 20 measured attempts", () => {
  function world() {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "bb");
    return { bb, db };
  }
  /** `n` finished attempts of openlux/m that reported `tokens(i)` each; i ascending gives the newest last. */
  function measured(db: ReturnType<typeof world>["db"], tokens: number[]) {
    tokens.forEach((total, i) => {
      const taskId = `m${i}`, attemptId = `am${i}`, threadId = `thr_m${i}`;
      createTask(db, { id: taskId, runId: "run", kind: "bb", contract: { id: taskId } });
      createAttempt(db, { id: attemptId, runId: "run", taskId });
      db.prepare("UPDATE lane_pilot_attempt SET state='accepted', thread_id=?, created_at=? WHERE id=?").run(threadId, NOW - (tokens.length - i) * 1000, attemptId);
      db.prepare("INSERT INTO lane_pilot_token_cursor(thread_id,project_id,provider_id,last_model,last_provider,total_json,updated_at) VALUES(?,?,?,?,?,?,1)").run(threadId, "proj", "openlux", "m", "openlux", JSON.stringify({ input: total, output: 0, total }));
    });
  }
  function silent(db: ReturnType<typeof world>["db"], appetite?: number) {
    createTask(db, { id: "t_silent", runId: "run", kind: "bb", contract: { id: "t_silent", ...(appetite ? { appetite: { tokens: appetite } } : {}) } });
    createAttempt(db, { id: "a_silent", runId: "run", taskId: "t_silent" });
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted', thread_id='thr_silent', created_at=? WHERE id='a_silent'").run(NOW - 100);
    db.prepare("INSERT INTO lane_pilot_stage_receipt(run_id,task_id,stage_id,contract_version,state,input_sha256,attempt,provider_id,model,updated_at) VALUES('run','t_silent','writer-agent',1,'passed','x',0,'openlux','m',?)").run(NOW);
  }

  it("with five or more measured attempts of the same provider and model the estimate is their median, marked estimated, unset setting or not", () => {
    const w = world();
    measured(w.db, [100_000, 200_000, 300_000, 400_000, 500_000, 600_000]);
    silent(w.db);
    const status = createMoney({ db: w.db, bb: w.bb }).money.status(NOW);
    // median of the last 20 = (300k + 400k) / 2 = 350k tokens; openlux blended list price is (0.5 + 1.5) / 2 per M
    expect(status.estimatedAttempts).toBe(1);
    expect(status.silentAttempts).toBe(1);
    expect(status.silentUnknown).toBe(0);
    expect(status.estimatedUsd).toBeCloseTo(0.35, 5);
    expect(status.monthUsd).toBeCloseTo(status.estimatedUsd, 5);
  });

  it("fewer than five measured attempts of the lane: no estimate, the silent spend is unknown — not zero, not summed", () => {
    const w = world();
    measured(w.db, [100_000, 200_000, 300_000, 400_000]);
    silent(w.db);
    const status = createMoney({ db: w.db, bb: w.bb }).money.status(NOW);
    expect(status.estimatedUsd).toBe(0);
    expect(status.estimatedAttempts).toBe(0);
    expect(status.silentUnknown).toBe(1);
    expect(status.monthUsd).toBe(0);
  });

  it("money.silent_estimate_tokens still wins over the lane median", () => {
    const w = world();
    measured(w.db, [100_000, 200_000, 300_000, 400_000, 500_000]);
    silent(w.db);
    saveProjectSetting(w.db, "*", "money.silent_estimate_tokens", 1_000_000);
    const status = createMoney({ db: w.db, bb: w.bb }).money.status(NOW);
    expect(status.estimatedUsd).toBeCloseTo(1.0, 5);
  });
});

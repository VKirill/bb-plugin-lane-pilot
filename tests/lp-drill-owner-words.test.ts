import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Full drill 2026-10-27 (0.1.341): live_word turned owner.words on and could not turn it off again, because reset_project_settings refuses a key that is
// not in the settings catalog (ok:false, which the drill never read). Every later task (skills, reload) and phase then waited for the owner's word.
const drill = fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url));

/** Runs `body` (python) against the drill module with a fake hub: save_setting works for any key, reset_project_settings refuses owner.words. */
function withFakeHub(body: string): { rows: Record<string, unknown>; out: unknown } {
  const code = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drill)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
rows = {}      # key -> [value, version]
m.log = lambda *a, **k: None
def fake_rpc(method, payload):
    key = payload.get("key") or (payload.get("keys") or [""])[0]
    if method == "save_setting":
        value, version = rows.get(key, [None, 0])
        if payload["expectedVersion"] != version:
            return {"ok": False, "conflict": True, "version": version, "value": value}
        rows[key] = [payload["value"], version + 1]
        return {"ok": True, "conflict": False, "version": version + 1, "value": payload["value"]}
    if method == "reset_project_settings":
        return {"ok": False, "conflict": False, "values": {}, "versions": {}, "validation": {"code": "incompatible_setting", "key": key}}
    if method == "task_word":
        return {"ok": True}
    raise AssertionError(method)
def fake_hubsql(sql):
    if "owner.words" in sql and key_row():
        value, version = key_row()
        return [{"value": json.dumps(value), "version": version}]
    return []
def key_row():
    return rows.get("owner.words")
m.setting_rpc = fake_rpc
m.hubsql = fake_hubsql
class Ctx:
    project = "proj_x"; run_id = "run_x"; pm = "thr_pm"; cwd = "/tmp/x"
    def dispatch(self, spec): return True
    def wait_ended(self, ids): return [{"id": ids[0], "state": "accepted", "attempts": 1}]
ctx = Ctx()
${body}
print(json.dumps({"rows": rows, "out": out}))
`;
  const res = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 30_000 });
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout.trim().split("\n").pop()!);
}

describe("the drill puts owner.words back", () => {
  it("restores a key that was not set before to off, through a save the hub accepts", () => {
    const { rows, out } = withFakeHub(`
original, version = m.owner_words(ctx, "on")
assert rows["owner.words"][0] == "on"
out = m.restore_owner_words(ctx, original, version)`);
    expect(out).toEqual([]);
    expect((rows["owner.words"] as unknown[])[0]).toBe("off");
  });

  it("takes a stale on of an earlier drill for a leftover, not for the project's choice", () => {
    const { rows, out } = withFakeHub(`
rows["owner.words"] = ["on", 1]
original, version = m.owner_words(ctx, "on")
out = m.restore_owner_words(ctx, original, version)`);
    expect(out).toEqual([]);
    expect((rows["owner.words"] as unknown[])[0]).toBe("off");
  });

  it("clears a leftover on before the scenarios start, and does nothing when it is off", () => {
    const left = withFakeHub(`
rows["owner.words"] = ["on", 3]
out = m.clear_stale_owner_words(ctx)`);
    expect(left.out).toEqual([]);
    expect((left.rows["owner.words"] as unknown[])[0]).toBe("off");
    const clean = withFakeHub(`
rows["owner.words"] = ["off", 3]
out = m.clear_stale_owner_words(ctx)`);
    expect(clean.rows["owner.words"]).toEqual(["off", 3]);
  });

  it("the live word scenario leaves the key off and the verdict green", () => {
    const { rows, out } = withFakeHub(`
m.thread_text = lambda thread: "waits for the owner's word before it lands"
m.summarize = lambda rows_, task_id, cwd, output=None: {"state": "accepted", "states": ["accepted"], "reason": ""}
out = m.scenario_live_word(ctx)`);
    expect((out as { result: string }).result).toBe("pass");
    expect((rows["owner.words"] as unknown[])[0]).toBe("off");
  });
});

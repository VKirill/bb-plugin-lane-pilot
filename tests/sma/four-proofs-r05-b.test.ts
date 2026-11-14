// Region 5 · Daemon life, batch b — the behaviour proofs of the map nodes n472–n502 (docs/sma-evidence.md). Each test checks the result a card names (the line said, the
// row written, the post sent, the exit code), whole values, not that a function was called. The values come from tests/sma/r05-world-b.ts, which the drill scene sma_r05_b.py
// reads too. The cards describe the old daemon process; each node is proved by the part of Lane Pilot that serves it now. n480 (conveyor off from the factory) is not here:
// the conveyor starts ON (src/rooms/sma-map/gaps.ts), so its card has no behaviour to prove.
import { describe, expect, it } from "vitest";
import { observeB } from "./r05-world-b";

describe("daemon life b: stop, journal, registers and the permit channel", () => {
  it("[sma:m_no_wait_stop] a stop frees the slot of a pass at once with the core's reason; the work it abandoned finishes by itself; an already stopped signal refuses at once", async () => {
    const seen = await observeB.m_no_wait_stop();
    expect(seen).toEqual({ settled: "time limit 60000 ms", finishedWhenFreed: false, workResult: "late", workFinished: true, alreadyAborted: "stopped by a reload" });
  });

  it("[sma:m_dj_journal] the core's log door writes exactly one line per event, at warn, into the process output", () => {
    expect(observeB.m_dj_journal().entries).toEqual(["warn: tick: sweep ran, door: version asked"]);
  });

  it("[sma:m_unknown_codes] reasons no class names are counted by their text without digits, the newest time kept, most frequent first; known, blank and empty ones are not in it", () => {
    expect(observeB.m_unknown_codes()).toEqual([
      { reason: "strange fault at slot 12", count: 2, lastAt: 300 },
      { reason: "odd one", count: 1, lastAt: 200 },
    ]);
  });

  it("[sma:m_action_channel] the permit channel is a schedule «permit-sweep» every minute: a writer's ticket goes once, in full words, to the PM of its run", async () => {
    const seen = await observeB.m_action_channel();
    expect(seen.registered).toEqual([{ name: "permit-sweep", cron: "* * * * *" }]);
    expect(seen.first).toHaveLength(1);
    expect(seen.first[0]).toMatch(/^pm-a: \[Lane Pilot permit\] The writer of task-a asks permission \(delete_for_good\): `rm data\.csv`\./);
    expect(seen.afterSecondSweep).toBe(1);
  });
});

describe("daemon life b: settings", () => {
  it("[sma:m_cfg_load] a whole settings object is judged key by key: a bad value and a writer pair that cannot work are both named; a good object has no problem", () => {
    const seen = observeB.m_cfg_load();
    expect(seen.clean).toEqual([]);
    expect(seen.broken).toEqual(["invalid_choice:run.max_tokens", "incompatible_setting:writer.reasoning_effort"]);
    expect(seen.bad).not.toBe(seen.good);
  });

  it("[sma:m_cfg_path] the settings are rows of the hub database per project, version 1 on the first save; a fresh read sees them, there is no settings file", () => {
    const seen = observeB.m_cfg_path();
    expect(seen.saved).toEqual({ ok: true, version: 1 });
    expect(seen.row).toEqual([{ key: "run.max_tokens", value: "40", version: 1 }]);
    expect(seen.loaded).toEqual({ "run.max_tokens": 40 });
  });

  it("[sma:m_cfg_default] without a setting every role gets its table default: a model, an effort, source «default»", () => {
    expect(observeB.m_cfg_default()).toEqual({
      roles: 40, allDefault: true, analyst: "claude-code/claude-opus-5-5/high", copyLead: "claude-code/claude-sonnet-5-5/high", pmReader: "claude-code/claude-haiku-5-5/low", auditor: "codex/gpt-6.1-sol/high",
    });
  });

  it("[sma:m_cfg_bind] the door script clears the port's old rules and lays loopback, WireGuard, the docker bridges, then a drop for everyone else; the port is the argument", () => {
    const rules = (port: string) => [
      `-I INPUT 1 -p tcp --dport ${port} -i lo -j ACCEPT`, `-I INPUT 2 -p tcp --dport ${port} -i wg0 -j ACCEPT`,
      `-I INPUT 3 -p tcp --dport ${port} -s 172.16.0.0/12 -j ACCEPT`, `-I INPUT 4 -p tcp --dport ${port} -j DROP`,
    ];
    expect(observeB.m_cfg_bind()).toEqual({ standard: { exit: 0, laid: rules("38886"), removed: 4 }, other: { exit: 0, laid: rules("4000"), removed: 4 } });
  });

  it("[sma:m_cfg_budget0] a paid lane has no money while the cap is unset (the whole refusal, with both ways out); a subscription lane is never held; «unlimited» or off lifts it", () => {
    expect(observeB.m_cfg_budget0()).toEqual({
      cap: 0,
      paid: "no money cap is set: openlux is a paid lane and stays closed until the monthly cap is set in the Lane Pilot window (dollars, or the word unlimited) or bb lane-pilot setting money.cap_unset_zero=off; subscription lanes go on",
      subscription: null, lifted: [null, null],
    });
  });

  it("[sma:m_cfg_write] each writer saves only its own key; a stale copy of a key is refused with the stored value, so a hand edit is not erased and the other key is untouched", () => {
    expect(observeB.m_cfg_write()).toEqual({
      a: { ok: true, version: 1 }, b: { ok: true, version: 1 }, hand: { ok: true, version: 2 },
      stale: { ok: false, conflict: true, version: 2, value: 55 }, stored: { "run.max_tokens": 55, "run.max_turns": 90 },
    });
  });

  it("[sma:m_cfg_secrets_view] a secret leaves as a name and a kind, never as its value: not in the catalog list, not in a check, not in the plugin log", async () => {
    const seen = await observeB.m_cfg_secrets_view();
    expect(seen.list).toEqual([{ name: "API_KEY", kind: "secret" }, { name: "SITE", kind: "login" }]);
    expect(seen.checkedMissing).toEqual(["NOPE"]);
    expect(seen.leakedInResults).toEqual([]);
    expect(seen.logLeaked).toBe(false);
    expect(seen.logLine).toBe("deploy failed with *** in the url");
  });

  it("[sma:m_restart_scoped] the turn ceiling is frozen into a run when it is created: a later change of the setting moves only the next run, an old policy without it has none", () => {
    expect(observeB.m_restart_scoped()).toEqual({ first: 5, second: 100, old: null, stored: 100 });
  });

  it("[sma:m_cfg_max_turns] without a key the named default (300) applies, 0 or off is none, a whole number 1-500 as given, anything else is refused", () => {
    expect(observeB.m_cfg_max_turns()).toEqual({
      unset: { ceiling: 300, invalid: false }, empty: { ceiling: 300, invalid: false }, zero: { ceiling: null, invalid: false }, off: { ceiling: null, invalid: false },
      given: { ceiling: 25, invalid: false }, top: { ceiling: 500, invalid: false }, over: { ceiling: null, invalid: true }, junk: { ceiling: null, invalid: true }, policy: 300,
    });
  });
});

describe("daemon life b: the stop and restart commands (scripts/hub-watchdog.sh against stand-in tools)", () => {
  it("[sma:m_ctl_cmd] stop issues the manager's stop and says it stopped; restart issues the manager's own restart and waits for the door", async () => {
    const seen = await observeB.m_ctl_cmd();
    expect(seen.stop).toEqual({ status: 0, first: "stopped: bb-server is inactive", calls: ["--user stop --no-block bb-server"] });
    expect(seen.restart.status).toBe(0);
    expect(seen.restart.last).toMatch(/^ok: the door answers after \d+s$/);
    expect(seen.restart.calls).toEqual(["--user restart bb-server"]);
  }, 30000);

  it("[sma:m_ctl_identify] the service is the manager's MainPID and the door at the configured address, whatever a program name search would find", () => {
    expect(observeB.m_ctl_identify()).toEqual({ pid: "4242", port: "38886", other: "4555", noPort: "443", status: "ok: bb-server active, pid 4242, up <n>s, the door answers" });
  });

  it("[sma:m_ctl_probe] the board request names a list «ok», a sign-in refusal «auth», any other answer «unknown», and no CLI «none»", () => {
    expect(observeB.m_ctl_probe()).toEqual({ ok: "ok", auth: "auth", notList: "unknown", noise: "unknown", none: "none" });
  });

  it("[sma:m_ctl_not_running] a service that is not running is stopped calmly, twice the same: exit 0, one «stopped» line, no kill, nothing recorded as hard", () => {
    expect(observeB.m_ctl_not_running()).toEqual({
      first: { status: 0, line: "stopped: bb-server is inactive" }, second: { status: 0, line: "stopped: bb-server is inactive" }, killed: false, hardRecorded: false,
    });
  });

  it("[sma:m_ctl_unnamed] a door answered from a process outside the unit: stop, restart and status say «process unproven», touch nothing, exit 2; --force goes on", () => {
    const line = "door answers, process unproven: port 38886 is held by pid <pid>, outside bb-server (pid 4242); nothing was touched (--force goes on)";
    expect(observeB.m_ctl_unnamed()).toEqual({
      out: { status: { status: 2, line }, stop: { status: 2, line }, restart: { status: 2, line } }, touched: false, holderAlive: true,
      forced: "door answers, process unproven: port 38886 is held by pid <pid> outside bb-server; --force given, going on", stoppedAfterForce: true,
    });
  }, 30000);

  it("[sma:m_ctl_live_work] live work (every open attempt state) holds the stop and is listed; the stop is not issued until --force is said; an unreadable database does not hold it", () => {
    const seen = observeB.m_ctl_live_work();
    expect(seen.refused).toEqual({ status: 2, lines: ["refused: live work holds the stop (--force would stop anyway):", "att1 task1 thr1", "att2 task2 -"] });
    expect(seen.issuedWhileRefused).toEqual([]);
    expect(seen.forced).toEqual({ status: 0, issued: true });
    expect(seen.recorded).toEqual(["stop_refused", "stop_forced", "stop_unknown_live_work"]);
    expect(seen.unreadable.status).toBe(0);
    expect(seen.unreadable.line).toMatch(/^unknown live work: the Lane Pilot database cannot be read \(.*missing\.db\); proceeding$/);
  }, 30000);

  it("[sma:m_ctl_killed] a stop the process does not obey is killed after the wait it was given and said to have been hard, and the journal records it", () => {
    expect(observeB.m_ctl_killed()).toEqual({
      status: 0, line: "stopped hard: the process did not leave in 3s and was killed", calls: ["--user stop --no-block bb-server", "--user kill -s SIGKILL bb-server"], waited: 3, recorded: true,
    });
  }, 30000);

  it("[sma:m_ctl_restart] the restart waits for the door: it says how long it took when it answers (exit 0), and that it did not in the time given (exit 1)", () => {
    const seen = observeB.m_ctl_restart();
    expect(seen.answered.status).toBe(0);
    expect(seen.answered.last).toMatch(/^ok: the door answers after \d+s$/);
    expect(seen.silent).toEqual({ status: 1, last: "down: the door did not answer in 30s" });
  }, 30000);

  it("[sma:m_ctl_lift_cmd] one lift command by platform: launchctl on a Mac, sudo systemctl where sudo works, systemctl --user without", () => {
    expect(observeB.m_ctl_lift_cmd()).toEqual({ mac: "launchctl kickstart -k gui/<uid>/svc", sudo: "sudo -n systemctl restart bb-server", user: "systemctl --user restart bb-server" });
  });

  it("[sma:m_ctl_exit] exit 0 the machine is as asked, 1 down, 2 a refusal a flag lifts (live work, a foreign door); with the flag, 0", () => {
    expect(observeB.m_ctl_exit()).toEqual({ answers: 0, down: 1, liveWork: 2, forcedLiveWork: 0, foreignDoor: 2, foreignForced: 0 });
  }, 30000);
});

describe("daemon life b: the phase memory, the webhook and the owner's call", () => {
  it("[sma:m_aging_mem] the «no movement» note is said once a day: none while fresh, none an hour after it was said, said again a day later with the new count", async () => {
    expect(await observeB.m_aging_mem()).toEqual({
      fresh: [], firstDay: ["no movement for 4 day(s) at discussion"], sameDay: ["no movement for 4 day(s) at discussion"],
      nextDay: ["no movement for 4 day(s) at discussion", "no movement for 5 day(s) at discussion"],
    });
  }, 30000);

  it("[sma:m_wave_wait_mem] a standing wave is named once: its table is booked when its first piece is issued and the next passes do not write it again", async () => {
    expect(await observeB.m_wave_wait_mem()).toEqual({ first: ["wave 1:"], afterThree: ["wave 1:"], issued: ["p1"] });
  }, 30000);

  it("[sma:m_report] a task that ends is posted once per state to the project's https address as JSON; a state already posted is not posted again; the answer is never read", async () => {
    const seen = await observeB.m_report();
    expect(seen.posts).toEqual([
      { url: "https://hooks.example.test/lp", method: "POST", event: "task.blocked", state: "blocked", taskId: "T1" },
      { url: "https://hooks.example.test/lp", method: "POST", event: "task.accepted", state: "accepted", taskId: "T1" },
    ]);
    expect(seen.answerRead).toBe(false);
  });

  it("[sma:m_report_keys] the body is exactly the nine named fields in order, each clipped to 200; a diff, a transcript or a token in the task is not in it", async () => {
    expect(await observeB.m_report_keys()).toEqual({ keys: ["event", "projectId", "runId", "taskId", "title", "kind", "state", "attempt", "at"], titleLength: 200, leaked: [], attempt: 1, kind: "bb" });
  });

  it("[sma:m_report_off] with no address, a blank one or an address that is not https the factory posts nothing", async () => {
    expect(await observeB.m_report_off()).toEqual({ noAddress: 0, blank: 0, http: 0 });
  });

  it("[sma:m_sum_build] the owner's digest is built from the live settings at every call: switched off it is silent, switched on again it is heard at the next call without a restart, and said once", () => {
    expect(observeB.m_sum_build()).toEqual({
      on: { send: true, keys: ["night:a"], text: "Lane Pilot: ждут владельца, новых — 1." }, off: { send: false, reason: "disabled" },
      back: { send: true, keys: ["night:a"] }, after: { send: false, reason: "nothing_new" },
    });
  });
});

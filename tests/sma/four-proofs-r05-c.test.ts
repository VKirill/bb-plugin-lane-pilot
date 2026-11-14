// Region 5 · Daemon life, batch c — the behaviour proofs of the map nodes n503–n528 (docs/sma-evidence.md): the owner's call (digest, ack, repeat, retry), the estimate report and
// the hub watchdog (knock, decide, lift, say). Each test checks the result a card names (the line said, the row written, the event recorded, the command issued), whole values.
// The values come from tests/sma/r05-world-c.ts, which the drill scene sma_r05_c.py reads too. The watchdog's loop runs against stand-in curl, systemctl and sleep (no waiting in real time).
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWatchdog } from "../helpers/hub-watchdog";
import { observeC, observeC2 } from "./r05-world-c";

afterEach(cleanupWatchdog);

describe("daemon life c: the owner's call and the estimate report", () => {
  it("[sma:m_sum_kinds] a person is called for four reasons — a decision, work that cannot go on, something red, a term that ends — each row named with its reason, the costliest first", () => {
    expect(observeC.m_sum_kinds()).toEqual({
      reasons: ["decision", "blocked", "red", "term"],
      classes: { canary_red: "red", outage_started: "red", deferral_term: "term", deadline: "term", wall: "blocked", stalled_batch: "blocked", needs_human: "blocked", choice: "decision", acceptance: "decision" },
      lines: ["• ночь [красное]: the canary is red", "• ночь [стоит]: work cannot go on", "• ночь [срок]: the term ends", "• ночь [решение]: pick the colour"],
    });
  });

  it("[sma:m_sum_digest] ten waiting rows are one message: one header with the count, the rows named, one footer — not ten messages", () => {
    expect(observeC.m_sum_digest()).toEqual({
      send: true, keys: ["a0", "a1", "a2", "a3", "a4"], shown: 5, more: 0, header: "Lane Pilot: ждут владельца, новых — 5.",
      rows: ["• ночь [решение]: question 0", "• ночь [решение]: question 1", "• ночь [решение]: question 2", "• ночь [решение]: question 3", "• ночь [решение]: question 4"],
      footer: "Что, почему и точное действие — на э",
    });
  });

  it("[sma:m_sum_raise] the call is asked every tick and goes out once: after it is acknowledged five later ticks say nothing, and acknowledging again adds nothing", () => {
    expect(observeC.m_sum_raise()).toEqual({ first: { send: true, keys: ["a"] }, added: 1, ticks: ["nothing_new", "nothing_new", "nothing_new", "nothing_new", "nothing_new"], again: 0 });
  });

  it("[sma:m_sum_said] the memory is a row on disk with the time of the call: an hour later and one minute short of six hours say nothing; at six hours one «still waiting» line; never a third", () => {
    expect(observeC.m_sum_said()).toEqual({
      rows: [{ key: "a", at: Date.UTC(2026, 9, 22, 7, 0, 0) }], soon: "nothing_new", almost: "nothing_new",
      repeat: { keys: ["a#again"], text: "• ночь [решение]: (ещё ждёт, 6 ч) a thing" }, later: "nothing_new",
    });
  });

  it("[sma:m_sum_ghost] closed work stays silent: a card marked done and a piece of a cancelled batch are closed by the sweep with its reason, an answered row leaves, and a closed row cannot be closed again", () => {
    expect(observeC.m_sum_ghost()).toEqual({
      before: ["batch:cancelled", "night:owner", "backlog:done", "backlog:open"], swept: ["night:owner", "backlog:open"], after: ["backlog:open"],
      closed: true, closedAgain: false, missing: false,
      by: [{ key: "backlog:done", by: "janitor:card is done" }, { key: "batch:cancelled", by: "janitor:batch cancelled" }, { key: "night:owner", by: "screen" }],
    });
  });

  it("[sma:m_sum_repeat] after a failed send the next try waits five minutes: a hand run 250 s later says it waits and sends nothing, 350 s later it sends and clears the mark", () => {
    expect(observeC.m_sum_repeat()).toEqual({
      failed: { status: 1, said: "", sends: 1 }, at250: { status: 0, said: "waiting after a failed send (250s < 300s)", sends: 1 }, at350: { status: 0, said: "hi", sends: 2 }, markerGone: true,
    });
  });

  it("[sma:m_sp_report] the report is per area and overall: files error, the share of first tries that came true, the median fact over forecast (even counts average the middle two, an unmeasured side is left out), a model's own history only", () => {
    const seen = observeC.m_sp_report();
    expect(seen.overall).toEqual({ area: "all", tasks: 5, filesMae: 0.6, filesBias: -0.2, firstTryHit: 0.8, tokensRatio: 2, minutesRatio: 2 });
    expect(seen.byArea).toEqual([
      { area: "api", tasks: 4, filesMae: 0.75, filesBias: -0.25, firstTryHit: 0.75, tokensRatio: 2, minutesRatio: 1.5 },
      { area: "ui", tasks: 1, filesMae: 0, filesBias: 0, firstTryHit: 1, tokensRatio: null, minutesRatio: 2 },
    ]);
    expect(seen.ofM1).toEqual({
      overall: { area: "all", tasks: 2, filesMae: 1.5, filesBias: -0.5, firstTryHit: 0.5, tokensRatio: 1.25, minutesRatio: 1.5 },
      byArea: [{ area: "api", tasks: 2, filesMae: 1.5, filesBias: -0.5, firstTryHit: 0.5, tokensRatio: 1.25, minutesRatio: 1.5 }],
    });
    expect(seen.none).toEqual({ overall: null, byArea: [] });
    expect(seen.line).toBe("Your forecasts in api (4 tasks): files off by 0.75 on average (bias -0.25), first-try right 75%, real effort ×1.5 the forecast.");
  });
});

describe("daemon life c: the watchdog decides from the door and the process record", () => {
  it("[sma:m_w_knock] the watchdog knocks every 15 seconds (the setting moves it) and decides from the door, the record and the lift only: it never opens Lane Pilot's database, not even to declare an outage", () => {
    expect(observeC.m_w_knock()).toEqual({ sleeps: ["15", "15", "15", "15"], quick: ["7", "7", "7"], sqliteCalls: "", outageEvents: 1, downSqlite: "" });
  });

  it("[sma:m_w_up] a door that answers resets the silence count: seven silent knocks, an answer and seven more are no outage, eight in a row are", () => {
    expect(observeC.m_w_up()).toEqual({ cut: [], cutKnocks: 16, straight: ["first_silence", "outage", "message_sent", "lift"], straightKnocks: 8 });
  });

  it("[sma:m_w_back] the process that was silent answering again is closed as a false alarm (and said so); another process answering is «risen» (and said so)", () => {
    expect(observeC.m_w_back()).toEqual({
      same: { tail: ["outage", "message_sent", "lift", "false_alarm", "message_sent"], falseAlarmSaid: 1, risenSaid: 0 },
      other: { tail: ["outage", "message_sent", "lift", "risen", "message_sent"], falseAlarmSaid: 0, risenSaid: 1 },
    });
  });

  it("[sma:m_w_stopped] no process record (MainPID 0 or empty) is a stop: the silence is not counted and nothing is lifted; with a record the same silence is an outage and is lifted", () => {
    expect(observeC.m_w_stopped()).toEqual({ zero: { outage: false, lifted: false }, empty: { outage: false, lifted: false }, recorded: { outage: true, lifted: true } });
  });

  it("[sma:m_w_starting] a process the manager calls activating or reloading is still loading: silence is not counted and nothing is lifted; the same silence from an active one is an outage", () => {
    expect(observeC.m_w_starting()).toEqual({ activating: { outage: false, lifted: false }, reloading: { outage: false, lifted: false }, active: { outage: true, lifted: true } });
  });

  it("[sma:m_w_suspect] eight silent knocks of any kind declare (seven do not); refused ones declare at the third once this process has answered 200 and not before, at the fourth when the setting says four, never for a process that has not answered", () => {
    expect(observeC.m_w_suspect()).toEqual({
      defaults: "3 8", sevenTimeouts: false, eightTimeouts: true, sevenThenAnswer: false, eightRefused: true,
      threeRefusedAfterAnswer: true, beforeTheThird: false, threeRefusedNeverAnswered: false, fourSetting: false, fourSettingFifth: true,
    });
  });
});

describe("daemon life c: the outage, the lift and what is said", () => {
  it("[sma:m_w_declared] an outage is declared with the fall time of the first silence (the declared knocks back), not the moment of the decision; the first silence is recorded before the declaration", () => {
    expect(observeC2.m_w_declared()).toEqual({
      order: ["start", "first_silence", "outage", "message_sent"], gapIsThreeKnocks: true, silence: "first knock without an answer (timeout)", outage: "timeout: no answer for 45s from pid 4242 (active)",
    });
  });

  it("[sma:m_w_kill] a live process behind a silent door is killed by its record first and only then restarted: the kill command comes before the restart command", () => {
    expect(observeC2.m_w_kill()).toEqual({ rows: ["try 1, killing pid 4242"], manager: ["--user kill -s SIGKILL bb-server", "--user restart bb-server"] });
  });

  it("[sma:m_w_lift] the lift is the one command the restart verb uses, issued once after the kill", () => {
    expect(observeC2.m_w_lift()).toEqual({ command: "systemctl --user restart bb-server", issued: ["--user restart bb-server"] });
  });

  it("[sma:m_w_pending] the outcome of a lift is the door's: an answer in the wait records no failure; a silent door records «without an outcome» with the wait and then the failure with the manager's result", () => {
    expect(observeC2.m_w_pending()).toEqual({
      answered: [["lift", "try 1, killing pid 4242"]],
      silent: [["lift", "try 1, killing pid 4242"], ["lift_without_outcome", "try 1, waited 30s"], ["out_of_tries", "1 lifts without an answer: failure"]],
    });
  });

  it("[sma:m_w_abandoned] out of tries the watchdog records it with the reason, says it to the person once, leaves a mark for the outage and sleeps 600 s instead of looping", () => {
    expect(observeC2.m_w_abandoned()).toEqual({
      outOfTries: ["1 lifts without an answer: Job failed. See journalctl"],
      said: ["Хаб BB не поднялся после 1 попыток. Причина: Job failed. See journalctl Нужен человек: ssh ubuntu@10.8.0.1, journalctl -u bb-server -n 100."], longSleeps: 1, marker: true,
    });
  });

  it("[sma:m_out_marker] the record of one outage holds the first silence, the declaration, the lift and its failure in order, each with its time; the first silence is the knocks before the declaration", () => {
    expect(observeC2.m_out_marker()).toEqual({
      rows: [
        ["start", "watchdog up; the first look waits 0s"], ["first_silence", "first knock without an answer (timeout)"], ["outage", "timeout: no answer for 30s from pid 4242 (active)"],
        ["lift", "try 1, killing pid 4242"], ["lift_without_outcome", "try 1, waited 30s"], ["out_of_tries", "1 lifts without an answer: Job failed. See journalctl"],
      ],
      gap: true, ordered: true,
    });
  });

  it("[sma:m_out_fall_msg] the first message says how long the hub has been silent, the kind of silence and the process that hangs, and that the lift starts", () => {
    expect(observeC2.m_out_fall_msg()).toEqual(["Хаб BB упал: сервер не отвечает 30 с (timeout, процесс 4242 висит). Поднимаю."]);
  });

  it("[sma:m_out_lift_failed] the second message goes once, after the tries are spent, with the reason from the lift's own output and where to look", () => {
    expect(observeC2.m_out_lift_failed()).toEqual({
      said: ["Хаб BB не поднялся после 1 попыток. Причина: Job failed. See journalctl Нужен человек: ssh ubuntu@10.8.0.1, journalctl -u bb-server -n 100."], fellSaid: 1, events: 1,
    });
  });

  it("[sma:m_out_announce] the risen hub is announced only after the door answers, with the minutes it was silent; while it is silent nothing of the sort is said, and a door that never fell is never announced", () => {
    expect(observeC2.m_out_announce()).toEqual({
      risen: ["Хаб BB упал: сервер не отвечает 30 с (timeout, процесс 4242 висит). Поднимаю.", "Хаб BB поднялся: не отвечал около 1 мин."], whileSilent: [], healthy: [],
    });
  });

  it("[sma:m_out_receipt] the outage is closed with a receipt row carrying every time: the last beat, the start of this run, the minutes, the cause (the stop's own words) and when it was noticed", async () => {
    const seen = await observeC2.m_out_receipt();
    expect(seen.rows).toEqual([{ id: 1, fromAt: seen.expectFrom, toAt: seen.expectTo, minutes: 30, cause: "the plugin was reloaded (a deploy or a settings change)", noticedAt: seen.expectTo }]);
  });

  it("[sma:m_out_notify] with no bot file, no token or no chat nothing is sent and the log names the reason; a refused send names the curl code; a good send is recorded with its text", () => {
    const seen = observeC2.m_out_notify();
    const dir = seen.noEnvPath.replace(/\/no-telegram$/, "");
    expect(seen.out.map((row) => ({ ...row, detail: row.detail.replace(dir, "<dir>") }))).toEqual([
      { case: "no file", event: "message_not_sent", detail: "no tg.env at <dir>/no-telegram", sends: 0 },
      { case: "no token", event: "message_not_sent", detail: "TG_TOKEN empty in <dir>/tg.env", sends: 0 },
      { case: "no chat", event: "message_not_sent", detail: "TG_CHAT empty in <dir>/tg.env", sends: 0 },
      { case: "refused", event: "message_not_sent", detail: "telegram refused (curl 22)", sends: 1 },
      { case: "sent", event: "message_sent", detail: "hello", sends: 2 },
    ]);
  });
});

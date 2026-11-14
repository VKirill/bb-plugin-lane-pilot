// Region 5 · Daemon life, batch c — the behaviour proofs of the map nodes n503–n528 (docs/sma-evidence.md): the owner's call (digest, ack, repeat, retry), the estimate report and
// the hub watchdog (knock, decide, lift, say). Each test checks the result a card names (the line said, the row written, the event recorded, the command issued), whole values.
// The values come from tests/sma/r05-world-c.ts, which the drill scene sma_r05_c.py reads too. The watchdog's loop runs against stand-in curl, systemctl and sleep (no waiting in real time).
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWatchdog } from "../helpers/hub-watchdog";
import { observeC } from "./r05-world-c";

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

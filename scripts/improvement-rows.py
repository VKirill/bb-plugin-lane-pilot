#!/usr/bin/env python3
"""Adds (or refreshes) the catalog rows of the self-improvement settings in scripts/ui-catalog-hand.json.

The rows are written by hand in one place, here, so the label and the help of a control sit next to each other in both languages;
run `python3 scripts/improvement-rows.py` and then `python3 scripts/generate-ui-catalog.py` to rebuild the catalog, the i18n field strings and
docs/adoc-applicability.md. The script is idempotent: it replaces its own rows (setting keys listed below) and leaves every other row alone.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HAND = ROOT / "scripts/ui-catalog-hand.json"
FIRST_ID = 478
SECTION = "improvement"

EFFORTS = ["low", "medium", "high", "xhigh", "max"]


def row(key, en, ru, help_en, help_ru, *, inv, values, default, control, scope="global", options=None, lo=None, hi=None, cite):
    return dict(key=key, en=en, ru=ru, help_en=help_en, help_ru=help_ru, inv=inv, values=values, default=default, control=control,
                scope=scope, options=options or [], lo=lo, hi=hi, cite=cite)


SPECS = [
    # ---- night loop
    row("wall.enabled", "Night loop on", "Ночной цикл включён",
        "Every night at 03:00 the failures of the last 24 hours are grouped into classes and the worst classes get a repair with proof. Default: on. Turn it off when nothing should change at night.",
        "Каждую ночь в 03:00 сбои за сутки собираются в классы, и самые частые классы получают починку с доказательством. По умолчанию включено. Выключите, если ночью ничего менять не нужно.",
        inv="bool", values="true/false", default="true", control="switch", cite=("src/rooms/wall/config.ts", "enabled: boolean")),
    row("wall.max_classes_per_night", "Classes a night", "Классов за ночь",
        "How many failure classes one night repairs. Fewer is cheaper and easier to review in the morning. Default 3, the most it may be.",
        "Сколько классов сбоев ночь чинит за один раз. Меньше — дешевле и проще проверить утром. По умолчанию 3, больше нельзя.",
        inv="int", values="1-3", default="3", control="number", lo=1, hi=3, cite=("src/rooms/wall/config.ts", "maxClassesPerNight: number")),
    row("wall.rounds_per_night", "Repair rounds a class", "Кругов починки на класс",
        "How many times one night may redo a repair of a class when its proof fails. Default 2, the most it may be.",
        "Сколько раз за ночь можно переделать починку класса, если её проверка не прошла. По умолчанию 2, больше нельзя.",
        inv="int", values="1-2", default="2", control="number", lo=1, hi=2, cite=("src/rooms/wall/config.ts", "roundsPerNight: number")),
    row("wall.recurrence_floor", "Repeats to act on", "Повторов, чтобы браться",
        "A failure that is not on Lane Pilot's side is taken into work when it repeated this many times in 7 days. Lower: the night reacts to rare failures. Default 3.",
        "Сбой не на стороне Lane Pilot берётся в работу, если за 7 дней он повторился столько раз. Меньше — ночь реагирует и на редкие сбои. По умолчанию 3.",
        inv="int", values="1-50", default="3", control="number", lo=1, hi=50, cite=("src/rooms/wall/config.ts", "recurrenceFloor: number")),
    row("wall.walks", "Plain tries before the hunt", "Обычных попыток до охоты",
        "How many ordinary attempts to get past a wall the night makes before it calls the hunters. Default 2: the third move is the hunt.",
        "Сколько обычных попыток обойти стену делает ночь, прежде чем звать охотников. По умолчанию 2: третий ход заменяет охота.",
        inv="int", values="1-5", default="2", control="number", lo=1, hi=5, cite=("src/rooms/wall/config.ts", "walks: number")),
    row("wall.hunters", "Hunters a wall", "Охотников на стену",
        "How many read-only readers look for the cause of a stubborn failure, each from another side. Each costs tokens. Default 3.",
        "Сколько читателей без права записи ищут причину упорного сбоя, каждый со своей стороны. Каждый стоит токенов. По умолчанию 3.",
        inv="int", values="1-5", default="3", control="number", lo=1, hi=5, cite=("src/rooms/wall/config.ts", "hunters: number")),
    row("wall.hunter_provider", "Hunters: provider", "Охотники: провайдер",
        "The provider of the hunters' model. Pick another one than the repairing engineer uses, then the look is fresh. Default codex.",
        "Провайдер модели охотников. Лучше не тот, на котором чинит инженер: тогда взгляд свежий. По умолчанию codex.",
        inv="string", values="BB provider id", default="codex", control="input", cite=("src/rooms/wall/config.ts", "hunterProviderId: string")),
    row("wall.hunter_model", "Hunters: model", "Охотники: модель",
        "The model of the hunters, as the provider lists it in BB. Default gpt-6.1-sol.",
        "Модель охотников так, как её называет провайдер в BB. По умолчанию gpt-6.1-sol.",
        inv="string", values="a model id the provider lists in BB", default="gpt-6.1-sol", control="input", cite=("src/rooms/wall/config.ts", "hunterModel: string")),
    row("wall.hunter_reasoning_effort", "Hunters: effort", "Охотники: рассуждение",
        "How hard the hunters think. Higher is slower and costs more. Default medium.",
        "Насколько глубоко думают охотники. Выше — дольше и дороже. По умолчанию medium.",
        inv="enum", values=",".join(EFFORTS), default="medium", control="select", options=EFFORTS, cite=("src/rooms/wall/config.ts", "hunterReasoningLevel: string")),
    row("wall.night_token_cap", "Token cap for a night", "Потолок токенов на ночь",
        "Everything one night spends: repairs, hunters, analysis. When it is reached the night stops and writes why. Default 20 000 000.",
        "Всё, что тратит одна ночь: починки, охотники, разбор. Когда потолок достигнут, ночь останавливается и пишет причину. По умолчанию 20 000 000.",
        inv="int", values="0-1000000000", default="20000000", control="number", lo=0, hi=1_000_000_000, cite=("src/rooms/wall/config.ts", "nightTokenCap: number")),
    row("wall.hunt_share_percent", "Share of the cap for hunts", "Доля потолка на охоту",
        "How much of the night's token cap the hunts may use, in percent. Default 25.",
        "Какую часть ночного потолка токенов могут потратить охотники, в процентах. По умолчанию 25.",
        inv="int", values="1-100", default="25", control="number", lo=1, hi=100, cite=("src/rooms/wall/config.ts", "huntShare: number")),
    row("wall.assumed_repair_tokens", "Cost of a repair before its report", "Цена починки до отчёта",
        "What a repair counts for in the night's budget until its real usage is known. Default 4 000 000.",
        "Сколько починка засчитывается в бюджет ночи, пока её настоящий расход неизвестен. По умолчанию 4 000 000.",
        inv="int", values="0-1000000000", default="4000000", control="number", lo=0, hi=1_000_000_000, cite=("src/rooms/wall/config.ts", "assumedRepairTokens: number")),
    row("wall.bench_subset", "Bench tasks for proof", "Задач эталонного набора для проверки",
        "How many tasks of the newest bench set the acceptance of a repair compares. 0 turns the bench check off, and then the night merges nothing alone. Default 8.",
        "Сколько задач свежего эталонного набора сравнивает приёмка починки. 0 выключает эту сверку, и тогда ночь сама ничего не вливает. По умолчанию 8.",
        inv="int", values="0-50", default="8", control="number", lo=0, hi=50, cite=("src/rooms/wall/config.ts", "benchSubset: number")),
    row("wall.rerun_sandbox_only", "Re-run in the sandbox only", "Перезапуск только в песочнице",
        "Failed attempts of a repaired class are re-run only on sandbox and bench projects; real projects go to the morning list. Turn it off only when you trust the repairs. Default: on.",
        "Упавшие попытки починенного класса перезапускаются только в песочнице и в тестовых проектах; настоящие проекты уходят в утренний список. Выключайте, только если доверяете починкам. По умолчанию включено.",
        inv="bool", values="true/false", default="true", control="switch", cite=("src/rooms/wall/config.ts", "rerunSandboxOnly: boolean")),
    # ---- bench
    row("bench.budget_tokens", "Token cap for a series", "Потолок токенов на серию",
        "A series of bench runs stops when it has spent this many tokens. Default 120 000 000.",
        "Серия прогонов эталонного набора останавливается, когда потратила столько токенов. По умолчанию 120 000 000.",
        inv="int", values="1-10000000000", default="120000000", control="number", lo=1, hi=10_000_000_000, cite=("src/rooms/bench/runner.ts", "DEFAULT_BUDGET_TOKENS")),
    row("bench.budget_hours", "Hour cap for a series", "Потолок часов на серию",
        "A series of bench runs stops after this many hours. Default 6.",
        "Серия прогонов эталонного набора останавливается через столько часов. По умолчанию 6.",
        inv="int", values="1-168", default="6", control="number", lo=1, hi=168, cite=("src/rooms/bench/runner.ts", "DEFAULT_BUDGET_HOURS")),
    row("harness.adopt_by", "Who adopts a new instruction tree", "Кто принимает новое дерево инструкций",
        "bench: a tree taught by the nightly editor is adopted only after it won on the bench set. live: the alternation on real tasks decides. Default bench. A project that set its own value keeps it.",
        "bench: новое дерево инструкций принимается, только если оно выиграло на эталонном наборе. live: решает чередование на живых задачах. По умолчанию bench. Проект со своим значением его сохраняет.",
        inv="enum", values="bench,live", default="bench", control="select", options=["bench", "live"], cite=("src/rooms/harness/server/harness.ts", "adoptBy: AdoptBy")),
    # ---- owner push
    row("owner_push.enabled", "Telegram push about what waits for you", "Пуш в Telegram о том, что ждёт вас",
        "One short message when something new needs only you (an overdue deferral, a memory conflict, a night proposal). Nothing waits for an answer. Default: on.",
        "Одно короткое сообщение, когда появилось новое, что решить можете только вы (просроченная отсрочка, конфликт памяти, предложение ночи). Ответа никто не ждёт. По умолчанию включено.",
        inv="bool", values="true/false", default="true", control="switch", cite=("src/rooms/owner-waiting/push.ts", "export type PushConfig")),
    row("owner_push.quiet", "Quiet hours", "Тихие часы",
        "No push inside this window; what came meanwhile goes out in the first message after it. Format HH:MM-HH:MM, for example 23:00-08:00; 00:00-00:00 means no quiet hours. Default 23:00-08:00.",
        "В это окно пуши не уходят; накопившееся придёт первым сообщением после него. Формат ЧЧ:ММ-ЧЧ:ММ, например 23:00-08:00; 00:00-00:00 — без тихих часов. По умолчанию 23:00-08:00.",
        inv="string", values="HH:MM-HH:MM", default="23:00-08:00", control="input", cite=("src/rooms/owner-waiting/push.ts", "const QUIET")),
    row("owner_push.timezone", "Time zone of the quiet hours", "Часовой пояс тихих часов",
        "The time zone the quiet hours are counted in, an IANA name such as Europe/Madrid. Default Europe/Madrid.",
        "Часовой пояс, в котором считаются тихие часы, название вида Europe/Madrid. По умолчанию Europe/Madrid.",
        inv="string", values="IANA time zone", default="Europe/Madrid", control="input", cite=("src/rooms/owner-waiting/push.ts", "function validTimezone")),
    # ---- checks (a default for every project; a project may set its own)
    row("baseline.already_built", "When the task is already done", "Если задача уже сделана",
        "Before a writer starts, the task's checks run on the base. If they all pass, the task may be already built. notify: tell the PM and the acceptance card, the writer starts anyway. stop: do not start. Default notify.",
        "Перед писателем проверки задачи запускаются на базе. Если все зелёные, задача, возможно, уже сделана. notify: сказать PM и показать в приёмке, писатель всё равно стартует. stop: не запускать. По умолчанию notify.",
        inv="enum", values="notify,stop", default="notify", control="select", scope="project", options=["notify", "stop"], cite=("src/rooms/baseline/logic.ts", "BaselineSettings")),
    row("baseline.time_cap_sec", "Time for the baseline", "Время на базовую линию",
        "The most time the baseline may spend on a start, in seconds, as the sum of the checks' estimates. 0 turns the baseline off. Default 300.",
        "Сколько секунд базовая линия может потратить на старте (сумма оценок проверок). 0 выключает базовую линию. По умолчанию 300.",
        inv="int", values="0 or 10-3600", default="300", control="number", scope="project", lo=0, hi=3600, cite=("src/rooms/baseline/logic.ts", "timeCapSec: number")),
    row("regress.nightly", "Re-check every night", "Сверять каждую ночь",
        "Each night the checks of the last accepted tasks run again on the current main; a check that went red gets a search for the first bad commit. Default: on.",
        "Каждую ночь проверки последних принятых задач запускаются заново на текущей main; если проверка покраснела, ищется первый плохой коммит. По умолчанию включено.",
        inv="bool", values="true/false", default="true", control="switch", scope="project", cite=("src/rooms/baseline/logic.ts", "nightly: boolean")),
    row("regress.last_n", "Accepted tasks to re-check", "Сколько принятых задач сверять",
        "The last N accepted tasks of a project take part in the night re-check. Default 30.",
        "В ночной сверке участвуют последние N принятых задач проекта. По умолчанию 30.",
        inv="int", values="1-200", default="30", control="number", scope="project", lo=1, hi=200, cite=("src/rooms/baseline/logic.ts", "lastN: number")),
    row("regress.last_days", "Days back to re-check", "За сколько дней сверять",
        "A task accepted longer ago than this is left out of the night re-check. Default 14.",
        "Задача, принятая раньше этого срока, в ночную сверку не попадает. По умолчанию 14.",
        inv="int", values="1-365", default="14", control="number", scope="project", lo=1, hi=365, cite=("src/rooms/baseline/logic.ts", "days: number")),
    row("regress.check_cap_sec", "Longest check that counts as cheap", "Самая долгая «дешёвая» проверка",
        "A check whose estimate is above this many seconds is not cheap and is left out of the re-check. Default 120.",
        "Проверка, которая по оценке дольше этого числа секунд, дешёвой не считается и в сверку не берётся. По умолчанию 120.",
        inv="int", values="5-1800", default="120", control="number", scope="project", lo=5, hi=1800, cite=("src/rooms/baseline/logic.ts", "checkCapSec: number")),
    row("regress.budget_sec", "Time for one project's re-check", "Время на сверку одного проекта",
        "The time one project's pass may spend running checks and searching for a bad commit, in seconds. Default 1800.",
        "Сколько секунд проход по одному проекту может тратить на проверки и поиск плохого коммита. По умолчанию 1800.",
        inv="int", values="60-14400", default="1800", control="number", scope="project", lo=60, hi=14400, cite=("src/rooms/baseline/logic.ts", "budgetSec: number")),
    row("regress.bisect_steps", "Steps of the bad-commit search", "Шагов поиска плохого коммита",
        "The search is not started over more than 2 to the power of this many commits. Default 9 (512 commits).",
        "Поиск не начинается, если коммитов больше, чем 2 в этой степени. По умолчанию 9 (512 коммитов).",
        inv="int", values="1-14", default="9", control="number", scope="project", lo=1, hi=14, cite=("src/rooms/baseline/logic.ts", "bisectSteps: number")),
    row("checks.require_red_on_base", 'A check that is red before the work', 'Проверка, красная до работы',
        'A task of this risk or more must have a check that fails on the base commit before its writer starts. When every check already passes there, the attempt does not start and the PM is told which checks are vacuous and what to add: a check that names the new file or behaviour. Refactor, docs, research and check tasks are never asked. Default: from medium risk.',
        'У задачи такого риска и выше должна быть проверка, которая падает на базовом коммите до старта исполнителя. Если все проверки там уже проходят, попытка не запускается, а PM получает список пустых проверок и что добавить: проверку, называющую новый файл или поведение. Рефакторинг, документация, исследование и проверки не затрагиваются. По умолчанию — от среднего риска.',
        inv="enum", values="off, medium, high", default="medium", control="select", scope="project", options=["off", "medium", "high"], cite=("src/rooms/baseline/logic.ts", "requireRed")),
]

AREAS = {"wall": "Lane Pilot night loop", "bench": "Lane Pilot bench", "harness": "Lane Pilot harness", "owner_push": "Lane Pilot owner push",
         "baseline": "Lane Pilot baseline", "checks": "Lane Pilot checks on the base", "regress": "Lane Pilot regression pass"}


def line_of(path: str, needle: str) -> int:
    for number, text in enumerate((ROOT / path).read_text().split("\n"), start=1):
        if needle in text:
            return number
    raise SystemExit(f"{path}: no line with {needle!r}")


def block(lines: list[str], opener: str, closer: str) -> tuple[int, int]:
    """Indexes of the first and the closing line of a multi-line list in the hand file."""
    first = lines.index(opener)
    last = next(i for i in range(first + 1, len(lines)) if lines[i] == closer)
    return first, last


def main() -> None:
    lines = HAND.read_text(encoding="utf-8").split("\n")
    hand = json.loads("\n".join(lines))
    mine = {spec["key"] for spec in SPECS}
    kept = [r for r in hand["rows"] if r["setting"] not in mine]
    base_index = max(r["index"] for r in kept) + 1
    # ids stay put once given: reuse the id of a row this script wrote before
    previous = {r["setting"]: r["id"] for r in hand["rows"] if r["setting"] in mine}
    next_id = max([FIRST_ID - 1] + [int(i[1:]) for i in previous.values()] + [int(r["id"][1:]) for r in kept]) + 1
    new_rows, fields = [], []
    for offset, spec in enumerate(SPECS):
        key = spec["key"]
        rid = previous.get(key)
        if rid is None:
            rid = f"s{next_id}"
            next_id += 1
        path, needle = spec["cite"]
        evidence = f"{path}:{line_of(path, needle)}"
        area = AREAS[key.split(".")[0]]
        new_rows.append({
            "id": rid, "index": base_index + offset, "area": area, "setting": key, "location": evidence, "category": "user",
            "invType": spec["inv"], "values": spec["values"], "defaultValue": spec["default"], "scope": spec["scope"], "control": spec["control"],
            "options": spec["options"] or (["true", "false"] if spec["control"] == "switch" else [spec["default"]] if spec["control"] == "input" else []), "min": spec["lo"], "max": spec["hi"], "section": SECTION, "channel": "OWN", "uiStatus": "editable",
            "rationale": spec["help_en"], "evidence": evidence, "matrixStatus": "readonly", "storageKey": key,
        })
        fields.append([f"field_{rid}", spec["en"], spec["ru"]])
        fields.append([f"reason_{rid}", spec["help_en"], spec["help_ru"]])

    # rows: one object a line
    first, last = block(lines, ' "rows": [', " ],")
    rows = kept + new_rows
    lines[first + 1:last] = [("  " + json.dumps(r, ensure_ascii=False)) + ("," if i < len(rows) - 1 else "") for i, r in enumerate(rows)]

    # field strings: one list a line
    first, last = block(lines, '  "after_sections": [', "  ],")
    entries = [json.loads(l.strip().rstrip(",")) for l in lines[first + 1:last]]
    drop = {name for name, _, _ in fields} | {f"section_{SECTION}"}
    entries = [e for e in entries if e[0] not in drop] + [[f"section_{SECTION}", "Self-improvement", "Самоулучшение"]] + fields
    lines[first + 1:last] = [("   " + json.dumps(e, ensure_ascii=False)) + ("," if i < len(entries) - 1 else "") for i, e in enumerate(entries)]

    # section order
    if f'  "{SECTION}",' not in lines:
        lines.insert(lines.index('  "other"'), f'  "{SECTION}",')
    HAND.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()

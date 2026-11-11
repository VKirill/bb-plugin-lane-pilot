#!/usr/bin/env python3
"""Organic content pack linter: deterministic offline gates for Dzen articles, Pinterest pins, Reels scripts and
blog funnel posts before the pack is handed to the content factory or published.

Channels and checks (every threshold can be overridden in "thresholds"):
  dzen_article      dz_title_len, dz_clickbait_ban, dz_title_promise, dz_lead_hook, dz_read_time, dz_h2_cadence,
                    dz_paragraph_len, dz_external_links
  pinterest_pin     pin_title_len, pin_title_keyword, pin_desc_len, pin_desc_keywords, pin_aspect_2x3,
                    pin_board_match, pin_overlay_hook, pin_outbound_utm
  reels_script      rl_hook_3s, rl_pacing_wps, rl_open_loop, rl_single_idea, rl_single_cta, rl_plain_language,
                    rl_duration
  blog_funnel_post  bf_trigger_present, bf_funnel_bridge, bf_case_structure, bf_single_cta
  pack level        pk_link_throttle (one outbound URL on too many pins per day), pk_sell_ratio (selling share of
                    blog posts), pk_utm_campaign (one utm_campaign per pack)

Severity: "error" blocks the item, "warn" lowers the score. Item score = max(0, 100 - 20*errors - 5*warnings).
Verdict: block (any error) | warn (warnings only) | pass. Pack verdict = the worst item or pack-level verdict.

Input JSON: one item {"channel": ..., ...} or a pack {"pack_id", "thresholds", "jargon": [], "items": [{"id",
"channel", ...}]}. Field reference: SCRIPTS_CONTRACTS.md, section mkt-organic-content.
Output JSON: channel (single channel name or "multi"), channels{}, items[], checks[], score, issues[], verdict, counts.
"""
import argparse
import json
import re
import sys
from urllib.parse import parse_qs, urlsplit

NAME = "audit_organic_pack.py"
VERSION = "1.0.0"
CHANNELS = ("dzen_article", "pinterest_pin", "reels_script", "blog_funnel_post")
DEFAULTS = {
    "dz_title_min": 30, "dz_title_max": 85, "dz_lead_min": 150, "dz_lead_max": 600, "dz_wpm": 180,
    "dz_read_min": 2.0, "dz_read_max": 9.0, "dz_h2_gap_words": 350, "dz_h2_from_words": 600,
    "dz_paragraph_words": 90, "dz_max_links": 2, "dz_link_after_share": 0.7,
    "pin_title_max": 100, "pin_title_min": 20, "pin_keyword_window": 40, "pin_desc_min": 100, "pin_desc_max": 500,
    "pin_desc_keywords": 2, "pin_max_hashtags": 3, "pin_ratio_lo": 1.45, "pin_ratio_hi": 1.55, "pin_ratio_cut": 2.1,
    "pin_min_width": 1000, "pin_overlay_max_words": 8, "pin_overlay_hard_words": 12, "pin_url_per_day": 5,
    "rl_hook_sec": 3.0, "rl_wps_lo": 2.0, "rl_wps_hi": 3.5, "rl_wps_hook": 2.8, "rl_dur_min": 7, "rl_dur_max": 90,
    "rl_long_word_chars": 15, "rl_long_word_share": 0.03, "rl_max_enum": 2, "rl_payoff_share": 0.6,
    "bf_max_trigger_families": 3, "bf_sell_ratio": 0.34,
}
CLICKBAIT = ["шок", "вы не поверите", "не поверите", "срочно", "это скрывают", "врачи молчат", "сенсация",
             "только сегодня", "вы будете в шоке", "никто не знал", "100%", "жесть", "кошмар", "волосы дыбом",
             "все ахнули", "мир замер", "узнайте правду", "вся правда"]
GREETINGS = ["привет", "всем привет", "здравствуйте", "добрый день", "меня зовут", "в этой статье", "в этом видео",
             "сегодня поговорим", "сегодня расскажу"]
HOOK_MARKERS = ["?", "почему", "ошибк", "оказалось", "но ", "однако", "никто", "секрет", "как я", "что будет",
                "досмотри", "в конце", "узнаешь", "узнаете", "покажу", "проверил", "проверила", "вместо", "перестал",
                "перестала", "стоит ли", "не делай", "не делайте"]
STORY_MARKERS = ["я ", "мы ", "моя ", "мой ", "мне ", "нам "]
CTA_FAMILIES = {
    "subscribe": ["подпиш", "подписывайся", "подписывайтесь"],
    "dm_codeword": ["кодовое слово", "напиши в директ", "напишите в директ", "пиши в директ", "напиши мне", "напишите мне"],
    "comment": ["в комментари", "в комменты", "напиши в коммент", "напишите в коммент"],
    "link": ["ссылка в шапке", "ссылка в профиле", "по ссылке", "переходи", "переходите", "жми", "в описании"],
    "save": ["сохрани", "сохраните"],
    "bot": ["в бот", "в боте", "бота", "start="],
}
TRIGGER_FAMILIES = {
    "crowd": ["уже", "тысяч", "все чаще", "большинство", "как все", "присоединил"],
    "exclusive": ["только для", "закрыт", "не для всех", "эксклюзив", "избранн"],
    "scarcity": ["осталось", "мест", "до конца", "последн", "ограничен", "только до"],
    "free": ["бесплатн", "в подарок", "подарю", "дарю", "гайд", "чек-лист", "чеклист"],
    "authority": ["исследован", "по данным", "статистик", "эксперт", "лет опыта", "врач", "доказан"],
    "case": ["кейс", "клиент", "результат", "было", "стало", "за месяц", "за неделю"],
    "fear": ["потеря", "потеряете", "теряете", "ошибк", "риск", "пока не поздно", "упустите"],
    "novelty": ["нов", "впервые", "первым", "первыми", "запуск", "2026"],
}
CASE_PROBLEM = ["было", "проблем", "не мог", "не могла", "не получалось", "пришел", "пришла", "пришли", "боль"]
CASE_ACTION = ["сделали", "начали", "внедрили", "поменяли", "разобрали", "настроили", "мы с ним", "мы с ней", "работали"]
CASE_RESULT = ["результат", "стало", "получил", "получила", "получили", "вырос", "выросли", "заработал", "итог"]
ENUM_MARKERS = re.compile(r"(?<![а-яё])(во-первых|во-вторых|в-третьих|первое|второе|третье|четвертое|пятое)(?![а-яё])"
                          r"|(?:^|\s)[1-9][.)]\s")
SHORTENERS = {"bit.ly", "clck.ru", "goo.su", "tinyurl.com", "cutt.ly", "t.co", "is.gd", "vk.cc", "u.to", "ow.ly"}
STOP = {"который", "которые", "которая", "чтобы", "этого", "этот", "эта", "этом", "если", "когда", "потому", "почему",
        "только", "очень", "можно", "нужно", "будет", "было", "есть", "себя", "свой", "своих", "после", "через",
        "вашего", "ваших", "ваша", "ваши", "наши", "наша", "наших", "всего", "всех", "даже", "тоже", "также"}
WORD_RE = re.compile(r"[A-Za-zА-Яа-яЁё0-9]+(?:-[A-Za-zА-Яа-яЁё0-9]+)*")
URL_RE = re.compile(r"https?://[^\s)\]»\"']+")


class Parser(argparse.ArgumentParser):
    def error(self, message):
        fail("usage", message, 2)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=2) + "\n")


def fail(code, message, rc=1):
    emit({"ok": False, "script": NAME, "version": VERSION, "error": {"code": code, "message": str(message)}})
    sys.exit(rc)


def load_input(args, fixture):
    if args.fixture:
        return fixture
    if not args.input:
        fail("no_input", "pass --input FILE.json (or - for stdin) or --fixture", 2)
    try:
        if args.input == "-":
            return json.load(sys.stdin)
        with open(args.input, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        fail("bad_input", "%s: %s" % (args.input, exc), 2)


def norm(text):
    return str(text or "").lower().replace("ё", "е")


def words(text):
    return WORD_RE.findall(str(text or ""))


def stems(text, min_len=4):
    out = []
    for w in words(norm(text)):
        if len(w) >= min_len and w not in STOP and not w.isdigit():
            out.append(w[:5])
    return out


def has_any(low, markers):
    return [m for m in markers if m in low]


def has_word(low, markers):
    return [m for m in markers if re.search(r"(?<![a-zа-я0-9])" + re.escape(m) + r"(?![a-zа-я0-9])", low)]


def check(cid, ok, severity, value, limit, detail):
    return {"id": cid, "pass": bool(ok), "severity": severity, "value": value, "limit": limit,
            "detail": "" if ok else detail}


def paragraphs(body):
    return [p.strip() for p in re.split(r"\n\s*\n", str(body or "")) if p.strip()]


def audit_dzen(item, t):
    title = str(item.get("title") or "")
    body = str(item.get("body") or "")
    paras = paragraphs(body)
    lead = str(item.get("lead") or (paras[0] if paras else ""))
    low_title = norm(title)
    res = []
    n = len(title)
    res.append(check("dz_title_len", t["dz_title_min"] <= n <= t["dz_title_max"], "error", n,
                     [t["dz_title_min"], t["dz_title_max"]], "headline %d chars, keep %d..%d" % (n, t["dz_title_min"], t["dz_title_max"])))
    bait = has_word(low_title, CLICKBAIT)
    caps = [w for w in words(title) if len(w) >= 4 and w.isupper() and not w.isdigit()]
    bad_punct = bool(re.search(r"[!?]{2,}|\.{3,}\s*$|…\s*$", title))
    found = bait + (["CAPS:" + ",".join(sorted(set(caps)))] if caps else []) + (["bait punctuation"] if bad_punct else [])
    res.append(check("dz_clickbait_ban", not found, "error", found, [], "clickbait markers: %s" % ", ".join(found)))
    t_stems = set(stems(title))
    l_stems = set(stems(lead))
    shared = sorted(t_stems & l_stems)
    res.append(check("dz_title_promise", bool(shared) or not t_stems, "error", shared, ">=1 shared stem",
                     "the lead does not deliver the headline promise (no headline keyword in the lead)"))
    low_lead = norm(lead)
    starts_greeting = any(low_lead.startswith(g) for g in GREETINGS)
    first2 = " ".join(re.split(r"(?<=[.!?])\s+", lead)[:2])
    hooks = has_any(norm(first2) + " ", HOOK_MARKERS) + (["digit"] if re.search(r"\d", first2) else []) \
        + (["story"] if has_any(" " + norm(first2) + " ", [" " + m for m in STORY_MARKERS]) else [])
    ln = len(lead)
    lead_ok = t["dz_lead_min"] <= ln <= t["dz_lead_max"] and not starts_greeting and bool(hooks)
    why = []
    if not t["dz_lead_min"] <= ln <= t["dz_lead_max"]:
        why.append("lead %d chars, keep %d..%d" % (ln, t["dz_lead_min"], t["dz_lead_max"]))
    if starts_greeting:
        why.append("lead opens with a greeting / announcement")
    if not hooks:
        why.append("no hook in the first two sentences (question, number, conflict or personal story)")
    res.append(check("dz_lead_hook", lead_ok, "error", {"chars": ln, "hooks": hooks}, [t["dz_lead_min"], t["dz_lead_max"]],
                     "; ".join(why)))
    wc = len(words(body))
    minutes = round(wc / float(t["dz_wpm"]), 2)
    res.append(check("dz_read_time", t["dz_read_min"] <= minutes <= t["dz_read_max"], "warn", minutes,
                     [t["dz_read_min"], t["dz_read_max"]], "read time %.2f min (%d words), keep %.1f..%.1f" %
                     (minutes, wc, t["dz_read_min"], t["dz_read_max"])))
    gaps, cur = [], 0
    h2_count = 0
    for line in body.split("\n"):
        if re.match(r"^\s*##\s+\S", line):
            gaps.append(cur)
            cur, h2_count = 0, h2_count + 1
        else:
            cur += len(words(line))
    gaps.append(cur)
    max_gap = max(gaps) if gaps else 0
    need_h2 = wc >= t["dz_h2_from_words"]
    cad_ok = (not need_h2) or (h2_count >= 1 and max_gap <= t["dz_h2_gap_words"])
    res.append(check("dz_h2_cadence", cad_ok, "warn", {"h2": h2_count, "max_gap_words": max_gap}, t["dz_h2_gap_words"],
                     "%d H2 for %d words, longest stretch without H2 %d words (max %d)" % (h2_count, wc, max_gap, t["dz_h2_gap_words"])))
    longest = max([len(words(p)) for p in paras] or [0])
    res.append(check("dz_paragraph_len", longest <= t["dz_paragraph_words"], "warn", longest, t["dz_paragraph_words"],
                     "a paragraph of %d words: split it for the phone screen" % longest))
    links = URL_RE.findall(body)
    first_pos = [body.find(u) / float(max(len(body), 1)) for u in links]
    early = [round(p, 2) for p in first_pos if p < t["dz_link_after_share"]]
    in_lead = bool(URL_RE.search(lead))
    link_ok = len(links) <= t["dz_max_links"] and not early and not in_lead
    res.append(check("dz_external_links", link_ok, "error" if in_lead else "warn",
                     {"links": len(links), "early_positions": early, "in_lead": in_lead}, t["dz_max_links"],
                     "outbound links: %d (max %d), before %d%% of the text: %s, in the lead: %s" %
                     (len(links), t["dz_max_links"], int(t["dz_link_after_share"] * 100), early, in_lead)))
    return res


def utm_problems(url):
    probs = []
    u = urlsplit(url)
    host = (u.hostname or "").lower()
    if u.scheme != "https":
        probs.append("not https")
    if host in SHORTENERS:
        probs.append("URL shortener %s (spam signal)" % host)
    q = parse_qs(u.query)
    for key in ("utm_source", "utm_medium", "utm_campaign"):
        if not (q.get(key) or [""])[0]:
            probs.append("missing %s" % key)
    src = (q.get("utm_source") or [""])[0].lower()
    if src and src != "pinterest":
        probs.append("utm_source=%s, expected pinterest" % src)
    return probs


def audit_pin(item, t):
    title = str(item.get("title") or "")
    desc = str(item.get("description") or "")
    kws = [norm(k) for k in item.get("keywords") or [] if str(k).strip()]
    res = []
    n = len(title)
    res.append(check("pin_title_len", t["pin_title_min"] <= n <= t["pin_title_max"], "error" if n > t["pin_title_max"] or n == 0 else "warn",
                     n, [t["pin_title_min"], t["pin_title_max"]], "title %d chars, keep %d..%d" % (n, t["pin_title_min"], t["pin_title_max"])))
    head = norm(title)[:t["pin_keyword_window"]]
    primary = kws[0] if kws else ""
    p_stems = stems(primary, 3)
    kw_ok = bool(primary) and all(s in head for s in p_stems)
    res.append(check("pin_title_keyword", kw_ok, "error", primary, "first %d chars" % t["pin_keyword_window"],
                     "the primary keyword «%s» is not in the first %d characters of the title" % (primary, t["pin_keyword_window"])))
    d = len(desc)
    res.append(check("pin_desc_len", t["pin_desc_min"] <= d <= t["pin_desc_max"], "error" if d > t["pin_desc_max"] else "warn",
                     d, [t["pin_desc_min"], t["pin_desc_max"]], "description %d chars, keep %d..%d" % (d, t["pin_desc_min"], t["pin_desc_max"])))
    low_desc = norm(desc)
    hit = sorted(k for k in kws if stems(k, 3) and all(s in low_desc for s in stems(k, 3)))
    tags = re.findall(r"#\w+", desc)
    need = min(t["pin_desc_keywords"], len(kws)) if kws else t["pin_desc_keywords"]
    desc_ok = len(hit) >= need and len(tags) <= t["pin_max_hashtags"]
    res.append(check("pin_desc_keywords", desc_ok, "warn", {"keywords_found": hit, "hashtags": len(tags)}, need,
                     "%d of the target keywords in the description (need %d), %d hashtags (max %d)" %
                     (len(hit), need, len(tags), t["pin_max_hashtags"])))
    img = item.get("image") or {}
    w, h = float(img.get("width") or 0), float(img.get("height") or 0)
    ratio = round(h / w, 3) if w else 0.0
    if not w or not h:
        sev, ok, why = "error", False, "image width/height missing"
    elif ratio > t["pin_ratio_cut"]:
        sev, ok, why = "error", False, "ratio %.2f: the feed crops pins taller than 1:%.1f" % (ratio, t["pin_ratio_cut"])
    else:
        ok = t["pin_ratio_lo"] <= ratio <= t["pin_ratio_hi"] and w >= t["pin_min_width"]
        sev = "warn"
        why = "ratio %.2f (target 2:3 = 1.5) and width %d (min %d)" % (ratio, int(w), t["pin_min_width"])
    res.append(check("pin_aspect_2x3", ok, sev, ratio, [t["pin_ratio_lo"], t["pin_ratio_hi"]], why))
    board = item.get("board") or {}
    b_stems = set(stems(" ".join([str(board.get("name") or "")] + [str(x) for x in board.get("keywords") or []]), 3))
    k_stems = set(s for k in kws for s in stems(k, 3))
    overlap = sorted(b_stems & k_stems)
    res.append(check("pin_board_match", bool(overlap), "error", overlap, ">=1 shared stem",
                     "the board «%s» shares no keyword with the pin: the pin lands in the wrong search context" % board.get("name")))
    ov = str(item.get("overlay_text") or "")
    ow = len(words(ov))
    if not ov.strip():
        ok, sev, why = False, "warn", "no text overlay: the pin has no readable hook in the feed"
    elif ow > t["pin_overlay_hard_words"]:
        ok, sev, why = False, "error", "overlay %d words: unreadable at feed size (max %d)" % (ow, t["pin_overlay_max_words"])
    else:
        ok, sev, why = ow <= t["pin_overlay_max_words"], "warn", "overlay %d words (max %d)" % (ow, t["pin_overlay_max_words"])
    res.append(check("pin_overlay_hook", ok, sev, ow, t["pin_overlay_max_words"], why))
    link = str(item.get("link") or "")
    probs = utm_problems(link) if link else ["no outbound link"]
    res.append(check("pin_outbound_utm", not probs, "error", probs, "https + utm_source=pinterest + utm_medium + utm_campaign",
                     "; ".join(probs)))
    return res


def audit_reels(item, t):
    hook = str(item.get("hook") or "")
    script = str(item.get("script") or "")
    if not hook and script:
        hook = re.split(r"(?<=[.!?])\s+", script.strip())[0]
    full = script if hook and norm(hook) in norm(script) else (hook + " " + script).strip()
    dur = float(item.get("duration_sec") or 0)
    res = []
    hw = len(words(hook))
    hook_sec = round(hw / float(t["rl_wps_hook"]), 2)
    low_hook = norm(hook).strip()
    greet = any(low_hook.startswith(g) for g in GREETINGS)
    ok = hw > 0 and hook_sec <= t["rl_hook_sec"] and not greet
    why = []
    if hook_sec > t["rl_hook_sec"]:
        why.append("hook %d words = %.1f s at %.1f words/s (max %.1f s)" % (hw, hook_sec, t["rl_wps_hook"], t["rl_hook_sec"]))
    if greet:
        why.append("hook opens with a greeting or self-introduction")
    if hw == 0:
        why.append("no hook")
    res.append(check("rl_hook_3s", ok, "error", {"words": hw, "seconds": hook_sec}, t["rl_hook_sec"], "; ".join(why)))
    tw = len(words(full))
    wps = round(tw / dur, 2) if dur else 0.0
    res.append(check("rl_pacing_wps", bool(dur) and t["rl_wps_lo"] <= wps <= t["rl_wps_hi"], "error" if not dur else "warn",
                     wps, [t["rl_wps_lo"], t["rl_wps_hi"]], "pace %.2f words/s (%d words in %.0f s), keep %.1f..%.1f" %
                     (wps, tw, dur, t["rl_wps_lo"], t["rl_wps_hi"])))
    all_words = words(norm(full))
    head_n = max(1, int(len(all_words) * 0.2))
    head_txt = " ".join(all_words[:head_n]) + " " + low_hook
    markers = has_any(head_txt + " ", HOOK_MARKERS)
    tail = set(w[:5] for w in all_words[int(len(all_words) * t["rl_payoff_share"]):] if len(w) >= 4)
    h_stems = set(stems(hook))
    closed = sorted(h_stems & tail)
    res.append(check("rl_open_loop", bool(markers) and bool(closed), "warn", {"markers": markers, "payoff_stems": closed},
                     "marker in the first 20%% and a hook keyword after %d%%" % int(t["rl_payoff_share"] * 100),
                     "open loop %s, payoff %s: the promise of the hook must come back at the end" %
                     ("found" if markers else "missing", "found" if closed else "missing")))
    enum = len(ENUM_MARKERS.findall(norm(full)))
    ideas = int(item.get("ideas") or 1)
    res.append(check("rl_single_idea", ideas <= 1 and enum <= t["rl_max_enum"], "error" if ideas > 1 else "warn",
                     {"ideas": ideas, "enumerations": enum}, t["rl_max_enum"],
                     "one reel = one idea: %d declared ideas, %d enumeration markers" % (ideas, enum)))
    low_full = norm(full + " " + str(item.get("cta") or ""))
    fams = sorted(f for f, pats in CTA_FAMILIES.items() if has_any(low_full, pats))
    res.append(check("rl_single_cta", len(fams) == 1, "error" if len(fams) > 1 else "warn", fams, 1,
                     "%d call-to-action types %s: keep exactly one" % (len(fams), fams)))
    jargon = [norm(j) for j in item.get("_jargon") or []]
    jhits = sorted(set(j for j in jargon if j and j in low_full))
    longs = [w for w in all_words if len(w) >= t["rl_long_word_chars"]]
    share = round(len(longs) / float(max(len(all_words), 1)), 3)
    res.append(check("rl_plain_language", not jhits and share <= t["rl_long_word_share"], "warn",
                     {"jargon": jhits, "long_word_share": share}, t["rl_long_word_share"],
                     "niche jargon %s, long-word share %.3f (max %.3f): say it for a fifth-grader" %
                     (jhits, share, t["rl_long_word_share"])))
    res.append(check("rl_duration", t["rl_dur_min"] <= dur <= t["rl_dur_max"], "warn", dur, [t["rl_dur_min"], t["rl_dur_max"]],
                     "duration %.0f s, keep %d..%d" % (dur, t["rl_dur_min"], t["rl_dur_max"])))
    return res


def audit_blog(item, t):
    text = str(item.get("text") or "")
    low = norm(text)
    funnel = item.get("funnel") or {}
    step = str(funnel.get("step") or "warm")
    res = []
    fams = sorted(f for f, pats in TRIGGER_FAMILIES.items() if has_any(low, pats))
    ok = 1 <= len(fams) <= t["bf_max_trigger_families"]
    res.append(check("bf_trigger_present", ok, "warn", fams, [1, t["bf_max_trigger_families"]],
                     "%d trigger families %s: keep 1..%d (none = flat post, more = pressure)" % (len(fams), fams, t["bf_max_trigger_families"])))
    bridge = funnel.get("bridge") or {}
    btype = str(bridge.get("type") or "")
    target = str(bridge.get("target") or "")
    why = ""
    if step == "reach" and not btype:
        ok, why = True, ""
    elif btype == "codeword":
        ok = bool(target) and norm(target) in low
        why = "the code word «%s» is not in the post" % target
    elif btype == "bot":
        u = urlsplit(target)
        payload = (parse_qs(u.query).get("start") or [""])[0]
        ok = u.hostname in ("t.me", "telegram.me") and bool(payload) and (target in text or norm(u.path.strip("/")) in low)
        why = "bot bridge needs a t.me/<bot>?start=<payload> link present in the post"
    elif btype in ("lead_magnet", "link"):
        ok = bool(target) and target in text
        why = "the bridge target is not in the post"
    else:
        ok, why = False, "no funnel bridge (codeword | bot | lead_magnet | link) for step %s" % step
    res.append(check("bf_funnel_bridge", ok, "error", {"step": step, "type": btype}, "one explicit next step", why))
    if step == "convert":
        parts = [bool(has_any(low, CASE_PROBLEM)), bool(has_any(low, CASE_ACTION)), bool(has_any(low, CASE_RESULT))]
        res.append(check("bf_case_structure", all(parts), "warn", {"problem": parts[0], "action": parts[1], "result": parts[2]},
                         "problem -> action -> result", "a selling post works as a case the reader recognises: problem, what was done, result"))
    cfams = sorted(f for f, pats in CTA_FAMILIES.items() if has_any(low, pats))
    res.append(check("bf_single_cta", len(cfams) <= 1, "warn", cfams, 1, "%d call-to-action types %s: keep one" % (len(cfams), cfams)))
    return res


AUDITORS = {"dzen_article": audit_dzen, "pinterest_pin": audit_pin, "reels_script": audit_reels, "blog_funnel_post": audit_blog}


def verdict_of(checks):
    if any(not c["pass"] and c["severity"] == "error" for c in checks):
        return "block"
    if any(not c["pass"] for c in checks):
        return "warn"
    return "pass"


def score_of(checks):
    e = sum(1 for c in checks if not c["pass"] and c["severity"] == "error")
    w = sum(1 for c in checks if not c["pass"] and c["severity"] == "warn")
    return max(0, 100 - 20 * e - 5 * w)


def pack_checks(items, t):
    res = []
    per_day = {}
    for it in items:
        if it.get("channel") == "pinterest_pin" and it.get("link"):
            u = urlsplit(str(it["link"]))
            key = (str(it.get("publish_date") or "undated"), (u.hostname or "") + u.path)
            per_day.setdefault(key, []).append(str(it.get("id")))
    worst = sorted(((len(v), k, v) for k, v in per_day.items()), key=lambda x: (-x[0], x[1]))
    over = [{"date": k[0], "url": k[1], "pins": n, "ids": sorted(v)} for n, k, v in worst if n > t["pin_url_per_day"]]
    res.append(check("pk_link_throttle", not over, "warn", over, t["pin_url_per_day"],
                     "one destination on more than %d pins a day looks like link spam: spread over days or URLs" % t["pin_url_per_day"]))
    blog = [it for it in items if it.get("channel") == "blog_funnel_post"]
    sell = [it for it in blog if str((it.get("funnel") or {}).get("step")) == "convert"]
    ratio = round(len(sell) / float(len(blog)), 3) if blog else 0.0
    res.append(check("pk_sell_ratio", not blog or ratio <= t["bf_sell_ratio"], "warn", ratio, t["bf_sell_ratio"],
                     "%d of %d blog posts sell (%.0f%%): keep selling posts at most %.0f%%" %
                     (len(sell), len(blog), ratio * 100, t["bf_sell_ratio"] * 100)))
    camps = set()
    for it in items:
        for u in URL_RE.findall(" ".join(str(it.get(k) or "") for k in ("link", "body", "text"))):
            c = (parse_qs(urlsplit(u).query).get("utm_campaign") or [""])[0]
            if c:
                camps.add(c)
    res.append(check("pk_utm_campaign", len(camps) <= 1, "warn", sorted(camps), 1,
                     "%d utm_campaign values in one pack: the funnel report cannot join them" % len(camps)))
    for c in res:
        c["item_id"], c["channel"] = "_pack", "pack"
    return res


FIXTURE = {"pack_id": "fx-organic-01", "jargon": ["диверсификация"], "items": [
    {"id": "dz-1", "channel": "dzen_article",
     "title": "Почему рассада вытягивается на подоконнике и как это исправить за неделю",
     "lead": "Рассада томатов вытягивается не из-за сорта, а из-за света и тепла. Я три сезона теряла по половине "
             "ящиков, пока не замерила освещённость люксметром. Ниже простая схема, которая исправляет вытягивание за неделю.",
     "body": "## Где ошибка\n" + "Свет и тепло работают в паре. " * 40 + "\n\n## Что сделать за неделю\n" + "Снизьте температуру ночью. " * 40
             + "\n\nПодробная таблица в канале: https://t.me/ogorod_channel"},
    {"id": "pin-1", "channel": "pinterest_pin", "keywords": ["рассада томатов", "подсветка рассады"],
     "title": "Рассада томатов: схема подсветки на подоконнике", "overlay_text": "Рассада не вытянется",
     "description": "Рассада томатов без вытягивания: подсветка рассады 14 часов, ночная температура 16 градусов и "
                    "полив по сухому верхнему слою. Схема для подоконника и балкона.",
     "image": {"width": 1000, "height": 1500}, "board": {"name": "Рассада томатов и перцев", "keywords": ["рассада"]},
     "link": "https://ogorod.example/rassada?utm_source=pinterest&utm_medium=organic&utm_campaign=spring26",
     "publish_date": "2026-03-02"},
    {"id": "rl-1", "channel": "reels_script", "duration_sec": 17,
     "hook": "Рассада вытягивается не от сорта. Почему?",
     "script": "Рассада вытягивается не от сорта. Почему? Ей не хватает света, а тепла слишком много. Поставьте лампу на "
               "двадцать сантиметров выше листьев и опустите ночью температуру до шестнадцати градусов. Через неделю "
               "рассада перестанет вытягиваться и станет крепкой. Подпишитесь, здесь про огород без ошибок."},
    {"id": "bf-1", "channel": "blog_funnel_post", "funnel": {"step": "convert", "bridge": {"type": "codeword", "target": "РАССАДА"}},
     "text": "Клиентка пришла с проблемой: рассада падала каждый год. Мы с ней разобрали свет и полив, настроили лампу. "
             "Результат: 40 крепких кустов. Хотите так же — напишите в директ кодовое слово РАССАДА."},
]}


def compute(data):
    t = dict(DEFAULTS)
    t.update({k: v for k, v in (data.get("thresholds") or {}).items() if k in DEFAULTS})
    items = data.get("items")
    if items is None:
        items = [dict(data, id=data.get("id") or "item-1")]
    if not isinstance(items, list) or not items:
        raise ValueError("items is empty")
    jargon = list(data.get("jargon") or [])
    out_items, all_checks, issues = [], [], []
    for idx, it in enumerate(items):
        if not isinstance(it, dict):
            raise TypeError("item %d is not an object" % idx)
        ch = it.get("channel")
        if ch not in AUDITORS:
            raise ValueError("item %s: channel %r not in %s" % (it.get("id", idx), ch, "|".join(CHANNELS)))
        iid = str(it.get("id") or "%s-%d" % (ch, idx + 1))
        work = dict(it, _jargon=jargon + list(it.get("jargon") or []))
        checks = AUDITORS[ch](work, t)
        for c in checks:
            c["item_id"], c["channel"] = iid, ch
        all_checks.extend(checks)
        bad = [c for c in checks if not c["pass"]]
        issues.extend({"item_id": iid, "channel": ch, "check": c["id"], "severity": c["severity"], "detail": c["detail"]} for c in bad)
        out_items.append({"id": iid, "channel": ch, "score": score_of(checks), "verdict": verdict_of(checks),
                          "failed": [c["id"] for c in bad]})
    pk = pack_checks(items, t)
    all_checks.extend(pk)
    issues.extend({"item_id": "_pack", "channel": "pack", "check": c["id"], "severity": c["severity"], "detail": c["detail"]}
                  for c in pk if not c["pass"])
    rank = {"pass": 0, "warn": 1, "block": 2}
    verdicts = [i["verdict"] for i in out_items] + [verdict_of(pk)]
    verdict = max(verdicts, key=lambda v: rank[v])
    chans = {}
    for i in out_items:
        chans[i["channel"]] = chans.get(i["channel"], 0) + 1
    score = round(sum(i["score"] for i in out_items) / float(len(out_items)) - 5 * sum(1 for c in pk if not c["pass"]), 1)
    issues.sort(key=lambda x: (0 if x["severity"] == "error" else 1, x["item_id"], x["check"]))
    return {"pack_id": data.get("pack_id"), "channel": next(iter(chans)) if len(chans) == 1 else "multi",
            "channels": chans, "items": out_items, "checks": all_checks, "score": max(0.0, score), "issues": issues,
            "verdict": verdict,
            "counts": {"items": len(out_items), "blocked": sum(1 for i in out_items if i["verdict"] == "block"),
                       "warned": sum(1 for i in out_items if i["verdict"] == "warn"),
                       "checks": len(all_checks), "failed_checks": len(issues)},
            "thresholds": t}


def main():
    ap = Parser(prog=NAME, description="Deterministic offline lint of an organic content pack: Dzen article, Pinterest pin, "
                                       "Reels script, blog funnel post. One JSON object on stdout.")
    ap.add_argument("--input", help="JSON input file (one item or {items: [...]}), - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample pack")
    ap.add_argument("--strict", action="store_true", help="exit 3 when the pack verdict is block")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    if not isinstance(data, dict):
        fail("invalid_data", "top-level JSON must be an object", 2)
    try:
        result = compute(data)
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})
    if args.strict and result["verdict"] == "block":
        sys.exit(3)


if __name__ == "__main__":
    main()

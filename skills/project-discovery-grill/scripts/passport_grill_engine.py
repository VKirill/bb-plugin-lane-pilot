#!/usr/bin/env python3
"""Deterministic Living Project Passport scorer, fluff detector, contradiction checker & adaptive question selector."""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any, Dict, List, Tuple

VERSION = "1.1.0"

SECTIONS: Tuple[str, ...] = (
    "identity",
    "market_rails",
    "positioning",
    "audience_jtbd",
    "messaging_voice",
    "economics_funnel",
    "proof_brandcore",
    "product_design_rails",
)

SECTION_WEIGHTS: Dict[str, float] = {
    "identity": 0.14,
    "market_rails": 0.18,
    "positioning": 0.16,
    "audience_jtbd": 0.16,
    "messaging_voice": 0.10,
    "economics_funnel": 0.10,
    "proof_brandcore": 0.08,
    "product_design_rails": 0.08,
}

DOMAIN_REQUIRED_SECTIONS: Dict[str, List[str]] = {
    "code": ["identity", "market_rails", "product_design_rails"],
    "design": ["identity", "market_rails", "positioning", "messaging_voice", "product_design_rails"],
    "seo": ["identity", "market_rails", "positioning", "audience_jtbd", "proof_brandcore"],
    "marketing": ["identity", "market_rails", "positioning", "audience_jtbd", "messaging_voice", "economics_funnel", "proof_brandcore"],
    "content": ["identity", "market_rails", "positioning", "audience_jtbd", "messaging_voice"],
    "research": ["identity", "market_rails", "positioning", "audience_jtbd"],
    "games": ["identity", "market_rails", "audience_jtbd", "product_design_rails"],
    "business": ["identity", "market_rails", "economics_funnel"],
}

FLUFF_PATTERNS: List[Tuple[str, re.Pattern[str], str]] = [
    (
        "EVERYONE_ICP",
        re.compile(
            r"\b(for\s+everyone|for\s+all\s+businesses|all\s+entrepreneurs|any\s+company|anyone\s+who)\b|"
            r"(для\s+всех|всем\s+предпринимателям|любому\s+бизнесу|для\s+любой\s+компании|широкая\s+аудитория)",
            re.IGNORECASE,
        ),
        "Mom Test Customer Slicing: narrow 'everyone' to a specific who+where+trigger segment.",
    ),
    (
        "SUNDAY_BUZZWORDS",
        re.compile(
            r"\b(innovative\s+platform|synergistic|world-class|cutting-edge|next-gen\s+ecosystem|turnkey\s+solution|seamless\s+synergy)\b|"
            r"(инновационн\w+|уникальн\w+\s+продукт|аналогов\s+нет|под\s+ключ|комплексн\w+\s+решени\w+|индивидуальный\s+подход|высокое\s+качество)",
            re.IGNORECASE,
        ),
        "Rumelt/Wiegers Anti-Fluff: replace abstract buzzwords with concrete mechanism, time, or cost delta.",
    ),
    (
        "HYPOTHETICAL_VALIDATION",
        re.compile(
            r"\b(friends\s+said\s+they\s+love|would\s+definitely\s+buy|everyone\s+will\s+want)\b|"
            r"(друзья\s+сказали|точно\s+купят|обещали\s+купить|всем\s+понравилось)",
            re.IGNORECASE,
        ),
        "Mom Test Rule #2: compliments and future promises are not evidence; anchor in past spend or downgrade to hypothesis.",
    ),
    (
        "UNQUANTIFIED_UX",
        re.compile(
            r"^(удобный|простой|быстрый|интуитивный|easy\s+to\s+use|user-friendly|fast|simple)[\s.!]*$",
            re.IGNORECASE,
        ),
        "Wiegers Verifiability: specify what 'simple/fast' means in concrete user steps or seconds.",
    ),
]

RU_ONLY_MARKERS = re.compile(
    r"(яндекс|директ|метрик|вебмастер|152-фз|38-фз|\berid\b|орд|юkassa|юкасса|yookassa|сбп|эльба|контур|авито|дзен|vk\s*ads|вконтакте|\+7|\brub\b|₽)",
    re.IGNORECASE,
)

TOPOLOGY_MARKERS = re.compile(
    r"\b(cctlds?|subfolders?|subdirector(?:y|ies)|subdomains?|hreflang)\b|"
    r"(подпапк\w*|поддомен\w*|доменн\w+\s+зон\w*)",
    re.IGNORECASE,
)

GEOIP_REDIRECT_RE = re.compile(
    r"(geoip\s*(?:auto[-\s]?)?redirects?|ip\s*auto[-\s]?redirects?|auto[-\s]?redirects?\s+by\s+(?:ip|country|geo|accept-language)|"
    r"авторедирект\w*\s+по\s+(?:ip|гео|стране|языку))",
    re.IGNORECASE,
)

NEGATION_GUARD_RE = re.compile(
    r"\b(no|never|ban|banned|forbid|forbidden|without|avoid|disable)\b|(без|запрет\w*|не\s+делать|никаких)",
    re.IGNORECASE,
)

CUSTOM_GENERIC_RE = re.compile(
    r"\b(build\s+(?:our\s+)?own\s+(?:billing|auth|authentication|sso|crm|cms|email\s+server)|"
    r"custom\s+(?:billing|auth|authentication|payment\s+gateway|crm)\s+from\s+scratch)\b|"
    r"(свой\s+биллинг\s+с\s+нуля|собственн\w+\s+авторизаци\w+\s+с\s+нуля|свою\s+crm\s+с\s+нуля)",
    re.IGNORECASE,
)

INFRA_CORE_DOMAIN_RE = re.compile(
    r"\b(auth|identity\s+provider|iam|billing\s+engine|payment\s+orchestration|crm\s+platform)\b|"
    r"(платёжн\w+\s+шлюз|провайдер\s+авторизац)",
    re.IGNORECASE,
)

FAKE_SCARCITY_RE = re.compile(
    r"\b(fake\s+(?:countdown|timer|scarcity)|resetting\s+(?:countdown|timer)|evergreen\s+fake\s+timer)\b|"
    r"(фейков\w+\s+таймер|вечн\w+\s+таймер|сбрасывающ\w+\s+таймер)",
    re.IGNORECASE,
)

RU_COUNTRIES = {"RU", "RUS", "RUSSIA", "РОССИЯ", "РФ"}
EAEU_COUNTRIES = RU_COUNTRIES | {"BY", "KZ"}

QUESTION_BANK: List[Dict[str, Any]] = [
    {
        "id": "Q-ID-CORE",
        "section": "identity",
        "field_path": "identity.one_liner",
        "modes": ["express", "deep_grill", "domain_delta"],
        "domains": ["code", "design", "seo", "marketing", "content", "research", "games", "business"],
        "priority": 100,
        "framework": "Lean Canvas + Patton Backbone",
        "question_ru": "Что именно представляет собой проект простыми словами, на какой он сейчас стадии (голая идея с нуля, MVP в разработке, уже есть сайт/пользователи) и какое одно главное действие человек в нём совершает?",
        "question_en": "In plain words, what is this project, what stage is it at (zero-stage idea, MVP in progress, live with users), and what single core action does a user take?",
        "anti_fluff_probe": "Если убрать общие слова — что человек открывает на экране и какой результат получает за первые 5 минут?",
    },
    {
        "id": "Q-RAILS-LOCALE-GEO",
        "section": "market_rails",
        "field_path": "market_rails.primary_countries",
        "modes": ["express", "deep_grill", "domain_delta"],
        "domains": ["code", "design", "seo", "marketing", "content", "research", "games", "business"],
        "priority": 98,
        "framework": "Global Market & Locale Rails",
        "question_ru": "На какие страны и языки делаем проект (интерфейс + контент), в какой валюте и через какие платёжки принимаем оплату, и какие рынки/каналы точно ИСКЛЮЧЕНЫ (например: только US/EU на английском через Stripe, без РФ и рублёвых реалий)?",
        "question_en": "Which target countries and languages (UI + content), currency/payment rails, and explicitly EXCLUDED markets/channels apply to this project?",
        "anti_fluff_probe": "Назови 1 основной язык и 1–3 приоритетные страны для первых 100 клиентов, чтобы агенты не смешивали локали и законы.",
    },
    {
        "id": "Q-POS-ALT-ICP",
        "section": "positioning",
        "field_path": "positioning.status_quo_alternatives",
        "modes": ["express", "deep_grill", "domain_delta"],
        "domains": ["design", "seo", "marketing", "content", "research", "code"],
        "priority": 95,
        "framework": "April Dunford 5+1 + Ries & Trout Repositioning",
        "question_ru": "Кому эта проблема жжёт сильнее всего прямо сейчас, ЧЕМ они затыкают дыру сегодня без вашего продукта (Excel, стажёр, переписка, конкурент) и в чём главный структурный изъян этого старого способа?",
        "question_en": "Who feels this pain most acutely right now, what status-quo workaround do they use on Monday morning, and what structural flaw makes that old way break?",
        "anti_fluff_probe": "Если сказать не «предприниматели вообще», а назвать конкретную роль и ситуацию — кто разозлится сильнее всех, если завтра старый способ сломается?",
    },
    {
        "id": "Q-POS-VALUE-CAT",
        "section": "positioning",
        "field_path": "positioning.core_value",
        "modes": ["express", "deep_grill", "domain_delta"],
        "domains": ["design", "seo", "marketing", "content"],
        "priority": 90,
        "framework": "April Dunford + Ries & Trout Mental Rung + Rumelt Kernel",
        "question_ru": "Чем ваш продукт объективно отличается от старого способа (механика, скорость, цена, точность) и какую ОДНУ понятную «полку» рынка в голове покупателя мы занимаем (без попытки быть всем для всех)?",
        "question_en": "What objective capability sets you apart from that status-quo alternative, and what single clear market category rung do we own in the buyer's mind?",
        "anti_fluff_probe": "Переведи фичу на язык выгоды («И что с того клиенту?»): сколько часов, денег или нервов это реально экономит?",
    },
    {
        "id": "Q-JTBD-SWITCH-FORCES",
        "section": "audience_jtbd",
        "field_path": "audience_jtbd.four_forces",
        "modes": ["deep_grill", "domain_delta"],
        "domains": ["marketing", "seo", "content", "design", "research"],
        "priority": 86,
        "framework": "JTBD Four Forces (Moesta / Klement) + Revella 5 Rings",
        "question_ru": "Что обычно случается в тот самый день, когда человек начинает искать решение (триггер), и чего он больше всего боится за секунду до оплаты или регистрации (главный страх / недоверие)?",
        "question_en": "What happens on the exact day the buyer starts looking for a solution (trigger), and what is their biggest fear or hesitation right before paying?",
        "anti_fluff_probe": "Если вы ещё не запускались и это пока догадка — так и скажи, мы честно запишем это как рабочую гипотезу для проверки!",
    },
    {
        "id": "Q-VOICE-LEXICON-TABOO",
        "section": "messaging_voice",
        "field_path": "messaging_voice.grunt_test",
        "modes": ["express", "deep_grill", "domain_delta"],
        "domains": ["content", "marketing", "design", "seo"],
        "priority": 82,
        "framework": "StoryBrand SB7 + Ogilvy Factual Headline + Cialdini Honest Limitation",
        "question_ru": "Какое конкретное фактическое обещание человек видит на первом экране за 5 секунд, кому продукт ЧЕСТНО НЕ подходит (анти-ЦА) и какие слова, фейковые таймеры или штампы СТРОГО ЗАПРЕЩЕНЫ?",
        "question_en": "What factual 5-second promise appears on the first screen, who is this product honestly NOT built for, and what clichés or fake urgency tactics are strictly TABOO?",
        "anti_fluff_probe": "Представь, что человек открыл сайт с телефона на 5 секунд в метро: какие 3 конкретных факта он должен понять мгновенно?",
    },
    {
        "id": "Q-ECON-FUNNEL",
        "section": "economics_funnel",
        "field_path": "economics_funnel.pricing_model",
        "modes": ["deep_grill", "domain_delta"],
        "domains": ["marketing", "business", "code"],
        "priority": 78,
        "framework": "Trusted Advisor Permission + Unit Economics Motion",
        "question_ru": "Если комфортно зафиксировать экономику на этом шаге: какой целевой чек/тариф (или гипотеза цены), как покупают (сам картой, триал, демо-созвон) и какой потолок CAC допустим?",
        "question_en": "If comfortable sharing unit economics at this stage: what is the price/tier (or hypothesis), self-serve vs sales-assisted motion, and acceptable max CAC?",
        "anti_fluff_probe": "Если точной экономики пока нет — назови хотя бы целевой чек и сколько дней в среднем человек думает перед оплатой.",
    },
    {
        "id": "Q-DDD-CORE-GENERIC",
        "section": "identity",
        "field_path": "identity.non_goals",
        "modes": ["deep_grill", "domain_delta"],
        "domains": ["code", "business", "design"],
        "priority": 76,
        "framework": "Khononov Learning DDD (Core vs Generic + Ubiquitous Language)",
        "question_ru": "В чём ваша уникальная «секретная механика» (Core — пишем сами), а какие типовые блоки (авторизация, биллинг, рассылки, админка — Generic) берём готовыми с полки и точно НЕ изобретаем с нуля?",
        "question_en": "What is your bespoke Core secret sauce (build in-house) vs Generic commodity subdomains (auth, billing, email — buy/integrate off-the-shelf and lock in non_goals)?",
        "anti_fluff_probe": "Назови 2–3 вещи, на которые команде строго запрещено тратить кастомную разработку в первой версии, и нет ли путаницы в терминах (лид/заказ/аккаунт).",
    },
    {
        "id": "Q-PROOF-BRANDCORE",
        "section": "proof_brandcore",
        "field_path": "proof_brandcore.verified_facts",
        "modes": ["deep_grill", "domain_delta"],
        "domains": ["seo", "marketing", "content"],
        "priority": 74,
        "framework": "DrMax BrandCore & E-E-A-T",
        "question_ru": "Какие твёрдые доказательства у нас реально есть уже сегодня (реальные кейсы, цифры, опыт команды, лицензии, открытый демо-стенд) — или мы стартуем честно с нуля без кейсов (чтобы агенты не выдумывали липовых отзывов)?",
        "question_en": "What hard proof exists today (real numbers, founder credentials, live demo, licences) — or are we pre-launch with zero cases so agents must never invent fake social proof?",
        "anti_fluff_probe": "Честный «ноль кейсов на старте» — это нормально: тогда мы включим защиту от выдуманных отзывов и будем опираться на демо и механику.",
    },
    {
        "id": "Q-RAILS-MULTILOCALE-SEO",
        "section": "market_rails",
        "field_path": "market_rails.url_topology",
        "modes": ["express", "deep_grill", "domain_delta"],
        "domains": ["seo", "code", "design", "marketing", "content"],
        "priority": 72,
        "framework": "The Art of SEO 4th ed. (Multi-Locale URL Topology & Hreflang)",
        "question_ru": "В проекте больше одного языка контента: какую URL-архитектуру фиксируем (подпапки `/de/`, отдельные ccTLD `.de` или поддомены) с self-canonical, взаимным `hreflang + x-default` и запретом авторедиректа ботов по GeoIP?",
        "question_en": "Multiple content locales are active: which URL topology (`subfolder /de/`, `ccTLD .de`, or `subdomain`) will anchor self-referential canonicals, reciprocal `hreflang + x-default`, and zero GeoIP crawler redirects?",
        "anti_fluff_probe": "Для SaaS и контента стандарт по умолчанию — подпапки (`/de/`, `/es/`) на одном домене с ручным переключателем языка без редиректа по IP.",
    },
    {
        "id": "Q-PRODUCT-UX-RAILS",
        "section": "product_design_rails",
        "field_path": "product_design_rails.core_jobs",
        "modes": ["deep_grill", "domain_delta"],
        "domains": ["code", "design", "games"],
        "priority": 70,
        "framework": "Patton Walking Skeleton + Wheeler Brand Coherence",
        "question_ru": "Какие 3–5 последовательных шагов образуют «ходячий скелет» первой версии от входа до результата (Walking Skeleton), на каком экране им пользуются (375px мобайл vs десктоп) и какие визуальные референсы нравятся / какие клише рынка бесят?",
        "question_en": "What 3–5 chronological steps form the end-to-end Walking Skeleton from entry to payoff, on what primary viewport, and which visual references vs category anti-references set the bar?",
        "anti_fluff_probe": "Опиши сквозную цепочку «открыл -> сделал X -> получил на руки артефакт Y» и назови 1–2 анти-референса (как делать точно нельзя).",
    },
    {
        "id": "Q-QUALITY-TRADEOFFS",
        "section": "product_design_rails",
        "field_path": "product_design_rails.constraints",
        "modes": ["deep_grill", "domain_delta"],
        "domains": ["code", "design", "games"],
        "priority": 68,
        "framework": "Wiegers Quality Attribute Trade-Off Matrix",
        "question_ru": "Когда в продукте сталкиваются скорость ответа (Latency), строгая точность данных (Consistency), безопасность/комплаенс и вход в 1 клик без трения — что в вашем домене побеждает в первую очередь?",
        "question_en": "When Latency, Data Consistency, Security/Compliance, and Zero-Friction UX collide, what is your explicit rank order in `product_design_rails.constraints`?",
        "anti_fluff_probe": "Например: для финтеха важнее идемпотентность и точность копейки, чем 1 клик без логина; для потребительского бота — превью за 3 секунды без регистрации.",
    },
]


def is_claim_envelope(obj: Any) -> bool:
    return isinstance(obj, dict) and "status" in obj and "value" in obj


def claim_is_filled(val: Any) -> bool:
    if val is None:
        return False
    if isinstance(val, bool):
        return True
    if isinstance(val, (int, float)):
        return True
    if isinstance(val, str):
        return bool(val.strip())
    if isinstance(val, list):
        return len(val) > 0 and any(claim_is_filled(x) for x in val)
    if isinstance(val, dict):
        return len(val) > 0 and any(claim_is_filled(v) for v in val.values())
    return False


def walk_claims(node: Any, prefix: str = "") -> List[Tuple[str, str, Any, str]]:
    """Returns list of (path, status, value, evidence_ref)."""
    found: List[Tuple[str, str, Any, str]] = []
    if is_claim_envelope(node):
        status = str(node.get("status") or "unknown")
        val = node.get("value")
        ev = str(node.get("evidence_ref") or "")
        if status in ("confirmed", "hypothesis", "taboo") and not claim_is_filled(val):
            status = "unknown"
        found.append((prefix, status, val, ev))
        return found
    if isinstance(node, dict):
        for k, v in node.items():
            if k.startswith("_"):
                continue
            sub = f"{prefix}.{k}" if prefix else k
            found.extend(walk_claims(v, sub))
    return found


def stringify_leaf(val: Any) -> str:
    if val is None:
        return ""
    if isinstance(val, str):
        return val
    if isinstance(val, (int, float, bool)):
        return str(val)
    if isinstance(val, list):
        return " ; ".join(stringify_leaf(x) for x in val if stringify_leaf(x))
    if isinstance(val, dict):
        return " ; ".join(f"{k}: {stringify_leaf(v)}" for k, v in val.items() if stringify_leaf(v))
    return str(val)


def distinct_locales(raw_locales: Any) -> List[str]:
    items = raw_locales if isinstance(raw_locales, list) else ([raw_locales] if raw_locales else [])
    seen: List[str] = []
    for item in items:
        norm = str(item).strip().lower()
        if norm and norm not in seen:
            seen.append(norm)
    return seen


def has_multilocale_topology(passport: Dict[str, Any]) -> bool:
    url_topology, _ = extract_claim_val(passport, "market_rails.url_topology", "")
    pdr_constraints, _ = extract_claim_val(passport, "product_design_rails.constraints", [])
    market_sec = passport.get("market_rails", {})
    blob = " | ".join(
        [
            stringify_leaf(url_topology),
            stringify_leaf(pdr_constraints),
            stringify_leaf(market_sec),
        ]
    )
    return bool(TOPOLOGY_MARKERS.search(blob))


def is_thin_walking_skeleton(core_jobs: Any) -> bool:
    if isinstance(core_jobs, list):
        filled = [str(x).strip() for x in core_jobs if str(x).strip()]
        if len(filled) == 1 and "->" not in filled[0] and "→" not in filled[0]:
            return True
    elif isinstance(core_jobs, str) and core_jobs.strip():
        s = core_jobs.strip()
        if "->" not in s and "→" not in s and ";" not in s and "," not in s:
            return True
    return False


def detect_fluff(claims: List[Tuple[str, str, Any, str]]) -> List[Dict[str, str]]:
    warnings: List[Dict[str, str]] = []
    for path, status, val, _ in claims:
        if status in ("unknown", "taboo"):
            continue
        # Banned words / taboo lists intentionally contain clichés to ban!
        if path.endswith("banned_words") or path.endswith("forbidden_claims") or path.endswith("non_goals"):
            continue
        text = stringify_leaf(val)
        if not text:
            continue
        for code, pattern, hint in FLUFF_PATTERNS:
            m = pattern.search(text)
            if m:
                warnings.append(
                    {
                        "code": code,
                        "field_path": path,
                        "matched": m.group(0),
                        "status": status,
                        "remediation": hint,
                    }
                )
    return warnings


def extract_claim_val(passport: Dict[str, Any], dotted: str, default: Any = None) -> Tuple[Any, str]:
    cur: Any = passport
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default, "unknown"
        cur = cur[part]
    if is_claim_envelope(cur):
        status = str(cur.get("status") or "unknown")
        val = cur.get("value")
        return (val if claim_is_filled(val) else default), status
    return cur, ("confirmed" if claim_is_filled(cur) else "unknown")


def detect_contradictions(passport: Dict[str, Any]) -> List[Dict[str, str]]:
    issues: List[Dict[str, str]] = []

    primary_countries, pc_status = extract_claim_val(passport, "market_rails.primary_countries", [])
    excluded_countries, _ = extract_claim_val(passport, "market_rails.excluded_countries", [])
    ui_locales, _ = extract_claim_val(passport, "market_rails.ui_locales", [])
    content_locales, _ = extract_claim_val(passport, "market_rails.content_locales", [])
    payments, _ = extract_claim_val(passport, "market_rails.payment_rails", [])
    channels, _ = extract_claim_val(passport, "market_rails.allowed_channels", [])
    compliance, _ = extract_claim_val(passport, "market_rails.compliance_regimes", [])
    currency, _ = extract_claim_val(passport, "market_rails.currency", "")

    pc_upper = {str(c).strip().upper() for c in (primary_countries if isinstance(primary_countries, list) else [primary_countries]) if str(c).strip()}
    ex_upper = {str(c).strip().upper() for c in (excluded_countries if isinstance(excluded_countries, list) else [excluded_countries]) if str(c).strip()}
    locales_lower = [str(x).strip().lower() for x in ((ui_locales if isinstance(ui_locales, list) else []) + (content_locales if isinstance(content_locales, list) else [])) if str(x).strip()]

    excludes_ru = bool(ex_upper & RU_COUNTRIES) or (pc_status != "unknown" and len(pc_upper) > 0 and not (pc_upper & EAEU_COUNTRIES) and not any(loc.startswith("ru") for loc in locales_lower))

    rails_blob = " | ".join(
        [
            stringify_leaf(payments),
            stringify_leaf(channels),
            stringify_leaf(compliance),
            stringify_leaf(currency),
        ]
    )
    if excludes_ru and RU_ONLY_MARKERS.search(rails_blob):
        hit = RU_ONLY_MARKERS.search(rails_blob)
        issues.append(
            {
                "code": "MARKET_CHANNEL_CLASH",
                "severity": "high",
                "fields": "market_rails.primary_countries <-> market_rails.{payment_rails,allowed_channels,compliance_regimes}",
                "detail": f"Project targets non-RU markets ({sorted(pc_upper) or 'non-RU'}), but RU-specific rail '{hit.group(0) if hit else ''}' appears in payments/channels/compliance.",
                "fix": "Remove RU-only rails (Yandex Direct, ЮKassa, 152-ФЗ, erid, RUB) or explicitly add RU to target markets.",
            }
        )

    # Check RU-only market using Stripe without global entity warning
    only_ru = len(pc_upper) > 0 and pc_upper.issubset(RU_COUNTRIES)
    if only_ru and re.search(r"\bstripe\b", stringify_leaf(payments), re.IGNORECASE):
        issues.append(
            {
                "code": "RU_PAYMENT_CLASH",
                "severity": "medium",
                "fields": "market_rails.primary_countries <-> market_rails.payment_rails",
                "fields_note": "RU domestic buyers cannot pay via standard Stripe checkout with Russian cards.",
                "detail": "Target market is RU-only, but payment_rails lists Stripe.",
                "fix": "Use ЮKassa / Т-Касса / СБП / Robokassa / Telegram Stars for RU cards, or add international target markets.",
            }
        )

    # Multi-locale SEO topology & GeoIP redirect checks (The Art of SEO 4th ed.)
    c_locales = distinct_locales(content_locales)
    if len(c_locales) > 1 and not has_multilocale_topology(passport):
        issues.append(
            {
                "code": "MULTILOCALE_TOPOLOGY_MISSING",
                "severity": "medium",
                "fields": "market_rails.content_locales <-> market_rails.url_topology / product_design_rails.constraints",
                "detail": f"Multiple content_locales ({c_locales}) declared without an explicit URL topology (subfolder/ccTLD/subdomain) and reciprocal hreflang + self-canonical rail.",
                "fix": "Specify URL topology (e.g. /de/ subfolders), reciprocal hreflang + x-default, per-locale self-canonicals, and no GeoIP crawler auto-redirects.",
            }
        )

    pdr_constraints, _ = extract_claim_val(passport, "product_design_rails.constraints", [])
    url_topology_val, _ = extract_claim_val(passport, "market_rails.url_topology", "")
    for field_name, candidate_val in (
        ("market_rails.url_topology", url_topology_val),
        ("product_design_rails.constraints", pdr_constraints),
    ):
        items = candidate_val if isinstance(candidate_val, list) else [candidate_val]
        for entry in items:
            entry_str = stringify_leaf(entry)
            if entry_str and GEOIP_REDIRECT_RE.search(entry_str) and not NEGATION_GUARD_RE.search(entry_str):
                issues.append(
                    {
                        "code": "GEOIP_REDIRECT_TRAP",
                        "severity": "high",
                        "fields": f"market_rails.content_locales <-> {field_name}",
                        "detail": f"Auto-redirecting visitors/crawlers by GeoIP or Accept-Language ('{entry_str[:80]}') blocks search and AI bots from indexing non-US locales.",
                        "fix": "Serve 200 OK on all locale URLs from any IP with self-canonicals and reciprocal hreflang; offer a manual locale switcher banner instead.",
                    }
                )
                break

    # Check Price vs Sales Motion clash
    price_val, _ = extract_claim_val(passport, "economics_funnel.price_point", "")
    funnel_motion, _ = extract_claim_val(passport, "economics_funnel.sales_motion", "")
    price_str = stringify_leaf(price_val).lower()
    motion_str = stringify_leaf(funnel_motion).lower()

    low_dollar_match = re.search(r"(?:\$|usd\s*)(\d+(?:\.\d+)?)", price_str)
    if low_dollar_match:
        amt = float(low_dollar_match.group(1))
        if amt <= 25 and re.search(r"(whatsapp\s+closer|manual\s+sales|enterprise\s+outbound|менеджер\s+вручную|холодные\s+звонки)", motion_str):
            issues.append(
                {
                    "code": "PRICE_MOTION_CLASH",
                    "severity": "medium",
                    "fields": "economics_funnel.price_point <-> economics_funnel.sales_motion",
                    "detail": f"Low-ticket price (${amt}) paired with high-CAC manual sales motion ('{motion_str[:60]}').",
                    "fix": "Switch to self-serve checkout/PLG onboarding, or raise ACV/annual contract size to justify human sales.",
                }
            )

    # Check Stage / Zero Proof vs Case Claims clash
    stage_val, _ = extract_claim_val(passport, "identity.stage", "")
    zero_proof, _ = extract_claim_val(passport, "proof_brandcore.pre_launch_zero_proof", False)
    verified_facts, vf_status = extract_claim_val(passport, "proof_brandcore.verified_facts", [])
    facts_str = stringify_leaf(verified_facts)
    if (str(stage_val) == "idea_zero" or zero_proof is True) and vf_status == "confirmed":
        if re.search(r"\b(\d{2,}\s*(?:clients|customers|клиентов|компаний|отзывов|кейсов))\b", facts_str, re.IGNORECASE):
            issues.append(
                {
                    "code": "PROOF_STAGE_CLASH",
                    "severity": "high",
                    "fields": "identity.stage / proof_brandcore.pre_launch_zero_proof <-> proof_brandcore.verified_facts",
                    "detail": "Project is marked idea_zero / pre_launch_zero_proof, yet verified_facts claims dozens/hundreds of existing clients.",
                    "fix": "Never invent social proof on pre-launch projects; keep verified_facts limited to founder expertise, prototype benchmarks, or open methodology.",
                }
            )

    # Khononov DDD Core vs Generic Subdomain reinvention check
    one_liner_val, _ = extract_claim_val(passport, "identity.one_liner", "")
    market_cat_val, _ = extract_claim_val(passport, "positioning.market_category", "")
    core_jobs_val, cj_status = extract_claim_val(passport, "product_design_rails.core_jobs", [])
    scope_blob = f"{stringify_leaf(core_jobs_val)} | {stringify_leaf(pdr_constraints)}"
    domain_blob = f"{stringify_leaf(one_liner_val)} | {stringify_leaf(market_cat_val)}"
    if str(stage_val) in ("idea_zero", "mvp") and CUSTOM_GENERIC_RE.search(scope_blob) and not INFRA_CORE_DOMAIN_RE.search(domain_blob):
        hit = CUSTOM_GENERIC_RE.search(scope_blob)
        issues.append(
            {
                "code": "GENERIC_SUBDOMAIN_REINVENTION",
                "severity": "medium",
                "fields": "identity.stage <-> product_design_rails.core_jobs / identity.non_goals",
                "detail": f"Early-stage ({stage_val}) scope builds commodity Generic infrastructure from scratch ('{hit.group(0) if hit else ''}').",
                "fix": "Keep custom engineering strictly on the Core differentiator; buy/integrate off-the-shelf SaaS/OSS for auth, billing, and CRM in identity.non_goals.",
            }
        )

    # Patton Walking Skeleton completeness check
    if str(stage_val) in ("mvp", "live_cold", "scaling") and cj_status in ("confirmed", "hypothesis") and is_thin_walking_skeleton(core_jobs_val):
        issues.append(
            {
                "code": "THIN_WALKING_SKELETON",
                "severity": "low",
                "fields": "product_design_rails.core_jobs",
                "detail": "product_design_rails.core_jobs names a single isolated feature rather than a chronological Walking Skeleton (trigger -> core action -> user payoff).",
                "fix": "Map 3–5 ordered end-to-end user steps across the narrative backbone so MVP delivers a complete vertical slice.",
            }
        )

    # Cialdini / Ogilvy Honest Persuasion check against fake resetting timers
    grunt_val, _ = extract_claim_val(passport, "messaging_voice.grunt_test", "")
    persuasion_blob = f"{stringify_leaf(grunt_val)} | {motion_str}"
    if FAKE_SCARCITY_RE.search(persuasion_blob) and not NEGATION_GUARD_RE.search(persuasion_blob):
        issues.append(
            {
                "code": "FAKE_SCARCITY_CLASH",
                "severity": "high",
                "fields": "messaging_voice / economics_funnel.sales_motion <-> proof_brandcore.forbidden_claims",
                "detail": "Manufactured resetting countdown timer or fake scarcity tactic detected in funnel/messaging.",
                "fix": "Ban fake timers in proof_brandcore.forbidden_claims; use only verifiable capacity constraints or honest risk-reversal.",
            }
        )

    return issues


def compute_metrics(passport: Dict[str, Any]) -> Dict[str, Any]:
    section_scores: Dict[str, int] = {}
    confirmed_total = 0
    hypothesis_total = 0
    unknown_total = 0
    taboo_total = 0

    for sec in SECTIONS:
        sec_obj = passport.get(sec, {})
        claims = walk_claims(sec_obj, sec)
        if not claims:
            section_scores[sec] = 0
            unknown_total += 1
            continue
        earned = 0.0
        for _, status, _, _ in claims:
            if status == "confirmed":
                confirmed_total += 1
                earned += 1.0
            elif status == "taboo":
                taboo_total += 1
                earned += 1.0
            elif status == "hypothesis":
                hypothesis_total += 1
                earned += 0.65
            else:
                unknown_total += 1
        section_scores[sec] = int(round(100.0 * earned / len(claims)))

    weighted = sum(section_scores[s] * SECTION_WEIGHTS[s] for s in SECTIONS)
    completeness_score = int(round(weighted))

    content_locales, _ = extract_claim_val(passport, "market_rails.content_locales", [])
    multilocale_unready = len(distinct_locales(content_locales)) > 1 and not has_multilocale_topology(passport)

    readiness_by_domain: Dict[str, Dict[str, Any]] = {}
    for dom, req_secs in DOMAIN_REQUIRED_SECTIONS.items():
        avg = int(round(sum(section_scores.get(s, 0) for s in req_secs) / max(1, len(req_secs))))
        missing_secs = [s for s in req_secs if section_scores.get(s, 0) < 40]
        ready = avg >= 55 and "market_rails" not in missing_secs and "identity" not in missing_secs
        if dom in ("seo", "code") and multilocale_unready:
            ready = False
        readiness_by_domain[dom] = {
            "score": avg,
            "ready": ready,
            "thin_sections": missing_secs,
        }

    return {
        "completeness_score": completeness_score,
        "confirmed_count": confirmed_total,
        "hypothesis_count": hypothesis_total,
        "unknown_count": unknown_total,
        "taboo_count": taboo_total,
        "section_scores": section_scores,
        "readiness_by_domain": readiness_by_domain,
    }


def select_next_questions(
    passport: Dict[str, Any],
    metrics: Dict[str, Any],
    mode: str = "express",
    target_domain: str = "",
    max_questions: int = 3,
) -> List[Dict[str, Any]]:
    section_scores = metrics["section_scores"]
    candidates: List[Tuple[float, Dict[str, Any]]] = []
    content_locales, _ = extract_claim_val(passport, "market_rails.content_locales", [])
    is_multilocale = len(distinct_locales(content_locales)) > 1
    topology_locked = has_multilocale_topology(passport)

    for q in QUESTION_BANK:
        if mode not in q["modes"]:
            continue
        if mode == "domain_delta" and target_domain and target_domain not in q["domains"]:
            continue
        # Only ask multi-locale URL topology question when >1 content locale exists and topology is missing
        if q["id"] == "Q-RAILS-MULTILOCALE-SEO":
            if not is_multilocale or topology_locked:
                continue

        val, status = extract_claim_val(passport, q["field_path"], None)
        sec_score = section_scores.get(q["section"], 0)
        thin_skeleton = q["id"] == "Q-PRODUCT-UX-RAILS" and claim_is_filled(val) and is_thin_walking_skeleton(val)

        # Skip already well-answered fields unless entire section is very thin or skeleton/topology is incomplete
        if not thin_skeleton and q["id"] != "Q-RAILS-MULTILOCALE-SEO":
            if status in ("confirmed", "taboo") and claim_is_filled(val) and sec_score >= 60:
                continue
            if status == "hypothesis" and mode == "express" and claim_is_filled(val):
                continue

        urgency = float(q["priority"]) + (100.0 - sec_score) * 0.25
        if status == "unknown":
            urgency += 15.0
        if q["id"] == "Q-RAILS-MULTILOCALE-SEO" and is_multilocale and not topology_locked:
            urgency += 30.0
        if thin_skeleton:
            urgency += 18.0
        candidates.append((urgency, q))

    candidates.sort(key=lambda item: item[0], reverse=True)
    selected: List[Dict[str, Any]] = []
    seen_sections: set[str] = set()
    cap = max(1, min(3, max_questions))

    for _, q in candidates:
        if len(selected) >= cap:
            break
        # Prefer spreading across distinct sections in a single round
        if q["section"] in seen_sections and len(candidates) > cap:
            continue
        seen_sections.add(q["section"])
        selected.append(
            {
                "id": q["id"],
                "section": q["section"],
                "field_path": q["field_path"],
                "framework": q["framework"],
                "question_ru": q["question_ru"],
                "question_en": q["question_en"],
                "anti_fluff_probe": q["anti_fluff_probe"],
            }
        )
    return selected


def build_projections(passport: Dict[str, Any]) -> Dict[str, Any]:
    name, _ = extract_claim_val(passport, "identity.project_name", "Unnamed Project")
    one_liner, _ = extract_claim_val(passport, "identity.one_liner", "")
    stage, _ = extract_claim_val(passport, "identity.stage", "unknown")
    non_goals, _ = extract_claim_val(passport, "identity.non_goals", [])
    primary_countries, _ = extract_claim_val(passport, "market_rails.primary_countries", [])
    excluded_countries, _ = extract_claim_val(passport, "market_rails.excluded_countries", [])
    ui_locales, _ = extract_claim_val(passport, "market_rails.ui_locales", [])
    content_locales, _ = extract_claim_val(passport, "market_rails.content_locales", [])
    url_topology, _ = extract_claim_val(passport, "market_rails.url_topology", "")
    currency, _ = extract_claim_val(passport, "market_rails.currency", "")
    payments, _ = extract_claim_val(passport, "market_rails.payment_rails", [])
    compliance, _ = extract_claim_val(passport, "market_rails.compliance_regimes", [])
    forbidden_channels, _ = extract_claim_val(passport, "market_rails.forbidden_channels", [])
    icp, icp_st = extract_claim_val(passport, "positioning.best_fit_icp", "")
    alts, _ = extract_claim_val(passport, "positioning.status_quo_alternatives", [])
    core_val, _ = extract_claim_val(passport, "positioning.core_value", "")
    category, _ = extract_claim_val(passport, "positioning.market_category", "")
    verified_facts, _ = extract_claim_val(passport, "proof_brandcore.verified_facts", [])
    zero_proof, _ = extract_claim_val(passport, "proof_brandcore.pre_launch_zero_proof", False)
    forbidden_claims, _ = extract_claim_val(passport, "proof_brandcore.forbidden_claims", [])
    banned_words, _ = extract_claim_val(passport, "messaging_voice.banned_words", [])
    price_point, _ = extract_claim_val(passport, "economics_funnel.price_point", "")
    max_cac, _ = extract_claim_val(passport, "economics_funnel.max_cac", "")
    maturity_days, _ = extract_claim_val(passport, "economics_funnel.maturity_window_days", 14)

    brandcore_lines = [
        f"# BRANDCORE Projection — {name}",
        "",
        f"- **Stage:** {stage}",
        f"- **One-liner:** {one_liner or '(unknown)'}",
        f"- **Target Markets:** {', '.join(map(str, primary_countries)) if isinstance(primary_countries, list) and primary_countries else '(unspecified)'}",
        f"- **Excluded Markets:** {', '.join(map(str, excluded_countries)) if isinstance(excluded_countries, list) and excluded_countries else 'none'}",
        f"- **Locales (UI / Content):** {stringify_leaf(ui_locales) or '-'} / {stringify_leaf(content_locales) or '-'}",
        f"- **URL Topology:** {stringify_leaf(url_topology) or 'single-locale / default'}",
        f"- **Category:** {category or '(unspecified)'}",
        f"- **Best-Fit ICP ({icp_st}):** {icp or '(unspecified)'}",
        f"- **Status-Quo Alternatives:** {stringify_leaf(alts) or '(unspecified)'}",
        f"- **Core Provable Value:** {core_val or '(unspecified)'}",
        f"- **Non-Goals (Buy/Generic):** {stringify_leaf(non_goals) or 'none'}",
        f"- **Pre-Launch Zero-Proof Guard:** {'ON (NEVER fabricate cases/reviews)' if zero_proof else 'OFF'}",
        f"- **Verified Facts:** {stringify_leaf(verified_facts) or 'none recorded yet'}",
        f"- **Forbidden Claims / Taboos:** {stringify_leaf(forbidden_claims) or 'none'} | Banned words: {stringify_leaf(banned_words) or 'none'}",
    ]

    charter_defaults = {
        "project_name": name,
        "stage": stage,
        "primary_countries": primary_countries if isinstance(primary_countries, list) else [],
        "excluded_countries": excluded_countries if isinstance(excluded_countries, list) else [],
        "locales": content_locales if isinstance(content_locales, list) and content_locales else ui_locales,
        "url_topology": stringify_leaf(url_topology) or None,
        "currency": currency or "USD",
        "payment_rails": payments if isinstance(payments, list) else [],
        "compliance_regimes": compliance if isinstance(compliance, list) else [],
        "forbidden_channels": forbidden_channels if isinstance(forbidden_channels, list) else [],
        "price_point": price_point,
        "max_cac": max_cac,
        "maturity_window_days": maturity_days if isinstance(maturity_days, (int, float)) else 14,
        "pre_launch_zero_proof": bool(zero_proof),
    }

    return {
        "brandcore_md": "\n".join(brandcore_lines),
        "charter_defaults": charter_defaults,
    }


def evaluate_passport(payload: Dict[str, Any]) -> Dict[str, Any]:
    passport = payload.get("passport") if isinstance(payload.get("passport"), dict) else payload
    mode = str(payload.get("mode") or "express")
    target_domain = str(payload.get("target_domain") or "")
    max_questions = int(payload.get("max_questions") or 3)

    all_claims: List[Tuple[str, str, Any, str]] = []
    for sec in SECTIONS:
        if isinstance(passport.get(sec), dict):
            all_claims.extend(walk_claims(passport[sec], sec))

    metrics = compute_metrics(passport)
    fluff_warnings = detect_fluff(all_claims)
    contradictions = detect_contradictions(passport)
    next_questions = select_next_questions(passport, metrics, mode=mode, target_domain=target_domain, max_questions=max_questions)
    projections = build_projections(passport)

    verdict = "critical" if any(c.get("severity") == "high" for c in contradictions) else ("needs_discovery" if metrics["completeness_score"] < 55 else "ready")

    return {
        "ok": True,
        "version": VERSION,
        "verdict": verdict,
        "mode": mode,
        "target_domain": target_domain or None,
        "metrics": metrics,
        "fluff_warnings": fluff_warnings,
        "contradictions": contradictions,
        "next_questions": next_questions,
        "projections": projections,
        "summary": {
            "completeness_score": metrics["completeness_score"],
            "confirmed_count": metrics["confirmed_count"],
            "hypothesis_count": metrics["hypothesis_count"],
            "unknown_count": metrics["unknown_count"],
            "taboo_count": metrics["taboo_count"],
            "contradictions_count": len(contradictions),
            "fluff_count": len(fluff_warnings),
            "next_questions_count": len(next_questions),
        },
    }


def sample_fixture() -> Dict[str, Any]:
    return {
        "mode": "deep_grill",
        "target_domain": "marketing",
        "passport": {
            "identity": {
                "project_name": {"status": "confirmed", "value": "LedgerPulse", "evidence_ref": "vrb_001"},
                "one_liner": {"status": "confirmed", "value": "Automated Stripe-to-QuickBooks payout reconciliation for US multi-location dental groups.", "evidence_ref": "vrb_001"},
                "stage": {"status": "confirmed", "value": "mvp", "evidence_ref": "vrb_001"},
                "product_kind": {"status": "confirmed", "value": "saas", "evidence_ref": "vrb_001"},
                "non_goals": {"status": "taboo", "value": ["Buy Stripe Billing and Clerk Auth off-the-shelf (Generic subdomains); never build custom auth or invoicing"], "evidence_ref": "vrb_001"},
            },
            "market_rails": {
                "ui_locales": {"status": "confirmed", "value": ["en-US"], "evidence_ref": "vrb_002"},
                "content_locales": {"status": "confirmed", "value": ["en-US"], "evidence_ref": "vrb_002"},
                "primary_countries": {"status": "confirmed", "value": ["US", "CA"], "evidence_ref": "vrb_002"},
                "excluded_countries": {"status": "taboo", "value": ["RU", "BY", "CN"], "evidence_ref": "vrb_002"},
                "currency": {"status": "confirmed", "value": "USD", "evidence_ref": "vrb_002"},
                "payment_rails": {"status": "confirmed", "value": ["Stripe", "ACH"], "evidence_ref": "vrb_002"},
                "compliance_regimes": {"status": "confirmed", "value": ["SOC2-ready", "CCPA"], "evidence_ref": "vrb_002"},
                "allowed_channels": {"status": "confirmed", "value": ["Google Search", "LinkedIn", "Dental accounting podcasts"], "evidence_ref": "vrb_002"},
                "forbidden_channels": {"status": "taboo", "value": ["Yandex Direct", "VK Ads", "TikTok"], "evidence_ref": "vrb_002"},
            },
            "positioning": {
                "status_quo_alternatives": {"status": "confirmed", "value": ["Bookkeeper manually matching CSV exports in Excel every Friday (6 hours/week, silent formula drift)"], "evidence_ref": "vrb_003"},
                "unique_attributes": {"status": "confirmed", "value": ["Line-item split of insurance co-pays, merchant fees, and chargebacks in 90 seconds"], "evidence_ref": "vrb_003"},
                "core_value": {"status": "confirmed", "value": "Closes monthly books 4 days faster with zero penny-drift errors", "evidence_ref": "vrb_003"},
                "best_fit_icp": {"status": "confirmed", "value": "Controllers at US dental service organizations (DSOs) with 4–25 clinics", "evidence_ref": "vrb_003"},
                "market_category": {"status": "confirmed", "value": "Healthcare payout reconciliation software", "evidence_ref": "vrb_003"},
            },
            "audience_jtbd": {
                "trigger_event": {"status": "hypothesis", "value": "Failed external audit or acquiring a 4th clinic location", "evidence_ref": "vrb_004"},
                "four_forces": {
                    "push": {"status": "confirmed", "value": "Friday spreadsheet hell and unexplained Stripe fee discrepancies", "evidence_ref": "vrb_004"},
                    "pull": {"status": "confirmed", "value": "1-click balanced QuickBooks journal entry with audit trail", "evidence_ref": "vrb_004"},
                    "anxiety": {"status": "hypothesis", "value": "Fear that automated sync will overwrite historical QuickBooks ledger entries", "evidence_ref": "vrb_004"},
                    "habit": {"status": "confirmed", "value": "Existing VLOOKUP macro built by senior bookkeeper", "evidence_ref": "vrb_004"},
                },
                "awareness_level": {"status": "confirmed", "value": "problem_aware", "evidence_ref": "vrb_004"},
            },
            "messaging_voice": {
                "grunt_test": {"status": "confirmed", "value": "Reconcile dental Stripe & PMS payouts into QuickBooks in 90 seconds — Try Read-Only Sandbox", "evidence_ref": "vrb_005"},
                "tone_of_voice": {"status": "confirmed", "value": "Calm, audit-grade, plainspoken controller-to-controller", "evidence_ref": "vrb_005"},
                "owner_lexicon": {"status": "confirmed", "value": ["penny-drift", "Friday CSV hell", "read-only sandbox first"], "evidence_ref": "vrb_005"},
                "banned_words": {"status": "taboo", "value": ["AI magic", "revolutionary", "for everyone", "seamless synergy"], "evidence_ref": "vrb_005"},
            },
            "economics_funnel": {
                "pricing_model": {"status": "hypothesis", "value": "Per-location SaaS subscription", "evidence_ref": "vrb_006"},
                "price_point": {"status": "hypothesis", "value": "$149/mo per clinic", "evidence_ref": "vrb_006"},
                "sales_motion": {"status": "hypothesis", "value": "Interactive read-only sandbox -> 15-min controller walkthrough", "evidence_ref": "vrb_006"},
                "max_cac": {"status": "unknown", "value": "", "evidence_ref": ""},
                "maturity_window_days": {"status": "hypothesis", "value": 21, "evidence_ref": "vrb_006"},
            },
            "proof_brandcore": {
                "pre_launch_zero_proof": {"status": "confirmed", "value": True, "evidence_ref": "vrb_007"},
                "verified_facts": {"status": "confirmed", "value": ["Built by former 12-clinic DSO controller; tested on 50,000 anonymized payout rows"], "evidence_ref": "vrb_007"},
                "forbidden_claims": {"status": "taboo", "value": ["Never invent customer logos or G2 badges before launch", "Never claim HIPAA certification until BAA audit completes"], "evidence_ref": "vrb_007"},
            },
            "product_design_rails": {
                "core_jobs": {"status": "confirmed", "value": ["Connect Stripe + QuickBooks in read-only preview", "Inspect discrepancy diff table", "Approve journal post"], "evidence_ref": "vrb_008"},
                "devices": {"status": "confirmed", "value": ["desktop_workspace_1440"], "evidence_ref": "vrb_008"},
                "constraints": {"status": "confirmed", "value": ["Quality rank: Consistency & Idempotency > Security > UX friction > Raw latency; USD formatting"], "evidence_ref": "vrb_008"},
            },
        },
    }


def run_selftest() -> int:
    # 1. Fixture clean evaluation
    fx = evaluate_passport(sample_fixture())
    assert fx["ok"] is True
    assert fx["verdict"] == "ready", f"Expected ready, got {fx['verdict']}"
    assert fx["metrics"]["completeness_score"] >= 80, fx["metrics"]
    assert len(fx["contradictions"]) == 0, fx["contradictions"]
    assert len(fx["fluff_warnings"]) == 0, fx["fluff_warnings"]
    assert fx["projections"]["charter_defaults"]["currency"] == "USD"
    assert "NEVER fabricate" in fx["projections"]["brandcore_md"]

    # 2. Empty cold-start passport -> selects top 3 express questions starting with identity & market_rails
    cold = evaluate_passport({"mode": "express", "passport": {}})
    assert cold["metrics"]["completeness_score"] == 0
    assert cold["verdict"] == "needs_discovery"
    assert len(cold["next_questions"]) == 3
    q_ids = [q["id"] for q in cold["next_questions"]]
    assert "Q-ID-CORE" in q_ids and "Q-RAILS-LOCALE-GEO" in q_ids, q_ids

    # 3. Contradiction & Fluff detection (US SaaS leaking Yandex/RUB + fake pre-launch clients + Mom Test fluff)
    bad = evaluate_passport(
        {
            "mode": "deep_grill",
            "passport": {
                "identity": {
                    "project_name": {"status": "confirmed", "value": "GlobalAI"},
                    "stage": {"status": "confirmed", "value": "idea_zero"},
                    "one_liner": {"status": "confirmed", "value": "Инновационный продукт для всех предпринимателей под ключ"},
                },
                "market_rails": {
                    "primary_countries": {"status": "confirmed", "value": ["US"]},
                    "excluded_countries": {"status": "taboo", "value": ["RU"]},
                    "ui_locales": {"status": "confirmed", "value": ["en-US"]},
                    "payment_rails": {"status": "confirmed", "value": ["ЮKassa", "Stripe"]},
                    "allowed_channels": {"status": "confirmed", "value": ["Яндекс Директ", "Google Ads"]},
                },
                "economics_funnel": {
                    "price_point": {"status": "hypothesis", "value": "$15/mo"},
                    "sales_motion": {"status": "hypothesis", "value": "manual sales closer in WhatsApp"},
                },
                "proof_brandcore": {
                    "pre_launch_zero_proof": {"status": "confirmed", "value": True},
                    "verified_facts": {"status": "confirmed", "value": ["500 clients already love us"]},
                },
            },
        }
    )
    assert bad["verdict"] == "critical"
    c_codes = {c["code"] for c in bad["contradictions"]}
    assert "MARKET_CHANNEL_CLASH" in c_codes, c_codes
    assert "PRICE_MOTION_CLASH" in c_codes, c_codes
    assert "PROOF_STAGE_CLASH" in c_codes, c_codes
    f_codes = {f["code"] for f in bad["fluff_warnings"]}
    assert "EVERYONE_ICP" in f_codes and "SUNDAY_BUZZWORDS" in f_codes, f_codes

    # 4. Multi-locale URL topology, GeoIP redirect trap, DDD Core vs Generic & Walking Skeleton checks
    multi = evaluate_passport(
        {
            "mode": "domain_delta",
            "target_domain": "code",
            "passport": {
                "identity": {
                    "project_name": {"status": "confirmed", "value": "MenuSnap"},
                    "one_liner": {"status": "confirmed", "value": "QR menu translator for European bistros"},
                    "stage": {"status": "confirmed", "value": "mvp"},
                },
                "market_rails": {
                    "primary_countries": {"status": "confirmed", "value": ["DE", "FR", "ES"]},
                    "content_locales": {"status": "confirmed", "value": ["de-DE", "fr-FR", "es-ES"]},
                    "currency": {"status": "confirmed", "value": "EUR"},
                    "payment_rails": {"status": "confirmed", "value": ["Stripe"]},
                },
                "product_design_rails": {
                    "core_jobs": {"status": "confirmed", "value": ["Build own billing from scratch"]},
                },
            },
        }
    )
    m_codes = {c["code"] for c in multi["contradictions"]}
    assert "MULTILOCALE_TOPOLOGY_MISSING" in m_codes, m_codes
    assert "GENERIC_SUBDOMAIN_REINVENTION" in m_codes, m_codes
    assert "THIN_WALKING_SKELETON" in m_codes, m_codes
    assert multi["metrics"]["readiness_by_domain"]["code"]["ready"] is False
    m_qids = {q["id"] for q in multi["next_questions"]}
    assert "Q-RAILS-MULTILOCALE-SEO" in m_qids, m_qids

    geo_trap = evaluate_passport(
        {
            "mode": "express",
            "passport": {
                "identity": {"stage": {"status": "confirmed", "value": "mvp"}},
                "market_rails": {
                    "content_locales": {"status": "confirmed", "value": ["en-US", "de-DE"]},
                    "url_topology": {"status": "confirmed", "value": "subfolder (/de/) with self-canonical and hreflang"},
                },
                "product_design_rails": {
                    "constraints": {"status": "confirmed", "value": ["GeoIP auto-redirect by IP to locale"]},
                },
            },
        }
    )
    gt_codes = {c["code"] for c in geo_trap["contradictions"]}
    assert "MULTILOCALE_TOPOLOGY_MISSING" not in gt_codes, gt_codes
    assert "GEOIP_REDIRECT_TRAP" in gt_codes, gt_codes
    assert geo_trap["verdict"] == "critical"

    print(json.dumps({"ok": True, "selftest": "passed", "checks": 22, "version": VERSION}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Living Project Passport deterministic grill engine.")
    parser.add_argument("--input", help="Path to input JSON or '-' for stdin")
    parser.add_argument("--fixture", action="store_true", help="Run built-in US B2B SaaS fixture")
    parser.add_argument("--selftest", action="store_true", help="Run deterministic self-tests")
    args = parser.parse_args()

    try:
        if args.selftest:
            return run_selftest()
        if args.fixture:
            print(json.dumps(evaluate_passport(sample_fixture()), ensure_ascii=False))
            return 0
        if not args.input:
            print(json.dumps(evaluate_passport(sample_fixture()), ensure_ascii=False))
            return 0
        raw_text = sys.stdin.read() if args.input == "-" else open(args.input, "r", encoding="utf-8").read()
        payload = json.loads(raw_text) if raw_text.strip() else {}
        if not isinstance(payload, dict):
            raise ValueError("Input JSON must be an object")
        print(json.dumps(evaluate_passport(payload), ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())

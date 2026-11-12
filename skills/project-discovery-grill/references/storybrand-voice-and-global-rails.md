# StoryBrand Voice, Brand Coherence, Honest Persuasion & Global SEO/Market Rails

Distilled from:
- Donald Miller — *Building a StoryBrand 2.0* (2025)
- Nicole Fenton & Kate Kiefer Lee — *Nicely Said* (2014)
- Alina Wheeler — *Designing Brand Identity* (5th ed.)
- Robert B. Cialdini — *Influence* (New & Expanded, 2021) & David Ogilvy — *Ogilvy on Advertising* (1983)
- Eric Enge, Stephan Spencer & Jessie Stricchiola — *The Art of SEO* (4th ed., 2023)

---

## 1. StoryBrand SB7 & The 5-Second Caveman Grunt Test

When a page confuses the reader, conversion dies: the customer is the hero, and the brand acts strictly as the guide.

### Mapping `messaging_voice` in `PassportV1`
1. **Hero & Desire:** Who the customer is and the single tangible outcome they want.
2. **Three Levels of Problem:**
   - *External*: concrete workflow bottleneck,
   - *Internal* (`hero_internal_problem`): how that bottleneck makes them feel (anxious, blind, amateurish, afraid of costly errors) — **buyers pay to resolve internal tension**,
   - *Philosophical*: why that friction shouldn't exist in modern work.
3. **Guide (Empathy + Competency):** Express empathy in 1 crisp sentence and back competency with verified facts (`proof_brandcore`).
4. **3-Step Process Plan (`three_step_plan`):** 3–4 concrete steps bridging current state → payoff (dissolves onboarding fog).
5. **Direct & Transitional CTA:** High-contrast primary action (`Start Free Audit`, `Book 15-min Demo`) + low-risk preview (`See Read-Only Sample`).
6. **5-Second Grunt Test (`grunt_test`):** Above the fold on 375×812 mobile, pair **Ogilvy's Specific Factual Promise Rule** (concrete numbers, time, or named ICP — headlines draw ~5× the readership of body copy) to answer:
   - *What exact outcome/product is this?*
   - *Who is it for and what does it save/earn?*
   - *What happens the second I click?*

---

## 2. *Nicely Said* & Alina Wheeler's *Designing Brand Identity*

### Verbatim Voice vs Situational Tone (*Nicely Said*)
- **Voice** (`messaging_voice.tone_of_voice`): Stable public character across UI microcopy, docs, ads, and support.
- **Tone**: Shifts with user stress (calm and factual on billing/errors; brisk on onboarding wins).
- **Verbatim Lexicon (`owner_lexicon` vs `banned_words`):** Preserve 3–8 vivid founder/customer phrases from `VERBATIM.jsonl` and explicitly ban AI sludge («инновационный», «под ключ», «seamless synergy», «unlock your potential», «delve»).

### Brand Coherence & Visual Differentiation (*Designing Brand Identity*)
1. **Three Signature Touchpoints (`product_design_rails`):** Lock consistent visual and verbal craft across the three moments that define brand memory:
   - *Touchpoint 1 — First 5-Second Entry* (landing hero / Telegram bot `/start` card),
   - *Touchpoint 2 — Trust Threshold* (checkout, permission grant, or pricing comparison),
   - *Touchpoint 3 — Shareable Output Artifact* (exported PDF/report, generated video/image, public link, or audit scorecard that travels word-of-mouth).
2. **Visual Differentiation vs Category Clichés (`visual_references` vs `anti_references`):**
   - Audit `status_quo_alternatives` visual tropes and record 1–3 concrete `visual_references` alongside explicit `anti_references` (e.g., ban generic dark-purple AI neon gradients, fake stock-photo handshakes, or cluttered 40-widget admin chrome).

---

## 3. Cialdini & Ogilvy: Honest Persuasion Guardrails (`proof_brandcore`)

1. **Zero Manufactured Scarcity or Social Proof:** Lock hard bans in `proof_brandcore.forbidden_claims` against resetting countdown timers, fake «2 seats left» banners, and invented customer logos/reviews when `pre_launch_zero_proof == true`.
2. **Authority Boost via Honest Limitation Admission (*Cialdini*):** Pair `audience_jtbd.anti_audience` with an explicit admission of who the product is *not* built for (e.g., «Built for 4–25 clinic DSOs on QuickBooks; not designed for solo practices on paper ledgers») right before stating the core claim — candor disarms cold-traffic skepticism.
3. **Caption & Proof Specificity (*Ogilvy*):** Every product visual or case artifact requires a factual benefit caption rather than naked screenshots or boastful superlatives.

---

## 4. Global Market Rails & Multi-Locale SEO Architecture (*The Art of SEO* 4th ed.)

When `len(market_rails.content_locales) > 1` (or multi-country regional variants exist), lock **International SEO Architecture** in Gate 1 (`market_rails.url_topology` / `product_design_rails.constraints`) before any route or page ships:

1. **Explicit URL Topology Choice:**
   - **Subfolders (`example.com/de/`, `example.com/es/`)**: Default for SaaS/content — consolidates domain authority, simplest TLS/CDN ops.
   - **ccTLDs (`example.de`, `example.fr`)**: Strongest local country trust signal, but splits link equity and multiplies ops/domain cost.
   - **Subdomains (`de.example.com`)**: Useful only when regional infrastructure must be isolated; weaker authority inheritance than subfolders.
   *(Never rely on URL query parameters like `?lang=de` for indexable locales!)*
2. **Reciprocal `hreflang` + `x-default` + Per-Locale Self-Canonical Invariant:**
   - Every localized page MUST carry a **self-referential `rel="canonical"`** pointing to its own locale URL (never canonicalize `/de/pricing` back to `/en/pricing` — doing so deindexes the German page!).
   - Every cluster emits full bidirectional `hreflang` links (`ISO 639-1` language + optional `ISO 3166-1` country, e.g. `en-US`, `de-DE`, plus `x-default` fallback).
3. **Strict Ban on GeoIP / `Accept-Language` Auto-Redirects:**
   - Search crawlers (Googlebot crawls predominantly from US IPs; AI/RAG bots crawl from cloud regions) get locked out of non-US locales if the server `301/302` redirects based on GeoIP or `Accept-Language`. Serve `200 OK` on every locale URL from any IP and render a non-intrusive manual language banner instead.

### Cross-Market Rail Matrix (Enforced by `passport_grill_engine.py`)

| Market Archetype | UI / Content Locales | Currency & Payments | Legal & Trust Signals | Allowed Search / Ad / Social Channels | Hard Forbidden Leaks (`taboo`) |
|---|---|---|---|---|---|
| **US / Global English (`US`, `CA`, `GB`, `AU`)** | `en-US` / `en-GB` | `USD` (`$`), Stripe, Paddle, Apple/Google Pay | ToS, Privacy (CCPA/GDPR), SOC2, G2 / Trustpilot / LinkedIn | Google, Bing, Meta/IG, X, LinkedIn, Reddit, YouTube, ChatGPT/Perplexity GEO | Cyrillic UI, `+7` phones, `RUB`/`₽`, `152-ФЗ`, `ИНН/ОГРН`, `erid`, `ЮKassa/СБП`, `Яндекс.Директ`, `Эльба` |
| **EU / DACH (`DE`, `AT`, `CH`, `FR`, `ES`, `NL`)** | `de-DE`, `en-GB`, `fr-FR`, `es-ES` | `EUR` (`€`), Stripe, SEPA, Klarna, PayPal | **GDPR consent**, **Impressum** (mandatory in DACH), EU VAT | Google, Bing, LinkedIn, Meta, Perplexity/ChatGPT | Unconsented trackers, US-only phone masks, RU payment/ad rails |
| **LATAM / MENA / Global Telegram** | `es-419`, `pt-BR`, `ar`, `en` | `USD` / local (`PIX` in BR, Telegram Stars, Stripe) | WhatsApp-first / Telegram-first trust + local proof | Meta/WhatsApp Click-to-Chat, TikTok, Google, Telegram Ads | Desktop-only heavy forms, RU legal/payment markers |
| **Russia / EAEU (`RU`, `BY`, `KZ`)** | `ru-RU` (`kk-KZ`) | `RUB` (`₽`), ЮKassa, Т-Касса, СБП, счёт (`Эльба`) | `152-ФЗ` (ПДн), `38-ФЗ` (**маркировка `erid` / ОРД**), ИНН/ОГРН | Яндекс Поиск / Директ / Метрика, Telegram Ads, VK, Дзен, Авито, Алиса AI | Stripe checkout на РФ-карты без оговорки, креативы без `erid` |

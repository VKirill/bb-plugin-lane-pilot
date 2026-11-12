# Elicitation Discipline: The Mom Test, Trusted Advisor, Requirements, Story Mapping & DDD

Distilled from:
- Rob Fitzpatrick — *The Mom Test* (2013)
- Charles H. Green & Robert M. Galford — *The Trusted Advisor* (2000)
- Karl E. Wiegers — *Software Requirements* (3rd ed.)
- Jeff Patton — *User Story Mapping* (2014)
- Vladik Khononov — *Learning Domain-Driven Design* (2021)
- Peter Block — *Flawless Consulting* (3rd ed.)

---

## 1. *The Trusted Advisor*: The Trust Equation in Founder Grill Rounds

Founders shut down or give defensive one-word answers when an interviewer acts like a bureaucratic form-filler. Green & Galford model interview trust as:

$$T = \frac{\text{Credibility} + \text{Reliability} + \text{Intimacy}}{\text{Self-Orientation}}$$

- **Why robotic questionnaires fail:** Firing 10 schema questions in one turn spikes **Self-Orientation** (the agent cares about filling its JSON slots, not solving the founder's bottleneck) and collapses **Intimacy** (psychological safety to admit gaps).
- **Three Operational Grill Habits:**
  1. **Reflect Exact Pain Before Probing Numbers (`Intimacy` + `Credibility`):** Open follow-up turns by mirroring the founder's sharpest bottleneck in 1 sentence using their verbatim nouns before asking for metrics or trade-offs.
  2. **Permission Gate on Sensitive Economics (`Intimacy`):** Before probing CAC ceilings, margins, or runway, ask permission explicitly (e.g., «Уместно сейчас зафиксировать целевой чек и потолок CAC, или пока оставим гипотезой?»).
  3. **Micro-Promises Kept (`Reliability`):** Announce 2–3 questions per round, explain *which downstream workflow* needs each answer, and honor «сохранить как есть» immediately.

---

## 2. Adapting *The Mom Test* to Founder Discovery Interviews

When interviewing a founder (or auditing what the founder believes about customers), polite agreement is fatal. If an AI interviewer accepts vague optimism as confirmed truth, every downstream agent (SEO, Ads, Copy, UI, Code) inherits a hallucination.

### Three Core Rules
1. **Anchor in life & workflow, not pitch adjectives:** Ask what the target customer *currently does on Monday morning* before our product exists, not how great our features sound.
2. **Specifics in the past > generics or future promises:** Phrases with «usually», «always», «would definitely pay», «всем нужно» are *hypothesis* at best, never *confirmed* evidence.
3. **Customer Slicing (Who-Where Pair):** Slice broad labels until you reach a findable person in a specific trigger context.
   - Bad (`fluff`): «Малый бизнес», «Предприниматели», «Все, кто учит английский», «SMBs globally».
   - Sliced (`confirmed` / testable `hypothesis`): «Владельцы стоматологий на 3–7 кресел в Москве», «US Shopify Plus retention leads spending $20k+/mo on Klaviyo».

### Detecting & Deflecting the Three Types of Bad Data

| Bad Data Type | Typical Founder Input | Interviewer Deflection / Follow-Up Probe | Epistemic Tag if Unresolved |
|---|---|---|---|
| **Compliments / Ego Pitch** | «Друзья сказали, идея огонь, аналогов нет» | «Как именно эти люди решают задачу сейчас и сколько часов или денег теряют в неделю?» | `hypothesis` |
| **Fluff (Generics & Future)** | «Клиенты обычно хотят удобство и готовы платить $50» | «Вспомни последний случай: кто конкретно уже заплатил или отказался, и что стало решающим?» | `hypothesis` |
| **Feature-First (`Orphan Functionality`)** | «Нам нужен ИИ-чатбот, дашборд и рефералка в MVP» | «Какое одно действие в первый визит даёт ценность, без которой остальной функционал бессмысленен?» | `product_design_rails.core_jobs` probe |

---

## 3. Wiegers Software Requirements: User Classes, Boundary & Quality Trade-Offs

Separate **why**, **who**, **system boundary**, and **non-functional trade-offs** so `lp.analyze`, `lp.plan`, and `mvp-phase` receive unambiguous engineering rails:

1. **User Classes Matrix:** Differentiate actors across three axes — **usage frequency** (daily operator vs occasional guest), **privilege level** (end-user, tenant admin, billing approver), and **domain/tech expertise**. Name the **Favored User Class** so UX conflicts resolve deterministically.
2. **System Boundary & Context Actors:** Draw a hard line between what our code owns vs external actors/APIs (Stripe/ЮKassa webhooks, QuickBooks/CRM, Telegram Bot API, human moderators).
3. **`Stimulus -> System Response` Rules:** Replace vague feature nouns with behavioral pairs (`When user uploads CSV -> system validates schema in <2s and renders diff preview without writing to ledger`).
4. **Quality Attribute Trade-off Matrix (`product_design_rails.constraints`):** Latency, Consistency/Accuracy, Security/Compliance, and Zero-Friction UX inevitably collide. Force a strict rank order per domain:
   - *Fintech / Ledger / Medical*: `Consistency & Auditability > Security > Zero-Friction UX > Raw Latency`.
   - *Consumer Bot / Paid Landing*: `Zero-Friction UX & Speed (<2s) > Visual Polish > Strict Normalization`.

### Anti-Ambiguity Rule (Wiegers Ch. 1, Ch. 15)
Never store unquantified adjectives as requirements:
- Replace «быстрый / fast» → concrete latency budget (`LCP <= 2.5s`, preview `< 3s`).
- Replace «простой / интуитивный / user-friendly» → «без регистрации до первого превью» or «оплата в 2 клика через Apple Pay».
- Replace «под ключ / all-in-one» → explicit 1–3 core jobs included plus excluded scope (`non_goals`).

---

## 4. Jeff Patton's *User Story Mapping*: Backbone vs Walking Skeleton

1. **Narrative Backbone (`Activities -> Tasks` left-to-right):** Map the user's journey in strict chronological order from initial trigger to final value delivery («mile wide, inch deep»). Do not collect an unordered bag of features.
2. **Vertical Release Slice (`Walking Skeleton` -> `product_design_rails.core_jobs`):** Cut the thinnest **end-to-end vertical slice** across the entire backbone that delivers real user payoff in MVP Release 1. Never build horizontal infrastructure layers (full RBAC, multi-tier billing, referral cabinet) before the 3–5 backbone steps of the Walking Skeleton work end-to-end.

---

## 5. Vladik Khononov's *Learning DDD*: Subdomain Triage & Ubiquitous Language

1. **Subdomain Triage (`Core` vs `Supporting` vs `Generic`):**
   - **`Core` Subdomain (Build bespoke):** The proprietary mechanism, ranking model, or workflow where custom code creates unfair market advantage (`positioning.unique_attributes` + `product_design_rails.core_jobs`).
   - **`Supporting` Subdomain (Keep thin CRUD):** Domain-specific glue with zero competitive moat — implement with minimal standard CRUD, zero over-engineering.
   - **`Generic` Subdomain (Buy / SaaS / OSS -> lock in `identity.non_goals`):** Solved commodity capabilities (auth/SSO, recurring billing, email/SMS delivery, analytics, standard admin). Explicitly record «buy/integrate off-the-shelf, never build custom» in `identity.non_goals`.
2. **Ubiquitous Language & Homonym Collision Detection (`identity.domain_glossary`):**
   - Detect overloaded words (`lead`, `account`, `order`, `conversion`, `session`, `credit`) that shift meaning across Marketing, Sales, UI, and Database tables.
   - Pin one canonical definition per bounded context in `domain_glossary` and preserve exact founder phrasing in `messaging_voice.owner_lexicon`.

---

## 6. *Flawless Consulting*: Contracting & Honest Unknowns

Peter Block shows that resistance in discovery («не знаю», «потом решим», terse replies) comes from feeling interrogated without control.
1. **50/50 Control:** Keep rounds to 2–3 questions max and always offer «Достаточно на сейчас — сохранить паспорт как есть».
2. **Normalize `unknown` and `hypothesis`:** On `idea_zero`, not knowing CAC or retention is honest signal, never failure.
3. **Never push founders into inventing numbers:** Record `status: "unknown"` (or `"hypothesis"` for target ranges), set `proof_brandcore.pre_launch_zero_proof = true`, and route to `web-research`, `research-dossier`, `spike`, or `mkt-experiment-cycle`.

# Positioning, Mental Rungs, Awareness & Strategy Kernel

Distilled from:
- April Dunford — *Obviously Awesome* (2019)
- Al Ries & Jack Trout — *Positioning: The Battle for Your Mind* (2001)
- Eugene M. Schwartz — *Breakthrough Advertising* (1966)
- Richard P. Rumelt — *Good Strategy / Bad Strategy* (2011)

---

## 1. April Dunford's 5+1 Positioning Sequence (Strict Causal Order)

Never ask «В чём ваше позиционирование?» or use a fill-in-the-blanks Mad-Libs template. Extract the 5+1 components in strict dependency order:

| Step | Passport Field | Discovery Question | Common Trap to Catch |
|---|---|---|---|
| **1. Competitive Alternatives (`status_quo_alternatives`)** | `positioning.status_quo_alternatives` | «Если бы вашего продукта не было, что бы сделал клиент в понедельник утром? (Excel, стажёр, мессенджер, конкурент или забил?)» | Listing only obscure startups while 80% of buyers actually use Excel or manual workarounds |
| **2. Unique Attributes (`unique_attributes`)** | `positioning.unique_attributes` | «Что объективно есть в продукте или подходе (механика, данные, скорость), чего нет у этой альтернативы?» | Vague claims like «лучшее качество» or «индивидуальный подход» |
| **3. Provable Value (`core_value`)** | `positioning.core_value` | «Что это даёт клиенту в деньгах, часах или снятом риске? (*So what?* test)» | Stopping at technical features (*Feature-Only Pitch*) |
| **4. Best-Fit Customers (`best_fit_icp`)** | `positioning.best_fit_icp` | «У кого эта боль горит так сильно, что ценность очевидна с полуслова?» | Refusing to narrow down («подходит всем») |
| **5. Market Frame of Reference (`market_category`)** | `positioning.market_category` | «На какую понятную полку в голове покупателя ставим продукт? (*Head-to-Head*, *Big Fish Small Pond*, *New Game*)» | *Trend-First Blunder*: saying «AI Web3 agent» without naming the category |
| **+1. Relevant Trend (`relevant_trend`)** | `positioning.relevant_trend` | «Какой сдвиг на рынке делает покупку срочной именно в этом году?» (optional) | Layering a buzzword disconnected from core value |

---

## 2. Al Ries & Jack Trout — *Positioning: The Battle for Your Mind*

Positioning is not what you do to a product; it is how you anchor a single unmistakable concept in the overloaded mind of a prospect.

1. **Own One Clear Mental Rung:** Cold prospects remember at most 1–2 leaders per mental ladder. Never stack five unrelated value propositions in `identity.one_liner`. If an incumbent already owns the broad rung («all-in-one CRM»), carve out and own #1 in a sharp sub-ladder (*Big Fish, Small Pond*: e.g., «QuickBooks payout reconciliation for multi-clinic dental groups»).
2. **Avoid the Line-Extension Trap:** Stretching one early brand/product to serve opposite segments («for solo freelancers AND enterprise banks», «both agency service AND self-serve dev tool») blurs mental recall and breaks conversion match. Lock excluded segments in `audience_jtbd.anti_audience` and out-of-bounds product lines in `identity.non_goals`.
3. **Reposition the `status_quo_alternatives` Category Weakness:** Rather than boasting «we are better/faster», expose the **structural flaw inherent in the old category's design** so the buyer cannot unsee it:
   - *Manual spreadsheets / scripts*: silent human formula drift with zero audit trail.
   - *Legacy enterprise suites*: 90-day implementation and seat bloat built for IT buyers, not daily operators.
   - *Hourly agencies / freelancers*: billed hours reward slow turnaround rather than instant self-serve output.
   Pair every entry in `positioning.status_quo_alternatives` with the structural weakness that makes our `unique_attributes` inevitable.

---

## 3. Eugene Schwartz: 5 States of Awareness × 5 Stages of Market Sophistication

Downstream SEO (`seo-cocoon`, `seo-page`), CRO (`mkt-landing-cro-audit`), Ads (`mkt-direct-search-campaign`, `mkt-tg-ads-campaign`), and Video (`reels`) must know **where the buyer's head starts**:

### 5 States of Customer Awareness (`audience_jtbd.awareness_level`)
1. **`most_aware`**: Knows our product, only needs the deal, price, and direct CTA.
2. **`product_aware`**: Knows what we sell, unsure we outperform alternatives → needs proof, mechanism contrast, risk reversal.
3. **`solution_aware`**: Wants the outcome and knows solutions exist, doesn't know our brand → lead with desired outcome + differentiating mechanism.
4. **`problem_aware`**: Feels the pain acutely, doesn't know a category solution exists → lead with empathy + naming the problem + why status quo fails.
5. **`unaware`**: Doesn't recognize the problem yet (cold Reels/Dzen/Social feeds) → lead with story, identity, or hidden symptom, *never* price or brand name.

### 5 Stages of Market Sophistication (`positioning.market_sophistication`)
- **Stage 1 (First in market):** State the direct claim simply («Автоматическая сверка счетов за 10 секунд»).
- **Stage 2 (Second wave):** Enlarge the claim with concrete measure («Сверка 10 000 строк за 10 секунд за $29/мес»).
- **Stage 3 (Crowded claims, buyer skepticism):** Lead with the **Unique Mechanism** (*how* it works so the buyer believes *why* prior tools failed).
- **Stage 4 (Competitors copy mechanism):** Enlarge and specify the mechanism (speed, zero-setup, read-only safety).
- **Stage 5 (Exhausted claims):** Lead with **Identification** with the buyer's exact frustration, identity, and verbatim insider language.

---

## 4. Richard Rumelt's Strategy Kernel (Anti-Fluff Audit)

Every Passport strategy summary must pass Rumelt's 3-part Kernel check:
1. **Diagnosis (`obstacle`):** What is the single hardest bottleneck standing between the project and growth right now? (e.g., zero trust on cold US traffic, 45-day B2B procurement cycle, day-3 onboarding drop-off).
2. **Guiding Policy:** How we concentrate effort and **what we deliberately refuse to do** (`taboo` / `non_goals`). Strategy requires explicit exclusion, not a wishlist.
3. **Coherent Action:** Proximate steps where product, design, SEO, and paid acquisition reinforce one another (*Chain-Link System*).

### Bad Strategy Smells (Flagged by `passport_grill_engine.py`)
- **Goals masquerading as strategy:** «Наша стратегия — вырасти в 5 раз и занять 10% рынка».
- **Sunday words / Fluff:** inflated abstract nouns («синергетическая экосистема оптимизации») hiding the absence of a concrete buyer and mechanism.
- **Dog's dinner of objectives:** trying to serve B2C freemium students and Enterprise banks simultaneously on day 1.

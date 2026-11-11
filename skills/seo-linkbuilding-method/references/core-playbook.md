# seo-linkbuilding-method — Extended Playbook

## Procedures

### 1. Build the acceptor registry (pp. 471–472, 484)

For each candidate URL record six fields: cocoon role (Target L1 / Mixed L2 / Support L3); query cluster and Primary Entity; 28-day GSC baseline (impressions, clicks, CTR, position); next user action (lead form, cart, calculator, Mother-link click); internal redistribution pages (Mother up / Daughter down); trust contour status (author/reviewer, legal, NAP, proof blocks). Permanent ID per acceptor in the Materials & Acceptors registry. A URL missing any field is not an acceptor — route to the admission gate as unfinished.

### 2. Monthly admission gate (pp. 471–472, 478–479, 488–493, 511)

Sort each of the 10–20 monthly candidates:

1. Ready growth point (indexed, top 20, well structured) → readiness checks.
2. CTR or post-click trust deficit → snippet/price/terms fixes first.
3. Cannibalizing group (isSmearedSignal) → merge or role-separate first (procedure 3).
4. Isolated/unfinished node, no cluster role → **banned from external links**; build an MVC of 6–9 pages first.

Screen against the 7-mode failure matrix: low CTR in top 15; clicks no conversions; internal cannibalization; isolated URL; baseline trust deficit; thin LLM-reproducible content; scaled-content junk at section level. Then score the 6-item admission checklist (single JTBD, cocoon role, stable impressions, no Query-Page competitor, next step on screens 1–2, full E-E-A-T contour, contextual inlinks, one-click session close). Apply the natural-pretext test: one non-promotional reason an outside author would cite this URL. Reject at ≥2 failed items or any failure mode; send each reject to its named fix with an owner. A high-margin page that cannot hold the top is blocked even if management asks — links to it can lock in negative NavBoost signals. Checklist: [references/acceptor-and-sprint.md](references/acceptor-and-sprint.md).

### 3. Consolidate competing acceptors (pp. 471, 478, 546)

Collect every URL receiving external links for the topic; check Query-Page for alternating URLs. Keep pages serving distinct needs (strict entity/anchor separation); choose one primary acceptor per outreach angle; 301 redundant pages to the closest topical equivalent; update contractor briefs and the registry. Finish merges **before** the campaign. Never 301 a heavily linked informational URL to a hard-sell commercial page.

### 4. Readiness card and scoped pauses (pp. 494, 539, 545–548, 559)

Before placements go live (re-run if publication is delayed):

- **Technical card** (dated, attached to the placement task): HTTP 200, Googlebot-crawlable, no accidental noindex/login wall, clean final URL, valid canonical matching Google's choice, mobile parity, indexable main content.
- **Integration**: reachable via navigation, supporting internal links, connects to related guides/tools, leads to the service.
- **Conversion**: test lead/order reaches the team and analytics; phone works; price, stock, terms correct.
- **AI-citation structure** (asset pages): 40–60-word answer capsule; raw-HTML `<table>`/`<dl>`; stated limits; methodology and primary-source links; author + reviewedBy with sameAs; `<time datetime>`; same figures across blocks and schema.
- **Promise check**: donor sentence vs first screen vs available action. Someone who did not build the page looks for the promised result; build/restore it or rewrite the pitch honestly.

Pause only the affected scope — the broken URL, a migrating section, a broken funnel, a missing asset, a spam campaign, or all expansion during a hack/manual action. Each pause gets an owner and a checkable resume criterion. A template defect fixed once readies many acceptors; a local defect never becomes an indefinite ban. For a deeper per-URL verdict (tier A–D + transfer map + 20 ranked fixes), run the Link Target Readiness Analyzer from seo-prompt-kit (pp. 723, 729–731).

### 5. Cluster-first sprint math (pp. 473–476, 483–484, 488–493)

1. Confirm the cluster is a closed internal circuit (bidirectional Mother/Daughter/Sister links; 4–6 Mixed L2 and 10–15 Support L3 around the commercial hub).
2. Pick acceptors that already have GSC impressions and no cannibalization.
3. Allocate across four layers: brand-institutional (home, About, specialists, branches); direct commercial (L1); scenario-explanatory (L2 comparisons/guides); tool-collecting (L3 guides/calculators passing weight up via Mother-links). Up to 50–60% of placements → citable L2/L3 assets.
4. Links to L1 only when the child cluster is built and indexed and the hub needs a top-10→top-3 push.
5. Awkward service page → two-stage: links to specialist-signed pre-purchase guides, each with first-screen Mother-link + tool + booking form to the service. Category stuck on page 2 with only a JS filter → build static L2 collections and link both ways.
6. Local business → chain homepage → branch pages → specialist profiles → local services.
7. Young domain (hostAge <1 year) or pre-YMYL → reinforce the homepage too, branded/URL/neutral anchors only, after it has body links to priority L1s. Corporate news → homepage or /about/.
8. Sprint: 5–8 placements per month into one cluster (e.g. 2 L1, 3 L2, 2 L3), or 1 category + 3–5 connected pages per wave. Test with 2–3 links on a commercial page before scaling; watch for a cluster-leader shift.

Links into a connected cluster lift the whole topic; scattered links give a brief local spike. Never pump the homepage to pull a weak deep page up — fix the page.

### 6. Anchor and context spec (pp. 475, 484–486, 489, 520, 539)

Pick the anchor-mix row by acceptor role (full table in [references/anchors-donors-velocity.md](references/anchors-donors-velocity.md)):

- Home/About: branded 55–65%, URL 20–25%, neutral 10–15%, partial 5–10%, exact 0%.
- Author/doctor/branch: named 50–60%, URL 15–20%, neutral 10–15%, partial 10–20%, exact 0–2%.
- L1 commercial: branded 30–40%, URL 15–20%, neutral 15–20%, partial 25–35%, exact ≤3–5%.
- L2/L3 assets: branded 15–25%, URL 25–35%, neutral 15–25%, partial 25–35%, exact 0%.

Rules: 200–300-char passage around each link containing the main entity + 2–3 QBST terms; compound specialist anchors (role + organization + name); every partial-match anchor unique per domain; citation links use brand/URL/study/tool/expert name or "full report", "methodology", "source data". Commercial exact-match ≈70% → stop commercial anchors immediately; next waves go branded/URL/informational. No transactional anchors ("buy", "price", "cheap"); no cloned partial anchors across dozens of domains; paid placements let the publisher set rel and edit the anchor.

### 7. Donor media plan with passports (pp. 475–476, 480–483)

Segment by business model (local portals/maps/directories; professional media, registries, SROs for YMYL; integrator blogs/ratings for SaaS; reviews/comparisons for e-commerce). Assign 2–3 functional donor types per cluster; map donor type → acceptor layer. Passport per donor: topical rubric, the cluster task it solves, real topical organic traffic, link naturalness. Rate by topical closeness (siteFocusScore, siteRadius), never DR/DA alone. Prefer donors crediting a named author or engineer. Format guide/calculator links as footnote citations to a primary source. Plan unlinked mentions for entity co-occurrence. Exclude batch same-template exchanges; never 20–30 same-template sites in one month. Reject Site Reputation Abuse: disguised ads, unmoderated sponsor sections, parasite placements in unrelated sponsored folders.

### 8. Velocity tied to events (pp. 480, 486–487)

Split monthly volume into even weekly slots — never ~70% on days 27–30. Tie waves to real triggers: 2–4-week URL/branded burst after a study or calculator release; local directories and city media at a branch opening; gradual hub/L2 build as MVC impressions grow; buyer-guide placements 1.5–2 months before seasonal peaks. Confirm the site publishes/updates content in parallel. Vary article templates, link-paragraph position and anchor patterns within each sprint. Track link count and referring-domain count side by side. Rules: no new content for 6 months → do not start ~+30%/month growth; links spiking while domains stay flat → look for a sitewide block or reused donor base; never mix 5 strong links with 50 cheap directory links; drip-feeding manipulative links slowly does not make them compliant.

### 9. Post-batch GSC audit (pp. 474, 484, 487, 489, 492–493)

~1 month after a batch, count how many interlinked cluster pages grew together — never track a single URL.

- L1+L2+L3 all grew → conductivity healthy.
- Only the acceptor grew → move contextual links from footers into body text, add QBST terms to anchor windows.
- Info page rises instead of the linked commercial URL (target inversion) → stop buying for the laggard; make the riser the entry point with a strong commercial path.
- Jump then fall in 2–3 weeks while links stay indexed → NavBoost rollback; upgrade the landing page.
- Referring domains grew 3 months, flat breadth/impressions/positions → freeze the section, find technical/content blockers.

### 10. Four-registry tracking (pp. 549, 551, 553–557)

Four linked registries: Platforms & Contacts; Campaigns; Materials & Acceptors; Publications & Links. Permanent IDs; three URLs per link (exact href, final after redirects, intended acceptor); workflow stage (Found → Verified → Pitch Prepared → Sent → Reply → Approved → Published + stop reason) separate from link state (Confirmed, Content Changed, Acceptor Changed, Missing, Page Unavailable, Manual Check); separate dates for publication, link added, first check, tool discovery, change. Campaign card per campaign; shared contact log (departments never pitch one publisher twice); costs in full, paid placements separate. Five reporting levels: preparation, communication, publications, visits, search — mark "attribution not established" where unproven. Cohort snapshots for retention comparisons. LLM hygiene flags missing fields, name variants, duplicates, dead tasks, acceptor mismatches — review queue only, never auto-edits. Details: [references/tracking-and-risk.md](references/tracking-and-risk.md).

### 11. Profile risk audit + owner risk policy (pp. 480–481, 486, 538–548)

Group referring domains by functional type; map links to acceptor roles; flag 80–90% homepage concentration as a structural defect. Bucket anchors; highlight repeated commercial anchor-acceptor pairs and trace who ordered them. Overlay monthly links vs unique domains on real business milestones; attribute every spike (pages, domains, organizations, reasons; separate sitewide/syndication waves; separate discovery date from publication date; flag same-brief article clusters). ~80% of links explainable only as exchange purchases = high Core Update risk. Footer links are not spam by default — judge purpose, template spread, hidden links, widget type.

**Vendor vetting**: require work-type breakdown, platform criteria and terms before payment; pick your own sample from the vendor's full archive (ages, types, topics, edited/removed items); confirm authorization with the media's editorial office via contacts you found yourself; split the fee (research, writing, outreach, ad fee, checks, monitoring); sign per-placement acceptance criteria. Reject: bulk-by-quantity packages, vendors who cannot explain platforms pre-payment, networks whose selling point is hidden ownership or that refuse verification, three-way exchanges, mass AI article variants, "dofollow/eternal" as criteria, expired domains bought only to redirect metrics, CMS/GSC access requests just to place links.

**Disavow/manual action**: check GSC Manual Actions for an official penalty and its exact wording; demand justification (disputed links, how created, evidence of involvement, risk per group, which links you control); fix controllable links (remove or rel-attribute) and stop spam-scheme orders; use disavow **only** when both hold — large artificial-link volume AND an active manual action or well-founded risk. Back up the current file first (upload replaces it entirely), upload, then file reconsideration. A third-party toxicity score is not a Google notice — do not mass-disavow or pay for removals. Hack/security issue/manual action → freeze link expansion. Checklists: [references/tracking-and-risk.md](references/tracking-and-risk.md).

### 12. Review cadence (pp. 551–552, 554, 560)

- **Weekly**: replies, new publications, overdue approvals, tasks with no dated next step, new mentions.
- **Monthly**: cost vs results, rejection reasons, key live placements, lost links, asset queue, four questions — what got published, what went unclaimed, what needs fixing, which single task continues.
- **Quarterly**: business priorities, expert availability, evergreen freshness, dependence on a single contractor/publisher.
- Each review ends with a per-campaign decision: continue, change pitch, rework asset, repair placement, reallocate. Many pitches no replies → fix targeting and offer, not volume. Interest but no publication → missing evidence/permissions, unsuitable acceptor, or internal delays. Limit open tasks per specialist.

## Output contract

Returns to the calling node: acceptor registry with six fields per URL; approved monthly link-ready list + remediation backlog; canonical acceptor map; dated readiness cards + pause/resume tracker; sprint plan (cluster, per-layer counts, sequencing, test batch); anchor/context spec per placement; donor media plan with passports; weekly placement calendar; conductivity diagnosis; relational tracker; profile audit with attributed spikes; vendor verdict; disavow file or rejection with justification.

## Called by

- `seo-linkbuilding` graph (wave 3): acceptor registry → admission → sprint → anchors → donors → velocity → tracking → cadence; feeds `seo-outreach`, `seo-monitor`, `seo-page-refresh`, `seo-page`.
- `seo-outreach` sub-graph: anchor/context specs, donor vetting, readiness before pitches.
- `seo-mentions` sub-graph: reclamation targets, entity-page specs, redirect fixes for `seo-release`.

## Limits — owner decisions required

- Any paid placement, vendor contract, expired-domain purchase, disavow upload or reconsideration request is an owner decision; the agent prepares evidence, never commits.
- Sending pitches is outward-facing — human approval.
- Disavow upload replaces the whole file — irreversible; backup first, owner signs off.
- Never buy links to an unapproved acceptor, even under management pressure.

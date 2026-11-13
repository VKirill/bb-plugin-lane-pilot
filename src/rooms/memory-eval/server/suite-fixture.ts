import type { MemoryAudience, MemoryKind } from "@lane-pilot/memory-core";

/**
 * Fixture of the memory evaluation suite (cases H1-H7 of the memory research, 2026-11-13). Every note and every question is invented
 * for a made-up shipping-tracker product: no owner text lives here, and none may be added. Notes are planted in a scratch database by
 * `suite.ts`; a case names the notes it expects by key, or says «nothing».
 */
export const SUITE_PROJECT = "suite-project";

export type SuiteNote = {
  key: string; content: string; concepts?: string[]; kind?: MemoryKind; audience?: MemoryAudience;
  /** Sections the note belongs to, outermost first; `"shared"` marks a project-wide note on purpose. */
  scope?: string[] | "shared";
  /** Key of the older note this one replaces (planted after it, named in `supersedes`). */
  supersedes?: string;
  /** Planted, then moved off the shelf by the note budget: archived (`expired_reason: budget`), still indexed and embedded, so a PM search finds it and a brief does not. */
  archived?: boolean;
  /** Planted through the import door (`origin: import`), the way a note arrives from another memory store. */
  imported?: boolean;
  /** Planted straight into the table and its indexes, not through the write door: filler of a big shelf (the door costs about ten milliseconds a note). */
  bulk?: boolean;
};

/** Nature words that appear in no other fixture note: filler whose stems do not overlap any question. */
const BANK = ["amber", "basalt", "cobalt", "dunes", "ember", "fjord", "garnet", "harbor", "indigo", "jasper", "kelp", "lagoon", "marble", "nectar", "onyx", "prairie", "quartz", "ridge", "saffron", "tundra",
  "umber", "velvet", "willow", "xenon", "yarrow", "zephyr", "alpine", "bamboo", "cinder", "delta", "estuary", "falcon", "glacier", "heron", "island", "juniper", "koala", "lichen", "meadow", "nebula",
  "orchid", "pebble", "quail", "reef", "sequoia", "thistle", "uplands", "violet", "walnut", "yucca", "zenith", "aurora", "boulder", "canyon", "dolphin", "eclipse", "fern", "grove", "horizon", "iceberg"];
/** About 1400 characters: a lead line and filler cycled from the first `width` words of the bank, so a paragraph adds a controlled amount of vocabulary of its own. */
const padding = (lead: string, width: number) => `${lead} ${Array.from({ length: 220 }, (_, index) => BANK[index % width]).join(" ")}`.slice(0, 1400);
/** H10: a runbook of about ten thousand characters; the facts sit in the sixth to the eighth paragraph, far beyond the 6000 characters one embedding reads. */
/** H11: a note of about 5,700 characters (under the embedding window); two of them match one question and together overrun the PM's 1,600-token budget. */
const bigNote = (lead: string) => [padding(lead, 20), ...Array.from({ length: 3 }, (_, index) => padding(`Continued ${index + 1}.`, 20))].join(" ");
/** H12: a ledger of nine paragraphs; the paragraph the question names is the sixth, the stamp that answers it stands in the seventh and shares no word with the question. */
const LEDGER = [
  ...Array.from({ length: 5 }, (_, index) => padding(`Ledger part ${index + 1}.`, 60)),
  padding("Porto customs hold: a pallet flagged by Porto customs is parked in bay nine until the hold ticket is closed; the closing procedure follows.", 20),
  padding("Closing procedure: the stamped form PX-9913 signed by the inspector clears the pallet, and the dispatcher files the form in services/dispatch/forms.ts.", 20),
  ...Array.from({ length: 2 }, (_, index) => padding(`Ledger part ${index + 8}.`, 60)),
].join("\n\n");
const RUNBOOK = [
  ...Array.from({ length: 5 }, (_, index) => padding(`Runbook part ${index + 1}.`, 60)),
  padding("Depot failover: when the Lisbon depot scanner mesh drops for more than ten minutes, switch the dispatcher to the manual queue and page the dispatch lead.", 20),
  padding("Manifest typeface fallback: if the Calibri bundle fails to load, the manifest service falls back to Courier and logs a warning in services/manifest/fallback.ts.", 20),
  padding("Quarantine retention: quarantined pallets are purged after 400 days by the job in services/quarantine/purge.ts.", 20),
].join("\n\n");

export const SUITE_NOTES: SuiteNote[] = [
  { key: "retry", content: "The invoice export job retries three times with a 40 second pause in services/invoicer/retry.ts, then parks the job in the failed list.", concepts: ["billing", "invoicing"] },
  { key: "cache", content: "The catalog cache in services/catalog/cache.ts keeps entries for 15 minutes and the nightly warm job refills it at 03:10.", concepts: ["catalog", "cache"] },
  { key: "queue", content: "Decision: the order queue uses Postgres advisory locks instead of Redis, because production runs no Redis. The lock code is services/orders/queue.ts.", concepts: ["orders", "decision"] },
  { key: "auth", content: "Decision: sign-in is by magic link only. Passwords were dropped for the pilot so support handles fewer reset requests. See services/auth/magic.ts.", concepts: ["auth", "decision"] },
  { key: "limit", content: "The public tracking endpoint allows 60 requests per minute per API key; the limiter lives in services/gateway/limit.ts.", concepts: ["gateway"] },
  { key: "zone", content: "All timestamps are stored in UTC and shown in the carrier's local time; the conversion happens in lib/time/carrier-zone.ts.", concepts: ["time"] },
  { key: "carrier", content: "Carrier adapters implement the Carrier interface in lib/carriers/base.ts; adding a carrier means one file and one registry line.", concepts: ["carriers"] },
  { key: "hook", content: "Webhook payloads are signed with HMAC SHA-256 and the signing secret rotates on the first day of each quarter (services/hooks/sign.ts).", concepts: ["webhooks", "security"] },
  { key: "page", content: "List endpoints use cursor pagination with a page size of 50 and a hard maximum of 200 (services/gateway/page.ts).", concepts: ["gateway"] },
  { key: "label", content: "Shipping labels are rendered as 4x6 inch PDFs by services/labels/render.ts using the Noto Sans font bundle. A customer can track a parcel with the number printed on the label.", concepts: ["labels"] },
  { key: "sms", content: "Delivery SMS messages go through the text gateway in services/notify/sms.ts and are never sent before 08:00 local time.", concepts: ["notify"] },
  { key: "backup", content: "Database backups run at 02:00 UTC and are kept for 14 days; restore drills happen on the first Monday of the month.", concepts: ["ops"] },
  { key: "flags", content: "Feature flags are read from config/flags.yaml at boot and cannot be changed without a restart.", concepts: ["config"] },
  { key: "sandbox", content: "Integration tests use the sandbox carrier in tests/support/sandbox-carrier.ts, which never calls a real carrier.", concepts: ["testing"] },
  { key: "redact", content: "Request logs drop the customer email and keep only a hash; the redaction is in lib/log/redact.ts.", concepts: ["logging", "privacy"] },
  { key: "core", kind: "core", content: "Conventions: TypeScript strict mode, named exports only, every endpoint has a contract test.", concepts: ["conventions"] },

  // H4: a fact and the note that replaced it. Number, polarity and a conclusion that depended on the old fact (three of each).
  { key: "weight-old", content: "Parcels over 25 kilograms are rejected by the label service (services/labels/limits.ts).", concepts: ["labels", "limits"] },
  { key: "weight-new", content: "Parcels over 30 kilograms are rejected by the label service (services/labels/limits.ts).", concepts: ["labels", "limits"], supersedes: "weight-old" },
  { key: "refresh-old", content: "The operations dashboard refreshes its tiles every 30 seconds (apps/dashboard/refresh.ts).", concepts: ["dashboard"] },
  { key: "refresh-new", content: "The operations dashboard refreshes its tiles every 10 seconds (apps/dashboard/refresh.ts).", concepts: ["dashboard"], supersedes: "refresh-old" },
  { key: "holdback-old", content: "A shipment is held back for 6 hours after payment before it reaches the carrier queue (services/orders/holdback.ts).", concepts: ["orders"] },
  { key: "holdback-new", content: "A shipment is held back for 2 hours after payment before it reaches the carrier queue (services/orders/holdback.ts).", concepts: ["orders"], supersedes: "holdback-old" },
  { key: "express-old", content: "Express shipping is enabled for all European destinations (config/express.yaml).", concepts: ["express"] },
  { key: "express-new", content: "Express shipping is disabled for European destinations since the carrier contract ended (config/express.yaml).", concepts: ["express"], supersedes: "express-old" },
  { key: "optimizer-old", content: "The route optimizer is switched on for the Rotterdam depot (config/optimizer.yaml).", concepts: ["routing"] },
  { key: "optimizer-new", content: "The route optimizer was switched off again for the Rotterdam depot after the March incident (config/optimizer.yaml).", concepts: ["routing"], supersedes: "optimizer-old" },
  { key: "weekend-old", content: "Weekend pickups are offered to every customer (services/pickup/slots.ts).", concepts: ["pickup"] },
  { key: "weekend-new", content: "Weekend pickups are no longer offered to any customer (services/pickup/slots.ts).", concepts: ["pickup"], supersedes: "weekend-old" },
  { key: "reports-old", content: "Reports are built from the replica database, so they lag by up to five minutes (services/reports/source.ts).", concepts: ["reports"] },
  { key: "reports-new", content: "Reports are now built from the primary database after the replica was retired, so they no longer lag (services/reports/source.ts).", concepts: ["reports"], supersedes: "reports-old" },
  { key: "warm-old", content: "Search index warm-up takes about 20 minutes, so deploys are scheduled outside 09:00-18:00 (docs/deploy.md).", concepts: ["deploy"] },
  { key: "warm-new", content: "Search index warm-up now takes 2 minutes, so deploys may run at any hour of the day (docs/deploy.md).", concepts: ["deploy"], supersedes: "warm-old" },
  { key: "media-old", content: "Image uploads go to the local disk volume, so the app must run on a single node (services/media/store.ts).", concepts: ["media"] },
  { key: "media-new", content: "Image uploads go to object storage, so the app can run on several nodes (services/media/store.ts).", concepts: ["media"], supersedes: "media-old" },

  // H5: notes of sections, a project-wide note, a nested section and notes of other audiences.
  { key: "web-map", scope: ["web"], content: "Web section: the tracking page draws its map from the tile layer configured in apps/web/map/tiles.ts with the violet palette.", concepts: ["web", "map"] },
  { key: "api-sign", scope: ["api"], content: "API section: the partner API signs every request with an Ed25519 key kept under the vault path partners/signing (apps/api/partners/sign.ts).", concepts: ["api", "partners"] },
  { key: "api-quota", scope: ["api"], content: "API section: partner accounts get a quota of 5000 calls per day and a burst of 40 calls per second (apps/api/partners/quota.ts).", concepts: ["api", "quota"] },
  { key: "web-checkout", scope: ["web", "checkout"], content: "Checkout section: the payment form is a hosted iframe, card numbers never touch our servers (apps/web/checkout/pay.ts).", concepts: ["checkout", "payments"] },
  { key: "web-cart", scope: ["web", "cart"], content: "Cart section: a cart is kept for 7 days for signed-in customers and for 1 day for guests (apps/web/cart/keep.ts).", concepts: ["cart"] },
  { key: "release", scope: "shared", content: "Project-wide: every section releases on the second Thursday of the month, with a freeze on the Monday before.", concepts: ["release"] },
  { key: "owner-floor", audience: "owner", content: "Owner only: the enterprise plan price may be negotiated down to 70 percent of the list price, never lower.", concepts: ["pricing"] },
  // H18 (`memory.scope`): the same words written in two sections. With `section` a note of the other section is out of reach; with `project` both are, and the asking section's note comes first.
  { key: "lantern-alpha", scope: ["alpha"], content: "Docking bay lanterns are swapped every Sunday by the alpha crew, who log it in ops/bay/lantern-alpha.ts.", concepts: ["bay", "lantern"] },
  { key: "lantern-beta", scope: ["beta"], content: "Docking bay lanterns are swapped every Sunday by the beta crew, who log it in ops/bay/lantern-beta.ts.", concepts: ["bay", "lantern"] },
  { key: "gantry-alpha", scope: ["alpha"], content: "Alpha section: the gantry crane at pier nine is greased on the first Friday of the month (ops/pier/gantry-grease.ts).", concepts: ["pier", "gantry"] },
  // H8: notes the budget moved off the shelf. They are archived, not deleted: a PM search finds them, a writer's brief does not carry them.
  { key: "vpn", archived: true, content: "The staging VPN gateway rotates its certificate every 90 days with the script services/infra/vpn-cert.ts and the on-call engineer renews it by hand.", concepts: ["infra", "vpn"] },
  { key: "bucket", archived: true, content: "Customer exports are written to the object bucket named in config/exports.yaml and expire after 30 days under the lifecycle rule of that bucket.", concepts: ["exports"] },
  { key: "pager", archived: true, content: "The overnight pager rota rotates every Monday at 09:00 and the schedule lives in ops/pager/rota.yaml.", concepts: ["ops", "pager"] },

  // H10: one long record (about 10,000 characters) whose answers lie in its later paragraphs.
  { key: "runbook", content: RUNBOOK, concepts: ["runbook"] },
  { key: "export-faq", audience: "export", content: "Export copy: customers can track a parcel with the number on the label, without signing in.", concepts: ["faq"] },
];

/**
 * The notes of H11 and H12, each set planted in a database of its own: big notes and a long ledger shift the answer gate's length statistics (and with them the
 * grey band of H3 and H6) and would compete for one budget, so a case names its set with `notes`. H11: two notes that match one question and do not fit the PM
 * budget together. H12: a long ledger whose answer sits next to the paragraph the question names.
 */
/**
 * H14-H17 (the Maslov recipe, round 5): a shelf of `MASLOV_FILLER` invented depot-log notes with five planted ones among them, so the cases run at the size
 * where a lock and a pin matter (the research measured 300 and 3000 notes). The filler uses nature words and «cargo gate» vocabulary no question shares.
 */
export const MASLOV_FILLER = 3000;
const maslovShelf = (): SuiteNote[] => {
  const filler = Array.from({ length: MASLOV_FILLER }, (_, index): SuiteNote => ({ key: `fill-${index}`,
    content: `Depot log ${index}: ${BANK[index % BANK.length]} ${BANK[(index * 7 + 3) % BANK.length]} ${BANK[(index * 13 + 5) % BANK.length]} cargo moved through gate ${index % 40} in batch ${index}.`, concepts: ["depot"], bulk: true }));
  return [
    ...filler,
    // exact identifier: only the words find it
    { key: "manifest", content: "The ledger export job writes the file ZX-7741-manifest.csv at 02:10 UTC and uploads it to the finance bucket.", concepts: ["ledger"] },
    // an English note a Russian question can reach only through the vectors
    { key: "ferry", content: "The ferry booking connector gives up a request after 14 seconds of silence and retries twice with exponential backoff.", concepts: ["ferry"] },
    // the rule: nothing in it overlaps any question of H17
    { key: "rule", kind: "core", content: "Rule: a customer parcel record is never deleted; it is archived with its history instead.", concepts: ["convention"] },
  ];
};

export const SUITE_PACK_NOTES: Record<"heads" | "chunks" | "dups" | "maslov", SuiteNote[]> = {
  maslov: maslovShelf(),
  heads: [
    { key: "kestrel-a", content: bigNote("Kestrel tallow lanyard rule A: pallets of the Kestrel depot are held 45 days before release."), concepts: ["kestrel"] },
    { key: "kestrel-b", content: bigNote("Kestrel tallow lanyard rule B: the tallow seal on a Kestrel lanyard is renewed every 8 days."), concepts: ["kestrel"] },
  ],
  chunks: [
    { key: "ledger", content: LEDGER, concepts: ["ledger"] },
  ],
  // H13: a fact and its copy imported from another store (a source mark in front), and a fact and a longer restatement of it. Planted by the write
  // door: with the near-duplicate check on, the copy is not stored and the longer wording replaces the shorter one.
  dups: [
    { key: "relay", content: "The Muse relay connector signs every outbound request with a rotating token and retries three times before it parks the job (services/muse/relay.ts).", concepts: ["muse"] },
    { key: "relay-copy", imported: true, content: "[из авто-памяти Claude Code, project memory] The Muse relay connector signs every outbound request with a rotating token and retries three times before it parks the job (services/muse/relay.ts).", concepts: ["muse", "kind:fact"] },
    { key: "pallet-old", content: "Quarantined pallets are scanned at bay twelve by the night crew and tagged with a violet sticker (services/quarantine/scan.ts).", concepts: ["quarantine"] },
    { key: "pallet-long", content: "Quarantined pallets are scanned at bay twelve by the night crew and tagged with a violet sticker (services/quarantine/scan.ts); a pallet with a torn sticker is rescanned by the shift lead before dispatch.", concepts: ["quarantine"] },
  ],
};

export type SuiteFamily = "H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "H8" | "H9" | "H10" | "H11" | "H12" | "H13" | "H14" | "H15" | "H16" | "H17" | "H18";
export type SuiteCase = {
  id: string; family: SuiteFamily;
  /** What the case exercises, for the table. */
  kind: string;
  question: string;
  /** `pm`: the PM tool's context for the question; `writer`: the writer's brief for a task that owns `paths`. */
  surface: "pm" | "writer";
  chain?: string[]; audience?: MemoryAudience;
  paths?: string[];
  /** Keys of the notes that must reach the reader, or «nothing»: the memory cannot answer, and the reader must be told so (no notes or a weak-match warning). */
  expect: string[] | "nothing";
  /** Keys of notes that must not reach the reader: a leak across sections or audiences, or a replaced version of a fact. */
  forbid?: string[];
  /** Text the reader's context must carry: a date interval of a replaced version, or the paragraph of a long record that answers. */
  contains?: string[];
  /** Key of the note that must come first among the notes that reached the reader (the rank boost of `memory.scope = project`). */
  first?: string;
  /** the case runs against its own set of `SUITE_PACK_NOTES` (H11, H12). */
  notes?: "heads" | "chunks" | "dups" | "maslov";
  /** `memory.*` settings of the case (the forks of the recipe: `memory.vector_mode`, `memory.door_lock`, `memory.pinned`). */
  settings?: Record<string, unknown>;
  /** The English keywords the door lock `translated` would get from its model call (the suite makes no call). */
  lockTerms?: string[];
};

const pm = (id: string, family: SuiteFamily, kind: string, question: string, expect: SuiteCase["expect"], more: Partial<SuiteCase> = {}): SuiteCase => ({ id, family, kind, question, surface: "pm", expect, ...more });
const writer = (id: string, question: string, paths: string[], expect: string[], more: Partial<SuiteCase> = {}): SuiteCase => ({ id, family: "H1", kind: "brief", question, surface: "writer", paths, expect, ...more });

export const SUITE_CASES: SuiteCase[] = [
  // H1: the writer's brief carries the note that names the files of the task.
  writer("h1-retry", "Change the pause between invoice export retries", ["services/invoicer/retry.ts"], ["retry"]),
  writer("h1-cache", "Make the catalog cache keep entries longer", ["services/catalog/cache.ts"], ["cache"]),
  writer("h1-limit", "Raise the request limit of the tracking endpoint", ["services/gateway/limit.ts"], ["limit"]),
  writer("h1-zone", "Show the delivery time in the carrier time zone", ["lib/time/carrier-zone.ts"], ["zone"]),
  writer("h1-hook", "Rotate the webhook signing secret monthly", ["services/hooks/sign.ts"], ["hook"]),
  writer("h1-label", "Print labels in A6 instead of 4x6", ["services/labels/render.ts"], ["label"]),
  writer("h1-sms", "Allow delivery text messages from 07:00", ["services/notify/sms.ts"], ["sms"]),
  writer("h1-web", "Change the colors of the tracking map", ["apps/web/map/tiles.ts"], ["web-map"], { chain: ["web"] }),

  // H2: the PM asks about a past decision or a fact written down.
  pm("h2-queue", "H2", "decision", "Why did we choose Postgres advisory locks for the order queue instead of Redis?", ["queue"]),
  pm("h2-auth", "H2", "decision", "Why is there no password sign-in in the pilot?", ["auth"]),
  pm("h2-hook", "H2", "fact", "How often does the webhook signing secret rotate?", ["hook"]),
  pm("h2-retry", "H2", "fact", "How many times does the invoice export retry and how long is the pause?", ["retry"]),
  pm("h2-cache", "H2", "fact", "How long does the catalog cache keep entries?", ["cache"]),
  pm("h2-page", "H2", "fact", "What is the maximum page size of the list endpoints?", ["page"]),
  pm("h2-backup", "H2", "fact", "How long are the database backups kept and when are restore drills?", ["backup"]),
  pm("h2-sandbox", "H2", "fact", "Which carrier do the integration tests use?", ["sandbox"]),

  // H3: no answer. Five questions about nothing in the notes, five near-misses: the topic is in memory, the fact asked for is not.
  pm("h3-font", "H3", "no answer", "Which font does the marketing website use for headings?", "nothing"),
  pm("h3-seats", "H3", "no answer", "How many seats does the enterprise licence include?", "nothing"),
  pm("h3-drone", "H3", "no answer", "What is our policy on drone deliveries?", "nothing"),
  pm("h3-oncall", "H3", "no answer", "Who is on call for the payments team this week?", "nothing"),
  pm("h3-region", "H3", "no answer", "Which cloud region hosts the staging cluster?", "nothing"),
  pm("h3-near-size", "H3", "near-miss", "What is the maximum size of an invoice the export job accepts?", "nothing"),
  pm("h3-near-warm", "H3", "near-miss", "How many catalog items does the nightly warm job refill per minute?", "nothing"),
  pm("h3-near-sandbox", "H3", "near-miss", "Which carriers does the sandbox carrier simulate and with what error rates?", "nothing"),
  pm("h3-near-who", "H3", "near-miss", "Who performs the webhook secret rotation each quarter?", "nothing"),
  pm("h3-near-sms", "H3", "near-miss", "What is the retry pause of the text gateway when a delivery message fails?", "nothing"),

  // H4: the fact changed; only the new version may come back (three number changes, three polarity flips, three dependent conclusions).
  pm("h4-weight", "H4", "number", "What is the heaviest parcel the label service accepts?", ["weight-new"], { forbid: ["weight-old"] }),
  pm("h4-refresh", "H4", "number", "How often does the operations dashboard refresh its tiles?", ["refresh-new"], { forbid: ["refresh-old"] }),
  pm("h4-holdback", "H4", "number", "How many hours is a shipment held back after payment?", ["holdback-new"], { forbid: ["holdback-old"] }),
  pm("h4-express", "H4", "polarity", "Is express shipping enabled for European destinations?", ["express-new"], { forbid: ["express-old"] }),
  pm("h4-optimizer", "H4", "polarity", "Is the route optimizer switched on for the Rotterdam depot?", ["optimizer-new"], { forbid: ["optimizer-old"] }),
  pm("h4-weekend", "H4", "polarity", "Do we offer weekend pickups to customers?", ["weekend-new"], { forbid: ["weekend-old"] }),
  pm("h4-reports", "H4", "conclusion", "Are the reports still built from the replica database?", ["reports-new"], { forbid: ["reports-old"] }),
  pm("h4-warm", "H4", "conclusion", "At which hours may we deploy given the search index warm-up?", ["warm-new"], { forbid: ["warm-old"] }),
  pm("h4-media", "H4", "conclusion", "Can the app run on several nodes given where image uploads go?", ["media-new"], { forbid: ["media-old"] }),

  // H5: leakage. A section's note must not reach a sibling, the project root, another audience; the controls must still arrive.
  pm("h5-web-from-api", "H5", "sibling", "Which tile layer and palette does the tracking page map use?", "nothing", { chain: ["api"], forbid: ["web-map"] }),
  pm("h5-web-from-root", "H5", "root", "Which tile layer and palette does the tracking page map use?", "nothing", { chain: [], forbid: ["web-map"] }),
  pm("h5-web-control", "H5", "control", "Which tile layer and palette does the tracking page map use?", ["web-map"], { chain: ["web"] }),
  pm("h5-api-from-web", "H5", "sibling", "Which key signs the partner API requests?", "nothing", { chain: ["web"], forbid: ["api-sign"] }),
  pm("h5-api-from-root", "H5", "root", "Which key signs the partner API requests?", "nothing", { chain: [], forbid: ["api-sign"] }),
  pm("h5-api-control", "H5", "control", "Which key signs the partner API requests?", ["api-sign"], { chain: ["api"] }),
  pm("h5-quota-from-web", "H5", "sibling", "What daily quota and burst do partner accounts get?", "nothing", { chain: ["web", "cart"], forbid: ["api-quota"] }),
  pm("h5-nested-from-parent", "H5", "nested", "How does the checkout payment form handle card numbers?", "nothing", { chain: ["web"], forbid: ["web-checkout"] }),
  pm("h5-nested-from-sibling", "H5", "nested", "How does the checkout payment form handle card numbers?", "nothing", { chain: ["web", "cart"], forbid: ["web-checkout"] }),
  pm("h5-nested-control", "H5", "control", "How does the checkout payment form handle card numbers?", ["web-checkout"], { chain: ["web", "checkout"] }),
  pm("h5-cart-from-checkout", "H5", "nested", "How long is a shopping cart kept for guests?", "nothing", { chain: ["web", "checkout"], forbid: ["web-cart"] }),
  pm("h5-shared-root", "H5", "shared", "On which day of the month does every section release?", ["release"], { chain: [] }),
  pm("h5-shared-api", "H5", "shared", "On which day of the month does every section release?", ["release"], { chain: ["api"] }),
  pm("h5-owner-subagent", "H5", "audience", "How low may the enterprise plan price be negotiated?", "nothing", { audience: "subagent", forbid: ["owner-floor"] }),
  pm("h5-owner-export", "H5", "audience", "How low may the enterprise plan price be negotiated?", "nothing", { audience: "export", forbid: ["owner-floor"] }),
  pm("h5-owner-control", "H5", "control", "How low may the enterprise plan price be negotiated?", ["owner-floor"], { audience: "owner" }),
  pm("h5-export-from-subagent", "H5", "audience", "How can a customer track a parcel with the number on the label?", ["label"], { audience: "subagent", forbid: ["export-faq"] }),

  // H6: the grey band of the answer gate. «grey-no»: a question that shares words with a note the note does not answer; «grey-yes»: an answerable question that shares few words with its note.
  pm("h6-no-invoice", "H6", "grey-no", "Can the invoice export keep retrying for hours when the carrier is down?", "nothing"),
  pm("h6-no-gateway", "H6", "grey-no", "Does the tracking endpoint limit apply to the dashboard too, and what happens above the limit?", "nothing"),
  pm("h6-no-cache", "H6", "grey-no", "Which entries does the catalog cache never keep and why?", "nothing"),
  pm("h6-yes-hook", "H6", "grey-yes", "When does the signing secret of the callbacks change?", ["hook"]),
  pm("h6-yes-page", "H6", "grey-yes", "What is the biggest page of rows a listing request may return?", ["page"]),
  pm("h6-yes-sms", "H6", "grey-yes", "From which hour may text messages about a delivery go out?", ["sms"]),

  // H8: archived records. A PM search still finds what the budget moved off the shelf; the writer's brief carries the shelf only.
  pm("h8-vpn", "H8", "archived", "How often does the staging VPN gateway rotate its certificate?", ["vpn"]),
  pm("h8-bucket", "H8", "archived", "After how many days do customer exports in the object bucket expire?", ["bucket"]),
  pm("h8-pager", "H8", "archived", "When does the overnight pager rota rotate?", ["pager"]),
  writer("h8-writer-shelf-only", "Renew the staging VPN certificate script", ["services/infra/vpn-cert.ts"], [], { family: "H8", kind: "brief", forbid: ["vpn"] }),

  // H9: history questions. The question asks for the past, so the replaced version comes back with its dates; the current one comes too.
  pm("h9-weight", "H9", "history", "What was the heaviest parcel the label service accepted before the change?", ["weight-new", "weight-old"], { contains: ["replaced; 20", "25 kilograms", "30 kilograms"] }),
  pm("h9-refresh", "H9", "history", "How often did the operations dashboard refresh its tiles previously?", ["refresh-new", "refresh-old"], { contains: ["replaced; 20", "every 30 seconds", "every 10 seconds"] }),
  pm("h9-holdback", "H9", "history", "How many hours was a shipment held back after payment before the change?", ["holdback-new", "holdback-old"], { contains: ["replaced; 20", "6 hours", "2 hours"] }),

  // H10: a long record found by a later paragraph; the pack shows the paragraph that answers, not the cut head.
  pm("h10-carrier", "H10", "long record", "What do we do when the Lisbon depot scanner mesh is down for ten minutes?", ["runbook"], { contains: ["manual queue", "part 6/"] }),
  pm("h10-font", "H10", "long record", "Which typeface does the manifest service use when the Calibri bundle fails to load?", ["runbook"], { contains: ["Courier"] }),
  pm("h10-customs", "H10", "long record", "How long are quarantined pallets kept before the purge job removes them?", ["runbook"], { contains: ["400 days"] }),

  // H11: a record over the budget appears as a head line (date, id, start of the text) instead of vanishing from the pack.
  pm("h11-kestrel", "H11", "head line", "What do the Kestrel tallow lanyard rules say about seals and audits?", ["kestrel-b"], { notes: "heads", contains: ["head; id=", "Kestrel tallow lanyard rule A: pallets of the Kestrel depot are held 45 days"] }),
  // H12: the best chunk is the one the question names; the answer stands in its neighbour, which the pack delivers with it.
  // H13: an imported copy of a stored fact makes no second note; a longer restatement is the next version of the first. Search returns one.
  pm("h13-copy", "H13", "imported copy", "How does the Muse relay connector sign requests and how often does it retry?", ["relay"], { notes: "dups", forbid: ["relay-copy"] }),
  pm("h13-longer", "H13", "longer restatement", "How are quarantined pallets tagged at bay twelve and what happens to a torn sticker?", ["pallet-long"], { notes: "dups", forbid: ["pallet-old"] }),
  // H14: the word layer finds an exact identifier by itself (the bridge adds nothing for a question in the notes' own language).
  pm("h14-exact", "H14", "exact identifier", "Where does the ZX-7741 manifest get uploaded?", ["manifest"], { notes: "maslov", settings: { "memory.vector_mode": "bridge" } }),
  pm("h14-exact-words", "H14", "exact identifier", "At what time is ZX-7741-manifest.csv written?", ["manifest"], { notes: "maslov", settings: { "memory.vector_mode": "bridge" } }),
  // H15: a Russian question reaches an English note through the vector bridge (the stand-in embedding knows a few Russian stems, like a multilingual model).
  pm("h15-ru-en", "H15", "russian question", "Через сколько секунд коннектор бронирования паромов обрывает запрос?", ["ferry"], { notes: "maslov", settings: { "memory.vector_mode": "bridge" } }),
  pm("h15-ru-en-retry", "H15", "russian question", "Сколько раз коннектор бронирования паромов повторяет запрос?", ["ferry"], { notes: "maslov", settings: { "memory.vector_mode": "bridge" } }),
  // H16: a question the word layer leaves closed gets silence at the size of 3000 notes; one that opens the door still gets its note.
  pm("h16-en-none", "H16", "no answer, literal lock", "Which font does the marketing website use for headings?", "nothing", { notes: "maslov", settings: { "memory.vector_mode": "bridge", "memory.door_lock": "literal" } }),
  pm("h16-ru-none", "H16", "no answer, literal lock", "Какой шрифт используется в заголовках сайта?", "nothing", { notes: "maslov", settings: { "memory.vector_mode": "bridge", "memory.door_lock": "literal" } }),
  pm("h16-ru-none-translated", "H16", "no answer, translated lock", "Какой шрифт используется в заголовках сайта?", "nothing", { notes: "maslov", lockTerms: ["font", "website", "headings"], settings: { "memory.vector_mode": "bridge", "memory.door_lock": "translated" } }),
  pm("h16-en-open", "H16", "answer, literal lock", "Where does the ZX-7741 manifest get uploaded?", ["manifest"], { notes: "maslov", settings: { "memory.vector_mode": "bridge", "memory.door_lock": "literal" } }),
  pm("h16-ru-open-translated", "H16", "answer, translated lock", "Через сколько секунд коннектор бронирования паромов обрывает запрос?", ["ferry"], { notes: "maslov", lockTerms: ["ferry", "booking", "connector", "request"], settings: { "memory.vector_mode": "bridge", "memory.door_lock": "translated" } }),
  // H17: the rule reaches the reader at 3000 notes whatever the question says (it shares no word with it) and whatever the lock says.
  pm("h17-rule-answerable", "H17", "pinned rule", "Where does the ZX-7741 manifest get uploaded?", ["manifest", "rule"], { notes: "maslov", settings: { "memory.pinned": true } }),
  pm("h17-rule-locked", "H17", "pinned rule behind a closed door", "Which font does the marketing website use for headings?", ["rule"], { notes: "maslov", settings: { "memory.pinned": true, "memory.vector_mode": "bridge", "memory.door_lock": "literal" } }),
  pm("h17-rule-off", "H17", "no pin, rule not asked for", "Where does the ZX-7741 manifest get uploaded?", ["manifest"], { notes: "maslov", forbid: ["rule"] }),
  // H18: section keeps a sibling section's note out; project shows it; the asking section's twin comes first.
  pm("h18-section-sibling", "H18", "section: sibling hidden", "When is the gantry crane at pier nine greased?", "nothing", { chain: ["beta"], forbid: ["gantry-alpha"] }),
  pm("h18-section-own", "H18", "section: own note", "When is the gantry crane at pier nine greased?", ["gantry-alpha"], { chain: ["alpha"] }),
  pm("h18-project-sibling", "H18", "project: sibling visible", "When is the gantry crane at pier nine greased?", ["gantry-alpha"], { chain: ["beta"], settings: { "memory.scope": "project" } }),
  pm("h18-project-root", "H18", "project: root reader sees a section's note", "When is the gantry crane at pier nine greased?", ["gantry-alpha"], { chain: [], settings: { "memory.scope": "project" } }),
  pm("h18-rank-alpha", "H18", "project: asking section first", "Who swaps the docking bay lanterns every Sunday?", ["lantern-alpha", "lantern-beta"], { chain: ["alpha"], first: "lantern-alpha", settings: { "memory.scope": "project" } }),
  pm("h18-rank-beta", "H18", "project: asking section first", "Who swaps the docking bay lanterns every Sunday?", ["lantern-alpha", "lantern-beta"], { chain: ["beta"], first: "lantern-beta", settings: { "memory.scope": "project" } }),
  pm("h18-section-twin", "H18", "section: only the own twin", "Who swaps the docking bay lanterns every Sunday?", ["lantern-beta"], { chain: ["beta"], forbid: ["lantern-alpha"] }),
  pm("h12-customs", "H12", "neighbour chunk", "What clears a Porto customs hold on a pallet?", ["ledger"], { notes: "chunks", contains: ["PX-9913", "part 5\u20137/"] }),
];

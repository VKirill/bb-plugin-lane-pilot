import { afterEach, describe, expect, it } from "vitest";
import { landingWordAsked, ownerWordsMode, ownerWordsOn, productionDeployText, sensitiveHits, taskStepEvidence } from "../src/rooms/tasks";
import { permitOwnerRule } from "../src/rooms/writer/server/permits";
import { criticLevel } from "../src/rooms/critique/critic-level";
import { firstRunSettings } from "../src/rooms/front/logic";

// owner.words = sensitive (the default since the owner's decision of 2026-11-14): his word is asked only for money, database changes and
// destructive data operations, and a deploy to production. Everything else lands by the gates, whatever its risk.
const SENSITIVE = { "owner.words": "sensitive" } as const;
type Task = Parameters<typeof taskStepEvidence>[0] & { risk: string };
const task = (over: Partial<Task> = {}): Task => ({ title: "Task", objective: "Do the work", kind: "feature", risk: "medium", owns_paths: ["src/ui/card.ts"], verification: [{ command: "npx vitest run tests/card.test.ts" }], ...over });
const asked = (t: Task, produced?: string[], settings: Record<string, unknown> = SENSITIVE) => landingWordAsked(settings, t.risk, taskStepEvidence(t, produced));

describe("owner.words sensitive: the three classes ask", () => {
  const before = process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
  afterEach(() => { if (before === undefined) delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT; else process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = before; });

  it("is the default mode", () => {
    delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
    expect(ownerWordsMode({})).toBe("sensitive");
    expect(ownerWordsMode(SENSITIVE)).toBe("sensitive");
  });

  it("money: a payment, billing, price, refund or payout path, a money command, or a money phrase in the task asks", () => {
    for (const path of ["src/payments/charge.ts", "apps/api/billing/invoice.ts", "src/pricing/plans.ts", "src/refunds/create.ts", "src/payouts/run.ts", "src/stripe-webhook.ts"])
      expect(asked(task({ risk: "low", owns_paths: [path] })), path).toBe(true);
    expect(sensitiveHits({ paths: ["src/billing/plan.ts"] })[0]).toEqual({ cls: "money", evidence: "path:src/billing/plan.ts" });
    expect(asked(task({ objective: "Change the subscription price of the pro plan to 990" }), ["src/plans.ts"])).toBe(true);
    expect(asked(task({ title: "Возврат средств по заказу" }), ["src/orders/cancel.ts"])).toBe(true);
    expect(asked(task({ objective: "Create the refund endpoint" }), ["src/api/orders.ts"])).toBe(true);
  });

  it("data: migrations, schema files, *.sql, migration commands and destructive SQL ask", () => {
    for (const path of ["db/migrations/0042_add_orders.ts", "prisma/schema.prisma", "src/db/seed.sql", "alembic/versions/ab12.py", "db/migrate/20260101_x.rb"])
      expect(asked(task({ risk: "low", owns_paths: [path] })), path).toBe(true);
    for (const command of ["npx prisma migrate deploy", "psql -c 'DROP TABLE users'", "psql -c \"TRUNCATE orders\"", "alembic upgrade head", "npx drizzle-kit push", "rm -rf /var/lib/app/data"])
      expect(asked(task({ verification: [{ command }] })), command).toBe(true);
    expect(asked(task({ objective: "Add a column to the orders table: schema change with a backfill of existing rows" }), ["src/orders.ts"])).toBe(true);
  });

  it("deploy: a production deploy command, a production deploy phrase or a deploy workflow asks", () => {
    for (const command of ["pm2 reload ecosystem.config.js", "./deploy.sh production", "npm run deploy -- --env=prod", "kubectl apply -f k8s/prod.yaml", "vercel --prod"])
      expect(asked(task({ verification: [{ command }] })), command).toBe(true);
    expect(asked(task({ objective: "Deploy the new build to production and restart the workers" }), ["scripts/restart.sh"])).toBe(true);
    expect(asked(task({ objective: "Выкатить релиз в прод" }), ["scripts/restart.sh"])).toBe(true);
    expect(asked(task({ owns_paths: [".github/workflows/deploy.yml"] }))).toBe(true);
    expect(asked(task({ owns_paths: ["ecosystem.config.cjs"] }))).toBe(true);
    // A deploy-named script next to a production marker.
    expect(asked(task({ objective: "Fix the release script so the live deploy keeps the previous build", owns_paths: ["scripts/deploy.sh"] }))).toBe(true);
  });
});

describe("owner.words sensitive: everything else lands by itself", () => {
  it("«deploy» alone, a staging or sandbox deploy, and the drill do not ask", () => {
    expect(asked(task({ risk: "high", objective: "Deploy to staging and check the page" }), ["scripts/restart.sh"])).toBe(false);
    expect(asked(task({ risk: "high", objective: "Fix the deploy script's usage message" }), ["scripts/deploy.sh"])).toBe(false);
    expect(asked(task({ risk: "high", verification: [{ command: "./deploy.sh staging" }] }))).toBe(false);
    expect(asked(task({ risk: "high", verification: [{ command: "npm run deploy:preview" }] }))).toBe(false);
    expect(asked(task({ risk: "high", objective: "Run the drill sandbox deploy for the release checklist" }), ["scripts/drill.py"])).toBe(false);
    expect(asked(task({ risk: "high", objective: "Do not deploy to production; only prepare the build" }), ["scripts/build.sh"])).toBe(false);
    expect(productionDeployText("Deploy to staging")).toBe(false);
    expect(productionDeployText("Deploy to production")).toBe(true);
  });

  it("a refactor, an auth change or a secrets change of risk high or critical does not ask", () => {
    expect(asked(task({ risk: "high", kind: "refactor", title: "Split the writer module", owns_paths: ["src/rooms/writer/server/dispatch.ts"] }))).toBe(false);
    expect(asked(task({ risk: "critical", kind: "feature", title: "Add OAuth login", owns_paths: ["src/auth/login.ts", "src/auth/secrets.ts"] }))).toBe(false);
    expect(asked(task({ risk: "high", kind: "fix", owns_paths: ["src/ui/card.ts"] }), ["src/ui/card.ts"])).toBe(false);
  });

  it("tests, docs, styles and images about money or data do not ask by their names or words", () => {
    expect(asked(task({ owns_paths: ["tests/billing.test.ts", "docs/payments.md"] }))).toBe(false);
    expect(asked(task({ objective: "Show the payment method icons in the footer" }), ["apps/web/assets/visa.svg", "apps/web/styles/footer.css"])).toBe(false);
    expect(asked(task({ kind: "docs", objective: "Describe the database migration process and the production deploy" }), ["docs/ops.md"])).toBe(false);
    // The word «price» or «migration» alone is not a phrase that changes money or data.
    expect(asked(task({ objective: "Rename the price column header in the table component" }), ["src/ui/table.ts"])).toBe(false);
  });

  it("the changed files, not the broad owns_paths, decide at the landing", () => {
    const wide = task({ owns_paths: ["src/billing/**", "src/ui/**"] });
    expect(asked(wide, ["src/ui/card.ts"])).toBe(false);
    expect(asked(wide, ["src/billing/plan.ts"])).toBe(true);
    // No changed files known (dispatch): the contract's own paths.
    expect(asked(wide)).toBe(true);
  });

  it("without evidence nothing asks on sensitive", () => {
    expect(landingWordAsked(SENSITIVE, "high")).toBe(false);
    expect(ownerWordsOn(SENSITIVE)).toBe(false);
  });
});

describe("owner.words sensitive: the other person steps", () => {
  it("a contract's clarification, a phase and a forge workflow ask only when the step itself is in the classes", () => {
    expect(ownerWordsOn(SENSITIVE, taskStepEvidence(task()))).toBe(false);
    expect(ownerWordsOn(SENSITIVE, taskStepEvidence(task({ owns_paths: ["src/payments/refund.ts"] })))).toBe(true);
    expect(ownerWordsOn(SENSITIVE, { text: ["Prices page", "Redesign the pricing page layout"] })).toBe(false);
    expect(ownerWordsOn(SENSITIVE, { text: ["Billing rewrite", "Rewrite payments and billing for the new provider"] })).toBe(true);
    expect(ownerWordsOn(SENSITIVE, { text: ["Release", "Deploy the phase result to production"] })).toBe(true);
    expect(ownerWordsOn(SENSITIVE, { text: ["Schema", "Database migration of the orders table"] })).toBe(true);
  });

  it("a permit ticket: the PM is told to ask the owner only for a data, money or production command on sensitive", () => {
    expect(permitOwnerRule("sensitive", "psql -c 'DROP TABLE users'")).toMatch(/data.*ask the owner first/);
    expect(permitOwnerRule("sensitive", "TRUNCATE orders")).toMatch(/ask the owner first/);
    expect(permitOwnerRule("sensitive", "pm2 reload all")).toMatch(/deploy.*ask the owner first/);
    expect(permitOwnerRule("sensitive", "rm -rf node_modules/.cache")).toMatch(/not asked|the owner is not asked/);
    expect(permitOwnerRule("sensitive", "rm -rf build/")).toMatch(/decide it yourself/);
    expect(permitOwnerRule("on", "rm -rf build/")).toMatch(/ask the owner first/);
    expect(permitOwnerRule("risky", "rm -rf build/")).toMatch(/ask the owner first/);
    expect(permitOwnerRule("off", "DROP TABLE users")).toMatch(/not asked/);
  });

  it("the first-run answer maps to the new mode", () => {
    expect(firstRunSettings({ projectId: "p", answers: { words: "sensitive" }, at: 1 })["owner.words"]).toBe("sensitive");
    expect(firstRunSettings({ projectId: "p", answers: { words: "только деньги и миграции" }, at: 1 })["owner.words"]).toBe("sensitive");
    expect(firstRunSettings({ projectId: "p", answers: { words: "risky" }, at: 1 })["owner.words"]).toBe("risky");
    expect(firstRunSettings({ projectId: "p", answers: { words: "yes" }, at: 1 })["owner.words"]).toBe("on");
    expect(firstRunSettings({ projectId: "p", answers: { words: "no" }, at: 1 })["owner.words"]).toBe("off");
  });
});

describe("the older modes work as before", () => {
  it("on asks every landing and step, risky asks risk high or critical, off asks none; evidence changes nothing there", () => {
    const money = task({ risk: "low", owns_paths: ["src/payments/charge.ts"] });
    const refactor = task({ risk: "high", kind: "refactor" });
    expect(asked(money, undefined, { "owner.words": "on" })).toBe(true);
    expect(asked(task(), undefined, { "owner.words": "on" })).toBe(true);
    expect(asked(money, undefined, { "owner.words": "risky" })).toBe(false);
    expect(asked(refactor, undefined, { "owner.words": "risky" })).toBe(true);
    expect(asked(task({ risk: "critical" }), undefined, { "owner.words": "risky" })).toBe(true);
    expect(asked(money, undefined, { "owner.words": "off" })).toBe(false);
    expect(asked(refactor, undefined, { "owner.words": "off" })).toBe(false);
    expect(ownerWordsOn({ "owner.words": "on" })).toBe(true);
    expect(ownerWordsOn({ "owner.words": "risky" })).toBe(true);
    expect(ownerWordsOn({ "owner.words": "off" }, taskStepEvidence(money))).toBe(false);
  });

  it("the code critic still gates money, migrations and schema paths, and the rest of its sensitive paths", () => {
    const level = (path: string) => criticLevel({ taskId: "t", kind: "feature", risk: "low", paths: [path], checks: [{ exitCode: 0 }] });
    for (const path of ["src/billing/x.ts", "db/migrations/1.sql", "prisma/schema.prisma", "src/auth/login.ts", "src/refunds/a.ts"]) expect(level(path).tier, path).toBe("strict");
    expect(level("src/ui/card.ts").tier).not.toBe("strict");
  });
});

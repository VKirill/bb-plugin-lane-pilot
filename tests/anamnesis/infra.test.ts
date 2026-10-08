import { describe, expect, it } from "vitest";
import { infrastructureReason } from "../../src/rooms/anamnesis/infra";
import { openStore } from "../../src/rooms/anamnesis/store";
import { fragmentJudgment, FRAGMENT_KINDS } from "../../src/rooms/anamnesis/judgment";

describe("the infrastructure filter: such text is never about the owner as a person", () => {
  it.each([
    ["Lane Pilot hub: ssh -i ~/.ssh/ovh_key root@51.38.12.7 then restart", "an IP address"],
    ["сервер хаба 10.8.0.1 за WireGuard", "an IP address"],
    ["ssh deploy@bb.vechkasov.pro для выкладки", "an ssh command"],
    ["ключ лежит в ~/.ssh/id_ed25519 и не должен попасть в git", "a key or secret path"],
    ["положи токен в /Users/vechkasov/secrets/tavily.env", "a key or secret path"],
    ["хаб слушает на bb.vechkasov.pro:8443, не на 80", "a host with a port"],
    ["открой localhost:3000 и проверь", "a local address"],
    ["задай ANAMNESIS_NOTES_DIR и LANE_PILOT_ANAMNESIS_DIR перед запуском", "an environment variable name"],
  ])("%s", (text, reason) => {
    expect(infrastructureReason(text)).toBe(reason);
  });

  it.each([
    "Живёт в Мадриде и работает над агентством",
    "Жена Анна ждёт ребёнка в мае, версия 2.0.1 вышла 12.03.2026",
    "Любит велосипед и фильмы Тарковского, читает про Rust и Go",
    "Всегда просит отчёты по-русски, коротко и без воды",
    "Родился в 1987 году, в семье трое детей. Цена 4.50 за штуку",
  ])("keeps a sentence about a person: %s", (text) => {
    expect(infrastructureReason(text)).toBeNull();
  });

  it("the store ignores an automatic record that looks like infrastructure, and lets the owner write it himself", () => {
    const store = openStore(":memory:");
    const record = { kind: "fact" as const, key: "hub", title: "Hub on 10.0.0.5", statement: "ssh -i ~/.ssh/key root@10.0.0.5", evidence: [{ source: "claude-memory" as const, ref: "p/hub", at: 1000 }] };
    expect(store.upsert(record, { actor: "auto:claude-memory", reason: "t" })).toMatchObject({ action: "ignored", reason: expect.stringMatching(/^infrastructure:/) });
    expect(store.counts().records).toBe(0);
    expect(store.upsert({ ...record, evidence: [] }, { actor: "owner", reason: "told" }).action).toBe("created");
  });
});

describe("what Jev is asked to find", () => {
  it("covers who I am, knowledge, skills, close people, hobbies, interests, life events and preferences, and not projects or tools", () => {
    expect([...FRAGMENT_KINDS].sort()).toEqual(["event", "fact", "hobby", "interest", "knowledge", "person", "preference", "self", "skill"]);
    const t = Object.fromEntries(Object.entries(fragmentJudgment.thresholds).map(([k, v]) => [k, v.default]));
    const answers = (top: string) => ({
      kind: { type: "choice" as const, choice: top, probabilities: { [top]: 0.9, nothing: 0.1 }, confidence: 0.9 },
      about_owner: { type: "noul" as const, noul: 0.9 }, sensitive: { type: "noul" as const, noul: 0.1 },
    });
    const decide = (top: string) => (fragmentJudgment.decide(answers(top) as never, t, { text: "x" }) as { decision: { kind: string } }).decision.kind;
    for (const kind of ["self", "knowledge", "hobby", "person"]) expect(decide(kind)).toBe(kind);
    for (const kind of ["project", "tool"]) expect(decide(kind)).toBe("nothing");
  });
});

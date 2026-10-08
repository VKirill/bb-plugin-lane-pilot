import { describe, expect, it, vi } from "vitest";
import { INCIDENT_APPROVAL_TTL_MS, INCIDENT_DENIED_QUIET_MS, createDeployIncident } from "../../src/server/deploy-incident";

// Audit 2026-10-08 round 3, P0-5: an incident deploy needs a reference the hub confirms; here, the owner's yes through a form.
type Settled = (answer: unknown) => void | Promise<void>;

function setup(options: { pmThread?: string | null; available?: boolean; shown?: boolean } = {}) {
  const kv = new Map<string, unknown>();
  const asks: Array<{ threadId: string; request: Record<string, unknown>; settle: Settled }> = [];
  let clock = 1_000_000;
  const logs: string[] = [];
  const bb = {
    log: { warn: (line: string) => logs.push(line) },
    storage: { kv: {
      get: async (key: string) => kv.get(key) ?? null,
      set: async (key: string, value: unknown) => { kv.set(key, JSON.parse(JSON.stringify(value))); },
      list: async (prefix: string) => [...kv.keys()].filter((key) => key.startsWith(prefix)),
    } },
  };
  const ownerAsk = {
    available: () => options.available ?? true,
    askInBackground: vi.fn(async (threadId: string, request: Record<string, unknown>, settle: Settled) => { asks.push({ threadId, request, settle }); return options.shown ?? true; }),
  };
  const db = { prepare: () => ({ get: () => (options.pmThread === null ? undefined : { pm_thread_id: options.pmThread ?? "thr_pm" }) }) };
  const incident = createDeployIncident({ bb, db, ownerAsk } as never, () => clock);
  return { incident, asks, ownerAsk, advance: (ms: number) => { clock += ms; }, logs, kv };
}
const ask = { reason: "hotfix for the OpenCode helpers", version: "0.1.196", sha: "abc123def456", requestedBy: "ubuntu@mini" };
type View = { requestId: string; state: string; message?: string; sha: string };

describe("the deploy_incident_request RPC", () => {
  it("opens a form for the owner in the PM chat, naming the commit and the reason, and answers pending", async () => {
    const { incident, asks } = setup();
    const first = await incident.request(ask) as View;
    expect(first).toMatchObject({ state: "pending", sha: "abc123def456" });
    expect(first.requestId).toMatch(/^dinc_/);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.threadId).toBe("thr_pm");
    expect(asks[0]!.request).toMatchObject({ source: "gate", options: ["Allow this deploy", "Do not allow"], allowText: false });
    expect(String(asks[0]!.request.question)).toContain("0.1.196");
    expect(String(asks[0]!.request.detail)).toContain("hotfix for the OpenCode helpers");
    expect(String(asks[0]!.request.detail)).toContain("ubuntu@mini");
  });

  it("does not open a second form while one is open for the same commit, and returns the same request", async () => {
    const { incident, asks } = setup();
    const first = await incident.request(ask) as View;
    const again = await incident.request(ask) as View;
    expect(again.requestId).toBe(first.requestId);
    expect(asks).toHaveLength(1);
  });

  it("turns the owner's yes into approved, once: consume spends it, another commit cannot use it", async () => {
    const { incident, asks } = setup();
    const { requestId } = await incident.request(ask) as View;
    expect((await incident.request({ requestId }) as View).state).toBe("pending");
    await asks[0]!.settle({ outcome: "answered", choice: { id: "1", label: "Allow this deploy" }, text: "", line: "Allow this deploy" });
    expect((await incident.request({ requestId, sha: "someotherSHA" }) as View).state).toBe("unknown");
    expect((await incident.request({ requestId, sha: ask.sha }) as View).state).toBe("approved");
    expect((await incident.request({ requestId, sha: ask.sha, consume: true }) as View).state).toBe("approved");
    expect((await incident.request({ requestId, sha: ask.sha, consume: true }) as View).state).toBe("consumed");
  });

  it("keeps to one open form: a request for another commit while one waits is not put to the owner", async () => {
    const { incident, asks } = setup();
    await incident.request(ask);
    const other = await incident.request({ ...ask, sha: "ffff00001111" }) as View;
    expect(other.state).toBe("unavailable");
    expect(other.message).toMatch(/Another incident request/);
    expect(asks).toHaveLength(1);
  });

  it("treats a no, a dismissed form and a silence as not approved, and does not ask again about the same commit for a while", async () => {
    const no = setup();
    const { requestId } = await no.incident.request(ask) as View;
    await no.asks[0]!.settle({ outcome: "answered", choice: { id: "2", label: "Do not allow" }, text: "", line: "Do not allow" });
    expect((await no.incident.request({ requestId }) as View).state).toBe("denied");
    const retry = await no.incident.request(ask) as View;
    expect(retry.state).toBe("denied");
    expect(retry.message).toMatch(/declined/);
    expect(no.asks).toHaveLength(1);
    no.advance(INCIDENT_DENIED_QUIET_MS + 1000);
    expect((await no.incident.request(ask) as View).state).toBe("pending");
    expect(no.asks).toHaveLength(2);

    const silent = setup();
    const quiet = await silent.incident.request(ask) as View;
    await silent.asks[0]!.settle({ outcome: "cancelled", reason: "timeout" });
    expect((await silent.incident.request({ requestId: quiet.requestId }) as View).state).toBe("expired");
  });

  it("lets a yes lapse after ten minutes", async () => {
    const { incident, asks, advance } = setup();
    const { requestId } = await incident.request(ask) as View;
    await asks[0]!.settle({ outcome: "answered", choice: { id: "1", label: "Allow this deploy" }, text: "", line: "Allow this deploy" });
    advance(INCIDENT_APPROVAL_TTL_MS + 1000);
    expect((await incident.request({ requestId, sha: ask.sha, consume: true }) as View).state).toBe("expired");
  });

  it("says unavailable when there is no PM chat or BB cannot show a form, and unknown for an id it never saw or without reason and sha", async () => {
    expect((await setup({ pmThread: null }).incident.request(ask) as View).state).toBe("unavailable");
    expect((await setup({ available: false }).incident.request(ask) as View).state).toBe("unavailable");
    expect((await setup({ shown: false }).incident.request(ask) as View).state).toBe("unavailable");
    const { incident, asks } = setup();
    expect((await incident.request({ requestId: "dinc_nope" }) as View).state).toBe("unknown");
    expect((await incident.request({ reason: "x" }) as View).state).toBe("unknown");
    expect(asks).toHaveLength(0);
  });

  it("can be asked in a given chat", async () => {
    const { incident, asks } = setup();
    await incident.request({ ...ask, threadId: "thr_given" });
    expect(asks[0]!.threadId).toBe("thr_given");
  });

  it("logs the owner's answer with the commit and the reason", async () => {
    const { incident, asks, logs } = setup();
    await incident.request(ask);
    await asks[0]!.settle({ outcome: "answered", choice: { id: "1", label: "Allow this deploy" }, text: "", line: "Allow this deploy" });
    expect(logs.join("\n")).toMatch(/incident deploy of 0\.1\.196 \(abc123def456\) approved.*hotfix for the OpenCode helpers/);
  });
});

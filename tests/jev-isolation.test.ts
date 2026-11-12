import { afterEach, expect, it, vi } from "vitest";
import { classifyPlan } from "../src/rooms/host-worker/host-handlers";
import { jevCallFor } from "../src/rooms/host-worker/jev-call";

afterEach(() => vi.unstubAllGlobals());

it("A-030 a concurrent host call must preserve the key/provider pair of the first call", async () => {
  const sent: Array<{ url: string; auth: string; task: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: { headers: { authorization: string }; body: string }) => {
    sent.push({ url: String(url), auth: init.headers.authorization, task: JSON.parse(init.body).state.task });
    return new Response(JSON.stringify({ answers: { effort: { choice: "low" } } }));
  }));
  // The server puts the key on the call. Overlapping calls must not share one global pair. (2026-10-29 audit A-030)
  const a = classifyPlan({ requestedHostId: "fixture", plan: "project-a", jevApiKey: "fixture-openlux-a", jevProvider: "openlux" }, {} as never);
  const b = classifyPlan({ requestedHostId: "fixture", plan: "project-b", jevApiKey: "fixture-typesafe-b", jevProvider: "typesafe" }, {} as never);
  await Promise.all([a, b]);
  expect(sent.find((x) => x.task === "project-a"), JSON.stringify(sent)).toMatchObject({ url: "https://api.openlux.ai/v1/systemone", auth: "Bearer fixture-openlux-a" });
  expect(sent.find((x) => x.task === "project-b"), JSON.stringify(sent)).toMatchObject({ url: "https://api.typesafe.ai/v1/systemone", auth: "Bearer fixture-typesafe-b" });
});

it("A-030 an empty next request must not retain the preceding request credential", async () => {
  const sent: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { headers: { authorization: string } }) => {
    sent.push(init.headers.authorization);
    return new Response(JSON.stringify({ answers: { effort: { choice: "low" } } }));
  }));
  const first = await jevCallFor({ jevApiKey: "fixture-previous-request", jevProvider: "openlux" });
  expect(first).toMatchObject({ key: "fixture-previous-request", provider: { id: "openlux", url: "https://api.openlux.ai/v1/systemone" } });
  await classifyPlan({ requestedHostId: "fixture", plan: "project-a", jevApiKey: "fixture-previous-request", jevProvider: "openlux" }, {} as never);
  await classifyPlan({ requestedHostId: "fixture", plan: "project-next" }, {} as never);
  expect(sent[0]).toBe("Bearer fixture-previous-request");
  expect(sent.slice(1).some((auth) => auth.includes("fixture-previous-request"))).toBe(false);
  expect((await jevCallFor())?.key ?? "").not.toBe("fixture-previous-request");
});

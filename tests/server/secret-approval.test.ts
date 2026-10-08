import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { loadProjectSettings, openDatabase, saveProjectSetting } from "../../src/database";
import { createSecretApproval } from "../../src/server/secret-approval";
import { allowedSecretNames, declaredAccess } from "../../src/server/secrets";
import type { OwnerAnswer } from "../../src/server/owner-ask";

// A form that settles when the test says so.
function fakeOwnerAsk(shown = true) {
  const asked: Array<{ threadId: string; question: string; detail?: string; options?: readonly string[] }> = [];
  const sent: string[] = [];
  let settle: ((answer: OwnerAnswer) => void | Promise<void>) | null = null;
  const ownerAsk = {
    askInBackground: async (threadId: string, request: { question: string; detail?: string; options?: readonly string[] }, onSettled: (answer: OwnerAnswer) => void | Promise<void>) => {
      asked.push({ threadId, ...request }); settle = onSettled; return shown;
    },
    sendToThread: async (_thread: string, text: string) => { sent.push(text); },
  };
  return { ownerAsk: ownerAsk as never, asked, sent, answer: async (value: OwnerAnswer) => { await settle!(value); } };
}
const yes: OwnerAnswer = { outcome: "answered", choice: { id: "1", label: "Allow for this project" }, text: "", line: "Allow for this project" };
const no: OwnerAnswer = { outcome: "answered", choice: { id: "2", label: "Do not allow" }, text: "", line: "Do not allow" };

function setup(shown = true) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const ask = fakeOwnerAsk(shown);
  return { db, ask, approval: createSecretApproval({ db, ownerAsk: ask.ownerAsk, log: () => undefined }) };
}
const request = { projectId: "P", pmThreadId: "pm", entries: ["STRIPE_TEST_KEY", "net:api.stripe.com"], use: "the check `node e2e.js` of task T-1" };

describe("owner approval of secrets", () => {
  it("an empty setting allows nothing; the declared access lists names and the hosts of checks that carry secrets", () => {
    expect(allowedSecretNames({})).toEqual([]);
    expect(declaredAccess([{ secrets: ["A"], network: ["Api.X.com"] }, { network: ["ignored.com"] }, { secrets: ["A", "B"] }])).toEqual(["A", "net:api.x.com", "B"]);
  });

  it("asks the owner once in the PM chat and does not ask again while the form is open", async () => {
    const { approval, ask } = setup();
    expect(await approval.request(request)).toBe("asked");
    expect(await approval.request(request)).toBe("asked");
    expect(ask.asked).toHaveLength(1);
    expect(ask.asked[0]).toMatchObject({ threadId: "pm", options: ["Allow for this project", "Do not allow"] });
    expect(ask.asked[0]!.question).toBe("Allow the check `node e2e.js` of task T-1 to use the secret STRIPE_TEST_KEY and reach api.stripe.com?");
  });

  it("a yes is saved in the project's secrets.allow and kept beside what was there", async () => {
    const { approval, ask, db } = setup();
    saveProjectSetting(db, "P", "secrets.allow", "OTHER_KEY");
    await approval.request(request);
    await ask.answer(yes);
    const allowed = allowedSecretNames(loadProjectSettings(db, "P"));
    expect(allowed).toEqual(["OTHER_KEY", "STRIPE_TEST_KEY", "net:api.stripe.com"]);
    expect(ask.sent[0]).toContain("allowed STRIPE_TEST_KEY, net:api.stripe.com");
  });

  it("a no changes nothing and the question waits an hour", async () => {
    const { approval, ask, db } = setup();
    await approval.request(request, 1000);
    await ask.answer(no);
    expect(allowedSecretNames(loadProjectSettings(db, "P"))).toEqual([]);
    expect(ask.sent[0]).toContain("did not allow");
    expect(await approval.request(request, Date.now() + 60_000)).toBe("declined");
    expect(await approval.request(request, Date.now() + 61 * 60_000)).toBe("asked");
    expect(ask.asked).toHaveLength(2);
  });

  it("with no form to show, or no PM chat, it says so and asks again next time", async () => {
    const closed = setup(false);
    expect(await closed.approval.request(request)).toBe("unavailable");
    expect(await closed.approval.request(request)).toBe("unavailable");
    expect(closed.ask.asked).toHaveLength(2);
    expect(await setup().approval.request({ ...request, pmThreadId: undefined })).toBe("unavailable");
  });
});

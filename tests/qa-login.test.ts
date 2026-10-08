import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lane-pilot/thread-observe", () => ({ observeStageChild: async () => ({ kind: "completed" }) }));
import { coreRequiredSessionAdvertisement, requiredSessionPolicySpawnBinding } from "../src/rooms/native-agent/helper-context";
import type { HelperPolicySnapshot } from "../src/rooms/native-agent/helper-context";
import { forgetSecrets, registerSecrets } from "@lane-pilot/kit";
import { awaitQaVerdict, parseQaCases, qaThreadPrompt } from "../src/rooms/qa/server/qa-thread";

// Test value only: not a real credential.
const PASSWORD = "test-login-pass-Xk29LmQ";
afterEach(() => forgetSecrets());

describe("browser check login (J5)", () => {
  it("reads `login: NAME` off the front of a case", () => {
    const parsed = parseQaCases(["login: SHOP_QA — open the cabinet", "Login : shop_qa; orders list", "login: ONLY_NAME", "Open the home page", "the login: text is not a prefix"]);
    expect(parsed.cases).toEqual([
      { text: "open the cabinet", login: "SHOP_QA" },
      { text: "orders list", login: "shop_qa" },
      { text: "sign in and check that the account page opens", login: "ONLY_NAME" },
      { text: "Open the home page", login: null },
      { text: "the login: text is not a prefix", login: null },
    ]);
    expect(parsed.logins).toEqual(["SHOP_QA", "shop_qa", "ONLY_NAME"]);
  });

  it("the thread's prompt names only that login, and a check without one gets no Env Catalog", () => {
    const base = { url: "https://shop.test/", viewports: "375", envClass: "staging", authorized: false, qaHostId: "host_mini" };
    const withLogin = qaThreadPrompt({ ...base, cases: ["login: SHOP_QA — open the cabinet", "Open the home page"] });
    expect(withLogin).toContain("1. open the cabinet (sign in first with the login SHOP_QA)");
    expect(withLogin).toContain("2. Open the home page");
    expect(withLogin).toContain("The only account you may use is the Env Catalog login SHOP_QA");
    expect(withLogin).toContain("Never call env_list");
    expect(qaThreadPrompt({ ...base, cases: ["Open the home page"] })).not.toContain("env_get");
  });

  it("the spawn policy adds Env Catalog to the browser-check profile only when asked", () => {
    const snapshot: HelperPolicySnapshot = { schemaVersion: 1, mode: "roles", settings: { mode: "roles", skills: [], mcpServers: [], bbPlugins: [], nativePlugins: [] }, parentRequired: false, parentPolicy: null, policy: null };
    const bind = (extra?: { bbPlugins: string[]; skills: string[] }) => requiredSessionPolicySpawnBinding({ capability: "required", snapshot, advertised: coreRequiredSessionAdvertisement(), providerId: "claude-code", role: "browser-qa", extra }) as
      { experimental_vkRequiredSessionPolicy: { policy: { bbPlugins: { names: string[] }; skills: { names: string[] } } } };
    expect(bind().experimental_vkRequiredSessionPolicy.policy.bbPlugins.names).not.toContain("env-catalog");
    const extra = bind({ bbPlugins: ["env-catalog"], skills: ["env-catalog"] }).experimental_vkRequiredSessionPolicy.policy;
    expect(extra.bbPlugins.names).toEqual(expect.arrayContaining(["browser-automation", "env-catalog"]));
    expect(extra.skills.names).toEqual(expect.arrayContaining(["browser-automation", "env-catalog"]));
  });

  it("masks the password if the check thread prints it in its verdict", async () => {
    registerSecrets([PASSWORD]);
    const verdict = { verdict: "failed", summary: `login form rejected ${PASSWORD}`, cases: [{ case: "orders", viewport: "375", result: "failed", note: `typed ${PASSWORD}` }] };
    const bb = { sdk: { threads: { output: async () => ({ output: `done\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`` }) } } };
    const result = await awaitQaVerdict({ bb: bb as never, isDisposed: () => false }, "thr", Date.now() + 5_000, 5);
    expect(result).toMatchObject({ verdict: "failed", summary: "login form rejected ***" });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });
});

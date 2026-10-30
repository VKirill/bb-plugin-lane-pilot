import { describe, expect, it } from "vitest";
import { providerBlockedForFolder, resolveSpawnModel } from "../src/rooms/core/server/spawn-model";

// Live cause (2026-10-30): opencode2's serve on the Mac mini has no Documents access; /api/mcp 500s EPERM for any
// folder under ~/Documents and the session policy refuses the start (vk_required_session_policy_unenforceable_mcp_servers).
describe("a provider that cannot work in the folder", () => {
  it("opencode2 is blocked under ~/Documents and free elsewhere; other providers are never blocked", () => {
    expect(providerBlockedForFolder("opencode2", "/Users/vechkasov/Documents/site")).toBe("opencode2_documents_eperm");
    expect(providerBlockedForFolder("opencode2", "/Users/vechkasov/Documents")).toBe("opencode2_documents_eperm");
    expect(providerBlockedForFolder("opencode2", "/Users/vechkasov/BB-service/x")).toBeNull();
    expect(providerBlockedForFolder("opencode2", "/home/ubuntu/Documents/x")).toBeNull();
    expect(providerBlockedForFolder("claude-code", "/Users/vechkasov/Documents/site")).toBeNull();
    expect(providerBlockedForFolder("opencode2", null)).toBeNull();
  });

  it("the resolver takes the role's next provider when the pick cannot work in the folder", () => {
    const blocked = resolveSpawnModel({ role: "analyst", settings: {}, envPath: "/Users/vechkasov/Documents/proj", hostId: "h" } as never);
    const free = resolveSpawnModel({ role: "analyst", settings: {}, envPath: "/Users/vechkasov/Work/proj", hostId: "h" } as never);
    if (free.providerId === "opencode2") expect(blocked.providerId).not.toBe("opencode2");
    else expect(blocked.providerId).toBe(free.providerId);
  });
});

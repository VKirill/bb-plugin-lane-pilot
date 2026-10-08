import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostContract } from "../src/contracts";

// Every host.call("<method>", { … }) on the server must pass input its host contract accepts: a strict schema refused
// prepareOpencodeMinimal's requestedHostId on the live hub (0.1.194) and every OpenCode helper failed to start.
const files = (dir:string):string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
});

describe("host call inputs match the host contracts", () => {
  it("passes requestedHostId only to methods whose input declares it", () => {
    const problems:string[] = [];
    for (const file of [...files("src/server"), "server.ts"]) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/host\.call\(\s*"([A-Za-z]+)"\s*,\s*\{([^}]*)\}/g)) {
        const [, method, body] = match;
        const contract = (hostContract as Record<string, { input?: { shape?: Record<string, unknown> } }>)[method!];
        if (!contract?.input?.shape) continue;
        if (/\brequestedHostId\b/.test(body!) && !("requestedHostId" in contract.input.shape)) problems.push(`${file}: ${method} gets requestedHostId it does not accept`);
      }
    }
    expect(problems).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanCheckOutput } from "../src/output-excerpt";
import { forgetSecrets, redactKnown, redactKnownDeep, redactSecrets, registerSecrets, secretStrings } from "../src/redact";
import { createCore } from "../src/server/core";

// Test values only: none of them is a real credential.
const KEY = "test-key-Zq81xW0pLm";
const PEM = "-----BEGIN TEST KEY-----\nQUJDREVGR0hJSktMTU5PUA\nUVJTVFVWV1hZWjAxMjM0NTY3\n-----END TEST KEY-----";

afterEach(() => forgetSecrets());

describe("redact", () => {
  it("masks a value in every form a program prints it", () => {
    const text = [`plain ${KEY}`, `json ${JSON.stringify({ k: KEY })}`, `url ?k=${encodeURIComponent(KEY)}`, `b64 ${Buffer.from(KEY).toString("base64")}`].join("\n");
    const out = redactSecrets(text, [KEY]);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(Buffer.from(KEY).toString("base64"));
    expect(out).toContain("plain ***");
  });

  it("masks each line of a multi-line key and leaves short values alone", () => {
    const out = redactSecrets(`oops\nQUJDREVGR0hJSktMTU5PUA\nfine ok 12`, [PEM, "ok", "12"]);
    expect(out).not.toContain("QUJDREVGR0hJSktMTU5PUA");
    expect(out).toContain("fine ok 12");
  });

  it("reads the secret strings of a catalog record, not its user name", () => {
    expect(secretStrings({ value: null, access: { username: "deploy", password: "pw-test-1234", privateKey: PEM } })).toEqual(["pw-test-1234", PEM]);
    expect(secretStrings({ value: KEY, access: null })).toEqual([KEY]);
  });

  it("remembered secrets are masked in check output, nested JSON and the plugin log", () => {
    expect(redactKnown(`a ${KEY}`)).toBe(`a ${KEY}`);
    registerSecrets([KEY]);
    expect(cleanCheckOutput(`token=${KEY}\n`)).toBe("token=***");
    expect(redactKnownDeep({ a: [`x ${KEY}`], b: { c: KEY } })).toEqual({ a: ["x ***"], b: { c: "***" } });
    const lines: string[] = [];
    const bb = { log: { debug: (m: string) => lines.push(m), info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) },
      onDispose: vi.fn(), hosts: { experimental_client: () => ({ call: vi.fn() }) } };
    try { createCore(bb as never, {} as never); } catch { /* the rest of the core needs a real SDK */ }
    bb.log.warn(`failed with ${KEY}`);
    expect(lines.at(-1)).toBe("failed with ***");
  });
});

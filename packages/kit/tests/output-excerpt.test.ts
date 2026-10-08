import { describe, expect, it } from "vitest";
import { cleanCheckOutput, failureExcerpt } from "@lane-pilot/kit";

describe("check output cleaning", () => {
  it("strips escapes, redraws and npm notices but keeps the words and layout", () => {
    const raw = "\x1b]0;vitest\x07\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\\n"
      + "\x1b[?25l\x1b[1G\x1b[32m✓\x1b[39m passes\x1b[2m quietly\x1b[39m\r\x1b[1G\x1b[0K\x1b[2mredrawn\x1b[39m\n"
      + "npm warn deprecated hoek\n\n\n\nnpm notice New major version of npm available: 11.0.0\n\x1b[?25h";
    const cleaned = cleanCheckOutput(raw);
    expect(cleaned).not.toMatch(/\x1b|\r/);
    expect(cleaned).not.toContain("npm notice");
    expect(cleaned).toBe("link\n✓ passes quietlyredrawn\nnpm warn deprecated hoek");
  });
});

describe("failure excerpt", () => {
  const filler = Array.from({ length: 40 }, (_, i) => ` \x1b[32m✓\x1b[39m src/other${i}.test.ts \x1b[2m(1 test)\x1b[39m \x1b[2m30ms\x1b[39m`).join("\n");

  it("quotes the failure even when it sits far from the end, cleaned, with the run summary", () => {
    const raw = [
      "> selfystudio@0.1.0 test",
      "> vitest run src",
      "\x1b[2mRUN \x1b[22m\x1b[36mv3.2.4\x1b[39m",
      filler,
      "npm notice New major version of npm available: 11.0.0",
      " \x1b[31mFAIL\x1b[39m \x1b[36msrc/cards/GreetingCard.test.ts\x1b[39m > renders the card title",
      "\x1b[31mAssertionError\x1b[39m: expected 'Hello <name>!' to be 'Hello, world!' // Object.is equality",
      "\x1b[32m- Expected\x1b[39m",
      "\x1b[32m+ Received\x1b[39m",
      "",
      "\x1b[32m- Hello <name>!\x1b[39m",
      "\x1b[32m+ Hello, world!\x1b[39m",
      " \x1b[2mTest Files\x1b[39m \x1b[31m1 failed\x1b[39m (40)",
      " \x1b[2m     Tests\x1b[39m \x1b[31m1 failed\x1b[39m (40)",
    ].join("\n");
    const excerpt = failureExcerpt(raw);
    expect(excerpt).not.toMatch(/\x1b/);
    expect(excerpt.trimStart().startsWith("FAIL src/cards/GreetingCard.test.ts")).toBe(true);
    expect(excerpt).toContain("AssertionError: expected 'Hello <name>!' to be 'Hello, world!'");
    expect(excerpt).toContain("+ Hello, world!");
    expect(excerpt).toContain("Test Files 1 failed (40)");
    expect(excerpt).toContain("Tests 1 failed (40)");
    // The old raw tail would have quoted the green filler above the failure instead.
    expect(excerpt).not.toContain("src/other0.test.ts");
  });

  it("appends the summary when the failure section alone outgrows the limit", () => {
    const diff = Array.from({ length: 80 }, (_, i) => `- expected line ${i} to be received`).join("\n");
    const raw = `FAIL src/long.test.ts\nError: snapshot drift\n${diff}\n\n Test Files 1 failed (1)\n      Tests 1 failed (1)\n`;
    const excerpt = failureExcerpt(raw);
    expect(excerpt.length).toBeLessThan(raw.length);
    expect(excerpt).toContain("Error: snapshot drift");
    expect(excerpt.endsWith("Tests 1 failed (1)")).toBe(true);
    expect(excerpt.match(/Test Files 1 failed \(1\)/g)).toHaveLength(1);
  });

  it("falls back to the cleaned tail when nothing names the failure", () => {
    const raw = "connecting to terminal\n\x1b[?25lwaiting for vitest\x1b[?25h\n\n\nverification timed out after 120s\n";
    expect(failureExcerpt(raw)).toBe("connecting to terminal\nwaiting for vitest\n\nverification timed out after 120s");
    expect(failureExcerpt("")).toBe("");
  });
});

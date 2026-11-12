import { describe, expect, it } from "vitest";
import { looksSensitive } from "@lane-pilot/jev";

describe("looksSensitive: a text the router keeps away from the Jev API", () => {
  it("plain work is not sensitive", () => {
    const clean = "Deployed the site to staging. Smoke checks passed on the home page and the pricing page. Next step: nothing.";
    expect(looksSensitive(clean, clean)).toBe(false);
  });

  it("a redaction, a credential or a talk about the environment is", () => {
    expect(looksSensitive("a sk-live-abcdef0123456789 b", "a *** b")).toBe(true);
    for (const text of [
      "Added OPENAI_API_KEY=abc to the settings of the service.",
      "Read the value with env_get from the Env Catalog and wrote it to .env.local.",
      "The request carried Authorization: Bearer abcdefghijklmnop0123.",
      "Found sk-live-abcdef0123456789 in the logs.",
    ]) expect(looksSensitive(text, text)).toBe(true);
  });
});

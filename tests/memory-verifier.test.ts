import { describe, expect, it } from "vitest";
import { memoryEntrySupported } from "../packages/memory-core/src";

// arXiv #7: the verifier keeps entries whose concrete claims the accepted result supports.
describe("memoryEntrySupported", () => {
  const result = '{"files":["src/store.ts:142"],"checks":["npx vitest run: exit 0"],"notes":"migration added at the end, port stays 3000"}';
  it("keeps a paraphrase with no concrete claims and a supported claim", () => {
    expect(memoryEntrySupported("Always append migrations at the end.", result)).toBe(true);
    expect(memoryEntrySupported("src/store.ts keeps the migration list.", result)).toBe(true);
    expect(memoryEntrySupported("The API listens on port 3000.", result)).toBe(true);
  });
  it("drops an entry inventing a path, version or number", () => {
    expect(memoryEntrySupported("src/other.ts holds the list.", result)).toBe(false);
    expect(memoryEntrySupported("The API listens on port 4099.", result)).toBe(false);
    expect(memoryEntrySupported("Requires plugin 0.1.390.", result)).toBe(false);
  });
});

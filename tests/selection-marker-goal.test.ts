import { describe, expect, it } from "vitest";
import { withoutSelectionMarkers } from "../src/rooms/native-agent/models/native-session";

// magicseo replay (2026-10-31): the PM was started from the CLI with the selection marker in its first message.
describe("a selection marker never reaches a goal", () => {
  const marker = "[lane-pilot-selection:656ba95b-1259-4d0b-b242-789118f7610f]";

  it("is cut from the owner's text, wherever it stands", () => {
    expect(withoutSelectionMarkers(`${marker}\n\nhttps://lk.magicseo.ru/ - надо просканировать сервис`)).toBe("https://lk.magicseo.ru/ - надо просканировать сервис");
    expect(withoutSelectionMarkers(`a ${marker} b`)).toBe("a b");
    expect(withoutSelectionMarkers("no marker here")).toBe("no marker here");
  });
});

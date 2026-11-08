import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMemorySettings } from "@lane-pilot/memory-core";

// The «Знания → Память» switch showed «Выкл» on unset projects while the server ran memory on (owner, 2026-11-08).
describe("knowledge tab memory switch", () => {
  it("shows the server default when the setting is unset", () => {
    const tab = readFileSync("src/rooms/pages/tab-knowledge.tsx", "utf8");
    const fallback = /enabledKey="memory\.enabled" fallback=\{(true|false)\}/.exec(tab)?.[1];
    expect(fallback).toBe(String(parseMemorySettings({}).enabled));
  });
});

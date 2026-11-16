import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { roleSpec } from "../../src/rooms/workflow/server/workflow-agent";
import { chain, reply, runHomeWorld } from "./run-home-world";

const captureGraph = (path = ".agents/marketing/cro/{{slug}}/") => chain({
  inputs: [{ name: "landing_url", type: "string", required: true }],
  outputs: [{ name: "capture_path", type: "string", required: false }],
  nodes: [
    {
      id: "capture",
      type: "agent",
      role: "browser-qa",
      prompt: "Collect only; return structured capture_data and capture_text. Do not write repository files.",
      out: {
        screens_path: "string",
        h1: "string",
        offer_text: "string",
        price_text: "string",
        cta_count: "int",
        capture_data: "object",
        capture_text: "string",
      },
    },
    {
      id: "persist_capture",
      type: "action",
      action: "fs.write",
      path,
      contents: { "capture.json": { data: "{{capture.capture_data}}", text: "{{capture.capture_text}}" } },
      out: { capture_path: "string" },
    },
    { id: "done", type: "action", action: "emit", map: { capture_path: "persist_capture.capture_path" } },
  ],
  edges: [
    { from: "start", to: "capture" },
    { from: "capture", to: "persist_capture" },
    { from: "persist_capture", to: "done" },
  ],
});

const browserReply = reply({
  screens_path: "screens.json",
  h1: "Restoration",
  offer_text: "Restore any photo",
  price_text: "from 990",
  cta_count: 1,
  capture_data: { viewport: "375x812", h1: "Restoration", ctas: [{ text: "Order", target: "/order" }] },
  capture_text: "Restore any photo from 990",
  handoff: "capture returned",
});

describe("mkt landing CRO capture contract", () => {
  it("keeps browser-qa read-only and does not grant repository access", () => {
    const spec = roleSpec("browser-qa");
    expect(spec.readOnly).toBe(true);
    expect(spec.editable(".agents/marketing/cro/capture.json")).toBe(false);
    expect(spec.editable(".bb/chats/pm/artifacts/capture.json")).toBe(true);
  });

  it("persists returned structured capture data through the registered fs.write action", async () => {
    const world = await runHomeWorld({ capture: [browserReply] });
    try {
      const summary = await world.start(captureGraph(), { landing_url: "https://example.test/restore" }).done;
      expect(summary.status).toBe("succeeded");
      const capturePath = String(summary.output?.capture_path);
      expect(capturePath).toMatch(/^\.agents\/marketing\/cro\/run\/capture\.json$/);
      expect(existsSync(join(world.checkout, capturePath))).toBe(true);
      expect(JSON.parse(readFileSync(join(world.checkout, capturePath), "utf8"))).toEqual({
        data: {
          viewport: "375x812",
          h1: "Restoration",
          ctas: [{ text: "Order", target: "/order" }],
        },
        text: "Restore any photo from 990",
      });
    } finally {
      await world.dispose();
    }
  });

  it("does not emit done when fs.write rejects a path", async () => {
    const world = await runHomeWorld({ capture: [browserReply] });
    try {
      const summary = await world.start(captureGraph("../capture.json"), { landing_url: "https://example.test/restore" }).done;
      expect(summary.status).toBe("failed");
      expect(summary.output ?? {}).not.toHaveProperty("capture_path");
    } finally {
      await world.dispose();
    }
  });
});

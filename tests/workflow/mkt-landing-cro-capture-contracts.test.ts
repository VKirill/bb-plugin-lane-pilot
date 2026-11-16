import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { roleSpec } from "../../src/rooms/workflow/server/workflow-agent";
import { chain, reply, runHomeWorld } from "./run-home-world";

const captureGraph = (path = ".agents/marketing/cro/{{slug}}/{{run_id}}/") => chain({
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

const browserCapture = {
  viewport: "375x812",
  h1: "Restoration",
  ctas: [{ text: "Order", target: "/order" }],
};

const browserReply = reply({
  screens_path: "stale-screens.json",
  h1: "Restoration",
  offer_text: "Restore any photo",
  price_text: "from 990",
  cta_count: 1,
  capture_data: browserCapture,
  capture_text: "Restore any photo from 990",
  handoff: "capture returned",
});

const captureMessageGraph = (ads = ".agents/marketing/cro/run/ads.json") => {
  const base = captureGraph();
  const message = messageMatchNodes("{{persist_capture.capture_path}}", ads);
  return chain({
    ...base,
    outputs: [
      { name: "min_score", type: "number", required: false },
      { name: "mismatches", type: "int", required: false },
      { name: "price_mismatch", type: "bool", required: false },
      { name: "report_path", type: "string", required: false },
    ],
    nodes: [...base.nodes.filter((node) => node.id !== "done"), ...message],
    edges: [...base.edges.filter((edge) => edge.to !== "done"), { from: "persist_capture", to: "message_match" }, { from: "message_match", to: "done" }],
  });
};

const messageMatchNodes = (capture: string, ads: string) => [
    {
      id: "message_match",
      type: "action",
      action: "sp.message_match",
      params: {
        ads,
        capture,
        target: "{{$inputs.landing_url}}",
        minLemmaOverlap: 0.5,
      },
      out: {
        min_score: "number",
        mismatches: "int",
        price_mismatch: "bool",
        report_path: "string",
      },
    },
    {
      id: "done",
      type: "action",
      action: "emit",
      map: {
        min_score: "message_match.min_score",
        mismatches: "message_match.mismatches",
        price_mismatch: "message_match.price_mismatch",
        report_path: "message_match.report_path",
      },
    },
  ];

const messageMatchGraph = (capture = ".agents/marketing/cro/run/capture.json", ads = ".agents/marketing/cro/run/ads.json") => chain({
  inputs: [{ name: "landing_url", type: "string", required: true }],
  outputs: [
    { name: "min_score", type: "number", required: false },
    { name: "mismatches", type: "int", required: false },
    { name: "price_mismatch", type: "bool", required: false },
    { name: "report_path", type: "string", required: false },
  ],
  nodes: messageMatchNodes(capture, ads),
  edges: [
    { from: "start", to: "message_match" },
    { from: "message_match", to: "done" },
  ],
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
      expect(capturePath).toBe(`.agents/marketing/cro/run/${summary.runId}/capture.json`);
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

  it("feeds persisted capture bytes to the registered message_match handler, not stale screens_path", async () => {
    const world = await runHomeWorld({ capture: [browserReply] });
    try {
      const adsPath = join(world.checkout, ".agents/marketing/cro/run/ads.json");
      const stalePath = join(world.checkout, "stale-screens.json");
      mkdirSync(join(world.checkout, ".agents/marketing/cro/run"), { recursive: true });
      writeFileSync(adsPath, JSON.stringify([
        { id: "ad_restore", keyword: "restore photo", title: "Restore any photo", text: "Restore any photo" },
      ]));
      writeFileSync(stalePath, "not JSON");

      const summary = await world.start(captureMessageGraph(), { landing_url: "https://example.test/restore" }).done;
      expect(summary.status).toBe("succeeded");

      // The capture agent's adversarial screens_path is stale and unreadable. The real
      // consumer still succeeds from the fs.write receipt's capture.json bytes.
      const persisted = JSON.parse(readFileSync(join(world.checkout, `.agents/marketing/cro/run/${summary.runId}/capture.json`), "utf8"));
      expect(persisted.data).toEqual(browserCapture);
      expect(summary.output).toMatchObject({ mismatches: 0, price_mismatch: false });
    } finally {
      await world.dispose();
    }
  });

  it("fails closed when the real message_match script returns a schema error", async () => {
    const world = await runHomeWorld();
    try {
      const capturePath = ".agents/marketing/cro/run/capture.json";
      const adsPath = ".agents/marketing/cro/run/ads.json";
      mkdirSync(join(world.checkout, ".agents/marketing/cro/run"), { recursive: true });
      writeFileSync(join(world.checkout, capturePath), JSON.stringify({
        data: { h1: "Restore any photo", title: "Restore any photo", first_screen: "Restore any photo from 990 ₽" },
        text: "Restore any photo from 990 ₽",
      }));
      writeFileSync(join(world.checkout, adsPath), JSON.stringify({ ads: "wrong schema" }));

      const summary = await world.start(messageMatchGraph(capturePath, adsPath), { landing_url: "https://example.test/restore" }).done;
      expect(summary.status).toBe("failed");
      expect(summary.output ?? {}).not.toHaveProperty("min_score");
      expect(summary.output ?? {}).not.toHaveProperty("mismatches");
    } finally {
      await world.dispose();
    }
  });

  it("wires analyze to the persisted capture receipt and never to screens_path", () => {
    const workflow = JSON.parse(readFileSync(join(process.cwd(), "workflows/mkt-landing-cro-audit.json"), "utf8")) as {
      nodes: Array<{ id: string; prompt?: string }>;
    };
    const analyze = workflow.nodes.find((node) => node.id === "analyze");
    expect(analyze?.prompt).toContain("{{persist_capture.capture_path}}");
    expect(analyze?.prompt).not.toContain("{{capture.screens_path}}");
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { backlogReadCommand, parseBacklogOutput } from "../../src/rooms/backlog";
import { BACKLOG_MARK } from "../../src/rooms/backlog/logic";
import { nextAction, type Phase } from "../../src/rooms/phase/logic";
import { rubricLine } from "../../src/rooms/phase/stages";
import { openDatabase } from "../../src/rooms/plugin-db";
import { queryTokenUsage, syncTokenUsage, utcDay } from "../../src/rooms/usage/server/token-usage";

const discussion = {
  id: "ph1", projectId: "p", pmThreadId: "thr", runId: null, title: "Sums", goal: "skip empty cells",
  stage: "discussion", state: "active", record: {}, edition: 1, createdAt: 1, updatedAt: 1,
} as Phase;

describe("intake, backlog read, spend book", () => {
  it("[sma:m_cd_phase_disc] a phase at discussion hands the chat the rubric and the card write", () => {
    const action = nextAction(discussion, new Map());
    expect(action.stage).toBe("discussion");
    expect(action.waitsForPm).toBe(true);
    expect(action.text).toContain("stage 1, discussion");
    expect(action.text).toContain(rubricLine("discussion"));
    expect(action.text).toContain('lane_pilot_phase {action:"context"');
    expect(action.text).toContain("Write the discussion to files");
  });

  it("[sma:m_in_parse] [sma:m_in_planning_home] only lines under the backlog marker are read, and only from .agents/todos", () => {
    expect(parseBacklogOutput("noise\nnot a heading\n<<<boom")).toEqual([]);
    expect(parseBacklogOutput(`${BACKLOG_MARK} .agents/todos/items/x/meta.yaml\ntitle: no id\n`)).toEqual([]);
    const marked = `${BACKLOG_MARK} .agents/todos/items/a/meta.yaml\nid: a\ntitle: A\nstatus: ready\nestimate: 3\n`;
    expect(parseBacklogOutput(`before the heading\n${marked}`).map((item) => item.id)).toEqual(["a"]);
    expect(backlogReadCommand).toContain(".agents/todos/items");
    const dir = mkdtempSync(join(tmpdir(), "lp-sma-todos-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "meta.yaml"), "id: code\nstatus: ready\nestimate: 1\n");
    expect(parseBacklogOutput(execSync(backlogReadCommand, { cwd: dir, shell: "/bin/sh", encoding: "utf8" }))).toEqual([]);
    mkdirSync(join(dir, ".agents/todos/items/a"), { recursive: true });
    writeFileSync(join(dir, ".agents/todos/items/a/meta.yaml"), "id: a\ntitle: A\nstatus: ready\nestimate: 3\n");
    expect(parseBacklogOutput(execSync(backlogReadCommand, { cwd: dir, shell: "/bin/sh", encoding: "utf8" })).map((item) => item.id)).toEqual(["a"]);
  });

  it("[sma:m_cf_book_usage] spend is booked under the model the turn actually used", async () => {
    const now = Date.now();
    const last = { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, totalTokens: 14 };
    const events = [
      { seq: 1, createdAt: now, type: "provider/modelFallback", data: { fallbackModel: "sonnet", originalModel: "opus" } },
      { seq: 2, createdAt: now, type: "thread/tokenUsage/updated", data: { tokenUsage: { last, total: last } } },
    ];
    const { bb } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        projects: { list: async () => [{ id: "proj_a", name: "A" }] },
        threads: {
          list: async () => [{ id: "thr_a", projectId: "proj_a", providerId: "claude-code" }],
          events: { list: async (args: { afterSeq?: string; types?: readonly string[] }) => {
            const after = args.afterSeq ? Number(args.afterSeq) : 0;
            const allowed = new Set(args.types ?? []);
            return events.filter((event) => event.seq > after && (!allowed.size || allowed.has(event.type)));
          } },
        },
      } as never,
    });
    const db = openDatabase(bb);
    await syncTokenUsage({ bb, db }, { sinceDays: 1 });
    const booked = await queryTokenUsage({ bb, db }, { range: "7d" });
    expect(booked.byModel.map((row) => row.model)).toEqual(["sonnet"]);
    expect(booked.byModel[0]?.total).toBe(14);
    expect(booked.series.find((row) => row.day === utcDay(now))?.models[0]?.model).toBe("sonnet");
  });

});

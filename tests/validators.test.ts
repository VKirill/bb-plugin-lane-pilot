import { describe, expect, it } from "vitest";
import { validateDeliverable, type RunResult } from "../src/rooms/validators/deliverable";

const hostOf = (script: (command: string) => RunResult | null) => ({
  host: { run: async (_id: string, _cwd: string, command: string, _t: number) => script(command) ?? { exitCode: 0, stdout: "", stderr: "" } },
  hostId: "h1",
});

describe("artifact validator", () => {
  it("rejects an empty file and accepts a non-empty one", async () => {
    expect((await validateDeliverable("artifact", "/tmp/x", { readFile: () => "" })).ok).toBe(false);
    expect((await validateDeliverable(null, "/tmp/x", { readFile: () => "content" })).ok).toBe(true);
  });
});

describe("text validator", () => {
  it("flags neural slop without ru-check installed", async () => {
    const bad = await validateDeliverable("text", "/tmp/t.md", {
      ...hostOf(() => ({ exitCode: 3, stdout: "", stderr: "" })),
      readFile: () => "Важно отметить, что в современном мире это не просто текст.",
    });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/slop/);
    const good = await validateDeliverable("text", "/tmp/t.md", { readFile: () => "Миграция добавляется в конец массива." });
    expect(good.ok).toBe(true);
  });
});

describe("video validator", () => {
  it("rejects a file without an audio stream and checks loudness", async () => {
    const noAudio = await validateDeliverable("video", "/tmp/v.mp4", hostOf((command) =>
      command.includes("ffprobe") ? { exitCode: 0, stdout: JSON.stringify({ streams: [{ codec_type: "video" }], format: { duration: "12.0" } }), stderr: "" } : null));
    expect(noAudio.ok).toBe(false);
    expect(noAudio.reason).toMatch(/audio/);
    const quiet = await validateDeliverable("video", "/tmp/v.mp4", hostOf((command) => {
      if (command.includes("ffprobe")) return { exitCode: 0, stdout: JSON.stringify({ streams: [{ codec_type: "video" }, { codec_type: "audio" }], format: { duration: "12.0" } }), stderr: "" };
      if (command.includes("loudnorm")) return { exitCode: 0, stdout: '"input_i" : "-23.5"', stderr: "" };
      return null;
    }));
    expect(quiet.ok).toBe(false);
    expect(quiet.reason).toMatch(/LUFS/);
    const ok = await validateDeliverable("video", "/tmp/v.mp4", hostOf((command) => {
      if (command.includes("ffprobe")) return { exitCode: 0, stdout: JSON.stringify({ streams: [{ codec_type: "video" }, { codec_type: "audio" }], format: { duration: "12.0" } }), stderr: "" };
      if (command.includes("loudnorm")) return { exitCode: 0, stdout: '"input_i" : "-14.2"', stderr: "" };
      return null;
    }));
    expect(ok.ok).toBe(true);
  });
});

describe("invoice validator", () => {
  it("rejects a PDF without the requested INN", async () => {
    const bad = await validateDeliverable("invoice", "/tmp/i.pdf", {
      readFile: () => "Счёт № 17 на сумму 1 500.00\nБИК 044525593\nсч 40702810123456789012 кор 30101810400000000225",
      brief: { inn: "7707083893", amount: 1500, bik: "044525593", company: "ООО Ромашка", service: "услуги" },
    });
    expect(bad.ok).toBe(false);
  });
});

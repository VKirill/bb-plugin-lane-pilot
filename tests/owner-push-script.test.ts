import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/lp-owner-push.sh", import.meta.url));

/** A hub with a fake `bb` (answers the digest, records the acknowledgement) and a fake `curl` (records the message, can fail). */
function hub(digest: Record<string, unknown>, options: { curlFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lp-owner-push-"));
  const home = join(dir, "home");
  mkdirSync(join(home, ".config", "lp-metrics"), { recursive: true });
  writeFileSync(join(home, ".config", "lp-metrics", "tg.env"), "TG_TOKEN=t\nTG_CHAT=c\nTG_TOPIC=9\n");
  writeFileSync(join(dir, "digest.json"), JSON.stringify({ result: digest }));
  const bb = join(dir, "bb");
  writeFileSync(bb, `#!/bin/sh
method="$5"; input="$7"
cp "$input" "${dir}/in-$method.json"
if [ "$method" = owner_waiting_digest ]; then cat "${dir}/digest.json"; else echo '{"result":{"acknowledged":1}}'; fi
`);
  const curl = join(dir, "curl");
  writeFileSync(curl, `#!/bin/sh\necho "$@" >> "${dir}/curl.log"\n${options.curlFails ? "exit 22" : "exit 0"}\n`);
  chmodSync(bb, 0o755); chmodSync(curl, 0o755);
  const run = (env: Record<string, string> = {}) => spawnSync("bash", [script], { encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: home, LP_BB: bb, BB_CLI: "/must/not/be/used", PATH: `${dir}:${process.env.PATH}`, ...env } });
  return { dir, run, ack: () => (existsSync(join(dir, "in-owner_waiting_ack.json")) ? JSON.parse(readFileSync(join(dir, "in-owner_waiting_ack.json"), "utf8")) : null), curlLog: () => (existsSync(join(dir, "curl.log")) ? readFileSync(join(dir, "curl.log"), "utf8") : "") };
}
const digest = { send: true, reason: null, text: "Lane Pilot: ждут владельца, новых — 1.\n• конфликт памяти: порт", keys: ["memory_conflict:mc1"], shown: 1, more: 0 };

describe("scripts/lp-owner-push.sh", () => {
  it("sends the digest with the daily report's bot and then acknowledges exactly its keys", () => {
    const h = hub(digest);
    const result = h.run();
    expect(result.status).toBe(0);
    expect(h.curlLog()).toContain("api.telegram.org/bott/sendMessage");
    expect(h.curlLog()).toContain("message_thread_id=9");
    expect(h.curlLog()).toContain("text=Lane Pilot: ждут владельца, новых — 1.");
    expect(h.ack()).toEqual({ keys: ["memory_conflict:mc1"] });
  });

  it("does not acknowledge when the send fails, so the next run offers the same keys again", () => {
    const h = hub(digest, { curlFails: true });
    expect(h.run().status).not.toBe(0);
    expect(h.ack()).toBeNull();
  });

  it("sends nothing in quiet hours, when nothing is new or when disabled (the plugin says why)", () => {
    for (const reason of ["quiet_hours", "nothing_new", "disabled"]) {
      const h = hub({ send: false, reason, text: "", keys: [], shown: 0, more: 0 });
      const result = h.run();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`nothing to send (${reason})`);
      expect(h.curlLog()).toBe("");
      expect(h.ack()).toBeNull();
    }
  });

  it("DRY_RUN prints the text and neither sends nor acknowledges", () => {
    const h = hub(digest);
    const result = h.run({ DRY_RUN: "1" });
    expect(result.stdout).toContain("конфликт памяти: порт");
    expect(h.curlLog()).toBe("");
    expect(h.ack()).toBeNull();
  });
});

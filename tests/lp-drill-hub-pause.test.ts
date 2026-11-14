import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The drill after the 0.1.568 deploy went red because `bb lane-pilot lead rights` met the hub in a 20 s pause and was asked once.
describe("a drill's read meets the hub in a pause", () => {
  const scripts = fileURLToPath(new URL("../scripts", import.meta.url));
  const ask = (answers: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "lp-hub-pause-"));
    const fake = join(dir, "bb");
    // Each call takes the next answer: "ok", or the error text bb prints with exit 1.
    writeFileSync(join(dir, "answers"), answers.join("\n"));
    writeFileSync(fake, `#!/bin/bash\nn=$(cat "${dir}/calls" 2>/dev/null || echo 0); echo $((n+1)) > "${dir}/calls"\nline=$(sed -n "$((n+1))p" "${dir}/answers")\nif [ "$line" = ok ]; then echo '{"rights":[]}'; exit 0; fi\necho "$line" >&2; exit 1\n`);
    chmodSync(fake, 0o755);
    const code = "import sys, json; sys.path.insert(0, sys.argv[1]); from lp_drill.hub import bb_read; rc, out, err = bb_read('lane-pilot', 'lead', 'rights', pause=0); print(json.dumps({'rc': rc, 'err': err.strip()}))";
    const run = spawnSync("python3", ["-I", "-c", code, scripts], { encoding: "utf8", timeout: 30_000, env: { ...process.env, BB_CLI: fake } });
    return { ...(JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}") as { rc: number; err: string }), calls: Number(readFileSync(join(dir, "calls"), "utf8")) };
  };

  it("asks again after «bb did not respond» and after HTTP 502, and returns the answer", () => {
    expect(ask(["bb did not respond at http://127.0.0.1:6051 after 3 attempts", "Unexpected response from the plugin CLI endpoint (HTTP 502)", "ok"])).toEqual({ rc: 0, err: "", calls: 3 });
  });

  it("gives up after three asks, and does not ask again for an error that is not a pause", () => {
    expect(ask(["bb did not respond", "bb did not respond", "bb did not respond", "ok"])).toMatchObject({ rc: 1, calls: 3 });
    expect(ask(["unknown command lead", "ok"])).toEqual({ rc: 1, err: "unknown command lead", calls: 1 });
  });
});

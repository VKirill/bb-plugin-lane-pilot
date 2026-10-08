import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommandOnHost } from "../src/rooms/writer/cli-run";
import { createGateResolver, detectGateCommand, GATE_PROBE, gateLabel } from "../src/rooms/verification/server/gate-detect";
import { parseIntegrationGateSettings } from "../src/rooms/verification/server/integration-gate";
import type { ServerCore } from "../src/rooms/core/server/core";

const pkg = (body: Record<string, unknown>) => `@@package.json\n${JSON.stringify(body, null, 2)}\n`;

describe("detectGateCommand (what the probe printed)", () => {
  it("a package.json test script is npm test", () => {
    expect(detectGateCommand(pkg({ scripts: { test: "vitest run" } }))).toMatchObject({ command: "npm test" });
  });
  it("the npm init placeholder and a watch script are not a test", () => {
    expect(detectGateCommand(pkg({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }))).toBeNull();
    expect(detectGateCommand(pkg({ scripts: { test: "jest --watch" } }))).toBeNull();
  });
  it("vitest installed without a test script is npx vitest run, and wins over jest", () => {
    expect(detectGateCommand("@@bin vitest\n@@bin jest\n")).toMatchObject({ command: "npx vitest run" });
    expect(detectGateCommand(pkg({ devDependencies: { vitest: "^2" } }))).toMatchObject({ command: "npx vitest run" });
  });
  it("jest installed is npx jest", () => {
    expect(detectGateCommand("@@bin jest\n")).toMatchObject({ command: "npx jest" });
    expect(detectGateCommand(pkg({ dependencies: { jest: "^29" } }))).toMatchObject({ command: "npx jest" });
  });
  it("a pytest config is pytest -q", () => {
    expect(detectGateCommand("@@pytest\n")).toMatchObject({ command: "pytest -q" });
  });
  it("a script beats the runner, and a broken package.json falls through to the runner", () => {
    expect(detectGateCommand(`${pkg({ scripts: { test: "node --test" } })}@@bin vitest\n`)?.command).toBe("npm test");
    expect(detectGateCommand("@@package.json\n{ not json\n@@bin jest\n")?.command).toBe("npx jest");
  });
  it("nothing to run is no gate", () => {
    expect(detectGateCommand("")).toBeNull();
    expect(detectGateCommand(pkg({ name: "x" }))).toBeNull();
  });
});

describe("the probe runs on a real folder through the host's runCommand", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lp-gate-detect-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const probe = async () => {
    const ran = await runCommandOnHost({ requestedHostId: "h", cwd: dir, command: GATE_PROBE, timeoutSec: 30 });
    expect(ran.exitCode).toBe(0);
    return detectGateCommand(ran.stdout);
  };

  it("npm: package.json with a test script", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    expect(await probe()).toMatchObject({ command: "npm test" });
  });
  it("vitest: the binary in node_modules", async () => {
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules/.bin/vitest"), "");
    expect(await probe()).toMatchObject({ command: "npx vitest run" });
  });
  it("jest: the binary in node_modules", async () => {
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules/.bin/jest"), "");
    expect(await probe()).toMatchObject({ command: "npx jest" });
  });
  it("pytest: pytest.ini, pyproject [tool.pytest], and the project's own cfg file", async () => {
    writeFileSync(join(dir, "pytest.ini"), "[pytest]\n");
    expect(await probe()).toMatchObject({ command: "pytest -q" });
    rmSync(join(dir, "pytest.ini"));
    expect(await probe()).toBeNull();
    writeFileSync(join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\naddopts = '-q'\n");
    expect(await probe()).toMatchObject({ command: "pytest -q" });
    rmSync(join(dir, "pyproject.toml"));
    writeFileSync(join(dir, ["set", "up.cfg"].join("")), "[tool:pytest]\n");
    expect(await probe()).toMatchObject({ command: "pytest -q" });
  });
  it("none: an empty folder", async () => {
    expect(await probe()).toBeNull();
  });
});

describe("gate resolver: explicit setting, off, detection and its cache", () => {
  let probes: number;
  let stdout: string;
  let resolve: ReturnType<typeof createGateResolver>;
  beforeEach(() => {
    probes = 0;
    stdout = pkg({ scripts: { test: "vitest run" } });
    const ctx = {
      db: {} as never,
      log: () => {},
      host: { call: async (method: string, input: { command: string }) => {
        expect(method).toBe("runCommand");
        expect(input.command).toBe(GATE_PROBE);
        probes += 1;
        return { hostId: "h", exitCode: 0, stdout, stderr: "" };
      } },
    } as unknown as Pick<ServerCore, "host" | "db" | "log">;
    resolve = createGateResolver(ctx);
  });
  const ask = (settings: Record<string, unknown>, runId = "run-1") =>
    resolve({ runId, hostId: "h", basePath: "/p", gate: parseIntegrationGateSettings(settings) });

  it("an empty setting detects, and the command is named in the label", async () => {
    const gate = await ask({});
    expect(gate).toMatchObject({ command: "npm test", source: "detected" });
    expect(gateLabel(gate!)).toContain("detected");
  });
  it("an explicit setting overrides and asks nobody", async () => {
    expect(await ask({ "integration.gate_command": "make check" })).toMatchObject({ command: "make check", source: "setting" });
    expect(probes).toBe(0);
  });
  it("off disables the gate, detected or not", async () => {
    expect(await ask({ "integration.gate_command": "off" })).toBeNull();
    expect(await ask({ "integration.gate_command": " OFF " })).toBeNull();
    expect(probes).toBe(0);
  });
  it("is asked once per run, and again for another run", async () => {
    await ask({}); await ask({}); await ask({});
    expect(probes).toBe(1);
    await ask({}, "run-2");
    expect(probes).toBe(2);
  });
  it("no test runner is no gate, and that answer is cached too", async () => {
    stdout = "";
    expect(await ask({})).toBeNull();
    expect(await ask({})).toBeNull();
    expect(probes).toBe(1);
  });
  it("a host that cannot answer is no gate now and is asked again next time", async () => {
    const failing = createGateResolver({ db: {} as never, log: () => {}, host: { call: async () => { probes += 1; throw new Error("host down"); } } } as unknown as Pick<ServerCore, "host" | "db" | "log">);
    const gate = parseIntegrationGateSettings({});
    expect(await failing({ runId: "r", hostId: "h", basePath: "/p", gate })).toBeNull();
    expect(await failing({ runId: "r", hostId: "h", basePath: "/p", gate })).toBeNull();
    expect(probes).toBe(2);
  });
});

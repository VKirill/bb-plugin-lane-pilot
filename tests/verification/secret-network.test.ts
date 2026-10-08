import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBubblewrapArgs, buildSeatbeltProfile, networkHostAllowed, runSandboxedCommandOnHost, startAllowListProxy } from "../../src/verification/sandbox";

// Audit 2026-10-08 S1: a check that carries secrets must not be able to send them out.
describe("network of a check that carries secrets", () => {
  it("seatbelt: open without secrets, localhost only with them", () => {
    expect(buildSeatbeltProfile("/w", "/t")).not.toContain("(deny network*)");
    const profile = buildSeatbeltProfile("/w", "/t", "loopback");
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
    // A catch-all `(allow network* (local ip ...))` would let every address out (checked on macOS).
    expect(profile).not.toContain("(allow network* ");
  });

  it("bubblewrap: the host network is shared only for a check without secrets", () => {
    const input = { workspacePath: "/w", cwd: "/w", tempPath: "/t", guardPaths: [] };
    expect(buildBubblewrapArgs(input)).toContain("--share-net");
    expect(buildBubblewrapArgs({ ...input, network: "open" })).toContain("--share-net");
    const closed = buildBubblewrapArgs({ ...input, network: "loopback" });
    expect(closed).not.toContain("--share-net");
    expect(closed).toContain("--unshare-all");
  });

  it("host patterns: exact names and subdomain wildcards, nothing wider", () => {
    expect(networkHostAllowed(["api.stripe.com"], "API.stripe.com")).toBe(true);
    expect(networkHostAllowed(["api.stripe.com"], "evil.com")).toBe(false);
    expect(networkHostAllowed(["api.stripe.com"], "x.api.stripe.com")).toBe(false);
    expect(networkHostAllowed(["*.stripe.com"], "files.stripe.com")).toBe(true);
    expect(networkHostAllowed(["*.stripe.com"], "stripe.com")).toBe(false);
    expect(networkHostAllowed(["*.stripe.com"], "evilstripe.com")).toBe(false);
  });

  it("the proxy refuses a host that was not approved and passes an approved one (ports allowed by the caller)", async () => {
    const target = createServer((_req, res) => res.end("hello from target"));
    await new Promise<void>((done) => target.listen(0, "127.0.0.1", () => done()));
    const targetPort = (target.address() as { port: number }).port;
    const proxy = await startAllowListProxy(["127.0.0.1"], new Set([targetPort]));
    try {
      const get = (url: string) => new Promise<{ status: number; body: string }>((done, fail) => {
        const req = httpRequest({ host: "127.0.0.1", port: proxy.port, method: "GET", path: url, headers: { host: new URL(url).host } }, (res) => {
          let body = ""; res.on("data", (chunk) => { body += chunk; }); res.on("end", () => done({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", fail); req.end();
      });
      expect(await get(`http://127.0.0.1:${targetPort}/`)).toEqual({ status: 200, body: "hello from target" });
      expect((await get("http://not-approved.example/")).status).toBe(403);
      // CONNECT to another host or port is refused before any connection is made.
      const refused = await new Promise<string>((done) => {
        const socket = connect(proxy.port, "127.0.0.1", () => socket.write("CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n"));
        let text = ""; socket.on("data", (chunk) => { text += chunk; }); socket.on("close", () => done(text));
      });
      expect(refused).toContain("403");
    } finally { await proxy.close(); target.close(); }
  });
});

describe.runIf(process.platform === "darwin")("the macOS sandbox with secrets", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lp-net-")));
  const run = (command: string, env?: Record<string, string>) =>
    runSandboxedCommandOnHost({ requestedHostId: "h", workspacePath: root, cwd: root, command, ...(env ? { env } : {}), timeoutSec: 20 });

  it("cannot connect out, can reach localhost, and says why on failure", async () => {
    const target = createServer((_req, res) => res.end("local-ok"));
    await new Promise<void>((done) => target.listen(0, "127.0.0.1", () => done()));
    const port = (target.address() as { port: number }).port;
    try {
      const out = await run("/usr/bin/curl -sS -m 3 http://1.1.1.1/", { MY_TEST_SECRET: "test-secret-Qw81xZ0pLm" });
      expect(out.exitCode).not.toBe(0);
      expect(out.stderr).toContain("[lane-pilot] this check carries secrets");
      const local = await run(`/usr/bin/curl -sS -m 5 http://127.0.0.1:${port}/`, { MY_TEST_SECRET: "test-secret-Qw81xZ0pLm" });
      expect(local.exitCode).toBe(0);
      expect(local.stdout).toContain("local-ok");
    } finally { target.close(); }
  });

  it("a check without secrets keeps the open network (it connects to a local server and is not denied)", async () => {
    const result = await run("/usr/bin/curl -sS -m 3 http://127.0.0.1:9/");
    // Port 9 is closed: refused, but by the network stack, not by the sandbox, and no note about secrets.
    expect(result.stderr).not.toContain("carries secrets");
  });
});

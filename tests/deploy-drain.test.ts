import { expect, it } from "vitest";
import { createDeployDrain } from "../src/server/deploy-drain";

it("holds new checkout writes while draining, reports the running ones, and lets reads through", async () => {
  let clock = 0;
  const drain = createDeployDrain(() => false, () => clock, 5);
  let release!:() => void;
  const merging = drain.around("gitIntegrate", () => new Promise<string>((done) => { release = () => done("merged"); }));
  expect(drain.set(true)).toMatchObject({ draining:true, inFlight:[{ method:"gitIntegrate" }] });
  let started = false;
  const held = drain.around("gitCreateWorktree", async () => { started = true; return "created"; });
  expect(await drain.around("diskFree", async () => "read")).toBe("read");
  await new Promise((wake) => setTimeout(wake, 20));
  expect(started).toBe(false);
  release();
  expect(await merging).toBe("merged");
  expect(drain.status().inFlight).toEqual([]);
  drain.set(false);
  expect(await held).toBe("created");
});

it("ends a drain nobody turned off after 20 minutes", async () => {
  let clock = 0;
  const drain = createDeployDrain(() => false, () => clock, 5);
  drain.set(true);
  clock = 21 * 60_000;
  expect(drain.status().draining).toBe(false);
  expect(await drain.around("gitIntegrate", async () => "ran")).toBe("ran");
});

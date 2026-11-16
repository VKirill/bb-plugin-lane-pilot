import { expect, it } from "vitest";
import { RunWriterPool } from "../src/rooms/tasks/run-policy";

it("serializes same-host parent/child folder claims while allowing disjoint claims", async () => {
  const pool = new RunWriterPool();
  const parent = await pool.acquireFolder("h1", "/repo");
  let childReady = false;
  const child = pool.acquireFolder("h1", "/repo/section").then((release) => { childReady = true; return release; });
  const disjoint = await pool.acquireFolder("h1", "/other");
  expect(childReady).toBe(false);
  disjoint();
  parent();
  const childRelease = await child;
  expect(childReady).toBe(true);
  childRelease();
});

it("does not serialize different hosts", async () => {
  const pool = new RunWriterPool();
  const first = await pool.acquireFolder("h1", "/repo");
  const second = await pool.acquireFolder("h2", "/repo");
  second();
  first();
});

it("treats the filesystem root as an ancestor", async () => {
  const pool = new RunWriterPool();
  const root = await pool.acquireFolder("h1", "/");
  let childReady = false;
  const child = pool.acquireFolder("h1", "/repo").then((release) => { childReady = true; return release; });
  await new Promise((wake) => setTimeout(wake, 0));
  expect(childReady).toBe(false);
  root();
  (await child)();
});

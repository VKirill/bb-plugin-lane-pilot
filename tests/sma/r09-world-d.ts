// Region 9 · Person and window, batch d — shared helpers of the batch's tests.
import { appendFileSync } from "node:fs";

/**
 * Writes what a test observed (the value a window sent or drew) as one JSON line to the file named by SMA_R09D_OBS. The region scene
 * sma_r09 sets the variable, runs the batch's tests and compares every line with the card; without the variable this does nothing.
 */
export function observe(node: string, value: unknown): void {
  const file = process.env.SMA_R09D_OBS;
  if (file) appendFileSync(file, `${JSON.stringify({ node, value })}\n`);
}

/** The rpc handle the cockpit screens take as a prop: it records every call and answers from the table. */
export type Table = Record<string, (params: never) => unknown>;
export function recorder(table: Table) {
  const calls: Array<[string, unknown]> = [];
  const rpc = { call: (name: string, params: unknown) => { calls.push([name, params]); const handler = table[name]; if (!handler) return Promise.resolve(undefined); try { return Promise.resolve(handler(params as never)); } catch (cause) { return Promise.reject(cause); } } };
  return { rpc, calls, of: (name: string) => calls.filter(([method]) => method === name).map(([, params]) => params) };
}

/** A window.matchMedia whose answer the test flips: `set(true)` tells every listener of the query. */
export function controllableMedia(matchesFor: (query: string) => boolean) {
  const listeners = new Map<string, Set<() => void>>();
  let current = matchesFor;
  const stub = (query: string) => ({
    get matches() { return current(query); }, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener: (_: string, fn: () => void) => { (listeners.get(query) ?? listeners.set(query, new Set()).get(query)!).add(fn); },
    removeEventListener: (_: string, fn: () => void) => { listeners.get(query)?.delete(fn); }, dispatchEvent: () => false,
  });
  return { stub: stub as never, flip: (next: (query: string) => boolean) => { current = next; for (const set of listeners.values()) for (const fn of [...set]) fn(); } };
}

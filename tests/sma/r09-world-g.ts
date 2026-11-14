// Region 9 · Person and window, batch g — shared helpers of the batch's tests.
import { appendFileSync } from "node:fs";

/**
 * Writes what a test observed (the value a screen drew or sent) as one JSON line to the file named by SMA_R09G_OBS. The region scene
 * sma_r09 sets the variable, runs the batch's tests and compares every line with the card; without the variable this does nothing.
 */
export function observe(node: string, value: unknown): void {
  const file = process.env.SMA_R09G_OBS;
  if (file) appendFileSync(file, `${JSON.stringify({ node, value })}\n`);
}

/** An rpc table that records every call (name, params) and answers from the table; an unknown name answers undefined. */
export type Table = Record<string, (params: never) => unknown>;
export function recorder(table: Table) {
  const calls: Array<[string, unknown]> = [];
  const wrapped: Table = Object.fromEntries(Object.entries(table).map(([name, handler]) => [name, ((params: unknown) => { calls.push([name, params]); return handler(params as never); }) as never]));
  const rpc = { call: (name: string, params: unknown) => { calls.push([name, params]); const handler = table[name]; if (!handler) return Promise.resolve(undefined); try { return Promise.resolve(handler(params as never)); } catch (cause) { return Promise.reject(cause); } } };
  return { rpc, table: wrapped, calls, of: (name: string) => calls.filter(([method]) => method === name).map(([, params]) => params) };
}

export const text = (node: Element | null) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();

// Region 9 · Person and window, batch e — shared helpers of the batch's tests.
import { appendFileSync } from "node:fs";

/**
 * Writes what a test observed (the value a window sent or drew, a row a server wrote) as one JSON line to the file named by SMA_R09E_OBS. The region
 * scene sma_r09 sets the variable, runs the batch's tests and compares every line with the card; without the variable this does nothing.
 */
export function observe(node: string, value: unknown): void {
  const file = process.env.SMA_R09E_OBS;
  if (file) appendFileSync(file, `${JSON.stringify({ node, value })}\n`);
}

/** The rpc handle the cockpit screens take as a prop: it records every call and answers from the table. */
export type Table = Record<string, (params: never) => unknown>;
export function recorder(table: Table) {
  const calls: Array<[string, unknown]> = [];
  const rpc = { call: (name: string, params: unknown) => { calls.push([name, params]); const handler = table[name]; if (!handler) return Promise.resolve(undefined); try { return Promise.resolve(handler(params as never)); } catch (cause) { return Promise.reject(cause); } } };
  return { rpc, calls, of: (name: string) => calls.filter(([method]) => method === name).map(([, params]) => params) };
}

/** Collapses the whitespace of a node's text. */
export const textOf = (node: Element | null | undefined) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();

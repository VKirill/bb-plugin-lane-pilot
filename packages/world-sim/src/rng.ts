import type { WorldState } from "./types";

/** mulberry32: one 32-bit word of state, so it fits in the saved world and a restored world continues the same sequence. */
export function nextRandom(state: { rng: number }): number {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const randInt = (s: { rng: number }, min: number, max: number): number => min + Math.floor(nextRandom(s) * (max - min + 1));
export const randRange = (s: { rng: number }, min: number, max: number): number => min + nextRandom(s) * (max - min);
export const chance = (s: { rng: number }, p: number): boolean => nextRandom(s) < p;
export function pick<T>(s: { rng: number }, items: readonly T[]): T {
  if (!items.length) throw new Error("pick from an empty list");
  return items[Math.floor(nextRandom(s) * items.length)]!;
}
export function shuffle<T>(s: { rng: number }, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(s) * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Stable 32-bit hash of a string (FNV-1a); used for colours and blueprint choice so the same project looks the same. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export function nextId(state: Pick<WorldState, "counters">, prefix: string): string {
  const n = (state.counters[prefix] ?? 0) + 1;
  state.counters[prefix] = n;
  return `${prefix}${n}`;
}

import { sha256Hex } from "@lane-pilot/kit";

export function planDigest(plan:string): { sha256:string; length:number } {
  return { sha256:sha256Hex(plan), length:Buffer.byteLength(plan, "utf8") };
}


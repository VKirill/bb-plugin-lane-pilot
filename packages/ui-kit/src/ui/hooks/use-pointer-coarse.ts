import { useMediaQuery } from "./use-media-query";

export const POINTER_COARSE_QUERY = "(pointer: coarse)";

export function usePointerCoarse(): boolean {
  return useMediaQuery(POINTER_COARSE_QUERY);
}

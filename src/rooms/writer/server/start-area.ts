/** Two tasks of the same page or feature, by their contract's `area`. */
export function sameArea(a:string | undefined, b:string | undefined):boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

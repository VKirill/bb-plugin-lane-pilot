export function boundedAgentName(value:unknown,fallback:string):string {
  if(typeof value!=="string") return fallback;
  const normalized=value.trim();
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u.test(normalized) ? normalized : fallback;
}

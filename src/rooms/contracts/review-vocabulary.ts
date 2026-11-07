/** Words that make a criterion unverifiable; the plan critic reports a criterion that rests on them. */
export const SUBJECTIVE_WORDS = ["looks correct", "properly", "correctly configured", "consistent with", "clean", "nice", "robust", "works well", "as expected", "appropriate", "корректно", "аккуратно", "нормально", "удобно"] as const;

export const FRONTEND_VERIFY_METHOD: readonly string[] = [
  "Assert, do not look. For each user-visible feature in a case, check three layers one by one and keep what you saw as evidence: (1) the entry point: the control that triggers the feature exists and can be reached (name the element); (2) the write: the action sends the expected write request (POST, PUT, PATCH or DELETE) with the right payload, when the browser tool lets you read network requests or the console; (3) the result: the DOM or state change you expect happens after the action (read the resulting text or element).",
  "Every write the case depends on needs a control that reaches it: a write with no reachable control in the page is a defect to report, not an untested item. A failed layer of something the user can see fails the case. If a layer cannot be observed with the tools you have (no network view, no way to read the DOM state), say so in the case note: that case is blocked, never passed.",
  "Silence is never a pass. A case you did not run, a layer you did not assert, or a check you could not complete is blocked or failed. Every claim in a note is backed by what you observed (the element found, the request captured, the DOM text read), not by «looks fine».",
];

export function boundedAgentName(value:unknown,fallback:string):string {
  if(typeof value!=="string") return fallback;
  const normalized=value.trim();
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u.test(normalized) ? normalized : fallback;
}

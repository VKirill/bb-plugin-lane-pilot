/**
 * The one classifier for Lane Pilot's own service notices (audit: owner provenance). BB records a sender-less
 * `threads.send` as `initiator:"user"`, so every notice the plugin writes into a chat without a live sender thread
 * used to read back as the owner's own words — in `ownerMessagesOf` (anamnesis/learning/critique) and in phase
 * intake alike. The patterns are deliberately exact templates, not a `^Lane Pilot` prefix: the owner may genuinely
 * write «Lane Pilot, исправь …» and that must stay an owner message.
 *
 * Two layers: the bracketed `[Lane Pilot …]` family is unmistakably machine-formatted; the bare `Lane Pilot: …`
 * notices are matched only by their exact historical producer templates (see git blame on the send sites).
 */
const SERVICE_NOTICE_TEXT: readonly RegExp[] = [
  // sendServiceMessage marks every sender-less send with this prefix (service-message.ts).
  /^\s*\[Lane Pilot service\]/,
  // Bracketed machine notices: [Lane Pilot phase …], [Lane Pilot permit …] and any future [Lane Pilot <tag>].
  /^\s*\[Lane Pilot(?! window)[\s\]]/,
  // Bare notices by exact producer template (workflow pm-notice, relay results digest, baseline, secrets).
  /^Lane Pilot: the scheduled run /,
  /^Lane Pilot: results of your tasks/,
  /^Lane Pilot: задача \S+ (не запущена|закрыта принятой)/,
  /^Lane Pilot: .*задача, возможно, уже сделана/,
  /^Lane Pilot: \S+ waits for access/,
  /^Lane Pilot: the PM corrected the task/,
  /^Lane Pilot: task \S+ was not accepted/,
  /^Lane Pilot: the writer of task /,
  /^Lane Pilot \(canary alert\)/,
  /^Lane Pilot \(parked tasks/,
  /^Lane Pilot: your answer could not be read/,
  /^Lane Pilot: из беклога проекта/,
  /^Lane Pilot: a fresh critic returned/,
  /^Lane Pilot: the owner (answered|did not answer|dismissed) «/,
  /^Lane Pilot: the owner answered your question(?:\s*\([^)]+\))?:/,
  /^Lane Pilot: the owner's question «.*» was lost when Lane Pilot reloaded/,
  /^Lane Pilot: (проверка после вливания|post-merge gate)/,
];

export const isServiceNoticeText = (text: string): boolean => SERVICE_NOTICE_TEXT.some((pattern) => pattern.test(text));

/** Prepended to a service send that carries no live sender thread, so provenance survives BB's initiator:user record. */
export const SERVICE_MESSAGE_MARKER = "[Lane Pilot service]";

/** The text a sender-less service send carries: marked unless a bracketed machine form already identifies it. */
export const serviceMessageText = (text: string): string =>
  /^\s*\[Lane Pilot(?! window)[\s\]]/.test(text) ? text : `${SERVICE_MESSAGE_MARKER} ${text}`;

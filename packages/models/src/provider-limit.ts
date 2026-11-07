// A provider that refuses work for the plan, quota or credits answers with its own notice instead of the writer's
// report; the task did not run (content-factory editor-policy-ui, 2026-10-06: acp-cursor/grok-4.6 «Upgrade your plan to continue»).
const PROVIDER_LIMIT = /upgrade (your|to a) (plan|subscription)|usage limit|(quota|credits?|tokens?) (exceeded|exhausted|reached|used up)|exceeded (your|the) (current )?quota|rate[- ]limit(ed| reached| exceeded)|too many requests|out of (credits|tokens|quota)|insufficient (credits|quota|balance|funds)|credit balance is too low|(you'?ve|you have) (hit|reached) (your|the) (\w+ )?limit|limit (reached|exceeded)|unavailable \(reset after/i;

/**
 * The provider's limit notice when that is all the writer answered; null for a real report. Only a short answer counts:
 * a report about rate-limit code names the files and checks it touched and runs far longer.
 */
export function providerLimitNotice(output: string): string | null {
  const text = output.trim();
  if (!text || text.length > 400 || !PROVIDER_LIMIT.test(text)) return null;
  return text.replace(/\s+/g, " ").slice(0, 200);
}

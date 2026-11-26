import { z } from "zod";

export const browserQaInputSchema = z.object({
  requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), url:z.string().url(),
  slug:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), cases:z.array(z.string().min(1).max(2000)).min(1).max(30),
  envClass:z.enum(["local","staging","preview","production","unknown"]), viewports:z.string().regex(/^\d{2,4}(,\d{2,4}){0,2}$/),
  authorized:z.boolean(), provider:z.enum(["codex"]), model:z.string().max(120).optional(),
  reasoningEffort:z.enum(["low","medium","high","xhigh","max"]).optional(),
  backend:z.enum(["live-chrome","chrome-qa","headless"]), timeoutSec:z.number().int().min(30).max(2400),
}).strict();

export type BrowserQaInput = z.infer<typeof browserQaInputSchema>;

export type BrowserQaResult = {
  hostId:string; provider:"codex"; runner:string; exitCode:number; verdict:"passed"|"failed"|"blocked";
  actualModel:string|null; actualReasoningEffort:string|null; actualBackend:string|null;
  reportPath:string|null; reportSha256:string|null; reportText:string|null;
  artifacts:Array<{path:string; sha256:string; size:number}>; stdout:string; stderr:string; reason:string|null;
  processPid:number|null; runnerPath:string|null;
};

export function browserQaVerdict(text:string, exitCode:number):BrowserQaResult["verdict"] {
  const summary = text.match(/Total\s*\/\s*Passed\s*\/\s*Failed\s*\/\s*Blocked(?:\s*\/\s*Pending)?\s*:\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)(?:\s*\/\s*(\d+))?/i);
  if (!summary) return "blocked";
  const total = Number(summary[1]);
  const passed = Number(summary[2]);
  const failed = Number(summary[3]);
  const blocked = Number(summary[4]);
  const pending = summary[5] == null ? total - passed - failed - blocked : Number(summary[5]);
  if (pending < 0 || passed + failed + blocked + pending !== total) return "blocked";
  if (failed > 0 || exitCode !== 0) return "failed";
  if (blocked > 0 || pending > 0 || total === 0 || passed !== total) return "blocked";
  return "passed";
}

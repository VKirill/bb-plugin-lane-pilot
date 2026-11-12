import { z } from "zod";

/** The dev-server ports a browser check looks on when no address is given (SMA k_wqa_find). */
export const QA_DEFAULT_PORTS = [3000, 5173, 8080, 4200, 8000] as const;

/** The machine's own browser: computer-use goals and browser QA runs against a live target. */
export const desktopHostMethods = {
  runBrowserQa: {
    input: z.object({
      requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), url:z.string().url(),
      slug:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), cases:z.array(z.string().min(1).max(2000)).min(1).max(30),
      envClass:z.enum(["local","staging","preview","production","unknown"]), viewports:z.string().regex(/^\d{2,4}(,\d{2,4}){0,2}$/),
      authorized:z.boolean(), provider:z.enum(["codex"]), model:z.string().max(120).optional(),
      reasoningEffort:z.enum(["low","medium","high","xhigh","max"]).optional(),
      backend:z.enum(["live-chrome","chrome-qa","headless"]), timeoutSec:z.number().int().min(30).max(1800),
    }).strict(),
    output:z.object({
      hostId:z.string(), provider:z.enum(["codex"]), runner:z.string(), exitCode:z.number().int(),
      verdict:z.enum(["passed","failed","blocked"]), reportPath:z.string().nullable(), reportSha256:z.string().nullable(),
      actualModel:z.string().nullable(),actualReasoningEffort:z.string().nullable(),actualBackend:z.string().nullable(),
      reportText:z.string().nullable(), artifacts:z.array(z.object({path:z.string(),sha256:z.string(),size:z.number().int().nonnegative()}).strict()),
      stdout:z.string(), stderr:z.string(), reason:z.string().nullable(),
      processPid:z.number().int().nullable(), runnerPath:z.string().nullable(),
    }).strict(),
  },
  findBrowserQaTarget: {
    input: z.object({
      requestedHostId: z.string().min(1),
    }).strict(),
    output: z.object({
      hostId: z.string(), urls: z.array(z.string()),
    }).strict(),
  },
  probeBrowserQaTarget: {
    input: z.object({
      requestedHostId:z.string().min(1), workspacePath:z.string().startsWith("/"), url:z.string().url(),
    }).strict(),
    output:z.object({
      hostId:z.string(), workspaceRealPath:z.string(), url:z.string(), processHostId:z.string(),
    }).strict(),
  },
};

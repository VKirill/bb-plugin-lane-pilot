import { PROVIDER_CAPABILITIES, ROLE_MODEL_OPTIONS, consistentProvider, nativeProviderFamily, roleModelOption } from "@lane-pilot/models";
import { ExprSyntaxError, checkExpr, placeholdersIn, refOf, toExpr } from "./expr";
import type { CheckEnv, Expr, Ref } from "./expr";
import { outputFields } from "./lower";
import { normalizeVerifyExpr } from "./node-form";
import type { Field, GraphNode, Workflow } from "./schema";
import type { ValidateOptions } from "./validate";

type Agent = Extract<GraphNode, { type: "agent" }>;
type ReportProblem = (code: string, message: string, extra?: { node?: string; edge?: number }) => void;

const KNOWN_PROVIDERS = new Set([...Object.keys(PROVIDER_CAPABILITIES), ...ROLE_MODEL_OPTIONS.map((option) => option.providerId)]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Validates node `form` (`agent | plan | script`), `fallback`, `script` fingerprint/command, `plan`, and mechanical `verify` checks. */
export function validateNodeForms(
  workflow: Workflow,
  byId: Map<string, GraphNode>,
  options: ValidateOptions,
  envFor: (from: string, strict: boolean, item: boolean) => CheckEnv,
  ancestorOf: (candidate: string, node: string, strict: boolean) => boolean,
  checkTemplate: (value: unknown, from: string, where: string, extra: { node?: string }) => void,
  error: ReportProblem,
): void {
  const knownNodeIds = new Set(byId.keys());
  const checkVerifyExpr = (exprSource: Parameters<typeof toExpr>[0], node: Agent, where: string, extra: { node: string }) => {
    let expr: Expr;
    try {
      const ownFields = outputFields(workflow, node, options.resolve);
      const fieldNames = new Set(ownFields === "unknown" ? [] : (ownFields as Field[]).map((f) => f.name));
      expr = normalizeVerifyExpr(toExpr(exprSource, node.id), node.id, fieldNames, knownNodeIds);
    } catch (cause) {
      error("bad_expr", `${where}: ${cause instanceof ExprSyntaxError ? cause.message : String(cause)}`, extra);
      return;
    }
    const list: string[] = [];
    const env: CheckEnv = {
      ...envFor(node.id, true, false),
      before: (id) => id === node.id || ancestorOf(id, node.id, true),
    };
    checkExpr(expr, env, list, where);
    for (const msg of list) {
      const code = /unknown field|cannot be read from it/.test(msg)
        ? "condition_field"
        : /never matches|needs numbers|compares numbers|cannot compare/.test(msg)
          ? "condition_type"
          : /is not one of/.test(msg)
            ? "condition_value"
            : "condition";
      error(code, msg, extra);
    }
  };

  for (const node of byId.values()) {
    if (node.type !== "agent") continue;
    const extra = { node: node.id };
    const form = node.form ?? "agent";

    if (form === "agent" && node.fallback !== undefined) {
      error("form_fallback_invalid", `${node.id}: form "agent" cannot declare fallback "${node.fallback}"`, extra);
    }
    if (form === "plan" && node.fallback === "plan") {
      error("form_fallback_invalid", `${node.id}: form "plan" cannot fall back to "plan"`, extra);
    }
    if (form === "script") {
      if (!node.script) {
        error("script_missing", `${node.id}: form "script" requires a script configuration`, extra);
      } else {
        if (!node.script.cmd && !node.script.command) {
          error("script_command_missing", `${node.id}: script requires cmd or command`, extra);
        }
        if (node.script.cmd && node.script.command) {
          error("script_command_conflict", `${node.id}: script cannot set both cmd and command`, extra);
        }
        if (!node.script.fingerprint?.trim()) {
          error("script_fingerprint_missing", `${node.id}: form "script" requires a non-empty environment fingerprint`, extra);
        }
      }
      if (node.verify === undefined) {
        error("script_verify_missing", `${node.id}: form "script" must declare a mechanical verify check`, extra);
      }
    }
    if ((form === "plan" || node.fallback === "plan") && node.plan === undefined) {
      error("plan_missing", `${node.id}: ${form === "plan" ? 'form "plan"' : 'fallback "plan"'} requires a saved plan`, extra);
    }

    if (node.script) {
      checkTemplate(
        { cmd: node.script.cmd, args: node.script.args, command: node.script.command, cwd: node.script.cwd, params: node.script.params },
        node.id,
        `${node.id} script`,
        extra,
      );
    }
    if (node.plan !== undefined) {
      if (typeof node.plan === "string") {
        checkTemplate(node.plan, node.id, `${node.id} plan`, extra);
      } else {
        checkTemplate({ template: node.plan.template, steps: node.plan.steps }, node.id, `${node.id} plan`, extra);
        const { provider, model } = node.plan;
        if (provider && !provider.includes("{{") && !KNOWN_PROVIDERS.has(provider) && !provider.startsWith("acp-")) {
          error("unknown_provider", `${node.id}: plan provider "${provider}" is not a provider Lane Pilot knows`, extra);
        } else if (provider && !model) {
          error("model_missing", `${node.id}: plan names provider "${provider}" without a model`, extra);
        } else if (model && !model.includes("{{")) {
          const providerId = provider && !provider.includes("{{") ? provider : consistentProvider(null, model);
          if (!providerId) error("unknown_model", `${node.id}: plan model "${model}" is not known and no provider is named for it`, extra);
          else if (nativeProviderFamily(providerId) && roleModelOption(model)?.providerId !== providerId) {
            error("unknown_model", `${node.id}: plan "${model}" is not a model of provider "${providerId}"`, extra);
          }
        }
      }
    }
    if (node.verify !== undefined) {
      if (typeof node.verify === "string" || (isRecord(node.verify) && ("field" in node.verify || "all" in node.verify || "any" in node.verify || "not" in node.verify))) {
        checkVerifyExpr(node.verify as Parameters<typeof toExpr>[0], node, `${node.id} verify`, extra);
      } else if (isRecord(node.verify)) {
        const exprs = node.verify.expr === undefined ? [] : Array.isArray(node.verify.expr) ? node.verify.expr : [node.verify.expr];
        exprs.forEach((expr, idx) => {
          if (typeof expr === "string") checkVerifyExpr(expr, node, `${node.id} verify.expr[${idx}]`, extra);
        });
        if (Array.isArray(node.verify.requiredFields)) {
          const have = outputFields(workflow, node, options.resolve);
          if (have !== "unknown") {
            const declared = new Set((have as Field[]).map((f) => f.name));
            for (const name of node.verify.requiredFields) {
              if (typeof name === "string" && !declared.has(name)) {
                error("verify_field", `${node.id}: verify.requiredFields names "${name}", which is not declared in output`, extra);
              }
            }
          }
        }
        checkTemplate({ cmd: node.verify.cmd, args: node.verify.args, command: node.verify.command, cwd: node.verify.cwd }, node.id, `${node.id} verify`, extra);
      }
    }
    for (const holder of typeof node.verify === "string" ? placeholdersIn(node.verify) : []) {
      const ref: Ref = refOf(holder);
      if (ref.kind === "node" && ref.node && ref.node !== node.id && !byId.has(ref.node)) {
        error("bad_ref", `${node.id} verify: unknown node "${ref.node}"`, extra);
      }
    }
  }
}

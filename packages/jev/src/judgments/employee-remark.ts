import { defineJudgment, noul, noulOf } from "../registry";

/** Is this owner text a remark addressed to the given employee's work — a lesson to keep? (employee pack 4). */
export const EMPLOYEE_REMARK_ID = "employee.remark";
export const employeeRemarkJudgment = defineJudgment<
  { text: string; role: string },
  { remark: boolean }
>({
  id: EMPLOYEE_REMARK_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 8_000,
  stateBuilder: (i) => ({ text: i.text.slice(0, 4000), role: i.role.slice(0, 80) }),
  questions: () => ({
    remark: noul("`text` is something the project owner wrote; `role` is an employee. Is it a remark about that employee's work — a rule or preference they should remember (how to do the work, style, tools, format), not general chat?", { true: "a lesson for this employee", false: "not addressed to this employee, or no lesson in it" }),
  }),
  thresholds: { remark_p: { default: 0.6, min: 0.3, max: 0.95, about: "p the text is a remark for this employee" } },
  decide: (a, t) => ({ decision: { remark: (noulOf(a, "remark") ?? 0) >= t.remark_p! } }),
  fallback: () => ({ remark: true }),
  describe: (d) => (d.remark ? "remark" : "not-a-remark"),
});

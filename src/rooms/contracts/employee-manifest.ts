import { MACHINE_AFFINITY_ANY, machineAffinitySchema } from "@lane-pilot/contracts";
import { EMPLOYEES, RESULT_EXISTS, resultExists, type EmployeeManifest } from "./server";

export { machineAffinitySchema } from "@lane-pilot/contracts";
export type MachineAffinity = string;


export const EMPLOYEE_IDS: readonly string[] = Object.keys(EMPLOYEES);

export function isEmployeeSpecialist(id: string): boolean {
  return Object.hasOwn(EMPLOYEES, id);
}

/**
 * critics branch owns SPECIALIST_ROLES. New employee ids join that list at plugin start
 * until the const itself lists them. Ceiling: a reload before tools.ts runs does not see the push;
 * isEmployeeSpecialist covers that path.
 */
export function installEmployeeSpecialists(roles: string[]): void {
  for (const id of EMPLOYEE_IDS) if (!roles.includes(id)) roles.push(id);
}

/** The old `skills` field is the always-on list. A new `coreSkills` wins and is capped at 3. */
export function coreSkillsOf(input: { skills?: readonly string[] | undefined; coreSkills?: readonly string[] | undefined }): string[] {
  if (input.coreSkills) return input.coreSkills.slice(0, 3);
  return [...(input.skills ?? [])];
}

type EmployeeMeta = {
  domain?: string | undefined;
  machineAffinity?: MachineAffinity | undefined;
  deliverables?: string[] | undefined;
  validator?: string | undefined;
  coreSkills?: string[] | undefined;
  skillSections?: string[] | undefined;
};

/** Own key only: `EMPLOYEES["constructor"]` is the prototype function, not an employee. */
export function stockEmployee(id: string): EmployeeManifest | undefined {
  return Object.hasOwn(EMPLOYEES, id) ? EMPLOYEES[id as keyof typeof EMPLOYEES] : undefined;
}

/** Domains of the stock agents that are not employees: the three advisers sit with research, the two Lane Pilot helpers under their own section. */
// A Map, not an object: an agent named `constructor` must not inherit Object.prototype (tests/owned-settings.test.ts).
const STOCK_DOMAIN: ReadonlyMap<string, string> = new Map([
  ["advisor-researcher", "research"], ["domain-researcher", "research"], ["ai-researcher", "research"],
  ["workflow-architect", "lanepilot"], ["mempalace-curator", "lanepilot"],
]);

/** Stock manifest, then the owner's meta, then the compiled profile's skills (an old row that only has `skills`). */
export function employeeView(id: string, meta?: EmployeeMeta, compiledSkills?: string[]): EmployeeManifest {
  const stock = stockEmployee(id);
  return {
    domain: meta?.domain ?? stock?.domain ?? STOCK_DOMAIN.get(id) ?? "general",
    machineAffinity: meta?.machineAffinity ?? stock?.machineAffinity ?? MACHINE_AFFINITY_ANY,
    deliverables: meta?.deliverables ?? stock?.deliverables ?? [],
    validator: meta?.validator ?? stock?.validator ?? RESULT_EXISTS,
    coreSkills: meta?.coreSkills ?? stock?.coreSkills ?? compiledSkills ?? [],
    skillSections: meta?.skillSections ?? stock?.skillSections ?? [],
  };
}

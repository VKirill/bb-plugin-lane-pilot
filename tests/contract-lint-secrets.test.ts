import { describe, expect, it } from "vitest";
import { taskV2Schema } from "../src/contracts";
import type { TaskV2 } from "../src/contracts";
import { compactContract } from "../src/writer-brief";
import { lintContract, nearSecretName, type LintInput } from "../src/server/contract-lint";
import type { SecretCheck } from "../src/rooms/secrets/server/secrets";

const root = "/tmp/writer";
const base: TaskV2 = {
  schema_version:2, id:"s", title:"S", risk:"low", lane:"writer", project_cwd:root, read_first:[], interfaces:["i"], invariants:["x"], out_of_scope:["o"],
  expected_outputs:["src/b.ts"], owns_paths:["src/"], never_touch:[".git/**"], depends_on:[], objective:"x", acceptance:["done"], verify:"tests",
  verification:[{ command:"node e2e.js", cwd:root, secrets:["STRIPE_TEST_KEY"] }],
};
const catalog = [{ name:"STRIPE_TEST_KEY", kind:"secret" as const }, { name:"DEPLOY_SSH", kind:"ssh" as const }];
const found = (over:Partial<SecretCheck & { catalog:null }> = {}):LintInput["secrets"] => ({ missing:[], denied:[], wrongKind:[], unavailable:false, catalog, ...over });
const lint = (secrets:LintInput["secrets"], task:Partial<TaskV2> = {}) =>
  lintContract({ task:{ ...base, ...task }, workspacePath:root, hostId:"h", kinds:null, sandboxUnsafe:[], openTasks:[], deadDependencies:[], secrets });
const codes = (rows:Array<{ code:string }>) => rows.map((row) => row.code);

describe("verification secrets in the contract", () => {
  it("the schema takes env-style names per check and refuses anything else", () => {
    expect(taskV2Schema.safeParse(base).success).toBe(true);
    expect(taskV2Schema.safeParse({ ...base, verification:[{ command:"x", cwd:root, secrets:["bad-name"] }] }).success).toBe(false);
    expect(taskV2Schema.safeParse({ ...base, verification:[{ command:"x", cwd:root, secrets:["A", "B"], extra:1 }] }).success).toBe(false);
  });

  it("passes when every name is allowed and saved", () => {
    expect(lint(found())).toEqual({ errors:[], warnings:[] });
  });

  it("a name a non-empty project list leaves out goes back to the PM, who may add it to the list", () => {
    const { errors } = lint(found({ denied:["STRIPE_TEST_KEY"] }));
    expect(codes(errors)).toEqual(["secret_not_allowed"]);
    expect(errors[0]!.message).toContain("secrets.allow");
  });

  it("a name not saved yet is a warning: the task will wait for it", () => {
    const result = lint(found({ missing:["PAYPAL_KEY"] }), { verification:[{ command:"x", cwd:root, secrets:["PAYPAL_KEY"] }] });
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((row) => row.code)).toEqual(["secret_missing"]);
    expect(result.warnings[0]!.message).toContain("env_request");
  });

  it("a typo of a saved name is an error with the right name", () => {
    const { errors } = lint(found({ missing:["stripe_test_key"] }), { verification:[{ command:"x", cwd:root, secrets:["stripe_test_key"] }] });
    expect(errors[0]).toMatchObject({ code:"secret_name_unknown", message:expect.stringContaining("did you mean STRIPE_TEST_KEY") });
    expect(nearSecretName("STRIPE_TEST_KY", catalog)).toBe("STRIPE_TEST_KEY");
    expect(nearSecretName("PAYPAL_KEY", catalog)).toBeNull();
  });

  it("refuses ssh/ftp kinds, a sandbox variable name, and an absent Env Catalog", () => {
    expect(codes(lint(found({ wrongKind:["DEPLOY_SSH"] })).errors)).toEqual(["secret_kind"]);
    expect(codes(lint(found(), { verification:[{ command:"x", cwd:root, secrets:["PATH"] }] }).errors)).toEqual(["secret_reserved"]);
    expect(codes(lint(found({ unavailable:true, catalog:null, missing:["STRIPE_TEST_KEY"] })).errors)).toEqual(["secret_catalog_unavailable"]);
  });

  it("the writer's brief shows the names a check gets, never a value", () => {
    expect(compactContract(base, false).verification).toEqual([{ command:"node e2e.js", secrets:["STRIPE_TEST_KEY"] }]);
  });
});

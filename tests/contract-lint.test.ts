import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../server";
import type { TaskV2 } from "../src/rooms/contracts";
import {
  createAttempt, createRun, createTask, listAttemptsForTask, openDatabase, recordCheckDuration, saveProjectSetting, savePrototypeConfig, setRunThread, transitionAttempt,
} from "../src/rooms/storage/database";
import { postMergeRepair } from "../src/rooms/writer/server/finish";
import { lintContract, lintProbePaths, lintReply, runnerFilterArgs, siblingTestFolders, type LintInput, type PathKind } from "../src/rooms/tasks/server/contract-lint";

const root = "/tmp/writer";
const baseTask: TaskV2 = {
  schema_version:2, display_title: "Тестовая задача", kind: "feature", area: "feature:lint-task", id:"lint-task", title:"Lint", risk:"low", lane:"writer", project_cwd:root,
  read_first:["src/a.ts"], interfaces:["i"], invariants:["inv"], out_of_scope:["out"], expected_outputs:["src/b.ts"],
  owns_paths:["src/"], never_touch:[".git/**"], depends_on:[], objective:"change a", acceptance:["done"],
  verify:"tests", verification:[{ command:"npx vitest run tests/a.test.ts", cwd:root }],
};
const lint = (task:Partial<TaskV2> = {}, input:Partial<LintInput> = {}, kinds:Record<string, PathKind> | null = {}) =>
  lintContract({ task:{ ...baseTask, ...task }, workspacePath:root, hostId:"host-1", sandboxUnsafe:[], openTasks:[], deadDependencies:[],
    kinds:kinds ? new Map(Object.entries(kinds).map(([path, kind]) => [`${root}/${path}`, kind])) : null, ...input });
const codes = (result:ReturnType<typeof lint>) => result.errors.map((error) => error.code);

describe("contract lint rules", () => {
  it("passes a sound contract", () => {
    expect(lint({}, {}, { "src/a.ts":"file" })).toEqual({ errors:[], warnings:[] });
  });

  describe("the browser check the task's graph runs (qa_url)", () => {
    const qa = (task:Partial<TaskV2>, qualityMode?:"quick" | "standard" | "full") => lint(task, qualityMode ? { qualityMode } : {}, { "src/a.ts":"file" }).errors.filter((error) => error.code === "qa_url_missing");
    it("requires qa_url next to qa_cases in full mode, and says what to add", () => {
      const [missing] = qa({ qa_cases:["the cart opens at 375"] }, "full");
      expect(missing?.message).toContain("add qa_url");
      expect(missing?.message).toContain("qa_env_class");
      expect(missing?.message).toContain("qa_dev_server");
    });
    it("is satisfied by qa_url, and silent in every other case", () => {
      expect(qa({ qa_cases:["the cart opens"], qa_url:"http://127.0.0.1:5173/cart" }, "full")).toEqual([]);
      expect(qa({}, "full")).toEqual([]);
      expect(qa({ qa_cases:[] }, "full")).toEqual([]);
      expect(qa({ qa_cases:["the cart opens"] }, "standard")).toEqual([]);
      expect(qa({ qa_cases:["the cart opens"] }, "quick")).toEqual([]);
      expect(qa({ qa_cases:["the cart opens"] })).toEqual([]);
    });
  });

  describe("task standard (the Tasks board)", () => {
    const standard = (task:Partial<TaskV2>) => lint(task, {}, { "src/a.ts":"file" }).errors.filter((error) => /^(display_title|kind|area)_/.test(error.code));
    it("asks for a card title, a kind and an area, each with the fix", () => {
      const missing = standard({ display_title:undefined, kind:undefined, area:undefined });
      expect(missing.map((error) => error.code)).toEqual(["display_title_missing", "kind_missing", "area_missing"]);
      expect(missing[0]!.message).toContain("~60 characters");
      expect(missing[1]!.message).toContain("feature, fix, check, docs, refactor, research, chore");
      expect(missing[2]!.message).toContain("page:/tools/cards");
    });
    it("treats a blank title or area as missing and a kind outside the list as missing", () => {
      expect(standard({ display_title:"  ", area:" ", kind:"bug" as never }).map((error) => error.code)).toEqual(["display_title_missing", "kind_missing", "area_missing"]);
    });
    it("takes a long title up to 1000 characters and refuses only beyond (owner 2026-10-27: no retries over title length)", () => {
      expect(standard({ display_title:"я".repeat(240) })).toEqual([]);
      expect(standard({ display_title:"я".repeat(1000) })).toEqual([]);
      expect(standard({ display_title:"я".repeat(1001) }).map((error) => error.code)).toEqual(["display_title_too_long"]);
    });
    it("accepts a Lane Pilot mainfix task, which fills the three itself", () => {
      const fix = postMergeRepair({ ...baseTask, id:"x".repeat(100), area:undefined }, [{ command:"npm test", exitCode:1 }]).fix;
      expect(fix).toMatchObject({ kind:"fix", area:"maintenance" });
      expect(fix.display_title).toMatch(/^Починка main после /);
      expect(standard(fix)).toEqual([]);
      expect(postMergeRepair({ ...baseTask, area:"page:/cards" }, [{ command:"npm test", exitCode:1 }]).fix.area).toBe("page:/cards");
    });
  });

  describe("read_first", () => {
    it("rejects a missing file, naming the machine and the fix", () => {
      const { errors } = lint({}, {}, { "src/a.ts":"missing" });
      expect(codes({ errors, warnings:[] })).toEqual(["read_first_missing"]);
      expect(errors[0]!.message).toContain("host-1");
    });
    it("lets a missing file through when the task creates it or waits for the task that does", () => {
      expect(codes(lint({ expected_outputs:["src/a.ts"] }, {}, { "src/a.ts":"missing" }))).toEqual([]);
      expect(codes(lint({ expected_outputs:["src/b.ts"], owns_paths:["src/"], depends_on:["other"] }, {}, { "src/a.ts":"missing" }))).toEqual([]);
    });
    it("marks a folder as a folder, and rejects a symlink", () => {
      expect(lint({ read_first:["src"] }, {}, { src:"directory" }).errors[0]).toMatchObject({ code:"read_first_folder", message:expect.stringContaining("is a directory, not a file: src/") });
      expect(codes(lint({}, {}, { "src/a.ts":"symlink" }))).toEqual(["read_first_not_file"]);
    });
    it("rejects a path that leaves the project", () => {
      expect(codes(lint({ read_first:["../secrets.txt"] }, {}, {}))).toEqual(["read_first_path"]);
    });
    it("stays silent about files when the machine could not be asked", () => {
      expect(codes(lint({}, {}, null))).toEqual([]);
    });
    it("takes line windows off the path", () => {
      expect(lintProbePaths({ ...baseTask, read_first:["src/a.ts:10-20"], verification:[] }, root)).toEqual([`${root}/src/a.ts`]);
    });
  });

  describe("ownership paths", () => {
    it("rejects owns_paths and never_touch that escape the root, all in one go", () => {
      const { errors } = lint({ owns_paths:["../x", "src/a.ts"], expected_outputs:["src/a.ts"], never_touch:["/etc"] }, {}, { "src/a.ts":"file" });
      expect(codes({ errors, warnings:[] })).toEqual(["ownership_unsafe", "ownership_unsafe"]);
      expect(errors[0]!.message).toContain("unsafe ownership path pattern: ../x");
    });
    it("rejects an owned path inside never_touch", () => {
      const { errors } = lint({ owns_paths:["src/a.ts"], never_touch:["src/"] }, {}, { "src/a.ts":"file" });
      expect(codes({ errors, warnings:[] })).toContain("owns_never_touch");
    });
    it("warns, without blocking, when owns_paths overlap an open task", () => {
      const open = { id:"open-1", owns_paths:["src/"], never_touch:[], depends_on:[] };
      const result = lint({}, { openTasks:[open] }, { "src/a.ts":"file" });
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([{ code:"owns_overlap_open", message:expect.stringContaining("open-1") }]);
      expect(lint({}, { openTasks:[{ ...open, owns_paths:["docs/"] }] }, { "src/a.ts":"file" }).warnings).toEqual([]);
    });
  });

  describe("expected_outputs", () => {
    it("rejects a file outside owns_paths with the fix", () => {
      const { errors } = lint({ owns_paths:["src/a.ts"], expected_outputs:["src/a.ts", "packages/contracts/src/stage-contract.ts"] }, {}, { "src/a.ts":"file" });
      expect(codes({ errors, warnings:[] })).toEqual(["output_unowned"]);
      expect(errors[0]!.message).toContain("packages/contracts/src/stage-contract.ts");
      expect(errors[0]!.message).toContain("add it (or its folder) to owns_paths");
    });
    it("leaves bare names, prose and a folder under owns_paths alone", () => {
      expect(codes(lint({ expected_outputs:["a.ts", "the page renders", "src/new/"], owns_paths:["src/"] }, {}, { "src/a.ts":"file" }))).toEqual([]);
    });
    it("rejects a file inside never_touch", () => {
      expect(codes(lint({ expected_outputs:["src/a.ts"], owns_paths:["src/"], never_touch:["src/a.ts"] }, {}, { "src/a.ts":"file" }))).toContain("output_never_touch");
    });
  });

  describe("tests next to owned files", () => {
    // owns_paths of the SelfyStudio contracts each rejected for its own test (2026-10-11…12), and the test files that were already there.
    const live = {
      "cards-postpay-bind-v2":{ owns:["apps/marketing/app/components/greeting-cards/", "apps/marketing/app/utils/greeting-card-analytics.ts", "apps/marketing/i18n/locales/"],
        kinds:{ "apps/marketing/app/utils/__tests__/greeting-card-analytics.test.ts":"file" as const }, test:"apps/marketing/app/utils/__tests__/greeting-card-analytics.test.ts" },
      "greeting-card-pages-en":{ owns:["apps/worker/src/processors/localization.ts", "apps/worker/src/processors/__tests__/", "apps/marketing/app/composables/useGreetingCard*", "apps/marketing/app/components/greeting-cards/"],
        kinds:{ "apps/marketing/app/composables/__tests__":"directory" as const }, test:"apps/marketing/app/composables/__tests__/useGreetingCard*" },
      "en-hreflang-sitemap-fix":{ owns:["apps/api/src/routes/v1/public-pages.ts", "apps/api/src/routes/v1/__tests__/", "apps/marketing/server/", "apps/marketing/app/composables/useHreflang.ts", "apps/marketing/tests/"],
        kinds:{ "apps/marketing/app/composables/__tests__/useHreflang.test.ts":"file" as const, "apps/api/src/routes/v1/__tests__/public-pages.test.ts":"file" as const }, test:"apps/marketing/app/composables/__tests__/useHreflang.test.ts" },
    };
    const task = (owns:string[]) => ({ owns_paths:owns, expected_outputs:[], read_first:[] });
    it("sends back each live contract whose owned file has an unowned test next to it, naming the test to add", () => {
      for (const [id, { owns, kinds, test }] of Object.entries(live)) {
        const { errors } = lint(task(owns), {}, kinds);
        expect(codes({ errors, warnings:[] }), id).toEqual(["test_unowned"]);
        expect(errors[0]!.message, id).toContain(`add ${test} to owns_paths, or to never_touch`);
        for (const path of Object.keys(kinds)) expect(lintProbePaths({ ...baseTask, ...task(owns) }, root), id).toContain(`${root}/${path}`);
      }
    });
    it("takes the contract once the test is owned or left to never_touch, and says nothing about a test that is not there", () => {
      for (const [id, { owns, kinds, test }] of Object.entries(live)) {
        expect(codes(lint(task([...owns, test]), {}, kinds)), id).toEqual([]);
        expect(codes(lint({ ...task(owns), never_touch:[test] }, {}, kinds)), id).toEqual([]);
        expect(codes(lint(task(owns), {}, {})), id).toEqual([]);
        expect(codes(lint(task(owns), {}, null)), id).toEqual([]);
      }
    });
    describe("tests named longer than the owned code (SelfyStudio, 2026-10-24)", () => {
      // The real folder on OVH (apps/site/app/composables/api and its __tests__) and the owns_paths each contract went out with.
      const api = "apps/site/app/composables/api";
      const listings = new Map<string, string[]>([
        [`${root}/${api}`, ["blog.ts", "cards.ts", "catalog.ts", "docs.ts", "home.ts", "models.ts", "quiz-inline-auth.ts", "service.ts", "share.ts", "shoot.ts", "site-image.ts", "stickers.ts", "teaser.ts", "tools-hubs.ts", "tools.ts"]],
        [`${root}/${api}/__tests__`, ["blog-authors-legal-en.test.ts", "blog-authors-seo-audit.test.ts", "cards-seo-audit.test.ts", "home-feed-ribbon.test.ts", "home-models-seo-audit.test.ts", "models-en.test.ts", "quiz-inline-auth.test.ts", "seo-polish.test.ts", "shoot-en.test.ts", "shoot-seo-audit.test.ts", "site-image.test.ts", "teaser.test.ts", "tools-en.test.ts", "tools-seo-audit.test.ts"]],
      ]);
      const rejected = {
        "site-en-shoot":{ owns:[`${api}/shoot.ts`, `${api}/__tests__/shoot-en.test.ts`, "apps/site/app/components/blocks/shoot/", "apps/site/app/utils/locale-routes.ts", "apps/site/app/utils/__tests__/locale-routes.test.ts", "apps/site/nuxt.config.ts"],
          tests:[`${api}/__tests__/shoot-seo-audit.test.ts`] },
        "site-seo-polish":{ owns:[`${api}/shoot.ts`, `${api}/cards.ts`, `${api}/models.ts`, `${api}/tools.ts`, `${api}/docs.ts`, `${api}/blog.ts`, `${api}/__tests__/seo-polish.test.ts`, "apps/site/app/components/blocks/cards/", "apps/site/app/utils/blog-schema.ts", "apps/site/app/utils/__tests__/blog-schema.test.ts"],
          tests:[`${api}/__tests__/shoot-seo-audit.test.ts`, `${api}/__tests__/cards-seo-audit.test.ts`] },
        "site-vitest-alias-fix":{ owns:["apps/site/vitest.config.mjs", "apps/site/shared/og/", `${api}/cards.ts`, `${api}/shoot.ts`, `${api}/models.ts`, `${api}/blog.ts`, "apps/site/app/composables/useOgImage.ts"],
          tests:[`${api}/__tests__/cards-seo-audit.test.ts`] },
        "site-en-hydration-fix":{ owns:["apps/site/app/pages/neiroseti/", `${api}/models.ts`, "apps/site/app/data/models/", "apps/site/scripts/check-hydration.mjs"],
          tests:[`${api}/__tests__/models-en.test.ts`] },
      };
      it("sends back each contract that lost an attempt to such a test, naming that test", () => {
        for (const [id, { owns, tests }] of Object.entries(rejected)) {
          const { errors } = lint(task(owns), { listings }, {});
          expect(errors.length, id).toBeGreaterThan(0);
          expect(new Set(codes({ errors, warnings:[] })), id).toEqual(new Set(["test_unowned"]));
          for (const test of tests) expect(errors.some((error) => new RegExp(`so add (\\S+, )*${test}(, \\S+)* to owns_paths, or to never_touch`).test(error.message)), `${id} ${test}`).toBe(true);
        }
      });
      it("takes the contract the PM fixed in place, and stays silent without listings", () => {
        // site-seo-polish as accepted: the PM added the audit tests of every owned file.
        const fixed = [...rejected["site-seo-polish"].owns, ...["shoot-seo-audit", "cards-seo-audit", "tools-seo-audit", "home-models-seo-audit", "blog-authors-seo-audit", "shoot-en", "models-en", "tools-en", "blog-authors-legal-en"].map((name) => `${api}/__tests__/${name}.test.ts`)];
        expect(codes(lint(task(fixed), { listings }, {}))).toEqual([]);
        for (const { owns } of Object.values(rejected)) {
          expect(codes(lint(task(owns), { listings:null }, {}))).toEqual([]);
          expect(codes(lint(task(owns), {}, {}))).toEqual([]);
          const flagged = lint(task(owns), { listings }, {}).errors.flatMap((error) => /so add (.+?) to owns_paths/.exec(error.message)![1]!.split(", "));
          expect(codes(lint({ ...task(owns), never_touch:flagged }, { listings }, {}))).toEqual([]);
        }
      });
      it("leaves a test of a longer-named code file to that file, and names only tests", () => {
        const tools = lint(task([`${api}/tools.ts`]), { listings }, {}).errors.map((error) => error.message).join("\n");
        expect(tools).toContain(`so add ${api}/__tests__/tools-en.test.ts, ${api}/__tests__/tools-seo-audit.test.ts to owns_paths, or to never_touch if the writer must leave them as they are`);
        const own = (dir:Record<string, string[]>) => new Map(Object.entries(dir).map(([key, names]) => [`${root}/${key}`, names]));
        expect(codes(lint(task(["src/tools.ts"]), { listings:own({ src:["tools.ts", "tools-hubs.ts", "tools-hubs.test.ts", "toolsy.test.ts", "tools-notes.md"] }) }, {}))).toEqual([]);
        expect(codes(lint(task(["src/tools.ts"]), { listings:own({ src:["tools.ts", "tools.edge.spec.ts"] }) }, {}))).toEqual(["test_unowned"]);
        expect(codes(lint(task(["src/index.ts", "src/a.test.ts", "src/*.ts"]), { listings:own({ src:["index.ts", "index-x.test.ts", "a.test.ts", "a-b.test.ts"] }) }, {}))).toEqual([]);
      });
      it("lists the owned code files' folder and its __tests__, once each", () => {
        expect(siblingTestFolders(task(rejected["site-seo-polish"].owns), root)).toEqual([`${root}/${api}`, `${root}/${api}/__tests__`, `${root}/apps/site/app/utils`, `${root}/apps/site/app/utils/__tests__`]);
        expect(siblingTestFolders(task(["src/", "src/*.ts", "README.md", "src/index.ts"]), root)).toEqual([]);
      });
    });
    it("looks next to the file and in __tests__, but not for a test, an index or a folder", () => {
      expect(codes(lint(task(["src/a.ts"]), {}, { "src/a.test.ts":"file" }))).toEqual(["test_unowned"]);
      expect(codes(lint(task(["lib/a.mjs"]), {}, { "lib/__tests__/a.test.mjs":"file" }))).toEqual(["test_unowned"]);
      expect(codes(lint(task(["src/a.test.ts", "src/index.ts", "src/"]), {}, { "src/__tests__/a.test.test.ts":"file", "src/__tests__/index.test.ts":"file", "src/__tests__":"directory" }))).toEqual([]);
    });
  });

  describe("check filters", () => {
    const folder = { "src/a.ts":"file" as const, "tests/server":"directory" as const };
    it("finds the folder words of vitest, jest and npm script filters", () => {
      expect(runnerFilterArgs("npx vitest run tests/server --reporter dot tests/a.test.ts")).toEqual(["run", "tests/server", "tests/a.test.ts"]);
      expect(runnerFilterArgs("npm -w pkg run test -- tests/server/ lib")).toEqual(["tests/server/", "lib"]);
      expect(runnerFilterArgs("npx vitest run --exclude tests/slow --config vite.config.ts && echo done")).toEqual(["run"]);
      expect(runnerFilterArgs("npx tsc --noEmit -p .")).toEqual([]);
    });
    it("does not read the value of --pool, --retry and the like as a filter", () => {
      expect(runnerFilterArgs("npx vitest run --pool forks --retry 2 --maxWorkers 4 tests/a.test.ts")).toEqual(["run", "tests/a.test.ts"]);
      expect(runnerFilterArgs("npx vitest run --pool=forks")).toEqual(["run"]);
    });
    it("counts a folder filter with a slash as focused under sandbox_unsafe, and a value flag as no filter at all", () => {
      const unsafe = { sandboxUnsafe:["tests/pipeline.test.ts"] };
      expect(codes(lint({ verification:[{ command:"npx vitest run tests/server/", cwd:root }] }, unsafe, folder))).toEqual([]);
      expect(codes(lint({ verification:[{ command:"npx vitest run --pool forks", cwd:root }] }, unsafe, folder))).toEqual(["sandbox_unsafe"]);
    });
    it("requires a trailing slash on a folder", () => {
      const task = { verification:[{ command:"npx vitest run tests/server", cwd:root }] };
      const { errors } = lint(task, {}, folder);
      expect(codes({ errors, warnings:[] })).toEqual(["filter_folder_slash"]);
      expect(errors[0]!.message).toContain("write tests/server/");
      expect(lintProbePaths({ ...baseTask, ...task }, root)).toContain(`${root}/tests/server`);
    });
    it("accepts the slash, a file filter, and a word that is not a folder", () => {
      expect(codes(lint({ verification:[{ command:"npx vitest run tests/server/", cwd:root }] }, {}, folder))).toEqual([]);
      expect(codes(lint({ verification:[{ command:"npx vitest run tests/a.test.ts", cwd:root }] }, {}, folder))).toEqual([]);
      expect(codes(lint({ verification:[{ command:"npx vitest run tests/server", cwd:root }] }, {}, { ...folder, "tests/server":"missing" }))).toEqual([]);
    });
    it("rejects a bare vitest run while verification.sandbox_unsafe lists tests, with the flags to add", () => {
      const { errors } = lint({ verification:[{ command:"npx vitest run", cwd:root }] }, { sandboxUnsafe:["tests/pipeline.test.ts"] }, folder);
      expect(errors).toEqual([{ code:"sandbox_unsafe", message:expect.stringContaining('--exclude "tests/pipeline.test.ts"'),
        data:{ missingExcludes:["tests/pipeline.test.ts"], suggestedFlags:'--exclude "tests/pipeline.test.ts"' } }]);
    });
  });

  describe("whole-suite checks while an integration gate is active", () => {
    const gate = { command:"npm test" };
    const folder = { "src/a.ts":"file" as const };
    const withGate = (command:string, input:Partial<LintInput> = {}) => lint({ verification:[{ command, cwd:root }] }, { gate, ...input }, folder);
    it("rejects each whole-suite form, with the fix", () => {
      for (const command of ["npx vitest run", "vitest run", "npm test", "npm run test --silent", "pnpm test", "pytest", "pytest -q", "python -m pytest", "npx jest", "npx jest --coverage", "cd pkg && npx vitest run --reporter dot"]) {
        const { errors } = withGate(command);
        expect(codes({ errors, warnings:[] }), command).toEqual(["whole_suite_with_gate"]);
        expect(errors[0]!.message).toContain("the integration gate (npm test) runs the whole suite once per batch");
        expect(errors[0]!.message).toContain("check only this task's files, e.g. npx vitest run <its test files>");
        expect(errors[0]!.data).toEqual({ gateCommand:"npm test" });
      }
    });
    it("lets a focused check through", () => {
      for (const command of ["npx vitest run tests/a.test.ts", "npx vitest related src/a.ts --run", "npm test -- tests/a.test.ts", "npm run test:unit", "npm -w packages/x test", "npx tsc --noEmit -p .",
        "pytest tests/test_a.py", "pytest -k parser", "python -m pytest tests/test_a.py -q", "npx jest src/a.test.ts", "npx jest -t parser"]) {
        expect(codes(withGate(command)), command).toEqual([]);
      }
    });
    it("does nothing without a gate, so a project with the gate off keeps its whole-suite checks", () => {
      expect(codes(lint({ verification:[{ command:"npm test", cwd:root }] }, {}, folder))).toEqual([]);
      expect(codes(lint({ verification:[{ command:"npm test", cwd:root }] }, { gate:null }, folder))).toEqual([]);
    });
    it("replaces the sandbox_unsafe exclusions for the same check, and keeps that rule where there is no gate", () => {
      const unsafe = { sandboxUnsafe:["tests/pipeline.test.ts"] };
      expect(codes(withGate("npx vitest run", unsafe))).toEqual(["whole_suite_with_gate"]);
      expect(codes(lint({ verification:[{ command:"npx vitest run", cwd:root }] }, unsafe, folder))).toEqual(["sandbox_unsafe"]);
    });
  });

  describe("a check that is the gate's own command (Vampirism Fire: the whole Studio suite as a task check)", () => {
    const gate = { command:"python3 -I scripts/studio_test.py" };
    const folder = { "src/a.ts":"file" as const };
    const withGate = (command:string, input:Partial<LintInput> = {}) => lint({ verification:[{ command, cwd:root }] }, { gate, ...input }, folder);
    it("rejects the gate command whole, behind a cd, or as one step of a chain, whatever the runner is", () => {
      for (const command of ["python3 -I scripts/studio_test.py", "cd game && python3 -I scripts/studio_test.py", "  python3   -I scripts/studio_test.py ", "test -f a && python3 -I scripts/studio_test.py; echo done"]) {
        const { errors } = withGate(command);
        expect(codes({ errors, warnings:[] }), command).toEqual(["whole_suite_with_gate"]);
        expect(errors[0]!.message).toContain("the integration gate (python3 -I scripts/studio_test.py) runs the whole suite once per batch");
      }
      expect(codes(withGate("python3 -I scripts/studio_test.py", { gate:{ command:"cd game && python3 -I scripts/studio_test.py" } }))).toEqual(["whole_suite_with_gate"]);
    });
    it("lets a filtered run, another script and a project without a gate through", () => {
      for (const command of ["cd game && python3 -I scripts/studio_test.py --filter Par010", "python3 -I scripts/studio_test.py --self-check", "python3 -I scripts/studio_test_helper.py"]) {
        expect(codes(withGate(command)), command).toEqual([]);
      }
      expect(codes(withGate("python3 -I scripts/studio_test.py", { gate:null }))).toEqual([]);
      expect(codes(withGate("python3 -I scripts/studio_test.py", {}))).toEqual(["whole_suite_with_gate"]);
      expect(codes(lint({ verification:[{ command:"python3 -I scripts/studio_test.py", cwd:root }] }, {}, folder))).toEqual([]);
    });
  });

  describe("a check with a history of running out of time", () => {
    const folder = { "src/a.ts":"file" as const };
    const suite = "cd game && python3 -I scripts/studio_test.py --filter Par";
    const history = (greenMs:number[], timedOutSec:number[]) => ({ checkHistory:(check:{ command:string }) => check.command === suite ? { greenMs, timedOutSec } : { greenMs:[], timedOutSec:[] } });
    const lintCheck = (timeout_sec:number | undefined, input:Partial<LintInput>) => lint({ verification:[{ command:suite, cwd:root, ...(timeout_sec ? { timeout_sec } : {}) }] }, input, folder);
    it("asks for a timeout_sec with a number when the command timed out at the default limit", () => {
      const { errors } = lintCheck(undefined, history([], [120, 120, 120]));
      expect(codes({ errors, warnings:[] })).toEqual(["verification_timeout"]);
      expect(errors[0]!.message).toContain("timed out in this project at 120 s (3 attempts)");
      expect(errors[0]!.message).toContain("no timeout_sec (the default is 120 s)");
      expect(errors[0]!.message).toContain("set timeout_sec to 600 or more");
    });
    it("asks again when the contract's own limit is no more than the one it timed out at, and takes a larger one", () => {
      expect(lintCheck(120, history([], [120])).errors[0]!.message).toContain("this contract has timeout_sec 120");
      expect(codes(lintCheck(600, history([], [120])))).toEqual([]);
      expect(lintCheck(600, history([], [600])).errors[0]!.message).toContain("set timeout_sec to 3000 or more");
      expect(lintCheck(5400, history([], [5400])).errors[0]!.message).toContain("set timeout_sec to 7200 or more");
    });
    it("asks for a timeout_sec above the p95 of its recorded green runs, from three runs on", () => {
      const green = [300_000, 310_000, 320_000, 330_000, 340_000];
      const { errors } = lintCheck(120, history(green, []));
      expect(codes({ errors, warnings:[] })).toEqual(["verification_timeout"]);
      expect(errors[0]!.message).toContain("took up to 340 s in its last 5 green runs");
      expect(errors[0]!.message).toContain("set timeout_sec to 720 or more");
      expect(codes(lintCheck(undefined, history(green, [])))).toEqual(["verification_timeout"]);
      expect(codes(lintCheck(400, history(green, [])))).toEqual([]);
      expect(codes(lintCheck(undefined, history([300_000, 310_000], [])))).toEqual([]);
    });
    it("leaves a check with no history, a quick check and a lint without history alone", () => {
      expect(codes(lintCheck(undefined, history([], [])))).toEqual([]);
      expect(codes(lintCheck(undefined, history([4_000, 5_000, 6_000], [])))).toEqual([]);
      expect(codes(lintCheck(undefined, {}))).toEqual([]);
    });
  });

  describe("red before green for a fix", () => {
    it("warns a low-risk fix whose checks all name files the base already has, as it does for medium risk", () => {
      const kinds = { "src/a.ts":"file" as const, "src/b.ts":"file" as const };
      const verification = [{ command:"grep -q x src/b.ts", cwd:root }];
      expect(lint({ risk:"low", kind:"fix", verification }, {}, kinds).warnings.map((warning) => warning.code)).toEqual(["no_red_before_green"]);
      expect(lint({ risk:"low", kind:"feature", verification }, {}, kinds).warnings).toEqual([]);
    });
  });

  describe("depends_on", () => {
    it("sends the PM back to replan when a dependency ended blocked or canceled", () => {
      const { errors } = lint({ depends_on:["P1", "P2"] }, { deadDependencies:[{ id:"P1", state:"blocked" }, { id:"P2", state:"canceled" }] }, { "src/a.ts":"file" });
      expect(codes({ errors, warnings:[] })).toEqual(["depends_dead", "depends_dead"]);
      expect(errors[0]!.message).toMatch(/^replan: depends_on P1 ended blocked/);
      expect(errors[1]!.message).toMatch(/^replan: depends_on P2 ended canceled/);
      expect(lintReply("run", errors)).toMatchObject({ state:"validation_failed", replan:true });
    });
  });

  it("answers every problem in one message", () => {
    const { errors } = lint({ owns_paths:["../x"], expected_outputs:["lib/z.ts"] }, { deadDependencies:[{ id:"P1", state:"blocked" }] }, { "src/a.ts":"missing" });
    const reply = lintReply("run-1", errors) as { reason:string; findings:unknown[] };
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(reply.reason).toMatch(/^contract lint: nothing was dispatched and no attempt was spent/);
    expect(reply.reason.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(errors.length);
    expect(reply.findings).toHaveLength(errors.length);
  });
});

const projectId = "project-lint";
const pmThreadId = "pm-thread";
const runId = "run-lint";
const config = {
  projectId, hostId:"host-test", pmWorkspacePath:"/tmp/pm", writerWorkspacePath:root,
  pmProviderId:"claude-code", pmModel:"claude-test", writerProviderId:"codex", writerModel:"codex-test",
};

/** The dispatch of a task through the real plugin; the host answers snapshotDryRun from `kinds` or fails when it is null. */
async function setup(kinds:Record<string, PathKind> | null, targets:Record<string, "file" | "directory" | "missing"> = {}, probeOutput = "", folders:Record<string, string[]> = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId:"lane-pilot",
    sdk:{ threads:{
      getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role:"pm", lanePilotRunId:runId } : { role:"writer" },
      spawn: async () => ({ id:"writer-lint" }),
      wait: async () => new Promise(() => undefined),
      get: async ({ threadId }) => ({ id:threadId, status:"idle", projectId }) as never,
      output: async () => ({ text:"" }),
      list: async () => [] as never,
    }, providers:{ list: async () => [] as never, models: async () => ({ models:[] as never }) }, files:{ read: async () => ({ content:"fixture\n" }), write: async () => ({ ok:true }) } },
    experimental_callHostRpc: async (call) => {
      if (call.method === "snapshotDryRun") {
        if (!kinds) throw new Error("host went away");
        const paths = (call.input as { paths:string[] }).paths;
        return { hostId:"host-test", entries:paths.map((path) => ({ path, kind:kinds[path.slice(root.length + 1)] ?? "missing", sha256:null, symlinkTarget:null,
          ...(targets[path.slice(root.length + 1)] ? { targetKind:targets[path.slice(root.length + 1)] } : {}) })) };
      }
      if (call.method === "listFolders") {
        const paths = (call.input as { paths:string[] }).paths;
        return { hostId:"host-test", entries:paths.map((path) => ({ path, names:folders[path.slice(root.length + 1)] ?? [], truncated:false })) };
      }
      if (call.method === "gitOwnershipBase") return new Promise(() => undefined);
      if (call.method === "runCommand" && String((call.input as { command?:string }).command ?? "").includes("@@package.json")) return { hostId:"host-test", exitCode:0, stdout:probeOutput, stderr:"" };
      return { hostId:"host-test", exitCode:0, stdout:String((call.input as { command?:string }).command ?? "").includes("porcelain") ? "[]" : "", stderr:"" };
    },
  });
  const db = openDatabase(bb);
  savePrototypeConfig(db, config);
  saveProjectSetting(db, projectId, "plan_critique.enabled", false);
  saveProjectSetting(db, projectId, "memory.enabled", false);
  createRun(db, runId, projectId, "bb", root);
  setRunThread(db, runId, pmThreadId);
  await plugin(bb);
  const dispatch = async (next:Partial<TaskV2> = {}) => JSON.parse(String(await harness.behavior.callAgentTool(
    "lane_pilot_dispatch_writer", { confirm: true, objective: "Проверка диспетча", plan:"Plan for the lint", task:{ ...baseTask, ...next } }, { threadId:pmThreadId, projectId },
  ))) as Record<string, unknown>;
  return { db, harness, dispatch };
}
const taskCount = (db:ReturnType<typeof openDatabase>) => (db.prepare("SELECT COUNT(*) count FROM lane_pilot_task WHERE run_id=?").get(runId) as { count:number }).count;

describe("contract lint at dispatch", () => {
  beforeEach(() => { process.env.LANE_PILOT_DISPATCH_ANSWER_MS = "50"; });
  afterEach(() => { delete process.env.LANE_PILOT_DISPATCH_ANSWER_MS; });

  it("reads the project's gate command and its recorded check history into the lint (Vampirism Fire: the whole Studio suite with the default 120 s)", async () => {
    const { db, harness, dispatch } = await setup({ "src/a.ts":"file" });
    saveProjectSetting(db, projectId, "integration.gate_command", "python3 -I scripts/studio_test.py");
    const whole = await dispatch({ verification:[{ command:"cd game && python3 -I scripts/studio_test.py", cwd:root }] });
    expect(whole).toMatchObject({ state:"validation_failed" });
    expect(String(whole.reason)).toContain("the integration gate (python3 -I scripts/studio_test.py) runs the whole suite once per batch");
    const slow = "cd game && python3 -I scripts/studio_test.py --filter Par010";
    for (const seconds of [300, 320, 340]) recordCheckDuration(db, { projectId, command:slow, cwd:root, root, durationMs:seconds * 1000, exitCode:0 });
    const timeout = await dispatch({ verification:[{ command:slow, cwd:root }] });
    expect(timeout).toMatchObject({ state:"validation_failed" });
    expect(String(timeout.reason)).toContain("took up to 340 s in its last 3 green runs");
    expect(String(timeout.reason)).toContain("set timeout_sec to 720 or more");
    expect(taskCount(db)).toBe(0);
    // The history is the check's own: the same check started from its folder is refused by it...
    const inFolder = await dispatch({ verification:[{ command:"python3 -I scripts/studio_test.py --filter Par010", cwd:`${root}/game` }] });
    expect(String(inFolder.reason)).toContain("took up to 340 s in its last 3 green runs");
    // ...and the same command in another folder of the project is not.
    const other = await dispatch({ verification:[{ command:slow, cwd:root }, { command:"python3 -I scripts/studio_test.py --filter Par010", cwd:`${root}/other` }] });
    expect(String(other.reason ?? "").match(/verification\[\d\][^\n]*green runs/g)).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("sends every contract error back in one message and creates no task and no attempt", async () => {
    const { db, harness, dispatch } = await setup({ "src/a.ts":"missing", tests:"directory" });
    const reply = await dispatch({ owns_paths:["../x"], expected_outputs:["lib/z.ts"], verification:[{ command:"npx vitest run tests", cwd:root }] });
    expect(reply).toMatchObject({ runId, state:"validation_failed" });
    expect(String(reply.reason)).toContain("unsafe ownership path pattern: ../x");
    expect(String(reply.reason)).toContain("read_first source is missing: src/a.ts");
    expect(String(reply.reason)).toContain("write tests/");
    expect(String(reply.reason)).toContain("lib/z.ts");
    expect(taskCount(db)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) count FROM lane_pilot_attempt WHERE run_id=?").get(runId)).toEqual({ count:0 });
    expect(db.prepare("SELECT state FROM lane_pilot_run WHERE id=?").get(runId)).not.toMatchObject({ state:"blocked" });
    await harness.lifecycle.dispose();
  });

  it("returns replan, and does not start the task, when depends_on names a blocked task", async () => {
    const { db, harness, dispatch } = await setup({ "src/a.ts":"file" });
    createTask(db, { id:"dep-1", runId, kind:"bb", contract:{ ...baseTask, id:"dep-1" } });
    createAttempt(db, { id:"dep-attempt", runId, taskId:"dep-1" });
    transitionAttempt(db, "dep-attempt", "queued");
    transitionAttempt(db, "dep-attempt", "blocked", { reason:"missing expected_outputs: src/a.ts" });
    const reply = await dispatch({ depends_on:["dep-1"] });
    expect(reply).toMatchObject({ state:"validation_failed", replan:true });
    expect(String(reply.reason)).toContain("replan: depends_on dep-1 ended blocked");
    expect(taskCount(db)).toBe(1);
    expect(listAttemptsForTask(db, runId, "lint-task")).toHaveLength(0);
    // Sent again, the dependency is no longer dead: the name follows its redispatch and the dependent is queued.
    createTask(db, { id:"dep-1.2", runId, kind:"bb", contract:{ ...baseTask, id:"dep-1.2", owns_paths:["docs/"], expected_outputs:["docs/x.md"] } });
    createAttempt(db, { id:"dep-attempt-2", runId, taskId:"dep-1.2" });
    transitionAttempt(db, "dep-attempt-2", "queued");
    const queued = await dispatch({ depends_on:["dep-1"] });
    expect(queued).toMatchObject({ taskId:"lint-task", state:"queued" });
    await harness.lifecycle.dispose();
  });

  it("sends a whole-suite check back while the project has a gate, and takes it when the gate is off", async () => {
    const { db, harness, dispatch } = await setup({ "src/a.ts":"file" });
    saveProjectSetting(db, projectId, "integration.gate_command", "npm run gate");
    const reply = await dispatch({ verification:[{ command:"npx vitest run", cwd:root }] });
    expect(reply).toMatchObject({ runId, state:"validation_failed" });
    expect(String(reply.reason)).toContain("the integration gate (npm run gate) runs the whole suite once per batch");
    expect(taskCount(db)).toBe(0);
    saveProjectSetting(db, projectId, "integration.gate_command", "off");
    expect(await dispatch({ verification:[{ command:"npx vitest run", cwd:root }] })).toMatchObject({ taskId:"lint-task", state:"queued" });
    await harness.lifecycle.dispose();
  });

  it("sends back an owned code file whose longer-named test the host lists (site-en-shoot, 2026-10-24), and takes it once owned", async () => {
    const folders = { "src/__tests__":["shoot-en.test.ts", "shoot-seo-audit.test.ts"], src:["a.ts", "shoot.ts"] };
    const { db, harness, dispatch } = await setup({ "src/a.ts":"file" }, {}, "", folders);
    const owns = ["src/shoot.ts", "src/__tests__/shoot-en.test.ts", "src/b.ts"];
    const reply = await dispatch({ owns_paths:owns });
    expect(reply).toMatchObject({ runId, state:"validation_failed" });
    expect((reply.findings as Array<{ code:string }>).map((finding) => finding.code)).toEqual(["test_unowned"]);
    expect(String(reply.reason)).toContain("so add src/__tests__/shoot-seo-audit.test.ts to owns_paths");
    expect(taskCount(db)).toBe(0);
    const taken = await dispatch({ owns_paths:[...owns, "src/__tests__/shoot-seo-audit.test.ts"] });
    expect(taken.state).not.toBe("validation_failed");
    await harness.lifecycle.dispose();
  });

  it("sends a task without the standard back before any task exists", async () => {
    const { db, harness, dispatch } = await setup({ "src/a.ts":"file" });
    const reply = await dispatch({ display_title:undefined, kind:undefined, area:undefined });
    expect(reply).toMatchObject({ runId, state:"validation_failed" });
    expect((reply.findings as Array<{ code:string }>).map((finding) => finding.code)).toEqual(["display_title_missing", "kind_missing", "area_missing"]);
    expect(taskCount(db)).toBe(0);
    await harness.lifecycle.dispose();
  });

  it("asks for the run objective on the first dispatch only", async () => {
    const { db, harness } = await setup({ "src/a.ts":"file" });
    const send = async (params:Record<string, unknown>) => JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer", { confirm:true, plan:"Plan for the lint", task:baseTask, ...params }, { threadId:pmThreadId, projectId },
    ))) as Record<string, unknown>;
    const refused = await send({});
    expect(refused).toMatchObject({ runId, state:"validation_failed" });
    expect((refused.findings as Array<{ code:string }>).map((finding) => finding.code)).toEqual(["objective_missing"]);
    expect(String(refused.reason)).toContain("add objective to this first dispatch");
    expect(taskCount(db)).toBe(0);
    expect(await send({ objective:"Привести заказы в порядок" })).toMatchObject({ taskId:"lint-task", state:"queued" });
    // The run keeps its objective, so a later dispatch may leave it out.
    expect(await send({ task:{ ...baseTask, id:"lint-task-2", owns_paths:["docs/"], expected_outputs:["docs/x.md"], read_first:[] } })).toMatchObject({ taskId:"lint-task-2" });
    await harness.lifecycle.dispose();
  });

  it("detects the gate on the host for the lint when no command is set", async () => {
    const { db, harness, dispatch } = await setup({ "src/a.ts":"file" }, {}, "@@package.json\n{\"scripts\":{\"test\":\"vitest run\"}}\n");
    const reply = await dispatch({ verification:[{ command:"npm test", cwd:root }] });
    expect(reply).toMatchObject({ state:"validation_failed" });
    expect(String(reply.reason)).toContain("the integration gate (npm test) runs the whole suite once per batch");
    expect(taskCount(db)).toBe(0);
    await harness.lifecycle.dispose();
  });

  it("accepts a read_first symlink that points at a file, and still rejects one that points nowhere", async () => {
    const { db, harness, dispatch } = await setup({ "AGENTS.md":"symlink" }, { "AGENTS.md":"file" });
    expect(await dispatch({ read_first:["AGENTS.md"] })).toMatchObject({ taskId:"lint-task", state:"queued" });
    expect(taskCount(db)).toBe(1);
    await harness.lifecycle.dispose();
    const dangling = await setup({ "AGENTS.md":"symlink" }, { "AGENTS.md":"missing" });
    expect(await dangling.dispatch({ read_first:["AGENTS.md"] })).toMatchObject({ state:"validation_failed" });
    await dangling.harness.lifecycle.dispose();
  });

  it("dispatches as before when the machine cannot be asked about the paths", async () => {
    const { db, harness, dispatch } = await setup(null);
    const reply = await dispatch();
    expect(reply).toMatchObject({ taskId:"lint-task", state:"queued" });
    expect(taskCount(db)).toBe(1);
    await harness.lifecycle.dispose();
  });
});

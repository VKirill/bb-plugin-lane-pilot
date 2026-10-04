import { describe, expect, it } from "vitest";
import { helperSpawnFields, resolveHelperPlacement } from "../src/helper-placement";

describe("helper placement", () => {
  const parent = { id:"thr_pm", projectId:"proj", sectionId:"sec_same", environmentId:"env-parent", sourceThreadId:"thr_source", lifecycleOwnerThreadId:"thr_owner" };

  it("keeps plugin helpers hidden without stealing the parent environment", () => {
    const resolved = resolveHelperPlacement({ mode:"plugin", projectId:"proj", parent, role:"code-critic", taskTitle:"Write a fixture" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(helperSpawnFields(resolved.placement)).toMatchObject({
      visibility:"hidden", projectId:"proj", parentThreadId:"thr_pm", lifecycleOwnerThreadId:"thr_owner",
      sectionId:"sec_same",
    });
    expect(helperSpawnFields(resolved.placement)).not.toHaveProperty("sourceThreadId");
    expect(resolved.placement.environmentId).toBeUndefined();
    expect(resolved.placement.title).toContain("code critique");
    // The owner watches writers, specialists, errands and browser checks; bookkeeping helpers stay hidden.
    const writerShown = resolveHelperPlacement({ mode:"plugin", projectId:"proj", parent, role:"writer" });
    expect(writerShown.ok && writerShown.placement.visibility).toBe("visible");
    expect(writerShown.ok && writerShown.placement.environmentId).toBeUndefined();
    const readerHidden = resolveHelperPlacement({ mode:"plugin", projectId:"proj", parent, role:"pm-reader" });
    expect(readerHidden.ok && readerHidden.placement.visibility).toBe("hidden");
    const docsVisible = resolveHelperPlacement({ mode:"project_tree", projectId:"proj", parent, role:"docs-maintainer" });
    expect(docsVisible.ok && docsVisible.placement.visibility).toBe("visible");
    expect(docsVisible.ok && docsVisible.placement.title).toContain("docs");
  });

  it("refuses a spawn that drops sourceThreadId or lifecycleOwnerThreadId instead of widening", () => {
    expect(resolveHelperPlacement({
      mode:"plugin", projectId:"proj", parent:{ id:"thr_pm", projectId:"proj" }, role:"writer",
    })).toEqual({ ok:false, reason:"helper_parent_relation_missing" });
    const moved = resolveHelperPlacement({
      mode:"plugin",
      projectId:"proj",
      parent:{ id:"thr_other", projectId:"proj", sourceThreadId:"thr_source", lifecycleOwnerThreadId:"thr_owner" },
      role:"writer",
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(helperSpawnFields(moved.placement)).toMatchObject({
      parentThreadId:"thr_other", lifecycleOwnerThreadId:"thr_owner",
    });
  });

  it("shows project-tree helpers beside the parent session", () => {
    const resolved = resolveHelperPlacement({ mode:"project_tree", projectId:"proj", parent, role:"writer" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.placement.visibility).toBe("visible");
    expect(resolved.placement.environmentId).toBe("env-parent");
  });
});

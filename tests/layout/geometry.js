/** Browser-side geometry checks. Root scrollWidth is not enough. */

export function collectPanelGeometry(root = globalThis.document?.body) {
  const panel = root.querySelector("[data-testid='owned-settings']") ?? root;
  const section = panel.matches?.("section") ? panel : panel.querySelector("section") ?? panel;
  const fieldset = panel.querySelector("fieldset") ?? panel;
  const controls = [...panel.querySelectorAll("input, select, textarea, button[role='combobox']")];
  const panelBox = panel.getBoundingClientRect();
  const overflowNodes = [section, fieldset, panel, ...panel.querySelectorAll("[data-testid^='agent-resource-']")]
    .filter((node, index, list) => node && list.indexOf(node) === index && node.scrollWidth > node.clientWidth + 1)
    .map((node) => ({
      tag: node.tagName.toLowerCase(),
      testId: node.getAttribute("data-testid"),
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
    }));
  const controlOverflow = controls.map((node) => {
    const box = node.getBoundingClientRect();
    return {
      tag: node.tagName.toLowerCase(),
      id: node.id || node.getAttribute("aria-label") || "",
      rightOverflow: Math.round(box.right - panelBox.right),
      width: Math.round(box.width),
    };
  }).filter((row) => row.rightOverflow > 1);
  const toolbar = root.querySelector("[data-testid='settings-toolbar']");
  const toolbarInput = toolbar?.querySelector("input");
  const toolbarButtons = toolbar ? [...toolbar.querySelectorAll("button")] : [];
  const toolbarBoxes = toolbarInput
    ? [toolbarInput, ...toolbarButtons].map((node) => {
      const box = node.getBoundingClientRect();
      return { tag: node.tagName.toLowerCase(), height: Math.round(box.height), top: Math.round(box.top), bottom: Math.round(box.bottom) };
    })
    : [];
  const inputBox = toolbarBoxes[0];
  const toolbarAligned = !inputBox || toolbarBoxes.slice(1).every((box) => {
    const heightOk = Math.abs(box.height - inputBox.height) <= 1;
    const stacked = box.top >= inputBox.bottom - 1;
    const rowAligned = Math.abs(box.top - inputBox.top) <= 1 && Math.abs(box.bottom - inputBox.bottom) <= 1;
    return heightOk && (stacked || rowAligned);
  });
  return {
    document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
    section: { clientWidth: section.clientWidth, scrollWidth: section.scrollWidth },
    fieldset: { clientWidth: fieldset.clientWidth, scrollWidth: fieldset.scrollWidth },
    panel: { clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth },
    overflowNodes,
    controlOverflow,
    toolbarBoxes,
    toolbarAligned,
    ok:
      section.scrollWidth <= section.clientWidth + 1 &&
      fieldset.scrollWidth <= fieldset.clientWidth + 1 &&
      panel.scrollWidth <= panel.clientWidth + 1 &&
      overflowNodes.length === 0 &&
      controlOverflow.length === 0 &&
      toolbarAligned,
  };
}

let lastInputModality: "pointer" | "keyboard" = "pointer";

if (typeof document !== "undefined") {
  document.addEventListener(
    "keydown",
    () => {
      lastInputModality = "keyboard";
    },
    { capture: true },
  );
  document.addEventListener(
    "pointerdown",
    () => {
      lastInputModality = "pointer";
    },
    { capture: true },
  );
}

export function isLastInputKeyboard(): boolean {
  return lastInputModality === "keyboard";
}

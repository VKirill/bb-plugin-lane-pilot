/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, KpiTile, PageHeader, StatusPill } from "@lane-pilot/ui-kit";

describe("ui-kit console primitives", () => {
  afterEach(() => {
    cleanup();
  });

  describe("ConfirmDialog", () => {
    it("disables confirm and shows pending state while onConfirm runs, then closes", async () => {
      let resolveConfirm!: () => void;
      const onConfirm = vi.fn(
        () => new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        }),
      );
      const onOpenChange = vi.fn();

      render(
        <ConfirmDialog
          open
          title="Delete item"
          body="This action cannot be undone."
          confirmLabel="Delete"
          cancelLabel="Cancel"
          tone="danger"
          onConfirm={onConfirm}
          onOpenChange={onOpenChange}
        />,
      );

      const confirmButton = screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
      const cancelButton = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
      expect(confirmButton.disabled).toBe(false);

      fireEvent.click(confirmButton);
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(confirmButton.disabled).toBe(true);
      expect(cancelButton.disabled).toBe(true);
      expect(confirmButton.getAttribute("aria-busy")).toBe("true");
      expect(confirmButton.getAttribute("data-pending")).toBe("true");
      expect(onOpenChange).not.toHaveBeenCalled();

      resolveConfirm();
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("keeps dialog open and shows error.message under the body when onConfirm rejects", async () => {
      const onConfirm = vi.fn().mockRejectedValue(new Error("Network timeout"));
      const onOpenChange = vi.fn();

      render(
        <ConfirmDialog
          open
          title="Stop workers"
          body="All active runs will halt."
          confirmLabel="Confirm"
          cancelLabel="Cancel"
          onConfirm={onConfirm}
          onOpenChange={onOpenChange}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe("Network timeout");
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("gates confirm until requireText matches exactly and resets state on close", async () => {
      const onConfirm = vi.fn();
      const onOpenChange = vi.fn();

      const { rerender } = render(
        <ConfirmDialog
          open
          title="Stop all"
          body="Type STOP to confirm."
          confirmLabel="Stop all"
          cancelLabel="Cancel"
          tone="danger"
          requireText="STOP"
          onConfirm={onConfirm}
          onOpenChange={onOpenChange}
        />,
      );

      const confirmButton = screen.getByRole("button", { name: "Stop all" }) as HTMLButtonElement;
      const input = screen.getByRole("textbox", { name: "STOP" }) as HTMLInputElement;
      expect(confirmButton.disabled).toBe(true);

      fireEvent.change(input, { target: { value: "STO" } });
      expect(confirmButton.disabled).toBe(true);

      fireEvent.change(input, { target: { value: "STOP" } });
      expect(confirmButton.disabled).toBe(false);

      fireEvent.click(confirmButton);
      await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

      rerender(
        <ConfirmDialog
          open={false}
          title="Stop all"
          body="Type STOP to confirm."
          confirmLabel="Stop all"
          cancelLabel="Cancel"
          tone="danger"
          requireText="STOP"
          onConfirm={onConfirm}
          onOpenChange={onOpenChange}
        />,
      );
      rerender(
        <ConfirmDialog
          open
          title="Stop all"
          body="Type STOP to confirm."
          confirmLabel="Stop all"
          cancelLabel="Cancel"
          tone="danger"
          requireText="STOP"
          onConfirm={onConfirm}
          onOpenChange={onOpenChange}
        />,
      );

      expect((screen.getByRole("textbox", { name: "STOP" }) as HTMLInputElement).value).toBe("");
      expect((screen.getByRole("button", { name: "Stop all" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe("KpiTile", () => {
    it("renders a div when onClick is omitted and a button with accessible name when onClick is set", () => {
      const onClick = vi.fn();

      const { rerender } = render(
        <KpiTile label="Open tasks" value={12} note="today" tone="accent" />,
      );

      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.getByText("Open tasks").parentElement?.tagName).toBe("DIV");
      expect(screen.getByText("12")).toBeTruthy();
      expect(screen.getByText("today")).toBeTruthy();

      rerender(
        <KpiTile label="Open tasks" value={12} note="today" tone="ok" onClick={onClick} />,
      );

      const button = screen.getByRole("button", { name: "Open tasks 12" });
      expect(button.tagName).toBe("BUTTON");
      fireEvent.click(button);
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe("PageHeader", () => {
    it("renders title, optional subtitle, and actions", () => {
      render(
        <PageHeader
          title="Overview"
          subtitle="Today across all projects"
          actions={<button type="button">Brake</button>}
        />,
      );

      expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
      expect(screen.getByText("Today across all projects")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Brake" })).toBeTruthy();
    });
  });

  describe("StatusPill", () => {
    it("maps each tone to the corresponding existing badge variant", () => {
      render(
        <div>
          <StatusPill tone="ok">Running</StatusPill>
          <StatusPill tone="warn">Pending</StatusPill>
          <StatusPill tone="bad">Failed</StatusPill>
          <StatusPill tone="accent">Active</StatusPill>
          <StatusPill tone="muted">Paused</StatusPill>
        </div>,
      );

      expect(screen.getByText("Running").className).toContain("lp-pill-success");
      expect(screen.getByText("Pending").className).toContain("lp-pill-neutral");
      expect(screen.getByText("Failed").className).toContain("lp-pill-danger");
      expect(screen.getByText("Active").className).toContain("lp-pill-info");
      expect(screen.getByText("Paused").className).toContain("lp-pill-muted");
    });
  });
});

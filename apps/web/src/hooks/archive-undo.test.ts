import { describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ success: vi.fn(() => "toast-1") }));
vi.mock("@knowledge-base/ui/components/sileo", () => ({ toast }));

const { ARCHIVE_UNDO_TOAST_MS, announceArchivedWithUndo } = await import("./archive-undo");

describe("announceArchivedWithUndo", () => {
  it("shows a success toast whose Undo restores the user", () => {
    const onUndo = vi.fn();
    const id = announceArchivedWithUndo({ message: "User archived", undoLabel: "Undo", onUndo });

    expect(id).toBe("toast-1");
    expect(toast.success).toHaveBeenCalledWith("User archived", {
      duration: ARCHIVE_UNDO_TOAST_MS,
      action: { label: "Undo", onClick: onUndo },
    });
    expect(onUndo).not.toHaveBeenCalled();
    const options = (toast.success.mock.calls[0] as unknown[])[1] as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it("stays up longer than a plain toast so the Undo can be reached", () => {
    expect(ARCHIVE_UNDO_TOAST_MS).toBeGreaterThanOrEqual(6_000);
  });
});

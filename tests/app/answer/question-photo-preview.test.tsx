import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import {
  getQuestionPhoto,
  QuestionPhotoDialog,
  QuestionPhotoPreview,
} from "@/app/answer/question-photo-preview";

const photo = {
  src: "/images/questions/q5-mandarin-oriental-scone.jpg",
  alt: "マンダリンオリエンタルホテルのスコーン",
  label: "マンダリンオリエンタルホテルのスコーンの写真",
};

afterEach(() => cleanup());

describe("question photo preview", () => {
  it("matches the Q5 scone activity after whitespace normalization", () => {
    expect(getQuestionPhoto(5, "  マンダリンオリエンタルホテルのスコーンを食べる  ")).toEqual(
      photo,
    );
    expect(getQuestionPhoto(4, "マンダリンオリエンタルホテルのスコーンを食べる")).toBeNull();
    expect(getQuestionPhoto(5, "別の活動")).toBeNull();
  });

  it("opens the selected photo from its preview button", () => {
    const onOpen = vi.fn();
    render(<QuestionPhotoPreview photo={photo} onOpen={onOpen} />);
    const previewButton = screen.getByRole("button", {
      name: "マンダリンオリエンタルホテルのスコーンの写真を拡大表示",
    });
    fireEvent.click(previewButton);
    expect(onOpen).toHaveBeenCalledWith(photo, expect.any(HTMLButtonElement));
    onOpen.mockClear();
    fireEvent.keyDown(previewButton, { key: "Enter" });
    fireEvent.click(previewButton);
    expect(onOpen).toHaveBeenCalledWith(photo, expect.any(HTMLButtonElement));
  });

  it("keeps an empty dialog closed without a photo", () => {
    render(<QuestionPhotoDialog photo={null} trigger={null} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { hidden: true })).not.toHaveAttribute("open");
  });

  it("handles close, Escape, tab wrapping, and outside clicks", () => {
    const trigger = document.createElement("button");
    const onClose = vi.fn();
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    });
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: showModal,
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: close,
    });
    render(<QuestionPhotoDialog photo={photo} trigger={trigger} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", {
      name: "マンダリンオリエンタルホテルのスコーンの写真",
    }) as HTMLDialogElement;
    expect(showModal).toHaveBeenCalledOnce();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "写真を閉じる" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: "写真を閉じる" }), { key: "Tab" });
    expect(screen.getByRole("button", { name: "写真を閉じる" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "写真を閉じる" }));
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(dialog, { clientX: -1, clientY: -1 });
    expect(onClose).toHaveBeenCalledTimes(3);

    dialog.removeAttribute("open");
    fireEvent.click(dialog, { clientX: -1, clientY: -1 });
    expect(onClose).toHaveBeenCalledTimes(3);
    cleanup();
    expect(close).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe("");
    expect(trigger).not.toHaveFocus();
  });

  it("keeps focus in an empty dialog when Tab is pressed", () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      }),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: vi.fn(),
    });
    const { container } = render(
      <QuestionPhotoDialog photo={photo} trigger={null} onClose={vi.fn()} />,
    );
    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    const closeButton = screen.getByRole("button", { name: "写真を閉じる" }) as HTMLButtonElement;
    closeButton.disabled = true;
    const enterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(dialog, enterEvent);
    expect(enterEvent.defaultPrevented).toBe(false);
    closeButton.disabled = false;
    dialog.focus();
    const tabEvent = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    fireEvent(dialog, tabEvent);
    expect(tabEvent.defaultPrevented).toBe(false);
    closeButton.disabled = true;
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog).toHaveFocus();
  });
});

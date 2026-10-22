import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChoiceButton from "@/components/ChoiceButton";

describe("ChoiceButton", () => {
  it("renders label and text in idle variant by default", () => {
    render(
      <ChoiceButton
        id="choice-a"
        name="answer"
        value="0"
        label="A."
        text="Choice text"
        variant="idle"
        checked={false}
      />,
    );
    expect(screen.getByText("A.")).toBeInTheDocument();
    expect(screen.getByText("Choice text")).toBeInTheDocument();
    expect(screen.getByText("Choice text").closest("label")).toHaveClass(
      "border-control-border",
      "bg-surface",
      "hover:border-primary",
    );
    const radio = screen.getByRole("radio", { name: /A\..*Choice text/ });
    expect(radio).not.toBeDisabled();
    expect(radio).not.toBeChecked();
  });

  it("renders the selected mark and a checked native radio", () => {
    render(
      <ChoiceButton
        id="choice-a"
        name="answer"
        value="0"
        label="A."
        text="Selected text"
        variant="selected"
        checked
      />,
    );
    expect(screen.getByText("選択中")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /A\..*Selected text/ })).toBeChecked();
  });

  it.each([
    ["correct", "border-success", "bg-success/15", "text-success"],
    ["selectedWrong", "border-error", "bg-error/15", "text-error"],
    ["muted", "border-border/60", "bg-surface/40", "opacity-50"],
  ] as const)("applies the %s variant styling", (variant, ...classes) => {
    render(
      <ChoiceButton
        id="choice-a"
        name="answer"
        value="0"
        label="A."
        text="Styled choice"
        variant={variant}
        checked={false}
      />,
    );

    expect(screen.getByText("Styled choice").closest("label")).toHaveClass(...classes);
  });

  it("changes the radio when its full row label is activated", async () => {
    const handleChange = vi.fn();
    const user = userEvent.setup();
    const choice = (checked: boolean) => (
      <ChoiceButton
        id="choice-a"
        name="answer"
        value="0"
        label="A."
        text="Clickable"
        variant={checked ? "selected" : "idle"}
        checked={checked}
        onChange={handleChange}
      />
    );
    const { rerender } = render(choice(false));
    const radio = screen.getByRole("radio", { name: /A\..*Clickable/ });

    await user.click(screen.getByText("Clickable"));
    expect(handleChange).toHaveBeenCalledOnce();
    expect(radio).not.toBeChecked();

    rerender(choice(true));
    expect(screen.getByRole("radio", { name: /A\..*Clickable/ })).toBeChecked();
    expect(screen.getByText("選択中")).toBeVisible();
  });

  it("disables the radio while a submission is pending", () => {
    render(
      <ChoiceButton
        id="choice-a"
        name="answer"
        value="0"
        label="A."
        text="Disabled"
        variant="idle"
        checked={false}
        disabled
      />,
    );
    const radio = screen.getByRole("radio", { name: /A\..*Disabled/ });
    expect(radio).toBeDisabled();
    expect(radio.closest("label")).toHaveClass("cursor-not-allowed");
  });
});

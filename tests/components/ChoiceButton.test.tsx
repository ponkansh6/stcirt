import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ChoiceButton from "@/components/ChoiceButton";

describe("ChoiceButton", () => {
  it("renders label and text in idle variant by default", () => {
    render(<ChoiceButton label="A." text="Choice text" variant="idle" />);
    expect(screen.getByText("A.")).toBeInTheDocument();
    expect(screen.getByText("Choice text")).toBeInTheDocument();
    const button = screen.getByRole("button");
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute("aria-busy");
  });

  it("renders correct variant with checkmark", () => {
    render(<ChoiceButton label="B." text="Correct text" variant="correct" />);
    expect(screen.getByText("✓")).toBeInTheDocument();
  });

  it("renders selectedWrong variant with cross", () => {
    render(<ChoiceButton label="C." text="Wrong text" variant="selectedWrong" />);
    expect(screen.getByText("✗")).toBeInTheDocument();
  });

  it("renders muted variant", () => {
    render(<ChoiceButton label="D." text="Muted text" variant="muted" />);
    expect(screen.getByText("D.")).toBeInTheDocument();
  });

  it("renders selected variant with a textual selected state", () => {
    render(<ChoiceButton label="A." text="Selected text" variant="selected" />);
    const button = screen.getByRole("button");
    expect(screen.getByText("選択中")).toBeInTheDocument();
    expect(button).not.toHaveAttribute("aria-busy");
  });

  it("calls onClick when clicked and not disabled", () => {
    const handleClick = vi.fn();
    render(<ChoiceButton label="A." text="Clickable" variant="idle" onClick={handleClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("does not call onClick when disabled", () => {
    const handleClick = vi.fn();
    render(
      <ChoiceButton label="A." text="Disabled" variant="idle" onClick={handleClick} disabled />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(handleClick).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeDisabled();
  });
});

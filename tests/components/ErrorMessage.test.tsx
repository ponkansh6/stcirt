import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorMessage } from "@/components/ErrorMessage";

describe("ErrorMessage", () => {
  it("renders message without retry button when onRetry is not provided", () => {
    render(<ErrorMessage message="Something went wrong" />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders retry button when onRetry is provided and calls it on click", () => {
    const handleRetry = vi.fn();
    render(<ErrorMessage message="Error occurred" onRetry={handleRetry} />);
    expect(screen.getByText("Error occurred")).toBeInTheDocument();

    const button = screen.getByRole("button", { name: "再試行" });
    expect(button).toBeInTheDocument();

    fireEvent.click(button);
    expect(handleRetry).toHaveBeenCalledTimes(1);
  });

  it("passes loading prop to the retry button", () => {
    render(<ErrorMessage message="Loading error" onRetry={() => {}} loading />);
    const button = screen.getByRole("button", { name: "再試行" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });
});

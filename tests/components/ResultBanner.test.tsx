import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ResultBanner from "@/components/ResultBanner";

describe("ResultBanner", () => {
  it("renders correct state when isCorrect is true", () => {
    render(<ResultBanner isCorrect={true} />);
    const banner = screen.getByRole("status");
    expect(banner).toBeInTheDocument();
    expect(screen.getByText("正解！")).toBeInTheDocument();
    expect(screen.getByText("✓")).toBeInTheDocument();
  });

  it("renders incorrect state when isCorrect is false", () => {
    render(<ResultBanner isCorrect={false} />);
    const banner = screen.getByRole("status");
    expect(banner).toBeInTheDocument();
    expect(screen.getByText("不正解")).toBeInTheDocument();
    expect(screen.getByText("✗")).toBeInTheDocument();
  });
});

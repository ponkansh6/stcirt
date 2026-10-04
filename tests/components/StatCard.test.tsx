import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatCard } from "@/components/StatCard";

describe("StatCard", () => {
  it("renders label and value without ring", () => {
    render(<StatCard label="問題数" value="12" />);
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("問題数")).toBeInTheDocument();
  });

  it("renders with progress bar when progress prop is provided", () => {
    const { container } = render(<StatCard label="本日の正答率" value="75%" progress={0.75} />);
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("本日の正答率")).toBeInTheDocument();
    const bar = container.querySelector(".bg-primary") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.style.width).toBe("75%");
  });
});

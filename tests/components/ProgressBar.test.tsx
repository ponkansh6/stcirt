import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ProgressBar } from "@/components/ProgressBar";

describe("ProgressBar", () => {
  it("renders correct width for 0.5", () => {
    const { container } = render(<ProgressBar value={0.5} />);
    const bar = container.querySelector(".bg-primary") as HTMLElement;
    expect(bar.style.width).toBe("50%");
  });

  it("clamps values above 1 to 100%", () => {
    const { container } = render(<ProgressBar value={1.5} />);
    const bar = container.querySelector(".bg-primary") as HTMLElement;
    expect(bar.style.width).toBe("100%");
  });

  it("clamps values below 0 to 0%", () => {
    const { container } = render(<ProgressBar value={-0.5} />);
    const bar = container.querySelector(".bg-primary") as HTMLElement;
    expect(bar.style.width).toBe("0%");
  });
});

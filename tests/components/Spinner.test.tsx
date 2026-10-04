import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Spinner } from "@/components/Spinner";

describe("Spinner", () => {
  it("renders an aria-hidden spinner with default sm/current classes", () => {
    const { container } = render(<Spinner />);
    const el = container.querySelector("span[aria-hidden='true']");
    expect(el).not.toBeNull();
    expect(el?.className).toContain("animate-spin");
    expect(el?.className).toContain("w-4");
    expect(el?.className).toContain("h-4");
    expect(el?.className).toContain("border-2");
    expect(el?.className).toContain("border-current");
  });

  it("renders lg size and primary color when requested", () => {
    const { container } = render(<Spinner size="lg" color="primary" />);
    const el = container.querySelector("span[aria-hidden='true']");
    expect(el?.className).toContain("w-8");
    expect(el?.className).toContain("h-8");
    expect(el?.className).toContain("border-4");
    expect(el?.className).toContain("border-primary");
    expect(el?.className).toContain("border-t-transparent");
  });

  it("appends extra className", () => {
    const { container } = render(<Spinner className="ml-auto" />);
    const el = container.querySelector("span[aria-hidden='true']");
    expect(el?.className).toContain("ml-auto");
  });
});

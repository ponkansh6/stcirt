import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NavLink } from "@/components/NavLink";

describe("NavLink", () => {
  it("renders children and passes href and className to the link", () => {
    render(
      <NavLink href="/dashboard" className="nav-class" pendingClassName="pending-class">
        Home
      </NavLink>,
    );
    const link = screen.getByRole("link", { name: "Home" });
    expect(link).toHaveAttribute("href", "/dashboard");
    expect(link).toHaveClass("nav-class");
  });

  it("applies the primary button variant by default", () => {
    render(<NavLink href="/dashboard">Home</NavLink>);
    const link = screen.getByRole("link", { name: "Home" });
    expect(link).toHaveClass("bg-primary", "text-on-primary");
  });

  it("applies the outline button variant when requested", () => {
    render(
      <NavLink href="/dashboard" variant="outline">
        Home
      </NavLink>,
    );
    const link = screen.getByRole("link", { name: "Home" });
    expect(link).toHaveClass("border-primary", "text-primary");
  });

  it("omits the button base and variant classes for the bare variant", () => {
    render(
      <NavLink href="/" variant="bare" className="text-lg">
        Home
      </NavLink>,
    );
    const link = screen.getByRole("link", { name: "Home" });
    expect(link).toHaveClass("text-lg");
    expect(link).not.toHaveClass("bg-primary");
    expect(link).not.toHaveClass("w-full");
  });

  it("keeps extra className alongside the button variant", () => {
    render(
      <NavLink href="/dashboard" variant="ghost" className="extra-class">
        Home
      </NavLink>,
    );
    const link = screen.getByRole("link", { name: "Home" });
    expect(link).toHaveClass("extra-class");
    expect(link).toHaveClass("text-muted");
  });
});

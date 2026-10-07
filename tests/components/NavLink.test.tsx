import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NavLink } from "@/components/NavLink";

const { useLinkStatusMock } = vi.hoisted(() => ({
  useLinkStatusMock: vi.fn((): { pending: boolean } => ({ pending: false })),
}));

vi.mock("next/link", async (importOriginal) => {
  const nextLink = await importOriginal<typeof import("next/link")>();
  return { ...nextLink, useLinkStatus: useLinkStatusMock };
});

describe("NavLink", () => {
  it("renders children and passes href and className to the link", () => {
    render(
      <NavLink
        href="/dashboard"
        className="nav-class"
        pendingClassName="pending-class"
        aria-current="page"
      >
        Home
      </NavLink>,
    );
    const link = screen.getByRole("link", { name: "Home" });
    expect(link).toHaveAttribute("href", "/dashboard");
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link).toHaveClass("nav-class");
    expect(link.querySelector("span")).not.toHaveClass("pending-class");
  });

  it("applies the pending class while navigation is pending", () => {
    useLinkStatusMock.mockReturnValueOnce({ pending: true });

    render(
      <NavLink href="/dashboard" pendingClassName="pending-class">
        Home
      </NavLink>,
    );

    expect(screen.getByRole("link", { name: "Home" }).querySelector("span")).toHaveClass(
      "pending-class",
    );
  });

  it("can receive keyboard focus as a native link", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Before link</button>
        <NavLink href="/dashboard">Home</NavLink>
      </>,
    );

    await user.tab();
    await user.tab();

    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Home" }));
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

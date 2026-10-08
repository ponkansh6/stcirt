import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PresentationPage from "@/app/presentation/page";

vi.mock("@/app/presentation/presentation-screen", () => ({
  default: ({ presenterRequested }: { presenterRequested: boolean }) => (
    <main aria-label="Presentation entry" data-presenter-requested={String(presenterRequested)}>
      Presentation entry
    </main>
  ),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "valid-session" }) }),
}));

vi.mock("@/lib/presentation/admin-auth", () => ({
  ADMIN_PRESENTATION_COOKIE: "stcirt_admin_presentation",
  isAdminPresentationAuthConfigured: () => true,
  verifyAdminPresentationSession: () => true,
}));

describe("presentation page entry", () => {
  it("renders the presentation screen for the default view", async () => {
    const page = await PresentationPage({ searchParams: Promise.resolve({}) });

    render(page);

    expect(screen.getByRole("main", { name: "Presentation entry" })).toHaveAttribute(
      "data-presenter-requested",
      "false",
    );
  });

  it("passes the presenter request from the query string to the screen", async () => {
    const page = await PresentationPage({
      searchParams: Promise.resolve({ presenter: "1" }),
    });

    render(page);

    expect(screen.getByRole("main", { name: "Presentation entry" })).toHaveAttribute(
      "data-presenter-requested",
      "true",
    );
  });
});

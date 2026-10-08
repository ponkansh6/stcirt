import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PresentationPage from "@/app/presentation/page";

const authState = vi.hoisted(() => ({
  configured: true,
  verifySession: vi.fn(() => true),
  redirect: vi.fn((destination: string): never => {
    throw new Error(`REDIRECT:${destination}`);
  }),
}));

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

vi.mock("next/navigation", () => ({
  redirect: authState.redirect,
}));

vi.mock("@/lib/presentation/admin-auth", () => ({
  ADMIN_PRESENTATION_COOKIE: "stcirt_admin_presentation",
  isAdminPresentationAuthConfigured: () => authState.configured,
  verifyAdminPresentationSession: authState.verifySession,
}));

describe("presentation page entry", () => {
  beforeEach(() => {
    authState.configured = true;
    authState.verifySession.mockReset().mockReturnValue(true);
    authState.redirect.mockClear();
  });

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

  it("redirects presenter requests when authentication is not configured", async () => {
    authState.configured = false;

    await expect(
      PresentationPage({ searchParams: Promise.resolve({ presenter: "1" }) }),
    ).rejects.toThrow("REDIRECT:/admin/presentation");

    expect(authState.redirect).toHaveBeenCalledWith("/admin/presentation");
    expect(authState.verifySession).not.toHaveBeenCalled();
  });

  it("redirects presenter requests with an invalid session", async () => {
    authState.verifySession.mockReturnValue(false);

    await expect(
      PresentationPage({ searchParams: Promise.resolve({ presenter: "1" }) }),
    ).rejects.toThrow("REDIRECT:/admin/presentation");

    expect(authState.redirect).toHaveBeenCalledWith("/admin/presentation");
    expect(authState.verifySession).toHaveBeenCalledWith("valid-session");
  });
});

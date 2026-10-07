import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GlobalHeader from "@/app/GlobalHeader";
import Home from "@/app/page";
import RootLayout, { metadata, viewport } from "@/app/layout";

const navigationState = vi.hoisted(() => ({
  pathname: "/answer",
  redirect: vi.fn((destination: string): never => {
    throw new Error(`REDIRECT:${destination}`);
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
  redirect: navigationState.redirect,
}));

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-geist-test" }),
}));

beforeEach(() => {
  navigationState.pathname = "/answer";
  navigationState.redirect.mockClear();
});

describe("GlobalHeader entry behavior", () => {
  it("renders its navigation landmark on the answer route", () => {
    render(<GlobalHeader />);

    expect(screen.getByRole("banner")).toContainElement(
      document.getElementById("global-header-navigation"),
    );
    expect(document.getElementById("global-header-navigation")).toBeInTheDocument();
  });

  it("does not render a header outside the answer route", () => {
    navigationState.pathname = "/results";

    render(<GlobalHeader />);

    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });
});

describe("root layout entry", () => {
  it("exports the app metadata and viewport settings", () => {
    expect(metadata).toEqual({
      title: "Stcirt - 1ナレッジ1問学習アプリ",
      description: "保存済みの問題を順番に解いて学習するアプリ",
    });
    expect(viewport).toEqual({
      width: "device-width",
      initialScale: 1,
      viewportFit: "cover",
    });
  });

  it("wraps page content in the Japanese document shell", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <main>Page content</main>
      </RootLayout>,
    );
    const document = new DOMParser().parseFromString(markup, "text/html");

    expect(document.documentElement.getAttribute("lang")).toBe("ja");
    expect(document.documentElement.classList.contains("font-geist-test")).toBe(true);
    expect(document.body.classList.contains("min-h-dvh")).toBe(true);
    expect(document.body.classList.contains("flex")).toBe(true);
    expect(document.body.classList.contains("flex-col")).toBe(true);
    expect(document.body.querySelector("#global-header-navigation")).not.toBeNull();
    expect(document.body.querySelector("body > div > main")?.textContent).toBe("Page content");
  });
});

describe("home entry", () => {
  it("redirects visitors to the answer page", () => {
    expect(() => Home()).toThrow("REDIRECT:/answer");
    expect(navigationState.redirect).toHaveBeenCalledWith("/answer");
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ResultsError from "@/app/results/error";

describe("/results error boundary", () => {
  it("shows a concise non-sensitive error and retries the route segment", () => {
    const retry = vi.fn();
    const privateFailure = new Error(
      "private participant data and database credentials",
    ) as Error & {
      digest: string;
    };
    privateFailure.digest = "private-error-digest";
    const { container } = render(<ResultsError error={privateFailure} retry={retry} />);

    expect(screen.getByRole("heading", { name: "結果を読み込めませんでした" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "一時的な問題が発生しました。もう一度お試しください。",
    );
    expect(container.textContent).not.toContain("private participant data");
    expect(container.textContent).not.toContain("database credentials");
    expect(container.textContent).not.toContain("private-error-digest");

    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

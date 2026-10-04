import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoadingState } from "@/components/LoadingState";

describe("LoadingState", () => {
  it("renders default label when none provided", () => {
    render(<LoadingState />);
    expect(screen.getByText("読み込み中...")).toBeInTheDocument();
  });

  it("renders custom label when provided", () => {
    render(<LoadingState label="カスタム読み込み中..." />);
    expect(screen.getByText("カスタム読み込み中...")).toBeInTheDocument();
  });
});

import { afterEach, vi } from "vitest";
import "@testing-library/jest-dom";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

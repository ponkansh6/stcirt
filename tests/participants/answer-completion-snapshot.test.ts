import { beforeEach, describe, expect, it, vi } from "vitest";

const getAnswerSubmissionCompletionVisibilityMock = vi.hoisted(() => vi.fn());
const getParticipantResultStateMock = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/repository/answer-repository", () => ({
  getAnswerSubmissionCompletionVisibility: getAnswerSubmissionCompletionVisibilityMock,
}));
vi.mock("@/lib/db/repository/presentation-repository.reads", () => ({
  getParticipantResultState: getParticipantResultStateMock,
}));

import { getAnswerCompletionSnapshot } from "@/lib/participants/answer-completion-snapshot";

const input = {
  scope: "assisted" as const,
  ownerParticipantId: 42,
  participantId: 77,
  submissionId: "00000000-0000-4000-8000-000000000701",
  revision: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  getParticipantResultStateMock.mockResolvedValue("waiting");
  getAnswerSubmissionCompletionVisibilityMock.mockResolvedValue({
    revision: input.revision,
    resultsVisible: false,
  });
});

describe("getAnswerCompletionSnapshot", () => {
  it("returns only the matching submission's minimal ready state", async () => {
    await expect(getAnswerCompletionSnapshot(input)).resolves.toEqual({
      status: "ready",
      identity: input,
      resultsState: "waiting",
      resultsVisible: false,
    });
    expect(getAnswerSubmissionCompletionVisibilityMock).toHaveBeenCalledWith(
      input.submissionId,
      input.participantId,
    );
  });

  it("returns failed when the current saved revision changed", async () => {
    getAnswerSubmissionCompletionVisibilityMock.mockResolvedValueOnce({
      revision: input.revision + 1,
      resultsVisible: false,
    });

    await expect(getAnswerCompletionSnapshot(input)).resolves.toEqual({
      status: "failed",
      identity: input,
      resultsState: null,
      resultsVisible: null,
    });
  });

  it("returns failed when publication changes between the two reads", async () => {
    getAnswerSubmissionCompletionVisibilityMock.mockResolvedValueOnce({
      revision: input.revision,
      resultsVisible: true,
    });

    await expect(getAnswerCompletionSnapshot(input)).resolves.toEqual({
      status: "failed",
      identity: input,
      resultsState: null,
      resultsVisible: null,
    });
  });

  it("returns failed when either state read fails", async () => {
    getParticipantResultStateMock.mockRejectedValueOnce(new Error("read failed"));

    await expect(getAnswerCompletionSnapshot(input)).resolves.toEqual({
      status: "failed",
      identity: input,
      resultsState: null,
      resultsVisible: null,
    });
  });

  it.each([
    ["visible", true],
    ["unavailable", true],
  ] as const)("preserves the published %s state", async (resultsState, resultsVisible) => {
    getParticipantResultStateMock.mockResolvedValueOnce(resultsState);
    getAnswerSubmissionCompletionVisibilityMock.mockResolvedValueOnce({
      revision: input.revision,
      resultsVisible,
    });

    await expect(getAnswerCompletionSnapshot(input)).resolves.toMatchObject({
      status: "ready",
      resultsState,
      resultsVisible,
    });
  });
});

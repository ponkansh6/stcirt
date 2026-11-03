import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/answers/bootstrap/route";

const findParticipantByIdMock = vi.hoisted(() => vi.fn());
const getLatestAnswerSubmissionMock = vi.hoisted(() => vi.fn());
const getAssistedParticipantMock = vi.hoisted(() => vi.fn());
const getExamQuestionsMock = vi.hoisted(() => vi.fn());
const getAnswerCompletionSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/repository/participant-repository", () => ({
  findParticipantById: findParticipantByIdMock,
}));
vi.mock("@/lib/db/repository/answer-repository", () => ({
  getLatestAnswerSubmission: getLatestAnswerSubmissionMock,
}));
vi.mock("@/lib/db/repository/assisted-participant-repository", () => ({
  getAssistedParticipant: getAssistedParticipantMock,
}));
vi.mock("@/lib/db/repository/question-repository", () => ({
  getExamQuestions: getExamQuestionsMock,
}));
vi.mock("@/lib/participants/answer-completion-snapshot", () => ({
  getAnswerCompletionSnapshot: getAnswerCompletionSnapshotMock,
}));
vi.mock("@/lib/participants/security", () => ({
  getParticipantCookie: vi.fn((request: Request) =>
    request.headers.get("cookie")?.replace("stcirt_participant_session=", ""),
  ),
  verifyParticipantSession: vi.fn((token?: string) =>
    token === "valid-session" ? { id: 42, expiresAt: new Date() } : null,
  ),
}));

import { getLatestAnswerSubmission } from "@/lib/db/repository/answer-repository";
import { getAssistedParticipant } from "@/lib/db/repository/assisted-participant-repository";
import { getExamQuestions } from "@/lib/db/repository/question-repository";
import { findParticipantById } from "@/lib/db/repository/participant-repository";

const owner = { id: 42, name: "Owner" };
const assisted = { id: 77, name: "Assisted" };
const questions = [1, 2, 3, 4, 5].map((id) => ({
  id,
  question: `Question ${id}`,
  choices: id === 5 ? [] : ["A", "B", "C", "D"],
  answerType: id === 5 ? ("freeText" as const) : ("selected" as const),
}));
const savedSubmission = {
  submissionId: "00000000-0000-4000-8000-000000000701",
  revision: 2,
  answers: [],
  restoreIntegrity: { status: "invalid" as const },
};

function request(path: string, authenticated = true) {
  return new Request(`http://localhost${path}`, {
    headers: authenticated ? { Cookie: "stcirt_participant_session=valid-session" } : {},
  });
}

function expectPrivateNoStore(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findParticipantById).mockResolvedValue(owner);
  vi.mocked(getAssistedParticipant).mockResolvedValue(assisted);
  vi.mocked(getLatestAnswerSubmission).mockResolvedValue(null);
  vi.mocked(getExamQuestions).mockResolvedValue(questions);
  getAnswerCompletionSnapshotMock.mockImplementation(async (input) => ({
    status: "ready",
    identity: input,
    resultsState: "waiting",
    resultsVisible: false,
  }));
});

describe("GET /api/answers/bootstrap", () => {
  it.each(["", "?mode=unknown", "?mode=owner&mode=assisted"])(
    "rejects an invalid mode query (%s) with private no-store headers",
    async (query) => {
      const response = await GET(request(`/api/answers/bootstrap${query}`));

      expect(response.status).toBe(400);
      expectPrivateNoStore(response);
      expect(getLatestAnswerSubmission).not.toHaveBeenCalled();
    },
  );

  it("requires a valid cookie session and an existing database participant", async () => {
    const unauthenticated = await GET(request("/api/answers/bootstrap?mode=owner", false));
    expect(unauthenticated.status).toBe(401);
    expectPrivateNoStore(unauthenticated);
    expect(findParticipantById).not.toHaveBeenCalled();

    vi.mocked(findParticipantById).mockResolvedValueOnce(null);
    const missingParticipant = await GET(request("/api/answers/bootstrap?mode=owner"));
    expect(missingParticipant.status).toBe(401);
    expectPrivateNoStore(missingParticipant);
    expect(getLatestAnswerSubmission).not.toHaveBeenCalled();
  });

  it("returns a public question batch only when the owner has no latest submission", async () => {
    const response = await GET(request("/api/answers/bootstrap?mode=owner"));

    expect(response.status).toBe(200);
    expectPrivateNoStore(response);
    const body = await response.json();
    expect(body).toEqual({
      mode: "owner",
      owner,
      participant: owner,
      submission: null,
      completionSnapshot: null,
      questions,
    });
    expect(getLatestAnswerSubmission).toHaveBeenCalledWith(owner.id);
    expect(getExamQuestions).toHaveBeenCalledOnce();

    expect(body.questions[0]).not.toHaveProperty("correctIndex");
    expect(body.questions[0]).not.toHaveProperty("explanation");
  });

  it("omits questions for a saved owner submission", async () => {
    vi.mocked(getLatestAnswerSubmission).mockResolvedValueOnce(savedSubmission);

    const response = await GET(request("/api/answers/bootstrap?mode=owner"));

    expect(response.status).toBe(200);
    expectPrivateNoStore(response);
    await expect(response.json()).resolves.toEqual({
      mode: "owner",
      owner,
      participant: owner,
      submission: savedSubmission,
      completionSnapshot: {
        status: "ready",
        identity: {
          scope: "owner",
          ownerParticipantId: owner.id,
          participantId: owner.id,
          submissionId: savedSubmission.submissionId,
          revision: savedSubmission.revision,
        },
        resultsState: "waiting",
        resultsVisible: false,
      },
    });
    expect(getAnswerCompletionSnapshotMock).toHaveBeenCalledWith({
      scope: "owner",
      ownerParticipantId: owner.id,
      participantId: owner.id,
      submissionId: savedSubmission.submissionId,
      revision: savedSubmission.revision,
    });
    expect(getExamQuestions).not.toHaveBeenCalled();
  });

  it("resolves the assisted target from the owner session, ignoring client participant IDs", async () => {
    const response = await GET(request("/api/answers/bootstrap?mode=assisted&participantId=999"));

    expect(response.status).toBe(200);
    expectPrivateNoStore(response);
    await expect(response.json()).resolves.toMatchObject({
      mode: "assisted",
      owner,
      participant: assisted,
      submission: null,
      completionSnapshot: null,
      questions,
    });
    expect(getAssistedParticipant).toHaveBeenCalledOnce();
    expect(getAssistedParticipant).toHaveBeenCalledWith(owner.id);
    expect(getLatestAnswerSubmission).toHaveBeenCalledOnce();
    expect(getLatestAnswerSubmission).toHaveBeenCalledWith(assisted.id);
    expect(getExamQuestions).toHaveBeenCalledOnce();
  });

  it("returns an assisted saved submission without loading questions", async () => {
    vi.mocked(getLatestAnswerSubmission).mockResolvedValueOnce(savedSubmission);

    const response = await GET(request("/api/answers/bootstrap?mode=assisted"));

    expect(response.status).toBe(200);
    expectPrivateNoStore(response);
    await expect(response.json()).resolves.toEqual({
      mode: "assisted",
      owner,
      participant: assisted,
      submission: savedSubmission,
      completionSnapshot: {
        status: "ready",
        identity: {
          scope: "assisted",
          ownerParticipantId: owner.id,
          participantId: assisted.id,
          submissionId: savedSubmission.submissionId,
          revision: savedSubmission.revision,
        },
        resultsState: "waiting",
        resultsVisible: false,
      },
    });
    expect(getAssistedParticipant).toHaveBeenCalledOnce();
    expect(getAssistedParticipant).toHaveBeenCalledWith(owner.id);
    expect(getLatestAnswerSubmission).toHaveBeenCalledOnce();
    expect(getLatestAnswerSubmission).toHaveBeenCalledWith(assisted.id);
    expect(getExamQuestions).not.toHaveBeenCalled();
  });

  it("keeps a saved submission available when the completion snapshot read fails", async () => {
    vi.mocked(getLatestAnswerSubmission).mockResolvedValueOnce(savedSubmission);
    getAnswerCompletionSnapshotMock.mockResolvedValueOnce({
      status: "failed",
      identity: {
        scope: "owner",
        ownerParticipantId: owner.id,
        participantId: owner.id,
        submissionId: savedSubmission.submissionId,
        revision: savedSubmission.revision,
      },
      resultsState: null,
      resultsVisible: null,
    });

    const response = await GET(request("/api/answers/bootstrap?mode=owner"));

    expect(response.status).toBe(200);
    expectPrivateNoStore(response);
    await expect(response.json()).resolves.toMatchObject({
      submission: savedSubmission,
      completionSnapshot: { status: "failed", resultsState: null, resultsVisible: null },
    });
  });

  it("returns 404 for a missing assisted target instead of treating it as a new submission", async () => {
    vi.mocked(getAssistedParticipant).mockResolvedValueOnce(null);

    const response = await GET(request("/api/answers/bootstrap?mode=assisted"));

    expect(response.status).toBe(404);
    expectPrivateNoStore(response);
    await expect(response.json()).resolves.toEqual({ error: "Assisted participant not found" });
    expect(getLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(getExamQuestions).not.toHaveBeenCalled();
  });

  it("keeps latest-submission failures distinct from an empty submission", async () => {
    vi.mocked(getLatestAnswerSubmission).mockRejectedValueOnce(new Error("database failure"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(request("/api/answers/bootstrap?mode=owner"));

    expect(response.status).toBe(500);
    expectPrivateNoStore(response);
    await expect(response.json()).resolves.toEqual({ error: "Internal server error" });
    expect(getExamQuestions).not.toHaveBeenCalled();
  });

  it("keeps question-repository failures as errors instead of returning a null/new response", async () => {
    vi.mocked(getExamQuestions).mockRejectedValueOnce(new Error("questions unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(request("/api/answers/bootstrap?mode=owner"));

    expect(response.status).toBe(500);
    expectPrivateNoStore(response);
    await expect(response.json()).resolves.toEqual({ error: "Internal server error" });
  });
});

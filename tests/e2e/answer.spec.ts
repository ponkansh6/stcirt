import { test, expect, type Page } from "@playwright/test";
import { makeQuestion } from "../fixtures/question";

const questionFor = (id: number) =>
  makeQuestion({
    id,
    question: `Question ${id}?`,
    choices: id === 5 ? [] : [`Option ${id}A`, `Option ${id}B`, `Option ${id}C`, `Option ${id}D`],
    answerType: id === 5 ? "freeText" : "selected",
  });

type BatchAnswer =
  | { questionId: number; selectedIndex: number }
  | { questionId: number; freeText: string };
type SavedBatchAnswer =
  | { questionId: number; answerKind: "selected"; selectedIndex: number; freeText: null }
  | { questionId: number; answerKind: "freeText"; selectedIndex: null; freeText: string };
type BatchPayload = {
  submissionId: string;
  operationId: string;
  expectedRevision: number;
  answers: BatchAnswer[];
};

async function mockParticipantSession(
  page: Page,
  initialName: string | null = null,
  latestSubmission: {
    submissionId: string;
    revision: number;
    answers: SavedBatchAnswer[];
  } | null = null,
) {
  let activeLatestSubmission = latestSubmission;
  let activeParticipant = initialName ? { id: 17, name: initialName } : null;
  let activeCredentials = initialName ? { name: initialName, pin: "0123" } : null;
  const loginRequests: unknown[] = [];
  let logoutRequests = 0;
  let nextParticipantId = 18;

  await page.route("**/api/answers/latest", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ submission: activeLatestSubmission }),
    });
  });

  await page.route("**/api/participants/session", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ participant: activeParticipant }),
      });
      return;
    }
    if (method === "POST") {
      const body = route.request().postDataJSON();
      loginRequests.push(body);
      const sameCredentials =
        activeCredentials !== null &&
        activeCredentials.name === body.name &&
        activeCredentials.pin === body.pin;
      activeParticipant = sameCredentials
        ? activeParticipant
        : { id: nextParticipantId++, name: body.name };
      activeCredentials = { name: body.name, pin: body.pin };
      await page.context().addCookies([
        {
          name: "stcirt_participant_session",
          value: "mock-session",
          url: new URL(route.request().url()).origin,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "set-cookie": "stcirt_participant_session=mock-session; Path=/; HttpOnly; SameSite=Lax",
        },
        body: JSON.stringify({
          participant: activeParticipant,
          expiresAt: "2030-01-01T00:00:00.000Z",
        }),
      });
      return;
    }
    if (method === "DELETE") {
      logoutRequests += 1;
      activeParticipant = null;
      activeCredentials = null;
      await route.fulfill({
        status: 204,
        headers: {
          "set-cookie": "stcirt_participant_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
        },
      });
      return;
    }
    await route.fallback();
  });

  return {
    loginRequests,
    setLatestSubmission(submission: typeof latestSubmission) {
      activeLatestSubmission = submission;
    },
    get logoutRequests() {
      return logoutRequests;
    },
  };
}

async function mockQuestions(page: Page, requests: string[] = []) {
  await page.route("**/api/questions/next*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${url.pathname}${url.search}`);
    const afterId = Number(url.searchParams.get("afterId") ?? 0);
    if (afterId >= 5) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "No question" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(questionFor(afterId + 1)),
    });
  });
}

async function signIn(page: Page, name = "Test Participant", pin = "0123") {
  await page.getByLabel("お名前").fill(name);
  await page.getByLabel("4桁PIN").fill(pin);
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(
    page.getByRole("heading", { name: /受検票|問題が足りません|問題を読み込めませんでした/ }),
  ).toBeVisible();
}

async function startQuiz(page: Page) {
  await expect(page.getByRole("heading", { name: "Question 1?" })).toBeVisible();
}

async function selectRadio(page: Page, name: RegExp) {
  const radio = page.getByRole("radio", { name });
  await radio.locator("xpath=ancestor::label").click();
  await expect(radio).toBeChecked();
}

async function answerQuestion(page: Page, id: number, choice: string) {
  if (id === 5) {
    await page.getByRole("textbox", { name: "回答（1000字以内）" }).fill(`自由記載${choice}`);
  } else {
    await selectRadio(page, new RegExp(`Option ${id}${choice}`));
  }
}

test("direct answer access requires name and four digit PIN before loading the quiz", async ({
  page,
}) => {
  const { loginRequests } = await mockParticipantSession(page);
  const requests: string[] = [];
  await mockQuestions(page, requests);

  await page.goto("/answer");
  await expect(page.getByRole("heading", { name: "参加して検定を受ける" })).toBeVisible();
  const sharedHeader = page.locator("body > header");
  await expect(sharedHeader.getByRole("link", { name: "ホームへ" })).toHaveCount(0);
  await expect(page.getByLabel("4桁PIN")).toHaveAttribute("inputmode", "numeric");
  await expect(page.getByLabel("4桁PIN")).toHaveAttribute("pattern", "[0-9]{4}");
  await signIn(page, "Aki", "0123");

  expect(loginRequests).toEqual([{ name: "Aki", pin: "0123" }]);
  expect(requests).toEqual([
    "/api/questions/next",
    "/api/questions/next?afterId=1",
    "/api/questions/next?afterId=2",
    "/api/questions/next?afterId=3",
    "/api/questions/next?afterId=4",
  ]);
  await startQuiz(page);
  await expect(page.getByRole("heading", { name: "Question 1?" })).toBeVisible();
  expect(requests).toEqual([
    "/api/questions/next",
    "/api/questions/next?afterId=1",
    "/api/questions/next?afterId=2",
    "/api/questions/next?afterId=3",
    "/api/questions/next?afterId=4",
  ]);
});

test("direct answer access explains when five questions are unavailable", async ({ page }) => {
  await mockParticipantSession(page);
  await page.route("**/api/questions/next*", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "No question" }),
    });
  });

  await page.goto("/answer");
  await signIn(page);
  await expect(page.getByRole("heading", { name: "問題が足りません" })).toBeVisible();
  await expect(
    page.getByText(
      "全5問をそろえられないため、検定を開始できません。問題が5問そろったら、もう一度お試しください。",
    ),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "ホームへ" })).toHaveCount(0);
});

test("keeps choices local, blocks an incomplete batch, then confirms all five with the participant cookie", async ({
  page,
}) => {
  await mockParticipantSession(page);
  await mockQuestions(page);
  const submitted: Array<{ body: BatchPayload; cookie: string | undefined }> = [];
  await page.route("**/api/answers/batch", async (route) => {
    const body = route.request().postDataJSON() as BatchPayload;
    submitted.push({
      body,
      cookie: route.request().headers().cookie,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ submissionId: body.submissionId, revision: 1 }),
    });
  });

  await page.goto("/answer");
  await signIn(page, "Aki");
  await startQuiz(page);
  await expect(page.getByRole("heading", { name: "Question 1?" })).toBeVisible();
  const confirm = page.getByRole("button", { name: "5問の回答を確定する" });
  await expect(confirm).toBeDisabled();
  await answerQuestion(page, 1, "B");
  expect(submitted).toHaveLength(0);
  for (let id = 2; id <= 5; id += 1) await answerQuestion(page, id, "B");
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page.getByRole("heading", { name: "回答完了" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "設問へ移動" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "ホームへ" })).toHaveCount(0);
  await expect(page.getByText(/正解！|不正解|解説:|正答率|合格/)).toHaveCount(0);
  expect(submitted).toHaveLength(1);
  expect(submitted[0].body).toMatchObject({ expectedRevision: 0 });
  expect(submitted[0].body.answers).toHaveLength(5);
  expect(
    submitted[0].body.answers.map((answer: { questionId: number }) => answer.questionId),
  ).toEqual([1, 2, 3, 4, 5]);
  expect(submitted[0].body.answers.filter((answer) => "selectedIndex" in answer)).toHaveLength(4);
  expect(submitted[0].body.answers[4]).toMatchObject({ questionId: 5, freeText: "自由記載B" });
  expect(submitted[0].cookie).toContain("stcirt_participant_session=mock-session");
});

test("locks the full answer sheet while its batch request is pending", async ({ page }) => {
  await mockParticipantSession(page);
  await mockQuestions(page);

  let answerCalls = 0;
  let markRequestStarted!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  let releaseAnswer!: () => void;
  const answerGate = new Promise<void>((resolve) => {
    releaseAnswer = resolve;
  });
  await page.route("**/api/answers/batch", async (route) => {
    const body = route.request().postDataJSON() as BatchPayload;
    answerCalls += 1;
    markRequestStarted();
    await answerGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ submissionId: body.submissionId, revision: 1 }),
    });
  });

  await page.goto("/answer");
  await signIn(page);
  await startQuiz(page);
  for (let id = 1; id <= 5; id += 1) await answerQuestion(page, id, "B");
  const confirm = page.getByRole("button", { name: "5問の回答を確定する" });
  await confirm.click();
  await requestStarted;

  const submittingButton = page.getByRole("button", { name: "回答を送信しています…" });
  await expect(submittingButton).toBeFocused();
  await expect(submittingButton).toHaveAttribute("aria-disabled", "true");
  await expect(submittingButton).toHaveAccessibleName("回答を送信しています…");
  await expect(submittingButton).not.toHaveAttribute("disabled");
  await expect(submittingButton).not.toHaveAttribute("aria-busy");
  await expect(page.getByRole("status")).toHaveText("回答を送信しています…");
  await expect(page.getByRole("radio", { name: /Option 1B/ })).toBeChecked();
  await submittingButton.evaluate((button: HTMLButtonElement) => button.click());
  expect(answerCalls).toBe(1);

  releaseAnswer();
  await expect(page.getByRole("heading", { name: "回答完了" })).toBeVisible();
});

test("supports native radio keyboard operation and reflows long Japanese text at 320px", async ({
  page,
}) => {
  // This sets a 320 CSS px viewport; browser zoom at 200% needs a real-browser check.
  await page.setViewportSize({ width: 320, height: 900 });
  await mockParticipantSession(page);
  await page.route("**/api/questions/next*", async (route) => {
    const url = new URL(route.request().url());
    const afterId = Number(url.searchParams.get("afterId") ?? 0);
    const id = afterId + 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        makeQuestion({
          id,
          question: "長文の設問です。".repeat(20),
          choices:
            id === 5
              ? []
              : [
                  "長文の選択肢Aです。".repeat(20),
                  "長文の選択肢Bです。".repeat(20),
                  "長文の選択肢Cです。".repeat(20),
                  "長文の選択肢Dです。".repeat(20),
                ],
          answerType: id === 5 ? "freeText" : "selected",
        }),
      ),
    });
  });

  await page.goto("/answer");
  await signIn(page);

  const group = page.locator("#question-1 fieldset");
  await expect(group).toBeVisible();
  await expect(group.getByRole("radio")).toHaveCount(4);
  const radios = page.getByRole("radio");
  await expect(radios).toHaveCount(16);
  await expect(page.getByRole("textbox", { name: "回答（1000字以内）" })).toBeVisible();
  const firstRadio = radios.nth(0);
  await expect(firstRadio).toHaveAttribute("name", "answer-1");
  await expect(firstRadio).toHaveAttribute("value", "0");
  await expect(firstRadio).toHaveAccessibleName(/A\. 長文の選択肢[A-D]です/);
  const firstRadioId = await firstRadio.getAttribute("id");
  expect(firstRadioId).toBeTruthy();
  await expect(page.locator(`label[for="${firstRadioId}"]`)).toHaveCount(1);
  const radioNames = await radios.evaluateAll((inputs) => [
    ...new Set(inputs.map((input) => (input as HTMLInputElement).name)),
  ]);
  expect(radioNames).toEqual(["answer-1", "answer-2", "answer-3", "answer-4"]);

  const navigation = page.getByRole("navigation", { name: "設問へ移動" });
  await firstRadio.locator("xpath=ancestor::label").click();
  await expect(firstRadio).toBeChecked();
  await expect(navigation.getByRole("link", { name: "第1問へ移動、回答済み" })).toBeVisible();
  const navControls = navigation.getByRole("link");
  for (let index = 0; index < 5; index += 1) {
    const box = await navControls.nth(index).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
  }

  await firstRadio.focus();
  await page.keyboard.press("Space");
  await expect(firstRadio).toBeChecked();
  const firstRow = firstRadio.locator("xpath=..");
  const radioFocusRing = await firstRow.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(radioFocusRing).not.toBe("none");

  await expect(navigation.locator("xpath=ancestor::header")).toBeVisible();
  await expect(page.getByRole("link", { name: "ホームへ" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "設問へ移動" })).toHaveCount(1);
  await expect(navigation.getByRole("list").getByRole("listitem")).toHaveCount(5);
  await expect(navigation.locator("a, button, input")).toHaveCount(5);
  const targetHeading = page.locator("#question-5 h2");
  await navigation.getByRole("link", { name: "第5問へ移動、未回答" }).click();
  await expect(targetHeading).toBeFocused();
  const headingTop = await targetHeading.evaluate((heading) => heading.getBoundingClientRect().top);
  const stickyBottom = await page
    .locator("body > header")
    .evaluate((header) => header.getBoundingClientRect().bottom);
  expect(headingTop).toBeGreaterThanOrEqual(stickyBottom);
  await expect(firstRadio).toBeChecked();

  const [rowBox, confirmBox] = await Promise.all([
    firstRow.boundingBox(),
    page.getByRole("button", { name: "5問の回答を確定する" }).boundingBox(),
  ]);
  expect(rowBox?.height).toBeGreaterThanOrEqual(44);
  expect(confirmBox?.height).toBeGreaterThanOrEqual(44);
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(Math.max(widths.document, widths.body)).toBeLessThanOrEqual(widths.viewport);
});

test("shows neutral completion after one batch and can reopen the same answer set for correction", async ({
  page,
}) => {
  await mockParticipantSession(page);
  await mockQuestions(page);
  const submissions: BatchPayload[] = [];
  await page.route("**/api/answers/batch", async (route) => {
    const request = route.request().postDataJSON() as BatchPayload;
    submissions.push(request);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        submissionId: request.submissionId,
        revision: submissions.length,
      }),
    });
  });

  await page.goto("/answer");
  await signIn(page);
  await startQuiz(page);
  for (let id = 1; id <= 5; id += 1) await answerQuestion(page, id, "A");
  await page.getByRole("button", { name: "5問の回答を確定する" }).click();

  await expect(page.getByRole("heading", { name: "回答完了" })).toBeVisible();
  await expect(page.getByText("全5問の回答を記録しました。")).toBeVisible();
  await expect(page.getByRole("button", { name: "回答を修正する" })).toBeVisible();
  await expect(page.getByText(/正解！|不正解|解説:|正答率|合格|得点/)).toHaveCount(0);
  expect(submissions).toHaveLength(1);
  await page.getByRole("button", { name: "回答を修正する" }).click();
  await expect(page.getByRole("button", { name: "修正内容を確定する" })).toBeEnabled();
  expect(await page.getByRole("radio", { name: /Option 1A/ }).isChecked()).toBe(true);
});

test("revisits a saved submission, restores it, and posts a correction to the same revisioned submission", async ({
  page,
}) => {
  const submissionId = "00000000-0000-4000-8000-000000000023";
  const savedAnswers: SavedBatchAnswer[] = [
    ...[1, 2, 3, 4].map((questionId) => ({
      questionId,
      answerKind: "selected" as const,
      selectedIndex: questionId - 1,
      freeText: null,
    })),
    {
      questionId: 5,
      answerKind: "freeText",
      selectedIndex: null,
      freeText: "保存済みの回答です。",
    },
  ];
  await mockParticipantSession(page, "Returning Participant", {
    submissionId,
    revision: 2,
    answers: savedAnswers,
  });
  await mockQuestions(page);
  const updates: BatchPayload[] = [];
  await page.route("**/api/answers/batch", async (route) => {
    updates.push(route.request().postDataJSON() as BatchPayload);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ submissionId, revision: 3 }),
    });
  });

  await page.goto("/answer");
  await expect(page.getByRole("heading", { name: "回答完了" })).toBeVisible();
  const edit = page.getByRole("button", { name: "回答を修正する" });
  await expect(edit).toBeEnabled();
  await edit.click();
  await expect(page.locator("#question-1 input[type=radio]:checked")).toHaveCount(1);
  const response = page.getByRole("textbox", { name: "回答（1000字以内）" });
  await expect(response).toHaveValue("保存済みの回答です。");

  await answerQuestion(page, 1, "B");
  await response.fill("修正後の回答です。");
  await page.getByRole("button", { name: "修正内容を確定する" }).click();
  await expect(page.getByRole("heading", { name: "回答完了" })).toBeVisible();
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({
    submissionId,
    expectedRevision: 2,
  });
  expect(updates[0]?.answers.find((answer) => answer.questionId === 2)).toMatchObject({
    questionId: 2,
    selectedIndex: 1,
  });
  expect(updates[0]?.answers.find((answer) => answer.questionId === 5)).toEqual({
    questionId: 5,
    freeText: "修正後の回答です。",
  });
});

test("restores the latest saved answers after a same-participant re-login on correction 401", async ({
  page,
}) => {
  const initialSubmissionId = "00000000-0000-4000-8000-000000000031";
  const latestSubmissionId = "00000000-0000-4000-8000-000000000032";
  const savedAnswers = (questionOneIndex: number, freeText: string): SavedBatchAnswer[] => [
    ...[1, 2, 3, 4].map((questionId) => ({
      questionId,
      answerKind: "selected" as const,
      selectedIndex: questionId === 1 ? questionOneIndex : questionId - 1,
      freeText: null,
    })),
    {
      questionId: 5,
      answerKind: "freeText" as const,
      selectedIndex: null,
      freeText,
    },
  ];
  const session = await mockParticipantSession(page, "Returning Participant", {
    submissionId: initialSubmissionId,
    revision: 2,
    answers: savedAnswers(0, "確認済みの保存回答です。"),
  });
  await mockQuestions(page);
  let answerCalls = 0;
  const posts: BatchPayload[] = [];
  await page.route("**/api/answers/batch", async (route) => {
    answerCalls += 1;
    posts.push(route.request().postDataJSON() as BatchPayload);
    session.setLatestSubmission({
      submissionId: latestSubmissionId,
      revision: 3,
      answers: savedAnswers(2, "再認証後の保存回答です。"),
    });
    if (answerCalls > 1) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ submissionId: latestSubmissionId, revision: 4 }),
      });
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ message: "Authentication required" }),
    });
  });

  await page.goto("/answer");
  await expect(page.getByRole("heading", { name: "回答完了" })).toBeVisible();
  await page.getByRole("button", { name: "回答を修正する" }).click();
  await answerQuestion(page, 1, "B");
  await page
    .getByRole("textbox", { name: "回答（1000字以内）" })
    .fill("送信に失敗した未保存の回答。");
  await page.getByRole("button", { name: "修正内容を確定する" }).click();
  await expect(page.getByRole("heading", { name: "参加状態の確認が必要です" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "回答（1000字以内）" })).toHaveValue(
    "送信に失敗した未保存の回答。",
  );

  await page.getByLabel("4桁PIN").fill("0123");
  await page.getByRole("button", { name: "再ログインする" }).click();
  await expect(page.getByRole("heading", { name: "回答完了" })).toBeVisible();
  expect(session.loginRequests).toEqual([{ name: "Returning Participant", pin: "0123" }]);
  expect(answerCalls).toBe(1);

  await page.getByRole("button", { name: "回答を修正する" }).click();
  await expect(page.locator("#question-1 input[type=radio]:checked")).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "回答（1000字以内）" })).toHaveValue(
    "再認証後の保存回答です。",
  );
  await page.getByRole("button", { name: "修正内容を確定する" }).click();
  await expect(page.getByRole("heading", { name: "回答完了" })).toBeVisible();
  expect(posts[1]).toMatchObject({ submissionId: latestSubmissionId, expectedRevision: 3 });
  expect(posts[1]?.answers.find((answer) => answer.questionId === 1)).toEqual({
    questionId: 1,
    selectedIndex: 2,
  });
  expect(posts[1]?.answers.find((answer) => answer.questionId === 5)).toEqual({
    questionId: 5,
    freeText: "再認証後の保存回答です。",
  });
});

test("loads the canonical batch after a revision conflict while preserving the local draft", async ({
  page,
}) => {
  await mockParticipantSession(page);
  await mockQuestions(page);
  const posts: BatchPayload[] = [];
  let savedAnswers: SavedBatchAnswer[] = [];
  let canonicalSubmissionId: string | undefined;
  await page.route("**/api/answers/batch**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          submissionId: canonicalSubmissionId,
          revision: 2,
          answers: savedAnswers,
        }),
      });
      return;
    }
    const body = request.postDataJSON() as BatchPayload;
    if (posts.length === 0) {
      canonicalSubmissionId = body.submissionId;
      savedAnswers = body.answers.map((answer) =>
        "freeText" in answer
          ? { ...answer, answerKind: "freeText" as const, selectedIndex: null }
          : { ...answer, answerKind: "selected" as const, freeText: null },
      );
      posts.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ submissionId: body.submissionId, revision: 1 }),
      });
      return;
    }
    if (posts.length === 1) {
      posts.push(body);
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ message: "Revision conflict" }),
      });
      return;
    }
    posts.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ submissionId: body.submissionId, revision: 3 }),
    });
  });

  await page.goto("/answer");
  await signIn(page);
  await startQuiz(page);
  for (let id = 1; id <= 5; id += 1) await answerQuestion(page, id, "A");
  await page.getByRole("button", { name: "5問の回答を確定する" }).click();
  await expect(page.getByRole("heading", { name: "回答完了" })).toBeVisible();

  await page.getByRole("button", { name: "回答を修正する" }).click();
  const q1Alternate = page.getByRole("radio", { name: /Option 1B/ });
  await selectRadio(page, /Option 1B/);
  await page.getByRole("button", { name: "修正内容を確定する" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "保存済み回答が更新されています。" }),
  ).toContainText("回答案は保持しています。内容を確認して、もう一度確定してください。");
  await expect(q1Alternate).toBeChecked();
  expect(posts).toHaveLength(2);
  expect(posts[1]?.submissionId).toBe(posts[0]?.submissionId);
  expect(posts[1]?.expectedRevision).toBe(1);
  const originalFirstAnswer = posts[0]?.answers[0];
  const revisedFirstAnswer = posts[1]?.answers[0];
  if (
    !originalFirstAnswer ||
    !revisedFirstAnswer ||
    !("selectedIndex" in originalFirstAnswer) ||
    !("selectedIndex" in revisedFirstAnswer)
  ) {
    throw new Error("Expected the first answer to be a selected answer");
  }
  expect(revisedFirstAnswer.selectedIndex).not.toBe(originalFirstAnswer.selectedIndex);

  const editedAnswers = posts[1]!.answers;
  await page.getByRole("button", { name: "修正内容を確定する" }).click();
  await expect(page.getByRole("heading", { name: "回答完了" })).toBeVisible();
  expect(posts).toHaveLength(3);
  expect(posts[2]?.expectedRevision).toBe(2);
  expect(posts[2]?.answers).toEqual(editedAnswers);
});

test("retains all choices through reauthentication and resubmits the batch only after an explicit action", async ({
  page,
}) => {
  await mockParticipantSession(page, "Aki");
  await mockQuestions(page);
  let answerCalls = 0;
  await page.route("**/api/answers/batch", async (route) => {
    answerCalls += 1;
    if (answerCalls === 1) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ message: "Authentication required" }),
      });
      return;
    }
    const body = route.request().postDataJSON() as BatchPayload;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ submissionId: body.submissionId, revision: 1 }),
    });
  });

  await page.goto("/answer");
  await expect(page.getByRole("heading", { name: "受検票" })).toBeVisible();
  await startQuiz(page);
  for (let id = 1; id <= 5; id += 1) await answerQuestion(page, id, "C");
  await page.getByRole("button", { name: "5問の回答を確定する" }).click();
  await expect(page.getByRole("heading", { name: "参加状態の確認が必要です" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Option 1C/ })).toBeChecked();

  await page.getByLabel("4桁PIN").fill("0123");
  await page.getByRole("button", { name: "再ログインする" }).click();
  await expect(page.getByRole("button", { name: "同じ回答を再送する" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Option 1C/ })).toBeChecked();
  expect(answerCalls).toBe(1);
  await page.getByRole("button", { name: "同じ回答を再送する" }).click();
  await expect(page.getByRole("heading", { name: "回答完了" })).toBeVisible();
  expect(answerCalls).toBe(2);
});

test("retries only missing questions after a prefetch network failure", async ({ page }) => {
  await mockParticipantSession(page);
  let fail = true;
  const requests: string[] = [];
  await page.route("**/api/questions/next*", async (route) => {
    const url = new URL(route.request().url());
    const afterId = Number(url.searchParams.get("afterId") ?? 0);
    requests.push(`${url.pathname}${url.search}`);
    if (afterId === 2 && fail) {
      fail = false;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary failure" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(questionFor(afterId + 1)),
    });
  });

  await page.goto("/answer");
  await signIn(page);
  await expect(page.getByRole("button", { name: "不足分を再読み込み" })).toBeVisible();
  await expect(page.getByRole("link", { name: "ホームへ" })).toHaveCount(0);
  await page.getByRole("button", { name: "不足分を再読み込み" }).click();
  await expect(page.getByRole("heading", { name: "Question 1?" })).toBeVisible();
  expect(requests).toEqual([
    "/api/questions/next",
    "/api/questions/next?afterId=1",
    "/api/questions/next?afterId=2",
    "/api/questions/next?afterId=2",
    "/api/questions/next?afterId=3",
    "/api/questions/next?afterId=4",
  ]);
});

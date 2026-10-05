"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import styles from "./presentation-admin.module.css";

type State =
  | "not_started"
  | "question"
  | "answer"
  | "podium_preview"
  | "third"
  | "second"
  | "first"
  | "finished";
type Action = "start" | "advance" | "previous" | "hide" | "show" | "setMode";
type PresentationMode = "full" | "short";

type Question = {
  id: string | number;
  question: string;
  choices: string[];
  correctAnswer: string;
  explanation: string | null;
};

type Entry = { displayName: string; score: number; rank: number };
type AdminData = {
  state: State;
  version: number;
  questionIndex: number;
  questionCount: number;
  questions: Question[];
  entries: Entry[];
  projectionHidden: boolean;
  presentationMode: PresentationMode;
};

const STAGE_LABEL: Record<State, string> = {
  not_started: "待機中",
  question: "設問のおさらい",
  answer: "正解・解説",
  podium_preview: "結果発表の予告",
  third: "第3位の発表",
  second: "第2位の発表",
  first: "第1位の発表",
  finished: "祝福・終了",
};

const NEXT_LABEL: Record<State, string> = {
  not_started: "発表を始める",
  question: "正解を発表する",
  answer: "次へ進む",
  podium_preview: "第3位を発表する",
  third: "第2位を発表する",
  second: "第1位を発表する",
  first: "締めの画面へ進む",
  finished: "発表は終了しました",
};

function messageForApiError(error: string) {
  const messages: Record<string, string> = {
    "Invalid PIN": "PIN が一致しません。入力内容をご確認ください。",
    "Invalid request origin": "安全な接続を確認できませんでした。ページを再読み込みしてください。",
    "Admin sign-in is unavailable":
      "管理者ログインが利用できません。サーバー設定を確認してください。",
    "Admin presentation is unavailable":
      "発表機能を利用できません。サーバー設定と接続を確認してください。",
    "Presentation has already started":
      "発表はすでに開始されています。最新の進行状態を読み込みました。",
    "Presentation has not started":
      "発表はまだ開始されていません。最新の進行状態を読み込みました。",
    "Presentation cannot advance from its current state":
      "この段階からは進行できません。最新の進行状態を読み込みました。",
    "Presentation state changed concurrently":
      "別の操作で進行が更新されました。最新状態を読み込みました。",
    "Presentation cannot go back from its current state":
      "この段階からは戻れません。最新の進行状態を読み込みました。",
    "Presentation is already at its first state": "これ以上前の段階はありません。",
    "Presentation is already hidden": "投影画面はすでに隠れています。最新状態を読み込みました。",
    "Presentation is already visible":
      "投影画面はすでに表示されています。最新状態を読み込みました。",
    "Invalid request": "入力を確認できませんでした。ページを再読み込みしてください。",
  };
  return messages[error] ?? error;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? messageForApiError(payload.error)
        : "通信に失敗しました。接続を確認して、もう一度お試しください。";
    throw new Error(detail);
  }
  return payload as T;
}

export default function PresentationAdmin() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [pin, setPin] = useState("");
  const [data, setData] = useState<AdminData | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);
  const refreshing = useRef(false);

  const updateData = useCallback((next: AdminData) => {
    setData((current) => (!current || next.version >= current.version ? next : current));
  }, []);

  const loadState = useCallback(async () => {
    const session = await requestJson<{ authenticated: boolean }>("/api/admin/session");
    setAuthenticated(session.authenticated);
    if (!session.authenticated) {
      setData(null);
      setLoading(false);
      return;
    }
    const next = await requestJson<AdminData>("/api/admin/presentation");
    updateData(next);
    setLoading(false);
  }, [updateData]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (refreshing.current || inFlight.current) return;
      refreshing.current = true;
      try {
        await loadState();
        if (active)
          setMessage((previous) => (previous?.startsWith("同期できません") ? null : previous));
      } catch (error) {
        if (active) {
          setLoading(false);
          setMessage(
            error instanceof Error
              ? `同期できませんでした。${error.message}`
              : "同期できませんでした。",
          );
        }
      } finally {
        refreshing.current = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (!inFlight.current) void refresh();
    }, 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [loadState]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await requestJson("/api/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      setPin("");
      await loadState();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ログインできませんでした。");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function handleLogout() {
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await requestJson("/api/admin/session", { method: "DELETE" });
      setAuthenticated(false);
      setData(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ログアウトできませんでした。");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function operate(action: Action, mode?: PresentationMode) {
    if (!data || inFlight.current) return;
    if (action === "start" && data.state !== "not_started") return;
    if (action === "advance" && data.state === "finished") return;
    if (
      action === "previous" &&
      (data.state === "not_started" ||
        (data.state === "question" && data.questionIndex === 0) ||
        (data.state === "podium_preview" && data.questionCount === 0))
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    const operationId = crypto.randomUUID();
    const body =
      action === "setMode"
        ? { operationId, action, mode: mode ?? data.presentationMode }
        : { operationId, action };
    try {
      const next = await requestJson<AdminData>("/api/admin/presentation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      updateData(next);
      try {
        const latest = await requestJson<AdminData>("/api/admin/presentation");
        updateData(latest);
      } catch {
        setMessage(
          "操作は反映されましたが、最新状態を取得できませんでした。接続を確認しています。",
        );
      }
    } catch (error) {
      // A response can be lost after the server commits; restore its durable state before retrying.
      try {
        const recovered = await requestJson<AdminData>("/api/admin/presentation");
        updateData(recovered);
      } catch {
        // Keep the current display and report the original action failure.
      }
      setMessage(error instanceof Error ? error.message : "進行を更新できませんでした。");
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  const currentQuestion = data?.questions[data.questionIndex];
  const canGoPrevious = Boolean(
    data &&
    data.state !== "not_started" &&
    !(data.state === "question" && data.questionIndex === 0) &&
    !(data.state === "podium_preview" && data.questionCount === 0),
  );
  const nextHint = useMemo(() => {
    if (!data) return "";
    if (data.state === "not_started") return "投影画面に待機案内が表示されます。";
    if (data.state === "question") return "次に正解とエピソードを表示します。";
    if (data.state === "answer") {
      return data.questionIndex + 1 < data.questionCount
        ? `次は第${data.questionIndex + 2}問です。`
        : "次はランキング発表の予告です。受賞者名はまだ表示されません。";
    }
    if (data.state === "podium_preview" || data.state === "third" || data.state === "second") {
      const rankLimit = data.state === "podium_preview" ? 3 : data.state === "third" ? 2 : 1;
      const upcoming = data.entries.find((entry) => entry.rank <= rankLimit);
      const upcomingLabel = upcoming ? `${upcoming.rank}位の方` : "締めの画面";
      return `次の操作で${upcomingLabel}を表示します。授与や拍手の時間を取ってから進めてください。`;
    }
    if (data.state === "first") return "第1位の発表画面を保持できます。次の操作で締めに進みます。";
    return "ご参加への感謝を表示しています。";
  }, [data]);

  if (loading && authenticated === null) {
    return (
      <main className={styles.shell}>
        <div className={styles.loading} role="status">
          管理者セッションを確認しています…
        </div>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className={styles.shell}>
        <section className={styles.loginCard} aria-labelledby="admin-title">
          <p className={styles.eyebrow}>STCIRT · HOST CONSOLE</p>
          <h1 id="admin-title">披露宴 発表操作</h1>
          <p className={styles.loginIntro}>司会者用 PIN を入力して、発表の進行画面に入ります。</p>
          <form className={styles.loginForm} onSubmit={handleLogin}>
            <label htmlFor="admin-pin">管理者 PIN</label>
            <input
              id="admin-pin"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              required
              aria-describedby={message ? "admin-message" : undefined}
            />
            <button
              className={styles.primaryButton}
              type="submit"
              disabled={busy || pin.length === 0}
            >
              {busy ? "確認中…" : "管理画面に入る"}
            </button>
          </form>
          {message && (
            <p id="admin-message" className={styles.error} role="alert">
              {message}
            </p>
          )}
          <p className={styles.loginFoot}>
            投影用画面は <code>/presentation</code> です。
          </p>
        </section>
      </main>
    );
  }

  if (!data) {
    return (
      <main className={styles.shell}>
        <div className={styles.loading} role={message ? "alert" : "status"}>
          {message ?? "発表データを読み込んでいます…"}
        </div>
      </main>
    );
  }

  const currentRank =
    data.state === "third" ? 3 : data.state === "second" ? 2 : data.state === "first" ? 1 : null;
  const currentEntries =
    currentRank === null ? [] : data.entries.filter((entry) => entry.rank === currentRank);
  const nextPodiumRank =
    data.state === "podium_preview"
      ? 3
      : data.state === "third"
        ? 2
        : data.state === "second"
          ? 1
          : null;
  const nextPodiumEntry =
    nextPodiumRank === null ? null : data.entries.find((entry) => entry.rank <= nextPodiumRank);
  const nextStage = nextPodiumEntry
    ? STAGE_LABEL[
        nextPodiumEntry.rank === 3 ? "third" : nextPodiumEntry.rank === 2 ? "second" : "first"
      ]
    : "締めの画面";
  const questionVisible = data.state === "question" || data.state === "answer";
  const answerVisible = data.state === "answer";

  return (
    <main className={styles.shell}>
      <div className={styles.console}>
        <header className={styles.topbar}>
          <div>
            <p className={styles.eyebrow}>STCIRT · HOST CONSOLE</p>
            <h1>披露宴 発表操作</h1>
          </div>
          <div className={styles.topActions}>
            <a href="/presentation" target="_blank" rel="noreferrer">
              投影画面を開く ↗
            </a>
            <button
              type="button"
              className={styles.quietButton}
              onClick={() => void operate(data.projectionHidden ? "show" : "hide")}
              disabled={busy}
            >
              {data.projectionHidden ? "投影画面を表示する" : "投影画面を隠す"}
            </button>
            <button
              type="button"
              className={styles.quietButton}
              onClick={handleLogout}
              disabled={busy}
            >
              ログアウト
            </button>
          </div>
        </header>

        {message && (
          <p className={styles.notice} role="status">
            {message}
          </p>
        )}

        <div className={styles.workspace}>
          <section className={styles.nowPanel} aria-labelledby="stage-heading">
            <div className={styles.stageHead}>
              <div>
                <p className={styles.overline}>NOW ON SCREEN</p>
                <h2 id="stage-heading">{STAGE_LABEL[data.state]}</h2>
              </div>
              <span className={styles.liveBadge} data-hidden={data.projectionHidden}>
                <span aria-hidden="true" />
                {data.projectionHidden ? "投影画面は非表示" : "投影画面を表示中"}
              </span>
            </div>

            {questionVisible && currentQuestion && (
              <div className={styles.questionBlock}>
                <p className={styles.questionCount}>
                  QUESTION {data.questionIndex + 1} <span>/ {data.questionCount}</span>
                </p>
                <h3>{currentQuestion.question}</h3>
                <ol className={styles.choices}>
                  {currentQuestion.choices.map((choice, index) => (
                    <li
                      key={`${index}-${choice}`}
                      className={
                        answerVisible && choice === currentQuestion.correctAnswer
                          ? styles.correctChoice
                          : ""
                      }
                    >
                      <span>{String.fromCharCode(65 + index)}</span>
                      {choice}
                      {answerVisible && choice === currentQuestion.correctAnswer && <b>正解</b>}
                    </li>
                  ))}
                </ol>
                {answerVisible && (
                  <div className={styles.explanation}>
                    <p className={styles.overline}>HOST NOTE · 解説</p>
                    <p>{currentQuestion.explanation || "解説は登録されていません。"}</p>
                  </div>
                )}
              </div>
            )}

            {data.state === "not_started" && (
              <div className={styles.emptyStage}>
                <span className={styles.stageNumber}>01</span>
                <p>準備ができたら、手動で発表を始めてください。</p>
              </div>
            )}
            {data.state === "podium_preview" && (
              <div className={styles.emptyStage}>
                <span className={styles.stageNumber}>03</span>
                <p>ランキング発表の予告中です。受賞者はまだ表示していません。</p>
                <small>第3位 → 第2位 → 第1位</small>
              </div>
            )}
            {["third", "second", "first"].includes(data.state) && (
              <div className={styles.winnerPreview}>
                <span className={styles.winnerRank}>{currentRank}</span>
                <div>
                  <p className={styles.overline}>公開中の受賞者</p>
                  {currentEntries.length ? (
                    currentEntries.map((entry) => (
                      <div key={`${entry.rank}-${entry.displayName}`}>
                        <h3>{entry.displayName}</h3>
                        <p>{entry.score} 問正解</p>
                      </div>
                    ))
                  ) : (
                    <h3>該当する受賞者はいません</h3>
                  )}
                </div>
              </div>
            )}
            {data.state === "finished" && (
              <div className={styles.emptyStage}>
                <span className={styles.stageNumber}>THANK YOU</span>
                <p>ご参加ありがとうございました。</p>
              </div>
            )}
          </section>

          <aside className={styles.sidePanel} aria-label="進行ガイド">
            <section className={styles.nextCard}>
              <p className={styles.overline}>NEXT STEP</p>
              <h2>
                {data.state === "finished"
                  ? "すべての発表が終了しました"
                  : data.state === "podium_preview" || ["third", "second"].includes(data.state)
                    ? `${nextStage}へ進む`
                    : NEXT_LABEL[data.state]}
              </h2>
              <p>{nextHint}</p>
              <button
                className={styles.primaryButton}
                type="button"
                onClick={() => void operate(data.state === "not_started" ? "start" : "advance")}
                disabled={busy || data.state === "finished"}
              >
                {busy
                  ? "同期しています…"
                  : data.state === "podium_preview" || ["third", "second"].includes(data.state)
                    ? `${nextStage}を発表する`
                    : NEXT_LABEL[data.state]}
              </button>
              <div className={styles.secondaryActions}>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  onClick={() => void operate("previous")}
                  disabled={busy || !canGoPrevious}
                >
                  ← 前の画面へ
                </button>
                <span>戻った後も次へ進む操作は手動です</span>
              </div>
              <p className={styles.manualNote}>
                進行は自動で切り替わりません。授与や拍手の間はこの画面を保持できます。
              </p>
            </section>
            <section className={styles.modeCard} aria-labelledby="presentation-mode-heading">
              <p className={styles.overline}>PRESENTATION MODE</p>
              <h2 id="presentation-mode-heading">答え合わせの進め方</h2>
              <p>
                {data.presentationMode === "short"
                  ? "短縮中：正解を強調し、解説を省きます。"
                  : "通常中：正解と登録済みの解説を表示します。"}{" "}
                未開始の間も設定でき、選択は保存されます。
              </p>
              <div className={styles.modeOptions} role="group" aria-label="発表モード">
                <button
                  type="button"
                  className={styles.modeOption}
                  aria-pressed={data.presentationMode === "full"}
                  onClick={() => void operate("setMode", "full")}
                  disabled={busy || data.presentationMode === "full"}
                >
                  <span>通常</span>
                  <small>正解と解説を表示</small>
                </button>
                <button
                  type="button"
                  className={styles.modeOption}
                  aria-pressed={data.presentationMode === "short"}
                  onClick={() => void operate("setMode", "short")}
                  disabled={busy || data.presentationMode === "short"}
                >
                  <span>短縮</span>
                  <small>正解のみを表示</small>
                </button>
              </div>
            </section>
            <section className={styles.progressCard}>
              <p className={styles.overline}>RUN OF SHOW</p>
              <ol className={styles.runList}>
                <li className={data.state === "not_started" ? styles.activeStep : styles.doneStep}>
                  <span>01</span>設問のおさらい
                </li>
                <li
                  className={
                    data.state === "question" || data.state === "answer"
                      ? styles.activeStep
                      : ["podium_preview", "third", "second", "first", "finished"].includes(
                            data.state,
                          )
                        ? styles.doneStep
                        : ""
                  }
                >
                  <span>02</span>正解・エピソード
                </li>
                <li
                  className={
                    data.state === "podium_preview"
                      ? styles.activeStep
                      : ["third", "second", "first", "finished"].includes(data.state)
                        ? styles.doneStep
                        : ""
                  }
                >
                  <span>03</span>第3位の予告
                </li>
                <li
                  className={
                    data.state === "third"
                      ? styles.activeStep
                      : ["second", "first", "finished"].includes(data.state)
                        ? styles.doneStep
                        : ""
                  }
                >
                  <span>04</span>第3位
                </li>
                <li
                  className={
                    data.state === "second"
                      ? styles.activeStep
                      : ["first", "finished"].includes(data.state)
                        ? styles.doneStep
                        : ""
                  }
                >
                  <span>05</span>第2位
                </li>
                <li
                  className={
                    data.state === "first"
                      ? styles.activeStep
                      : data.state === "finished"
                        ? styles.doneStep
                        : ""
                  }
                >
                  <span>06</span>第1位
                </li>
                <li className={data.state === "finished" ? styles.activeStep : ""}>
                  <span>07</span>祝福・終了
                </li>
              </ol>
            </section>
            <section className={styles.privacyCard}>
              <span className={styles.lockMark} aria-hidden="true">
                ✦
              </span>
              <div>
                <strong>投影情報を段階公開</strong>
                <p>
                  投影画面には現在公開中の内容だけが送られます。順位予告では名前・得点を伏せています。
                </p>
              </div>
            </section>
          </aside>
        </div>
        <footer className={styles.footer}>
          <span>発表データはサーバーに保存されています</span>
          <span>STATE VERSION {data.version}</span>
        </footer>
      </div>
    </main>
  );
}

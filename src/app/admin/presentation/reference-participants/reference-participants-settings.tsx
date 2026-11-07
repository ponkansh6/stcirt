"use client";

import Link from "next/link";
import { useEffect, useState, type MouseEvent } from "react";
import styles from "./reference-participants-settings.module.css";

const maxNames = 500;
const maxNameLength = 120;
const maxInputLength = maxNames * (maxNameLength + 2);

export default function ReferenceParticipantsSettings() {
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const hasChanges = text !== savedText;

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/presentation/reference-participants", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as {
          names?: unknown;
          error?: string;
        } | null;
        if (!response.ok) throw new Error(payload?.error ?? "設定を読み込めませんでした。");
        if (
          !Array.isArray(payload?.names) ||
          !payload.names.every((name) => typeof name === "string")
        )
          throw new Error("設定の形式を確認できませんでした。");
        const loaded = payload.names.join("\n");
        setText(loaded);
        setSavedText(loaded);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setMessage(error instanceof Error ? error.message : "設定を読み込めませんでした。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/presentation/reference-participants", {
        method: "PUT",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ namesText: text }),
      });
      const payload = (await response.json().catch(() => null)) as {
        names?: unknown;
        error?: string;
      } | null;
      if (!response.ok) throw new Error(payload?.error ?? "設定を保存できませんでした。");
      if (
        !Array.isArray(payload?.names) ||
        !payload.names.every((name) => typeof name === "string")
      )
        throw new Error("保存結果の形式を確認できませんでした。");
      const saved = payload.names.join("\n");
      setText(saved);
      setSavedText(saved);
      setMessage("参考対象氏名を保存しました。管理画面へ戻り、集計を実行してください。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "設定を保存できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  function returnToAdmin(event: MouseEvent<HTMLAnchorElement>) {
    if (!hasChanges) return;
    if (!window.confirm("保存していない変更は破棄されます。管理画面へ戻りますか？")) {
      event.preventDefault();
    }
  }

  return (
    <main className={styles.shell}>
      <section className={styles.card} aria-labelledby="reference-title">
        <h1 id="reference-title">参考対象氏名</h1>
        <p className={styles.eyebrow}>HOST CONSOLE</p>
        <p className={styles.intro}>
          1行に1名ずつ入力します。参加者の表示名と完全一致した有効な提出者は、通常順位と表彰から除外され、本人の結果に「位相当」を表示します。
        </p>
        <p className={styles.note}>
          前後の空白を含め、入力した名前は加工せず照合します。空行と空白だけの行は無視されます。最大
          {maxNames}名、1行{maxNameLength}文字までです。
        </p>
        <label className={styles.label} htmlFor="reference-names">
          参考対象の表示名（改行区切り）
        </label>
        <textarea
          id="reference-names"
          className={styles.textarea}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={12}
          maxLength={maxInputLength}
          disabled={loading || busy}
          aria-describedby="reference-guidance"
        />
        <p id="reference-guidance" className={styles.note}>
          保存後、管理画面へ戻って「集計」を実行すると保存済みの氏名一覧が反映されます。入力を変更しただけでは公開結果は変わりません。
        </p>
        {message ? (
          <p
            className={message.includes("保存しました") ? styles.success : styles.error}
            role="status"
          >
            {message}
          </p>
        ) : loading ? (
          <p className={styles.note} role="status">
            設定を読み込んでいます…
          </p>
        ) : null}
        <div className={styles.actions}>
          <button
            className={styles.primaryButton}
            type="button"
            disabled={loading || busy}
            onClick={() => void save()}
          >
            {busy ? "保存しています…" : "氏名一覧を保存"}
          </button>
          <Link
            className={styles.secondaryButton}
            href="/admin/presentation"
            onClick={returnToAdmin}
          >
            管理画面へ戻る
          </Link>
        </div>
      </section>
    </main>
  );
}

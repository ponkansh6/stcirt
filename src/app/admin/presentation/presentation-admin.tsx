"use client";

import { useEffect, useState, type FormEvent } from "react";
import styles from "./presentation-admin.module.css";

async function requestSession(method: "GET" | "POST", body?: { pin: string }) {
  const response = await fetch("/api/admin/session", {
    method,
    cache: "no-store",
    credentials: "same-origin",
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const payload = (await response.json().catch(() => null)) as {
    authenticated?: unknown;
    error?: string;
  } | null;
  if (!response.ok) throw new Error(payload?.error ?? "ログインできませんでした。");
  return payload;
}

export default function PresentationAdmin() {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void requestSession("GET")
      .then((session) => {
        if (active && session?.authenticated === true) {
          window.location.replace("/presentation?presenter=1");
        }
      })
      .catch(() => {
        if (active) setMessage("管理者セッションを確認できませんでした。PIN を入力してください。");
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || pin.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const session = await requestSession("POST", { pin });
      setPin("");
      if (session?.authenticated === true) window.location.assign("/presentation?presenter=1");
      else setMessage("管理者セッションを確認できませんでした。");
    } catch (error) {
      const message = error instanceof Error ? error.message : "ログインできませんでした。";
      setMessage(
        message === "Invalid PIN" ? "PIN が一致しません。入力内容をご確認ください。" : message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.shell}>
      <section className={styles.loginCard} aria-labelledby="admin-title">
        <p className={styles.eyebrow}>STCIRT · HOST CONSOLE</p>
        <h1 id="admin-title">披露宴 発表操作</h1>
        <p className={styles.loginIntro}>司会者用 PIN を入力して、発表画面を始めます。</p>
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
            {busy ? "確認中…" : "発表画面を始める"}
          </button>
        </form>
        {message && (
          <p id="admin-message" className={styles.error} role="alert">
            {message}
          </p>
        )}
        <p className={styles.loginFoot}>認証後、このタブでスライドと操作パネルを表示します。</p>
      </section>
    </main>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SharedResultPanel from "../shared-result-panel";
import { readRateLimitedSharedParticipantResult } from "@/lib/participants/assisted-result-sharing";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "共有された結果 | しゅんたま検定",
  description: "共有された代理回答の結果を確認できます。",
  robots: { index: false, follow: false, noarchive: true },
  openGraph: {
    title: "共有された結果 | しゅんたま検定",
    description: "共有された代理回答の結果を確認できます。",
  },
};

export default async function SharedResultPage({ params }: PageProps<"/shared-results/[token]">) {
  const { token } = await params;
  let outcome: Awaited<ReturnType<typeof readRateLimitedSharedParticipantResult>>;
  try {
    outcome = await readRateLimitedSharedParticipantResult(token);
  } catch {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <section className="rounded-2xl border border-border bg-surface p-7 shadow-sm sm:p-10">
          <h1 className="text-3xl font-bold">結果を確認できません</h1>
          <p className="mt-4 text-muted">時間をおいて再読み込みしてください。</p>
        </section>
      </main>
    );
  }
  if (outcome.state !== "ok") notFound();
  return <SharedResultPanel token={token} initial={outcome.result} />;
}

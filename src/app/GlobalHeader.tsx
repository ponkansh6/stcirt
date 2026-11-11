"use client";

import { usePathname } from "next/navigation";

export default function GlobalHeader() {
  const pathname = usePathname();
  const isAnswerRoute = pathname === "/answer";

  if (!isAnswerRoute) return null;

  return (
    <header id="answer-global-header" className="sticky top-0 z-10 border-b border-border bg-bg">
      <div className="mx-auto flex w-full max-w-3xl items-center px-4 py-2.5 sm:px-4">
        <div id="global-header-navigation" className="w-full" />
      </div>
    </header>
  );
}

"use client";

import { usePathname } from "next/navigation";

export default function GlobalHeader() {
  const pathname = usePathname();
  const isAnswerRoute = pathname === "/answer";

  if (!isAnswerRoute) return null;

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-2xl items-center px-4 py-4">
        <div id="global-header-navigation" className="w-full" />
      </div>
    </header>
  );
}

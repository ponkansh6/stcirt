"use client";

import { usePathname } from "next/navigation";
import { NavLink } from "@/components/NavLink";

export default function GlobalHeader() {
  const pathname = usePathname();
  const isAnswerRoute = pathname === "/answer";

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-2xl items-center px-4 py-4">
        {isAnswerRoute ? (
          <div id="global-header-navigation" className="w-full" />
        ) : (
          <NavLink
            href="/"
            variant="bare"
            className="font-bold text-lg hover:text-primary transition duration-200 ease-[var(--ease-out-soft)] motion-safe:active:scale-[0.98]"
            pendingClassName="opacity-50"
          >
            ホームへ
          </NavLink>
        )}
      </div>
    </header>
  );
}

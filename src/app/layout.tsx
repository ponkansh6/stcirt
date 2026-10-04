import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { NavLink } from "@/components/NavLink";
import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Stcirt - 1ナレッジ1問学習アプリ",
  description: "保存済みの問題を順番に解いて学習するアプリ",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={geist.variable}>
      <body className="min-h-dvh flex flex-col">
        <header className="sticky top-0 z-10 border-b border-border bg-bg/80 backdrop-blur-md">
          <div className="w-full max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
            <NavLink
              href="/"
              variant="bare"
              className="font-bold text-lg hover:text-primary transition duration-200 ease-[var(--ease-out-soft)] motion-safe:active:scale-[0.98]"
              pendingClassName="opacity-50"
            >
              ホームへ
            </NavLink>
          </div>
        </header>
        <div className="w-full max-w-2xl mx-auto px-4 flex-1 flex flex-col">{children}</div>
      </body>
    </html>
  );
}

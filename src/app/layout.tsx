import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import GlobalHeader from "./GlobalHeader";
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
        <GlobalHeader />
        <div className="w-full max-w-2xl mx-auto px-4 flex-1 flex flex-col">{children}</div>
      </body>
    </html>
  );
}

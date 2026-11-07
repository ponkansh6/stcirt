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
  title: "しゅんたま検定",
  description: "保存済みの問題を順番に解いて学習するアプリ",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={geist.variable}>
      <body className="min-h-dvh flex flex-col">
        <GlobalHeader />
        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col">{children}</div>
      </body>
    </html>
  );
}

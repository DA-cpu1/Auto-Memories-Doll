import type { Metadata } from "next";
import "../styles/globals.css";
import "../styles/components.css";
import ErrorBoundary from "../components/common/ErrorBoundary";
import DegradationBanner from "../components/common/DegradationBanner";

export const metadata: Metadata = {
  title: "Auto-Memories-Doll",
  description: "A local agent for organizing, reviewing, and retrieving knowledge.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="flex min-h-dvh flex-col antialiased">
        <ErrorBoundary>
          <DegradationBanner />
          {children}
        </ErrorBoundary>
      </body>
    </html>
  );
}

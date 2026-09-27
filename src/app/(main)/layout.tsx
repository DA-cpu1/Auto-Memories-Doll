"use client";

import TopNavbar from "@/components/common/TopNavbar";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-layout">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <TopNavbar />
      <main id="main-content" className="app-main">
        {children}
      </main>
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const settingsTabs = [
  { id: "ai", label: "AI 模型", href: "/settings/ai" },
  { id: "storage", label: "存储路径", href: "/settings/storage" },
  { id: "sources", label: "来源监听", href: "/settings/tools" },
] as const;

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="settings-shell">
      <aside className="settings-side" aria-label="设置分区">
        <div className="settings-side-heading">
          <h2>系统设置</h2>
          <p>模型、存储与采集来源</p>
        </div>
        <nav className="settings-nav" aria-label="设置分类">
          {settingsTabs.map((tab) => {
            const active =
              pathname === tab.href ||
              (tab.href !== "/settings/ai" && pathname.startsWith(tab.href));
            return (
              <Link key={tab.id} href={tab.href} aria-current={active ? "page" : undefined}>
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="settings-content">{children}</div>
    </div>
  );
}

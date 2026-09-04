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
    <div className="flex min-h-[calc(100vh-56px)] flex-col md:flex-row">
      <aside
        className="shrink-0 overflow-x-auto border-b md:w-64 md:overflow-y-auto md:border-b-0 md:border-r"
        style={{
          background: "var(--color-bg-secondary)",
          borderColor: "var(--color-border-default)",
        }}
      >
        <div className="px-4 pb-3 pt-5 md:p-6">
          <h2 className="mb-1 font-mono text-lg font-bold text-[#3E3224]">系统设置</h2>
          <p className="text-xs text-[#8B7355]">配置模型、存储与采集来源</p>
        </div>

        <nav className="flex min-w-max gap-1 px-3 pb-4 md:block md:min-w-0 md:space-y-1 md:pb-6">
          {settingsTabs.map((tab) => {
            const isActive =
              pathname === tab.href ||
              (tab.href !== "/settings/ai" && pathname.startsWith(tab.href));

            return (
              <Link
                key={tab.id}
                href={tab.href}
                aria-current={isActive ? "page" : undefined}
                className={`block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive ? "bg-accent text-white" : "text-text-secondary hover:bg-muted"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

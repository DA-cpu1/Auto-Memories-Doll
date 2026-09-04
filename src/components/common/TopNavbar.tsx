"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavTab {
  id: string;
  label: string;
  href: string;
}

const navTabs: NavTab[] = [
  { id: "home", label: "状态", href: "/" },
  { id: "library", label: "检索库", href: "/memory" },
  { id: "review", label: "审核", href: "/audit" },
  { id: "settings", label: "设置", href: "/settings/ai" },
];

export default function TopNavbar() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    if (href.startsWith("/settings")) return pathname.startsWith("/settings");
    return pathname.startsWith(href);
  };

  return (
    <header className="sticky top-0 z-50 flex h-14 shrink-0 items-center justify-between gap-2 px-2 nav-dark sm:px-6">
      {/* 左侧：Logo + 系统名称 */}
      <Link href="/" className="group flex shrink-0 items-center gap-2 sm:gap-2.5">
        <div
          aria-hidden="true"
          className="flex h-7 w-7 items-center justify-center rounded-md border border-[#D4B84A]/60 font-mono text-xs font-bold text-[#D4B84A]"
        >
          M
        </div>
        <span className="hidden text-base font-bold text-[#F5F0E8] transition-colors duration-200 group-hover:text-[#D4B84A] sm:block">
          记忆中枢
        </span>
      </Link>

      {/* 右侧：导航 Tab 列表 */}
      <nav className="flex min-w-0 items-center gap-0.5 sm:gap-1">
        {navTabs.map((tab) => {
          const active = isActive(tab.href);
          return (
            <Link
              key={tab.id}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`relative px-2.5 py-2 text-sm font-medium transition-all duration-200 sm:px-4 ${
                active
                  ? "text-[#D4B84A] bg-white/10"
                  : "text-[rgba(245,240,232,0.65)] hover:text-[#F5F0E8] hover:bg-white/5"
              }`}
            >
              {tab.label}
              {active ? (
                <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-4 h-0.5 rounded-full bg-[#C9A227]" />
              ) : null}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

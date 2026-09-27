"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { label: "首页", href: "/", active: (path: string) => path === "/" },
  { label: "状态", href: "/status", active: (path: string) => path.startsWith("/status") },
  { label: "检索库", href: "/memory", active: (path: string) => path.startsWith("/memory") },
  {
    label: "设置",
    href: "/settings/ai",
    active: (path: string) => path.startsWith("/settings"),
  },
];

export default function TopNavbar() {
  const pathname = usePathname();

  return (
    <header className="app-header">
      <Link href="/" className="app-brand" aria-label="记忆中枢首页">
        <span className="brand-mark" aria-hidden="true">
          M
        </span>
        <span>记忆中枢</span>
      </Link>
      <nav className="primary-nav" aria-label="主导航">
        {navItems.map((item) => {
          const active = item.active(pathname);
          return (
            <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

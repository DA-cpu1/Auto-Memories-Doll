import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import MemoryLibraryPage from "../app/(main)/memory/page";

describe("memory library page", () => {
  it("renders the library title and graph entry instead of the graph itself", () => {
    const html = renderToStaticMarkup(<MemoryLibraryPage />);

    expect(html).toContain("记忆检索库");
    expect(html).toContain('href="/memory/map"');
    expect(html).not.toContain("知识图谱加载失败");
  });
});

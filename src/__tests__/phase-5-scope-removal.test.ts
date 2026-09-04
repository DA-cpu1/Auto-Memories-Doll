import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiRouteContracts } from "../config/api-route-contracts";

const ROOT = process.cwd();

function source(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relativePath);
    return /\.(ts|tsx)$/.test(entry.name) ? [relativePath] : [];
  });
}

describe("LKA-001 Phase 5 product boundary", () => {
  it("removes out-of-scope pages and API routes", () => {
    const removedPaths = [
      "src/app/(main)/chat/page.tsx",
      "src/app/(main)/settings/mcp/page.tsx",
      "src/app/(main)/settings/profile/page.tsx",
      "src/app/(main)/settings/prompts/page.tsx",
      "src/app/(main)/settings/skills/page.tsx",
      "src/app/api/chat/route.ts",
      "src/app/api/chat/stream/route.ts",
      "src/app/api/chat/sessions/route.ts",
      "src/app/api/profile/route.ts",
      "src/app/api/prompt/route.ts",
      "src/app/api/config/mcp/route.ts",
      "src/app/api/config/skills/route.ts",
    ];

    expect(removedPaths.filter((path) => existsSync(join(ROOT, path)))).toEqual([]);
  });

  it("removes out-of-scope runtime implementations", () => {
    const removedPaths = [
      "src/components/chat/ChatInterface.tsx",
      "src/components/profile/ProfilePanel.tsx",
      "src/components/prompt/PromptEditor.tsx",
      "src/features/chat/handler.ts",
      "src/features/prompt/manager.ts",
      "src/features/agent/dispatcher.ts",
      "src/lib/browser/history-collector.ts",
      "src/lib/chat/conversation-compressor.ts",
      "src/lib/mcp/manager.ts",
      "src/lib/prompt/cache.ts",
      "src/lib/skills/manager.ts",
      "src/lib/ai/model-adapter.ts",
      "src/lib/ai/ai-events.ts",
      "src/server/services/chat-session-service.ts",
      "src/server/services/profile-updater.ts",
      "src/server/services/config-service.ts",
      "src/server/schedulers/browser-collect-scheduler.ts",
      "src/server/schedulers/mcp-collect-scheduler.ts",
    ];

    expect(removedPaths.filter((path) => existsSync(join(ROOT, path)))).toEqual([]);
  });

  it("keeps the retained production graph free of removed module imports", () => {
    const forbiddenImports =
      /(?:features\/(?:chat|prompt)|lib\/(?:chat|mcp|prompt|skills|browser)|\/model-adapter|\/ai-events|\/chat-session-service|\/profile-updater|\/config-service)/;
    const offenders = sourceFiles("src")
      .filter((file) => !file.includes("__tests__"))
      .filter((file) => forbiddenImports.test(source(file).replaceAll("\\", "/")));

    expect(offenders).toEqual([]);
  });

  it("keeps only retained routes in the API contract table", () => {
    const routes = Object.keys(apiRouteContracts);
    expect(
      routes.filter((route) =>
        /\/api\/(?:chat|profile|prompt|config\/(?:mcp|skills))(?:\/|$)/.test(route),
      ),
    ).toEqual([]);
    expect(apiRouteContracts["src/app/api/config/tool-sources/status/route.ts"]).toEqual({
      responseSchema: "toolSourceStatusResponseSchema",
      errorCodes: ["INTERNAL_ERROR"],
    });
  });

  it("replaces chat navigation with source, review, and retrieval entry points", () => {
    const homepage = source("src/app/(main)/page.tsx");
    const settings = source("src/components/settings/SettingsLayout.tsx");

    expect(homepage).toContain('href: "/settings/tools"');
    expect(homepage).toContain('href: "/audit"');
    expect(homepage).toContain('href="/memory"');
    expect(homepage).not.toMatch(/href[:=]\s*["']\/(?:chat|profile)/);
    expect(settings).not.toMatch(/settings\/(?:mcp|skills|profile|prompts)/);
  });

  it("removes runtime packages while preserving historical source provenance", () => {
    const packageJson = JSON.parse(source("package.json")) as {
      dependencies?: Record<string, string>;
    };
    const memoryTypes = source("src/types/memory.ts");

    expect(packageJson.dependencies).not.toHaveProperty("@modelcontextprotocol/sdk");
    expect(memoryTypes).toContain('"chat"');
    expect(memoryTypes).toContain('"mcp"');
    expect(memoryTypes).toContain('"skill"');
  });
});

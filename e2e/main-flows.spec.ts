import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { resolve } from "node:path";

const SOURCE_TITLE = "可观察的 KnowledgeAgent 循环";
const SOURCE_NAME = "Phase 8 演示来源";
const SOURCE_PATH = resolve(process.cwd(), "e2e/.tmp/source");

function collectBrowserDiagnostics(page: Page) {
  const diagnostics: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      diagnostics.push(`[console.${message.type()}] ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    diagnostics.push(`[pageerror] ${error.message}`);
  });
  return diagnostics;
}

async function replayQueue(request: APIRequestContext): Promise<void> {
  const response = await request.post("/api/audit", { data: { action: "replay" } });
  expect(response.ok()).toBe(true);
}

test.describe.configure({ mode: "serial" });

test("来源配置到审核发布、检索、主题资料和来源追溯形成完整闭环", async ({ page, request }) => {
  const diagnostics = collectBrowserDiagnostics(page);

  await page.goto("/settings/tools");
  await expect(page.getByRole("heading", { name: "来源设置" })).toBeVisible();
  await page.getByRole("button", { name: "新增自定义来源" }).click();
  await page.getByLabel("名称").fill(SOURCE_NAME);
  await page.getByLabel("来源类型").selectOption("markdown");
  await page.getByLabel("监听路径").fill(SOURCE_PATH);
  await page.getByLabel("包含规则").fill("*.md");
  await page.getByLabel("固定主题（可选）").fill("learning");
  await page.getByLabel("说明（可选）").fill("Phase 8 确定性演示数据");
  await page.getByRole("button", { name: "保存来源" }).click();
  await expect(page.getByText(SOURCE_NAME)).toBeVisible();

  await expect
    .poll(async () => {
      const response = await request.get("/api/config/tool-sources/status");
      const payload = await response.json();
      return payload.toolWatcher.running;
    })
    .toBe(1);

  await page.getByRole("button", { name: "扫描所有来源" }).click();
  await expect(page.getByRole("status")).toContainText("1 个工具会话文件已检查");

  await expect
    .poll(async () => {
      await replayQueue(request);
      const response = await request.get("/api/audit/review-events");
      return (await response.json()).items.length;
    })
    .toBe(1);

  await page.goto("/audit");
  await expect(page.getByRole("heading", { name: "审核工作台" })).toBeVisible();
  await expect(page.getByRole("heading", { name: SOURCE_TITLE })).toBeVisible();
  await expect(page.getByText("向量召回不可用", { exact: false })).toBeVisible();
  await expect(page.getByText(SOURCE_PATH, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "接受候选" }).click();
  await expect(page.getByText("没有等待裁决的候选。")).toBeVisible();

  await page.goto("/memory");
  await page.getByPlaceholder("搜索标题、摘要、正文或标签...").fill("KnowledgeAgent 循环");
  await page.getByRole("button", { name: "搜索记忆" }).click();
  await expect(page.getByText("当前处于降级模式", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: `查看记忆：${SOURCE_TITLE}` })).toBeVisible();
  await expect(page.getByText(`来源 ${SOURCE_NAME}:`, { exact: false })).toBeVisible();

  await page.getByRole("link", { name: "话题：学习笔记" }).click();
  await expect(page).toHaveURL(/\/memory\/topic\/learning$/);
  await expect(page.getByRole("heading", { name: /学习笔记\s*学习资料/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "来源版本", exact: true })).toBeVisible();
  await expect(page.getByText("observable-agent-loop.md", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: SOURCE_TITLE })).toBeVisible();

  expect(diagnostics).toEqual([]);
});

test("未变化来源重复扫描不产生副本", async ({ page, request }) => {
  const diagnostics = collectBrowserDiagnostics(page);
  const before = await request.get("/api/memory?limit=50&page=1");
  const beforePayload = await before.json();

  const scan = await request.post("/api/listen/scan");
  expect(scan.ok()).toBe(true);
  await replayQueue(request);

  const after = await request.get("/api/memory?limit=50&page=1");
  const afterPayload = await after.json();
  expect(afterPayload.data.total).toBe(beforePayload.data.total);
  expect(
    afterPayload.data.items.filter((item: { title: string }) => item.title === SOURCE_TITLE),
  ).toHaveLength(1);

  const reviews = await request.get("/api/audit/review-events");
  expect((await reviews.json()).items).toHaveLength(0);

  await page.goto("/memory");
  await expect(page.getByRole("link", { name: `查看记忆：${SOURCE_TITLE}` })).toHaveCount(1);
  expect(diagnostics).toEqual([]);
});

test("手机端主页面无横向溢出且可访问已发布知识", async ({ page }) => {
  const diagnostics = collectBrowserDiagnostics(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/");
  const pageMetrics = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(pageMetrics.pageWidth).toBeLessThanOrEqual(pageMetrics.viewportWidth);

  await page.getByPlaceholder("输入关键词或自然语言问题").fill("KnowledgeAgent");
  await page.getByRole("button", { name: "检索", exact: true }).click();
  await expect(page.getByText(SOURCE_TITLE).first()).toBeVisible();
  expect(diagnostics).toEqual([]);
});

test("已删除产品入口不可访问且 listen 非法请求保持结构化错误", async ({ request }) => {
  for (const path of ["/chat", "/settings/profile", "/api/chat", "/api/profile"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
  }

  const response = await request.post("/api/listen", {
    headers: { "content-type": "application/json" },
    data: Buffer.from("{"),
  });
  expect(response.status()).toBe(400);
  await expect(response.json()).resolves.toEqual({
    success: false,
    error: { code: "INVALID_JSON", message: "请求体不是有效 JSON" },
  });
});

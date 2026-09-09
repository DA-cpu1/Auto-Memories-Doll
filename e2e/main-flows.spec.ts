import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { final, jsonl, meta, noise, start, user } from "../src/__tests__/fixtures/codex-dialogue";

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
  expect(response.ok(), await response.text()).toBe(true);
}

test.describe.configure({ mode: "serial" });

test("设置页使用已保存的脱敏凭据完成连接测试", async ({ page }) => {
  await page.goto("/settings/ai");
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByText(/语言模型：\s*模型 e2e-model 响应正常/)).toBeVisible();
  await expect(page.getByText(/Embedding 模型：\s*已关闭/)).toBeVisible();
  await expect(page.getByRole("button", { name: "测试连接", exact: true })).toBeEnabled();
});

test("批量确认按钮位于长审核列表前，预览刷新后保留且可执行", async ({ page }, testInfo) => {
  let previewed = false;
  let executions = 0;
  const batch = {
    id: "test-visible-recovery",
    status: "preview",
    createdAt: "2026-09-05T00:00:00.000Z",
    items: Array.from({ length: 326 }, (_, index) => ({
      eventId: `review-${index}`,
      sourceId: "fixture-source",
      reason: index < 325 ? "ELIGIBLE" : "NOT_VECTOR_ONLY_REVIEW",
      status: index < 325 ? "pending" : "skipped",
    })),
  };
  await page.route("**/api/audit/dependencies", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: { items: [], vectorStates: {}, latestBatch: previewed ? batch : null },
      });
      return;
    }
    const command = route.request().postDataJSON();
    if (command.action === "preview") previewed = true;
    if (command.action === "execute") {
      expect(command.batchId).toBe(batch.id);
      executions++;
      batch.status = "done";
      batch.items.forEach((item) => {
        if (item.status === "pending") item.status = "queued";
      });
    }
    await route.fulfill({ json: batch });
  });
  await page.route("**/api/audit/review-events", (route) =>
    route.fulfill({
      json: {
        items: Array.from({ length: executions ? 1 : 326 }, (_, index) => ({
          eventId: `review-${index}`,
          memoryId: `memory-${index}`,
          sourceType: "ingest",
          createdAt: "2026-09-05",
          retryCount: 0,
          reasonCode: "VECTOR_RECALL_UNAVAILABLE",
          reason: "旧向量故障",
          candidate: {
            title: `测试候选 ${index + 1}`,
            summary: "候选摘要",
            content: "候选正文",
            tags: [],
            topic: "learning",
            kind: "fact",
            source: "fixture-source",
          },
        })),
      },
    }),
  );
  await page.goto("/audit");
  const preview = page.getByRole("button", { name: "预览旧服务故障候选" });
  await expect(preview).toBeInViewport();
  await preview.click();
  const confirm = page.getByRole("button", { name: "确认重新处理 325 条" });
  await expect(confirm).toBeInViewport();
  await page.reload();
  await expect(confirm).toBeInViewport();
  expect(executions).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("recovery-confirm-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(confirm).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("recovery-confirm-mobile.png") });
  await confirm.click();
  await expect(page.getByRole("status")).toContainText("批次提交完成");
  await expect(page.getByRole("heading", { name: /^测试候选 / })).toHaveCount(1);
  expect(executions).toBe(1);
  await expect(confirm).toHaveCount(0);
});

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
  await expect(page.getByText("证据不足，需要人工复核", { exact: false })).toBeVisible();
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
  const searchBounds = await page.getByRole("button", { name: "检索", exact: true }).boundingBox();
  expect(searchBounds!.x + searchBounds!.width).toBeLessThanOrEqual(390);
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

test("Codex 来源显示等待与未知格式，最终回答到达后可审核发布", async ({
  page,
  request,
}, testInfo) => {
  const diagnostics = collectBrowserDiagnostics(page);
  const file = resolve(SOURCE_PATH, "codex-waiting.jsonl");
  const prefix = jsonl(meta, start(), user("Codex 最终对话验收"), ...noise);
  writeFileSync(file, prefix);
  writeFileSync(resolve(SOURCE_PATH, "codex-unknown.jsonl"), jsonl({ unsupported: true }));
  const created = await request.post("/api/config/tool-sources", {
    data: {
      name: "我的 Codex 来源",
      toolType: "codex",
      path: SOURCE_PATH,
      filePattern: "*.jsonl",
      enabled: true,
    },
  });
  expect(created.ok()).toBe(true);
  await request.post("/api/listen/scan");
  await page.goto("/settings/tools");
  await expect(page.getByText("Codex（CLI / 桌面端）", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "我的 Codex 来源" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByText("等待最终回答", { exact: false })).toBeVisible();
  await expect(page.getByText("不支持的会话格式", { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("codex-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("codex-mobile.png"), fullPage: true });
  const before = await request.get("/api/audit/review-events");
  expect((await before.json()).items).toHaveLength(0);
  writeFileSync(file, prefix + jsonl(final("只归档真实问题与最终回答。")));
  await request.post("/api/listen/scan");
  await replayQueue(request);
  await page.goto("/audit");
  await expect(page.getByRole("heading", { name: "Codex 最终对话验收" })).toBeVisible();
  await page.getByRole("button", { name: "接受候选" }).click();
  await expect(page.getByText("没有等待裁决的候选。")).toBeVisible();
  await page.goto("/memory");
  await expect(page.getByRole("link", { name: "查看记忆：Codex 最终对话验收" })).toBeVisible();
  expect(diagnostics).toEqual([]);
});

test("模型故障显示独立等待列表，Embedding 关闭配置保留", async ({ page, request }, testInfo) => {
  const config = await (await request.get("/api/config/ai")).json();
  expect(config.embedding.enabled).toBe(false);
  const saved = await request.post("/api/config/ai", {
    data: { ...config, apiKey: "unavailable-e2e" },
  });
  expect(saved.ok()).toBe(true);
  const listened = await request.post("/api/listen", {
    data: {
      source: "ka003-waiting",
      sourceType: "listen",
      title: "等待服务专用候选",
      messages: [
        { role: "user", content: "如何处理模型服务故障？" },
        {
          role: "assistant",
          content: "将服务依赖状态持久化，保留原事件身份，并以有限退避等待恢复。",
        },
      ],
    },
  });
  expect(listened.ok()).toBe(true);
  await replayQueue(request);
  const waiting = await (await request.get("/api/audit/dependencies")).json();
  expect(waiting.items).toHaveLength(1);
  expect(waiting.items[0].dependency.paused).toBe(true);
  expect((await (await request.get("/api/audit/review-events")).json()).items).toHaveLength(0);
  await page.goto("/audit");
  await expect(page.getByRole("heading", { name: "等待模型服务 (1)" })).toBeVisible();
  await expect(page.getByText("自动重试已暂停", { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("ka003-waiting-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("ka003-waiting-mobile.png"), fullPage: true });
});

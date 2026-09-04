import { expect, test, type Page } from "@playwright/test";

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

test.describe.configure({ mode: "serial" });

test("首页展示处理状态并可进入来源设置", async ({ page }) => {
  const diagnostics = collectBrowserDiagnostics(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "知识处理概览" })).toBeVisible();
  await expect(page.getByText("已登记来源")).toBeVisible();
  await page.getByRole("link", { name: /来源设置/ }).click();

  await expect(page).toHaveURL(/\/settings\/tools$/);
  await expect(page.getByRole("heading", { name: "工具监听" })).toBeVisible();
  expect(diagnostics).toEqual([]);
});

test("手机端处理概览无横向溢出且可以检索", async ({ page }) => {
  const diagnostics = collectBrowserDiagnostics(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "知识处理概览" })).toBeVisible();

  const pageMetrics = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(pageMetrics.pageWidth).toBeLessThanOrEqual(pageMetrics.viewportWidth);

  await page.getByPlaceholder("输入关键词或自然语言问题").fill("E2E 测试记忆");
  await page.getByRole("button", { name: "检索", exact: true }).click();
  await expect(page.getByText("E2E 测试记忆").first()).toBeVisible();
  expect(diagnostics).toEqual([]);
});

test("首页导航进入检索库，列表可以打开记忆详情", async ({ page }) => {
  const diagnostics = collectBrowserDiagnostics(page);

  await page.goto("/");
  await page.getByRole("link", { name: "检索库", exact: true }).click();

  await expect(page).toHaveURL(/\/memory$/);
  await expect(page.getByRole("heading", { name: "记忆检索库" })).toBeVisible();
  await expect(page.getByRole("link", { name: /查看记忆：E2E 测试记忆/ })).toBeVisible();
  await page.getByRole("link", { name: /查看记忆：E2E 测试记忆/ }).click();

  await expect(page).toHaveURL(/\/memory\/[^/]+$/);
  await expect(page.getByText("E2E 测试记忆").first()).toBeVisible();
  expect(diagnostics).toEqual([]);
});

test("检索库可以进入唯一知识图谱页面", async ({ page }) => {
  const diagnostics = collectBrowserDiagnostics(page);

  await page.goto("/memory");
  await expect(page.getByRole("heading", { name: "记忆检索库" })).toBeVisible();
  await page.getByRole("link", { name: /查看知识图谱/ }).click();

  await expect(page).toHaveURL(/\/memory\/map$/);
  await expect(page.getByRole("heading", { name: "知识图谱" })).toBeVisible();
  await page.getByRole("button", { name: /显示筛选/ }).click();
  await expect(page.getByPlaceholder("搜索知识节点...")).toBeVisible();
  expect(diagnostics).toEqual([]);
});

test("设置侧栏可以进入工具监听并显示选中态", async ({ page }) => {
  const diagnostics = collectBrowserDiagnostics(page);

  await page.goto("/");
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("link", { name: "来源监听", exact: true }).click();

  await expect(page).toHaveURL(/\/settings\/tools$/);
  await expect(page.getByRole("heading", { name: "工具监听" })).toBeVisible();
  await expect(page.locator('aside a[href="/settings/tools"]')).toHaveClass(/bg-\[#A67C00\]/);
  expect(diagnostics).toEqual([]);
});

test("listen API 无效 JSON 返回结构化错误", async ({ request }) => {
  const response = await request.post("/api/listen", {
    headers: { "content-type": "application/json" },
    data: Buffer.from("{"),
  });

  expect(response.status()).toBe(400);
  await expect(response.json()).resolves.toEqual({
    success: false,
    error: {
      code: "INVALID_JSON",
      message: "请求体不是有效 JSON",
    },
  });
});

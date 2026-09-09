import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { KnowledgeConfigService } from "../../../../../server/services/knowledge-config-service";
import { redactSecrets } from "../../../../../lib/security/secret-redactor";

type ConnectionResult = {
  success: boolean;
  message: string;
  model?: string;
  dimensions?: number;
};

type TestConnectionOptions = {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  credentialError?: string;
};

const aiConfigTestSchema = z.object({
  provider: z.string().optional(),
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  embedding: z
    .object({
      enabled: z.boolean().optional(),
      baseURL: z.union([z.string().url(), z.literal("")]).optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
    })
    .optional(),
});

function resolveProbeOptions(
  options: TestConnectionOptions,
  storedKey?: string,
  storedURL?: string,
): TestConnectionOptions {
  if (!options.apiKey?.startsWith("****")) return options;
  if (!storedKey || options.apiKey !== `****${storedKey.slice(-4)}`) {
    return {
      ...options,
      apiKey: undefined,
      credentialError: "已保存的凭据已变化，请刷新设置页或重新输入 API Key",
    };
  }
  if (normalizeURL(options.baseURL) !== normalizeURL(storedURL)) {
    return {
      ...options,
      apiKey: undefined,
      credentialError: "端点已更改，请为新端点明确输入 API Key 后测试",
    };
  }
  return { ...options, apiKey: storedKey };
}

function businessError(data: unknown): string | undefined {
  const result = z
    .object({ base_resp: z.object({ status_code: z.number(), status_msg: z.string().optional() }) })
    .safeParse(data);
  if (!result.success || result.data.base_resp.status_code === 0) return undefined;
  return `提供商业务错误 ${result.data.base_resp.status_code}：${result.data.base_resp.status_msg || "请求被拒绝"}`;
}

function sanitizeMessage(message: string, keys: Array<string | undefined>): string {
  for (const key of keys) if (key) message = message.split(key).join("[REDACTED]");
  return redactSecrets(message).content;
}

/**
 * POST /api/config/ai/test
 *
 * 同时测试 Chat 与 Embedding API 连接。
 * Body: {
 *   baseURL, apiKey, model,
 *   embedding: { baseURL?, apiKey?, model? }
 * }
 */
export async function POST(request: NextRequest) {
  const parsed = aiConfigTestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "测试配置格式无效" }, { status: 400 });
  const service = new KnowledgeConfigService();
  try {
    const body = parsed.data;
    const stored = service.getAiConfig();
    const llmOptions = resolveProbeOptions(
      {
        baseURL: body.baseURL,
        apiKey: body.apiKey,
        model: body.model,
      },
      stored?.apiKey,
      stored?.baseURL,
    );
    const embeddingOptions = resolveProbeOptions(
      {
        baseURL: body.embedding?.baseURL || body.baseURL,
        apiKey: body.embedding?.apiKey || body.apiKey,
        model: body.embedding?.model,
      },
      body.embedding?.apiKey ? stored?.embedding.apiKey : stored?.apiKey,
      stored?.embedding.baseURL || stored?.baseURL,
    );
    const llm = await testChatConnection(llmOptions);
    const embedding =
      body.embedding?.enabled === false
        ? { success: true, message: "已关闭" }
        : await testEmbeddingConnection(embeddingOptions);
    const keys = [
      llmOptions.apiKey,
      embeddingOptions.apiKey,
      stored?.apiKey,
      stored?.embedding.apiKey,
    ];
    llm.message = sanitizeMessage(llm.message, keys);
    embedding.message = sanitizeMessage(embedding.message, keys);

    return NextResponse.json({
      success: llm.success && embedding.success,
      message: `语言模型：${llm.message}；Embedding：${embedding.message}`,
      llm,
      embedding,
      // 保留旧接口字段，兼容只读取顶层结果的调用方。
      model: llm.model,
      error: llm.success && embedding.success ? undefined : "部分或全部模型连接失败",
    });
  } catch {
    return NextResponse.json({ success: false, error: "服务器内部错误" }, { status: 500 });
  } finally {
    service.close();
  }
}

function normalizeURL(baseURL?: string): string {
  return (baseURL || "https://api.openai.com/v1").replace(/\/$/, "");
}

/**
 * Node fetch 网络层失败时 err.message 只有 "fetch failed"，
 * 真实原因（DNS/连接被拒/TLS/代理）在 err.cause 中，需要展开才能定位问题。
 */
function describeCause(err: Error & { cause?: unknown }): string {
  const causes: string[] = [];
  let current: unknown = err.cause;
  let depth = 0;
  while (current && depth < 3) {
    if (typeof current === "object" && current !== null) {
      const c = current as { code?: string; message?: string; name?: string };
      const label =
        c.code && c.message
          ? `${c.code} ${c.message}`
          : c.code || c.message || c.name || String(current);
      causes.push(label);
      current = (current as { cause?: unknown }).cause;
    } else {
      causes.push(String(current));
      break;
    }
    depth += 1;
  }
  return causes.length > 0 ? `${err.message}（${causes.join(" <- ")}）` : err.message;
}

function getResponseError(status: number, errorData: unknown): string {
  const message =
    typeof errorData === "object" &&
    errorData !== null &&
    "error" in errorData &&
    typeof errorData.error === "object" &&
    errorData.error !== null &&
    "message" in errorData.error
      ? errorData.error.message
      : undefined;

  if (typeof message === "string" && message) return message;
  if (status === 401) return "API Key 无效或已过期";
  if (status === 403) return "API Key 没有访问权限";
  if (status === 404) return "API 端点不正确或模型不存在";
  if (status === 429) return "请求频率超限，请稍后重试";
  return `HTTP ${status}`;
}

async function requestWithTimeout(
  url: string,
  init: RequestInit,
): Promise<{ response?: Response; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    return { response: await fetch(url, { ...init, signal: controller.signal }) };
  } catch (error: unknown) {
    const err = error as Error & { cause?: unknown };
    return {
      error:
        err.name === "AbortError"
          ? "连接超时（10秒），请检查网络和 API 地址"
          : `网络错误: ${describeCause(err)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function testChatConnection(options: TestConnectionOptions): Promise<ConnectionResult> {
  const testModel = options.model || "gpt-4o-mini";
  if (options.credentialError)
    return { success: false, message: options.credentialError, model: testModel };
  if (!options.apiKey?.trim()) {
    return { success: false, message: "API Key 不能为空", model: testModel };
  }

  const result = await requestWithTimeout(`${normalizeURL(options.baseURL)}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: testModel,
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 5,
    }),
  });

  if (result.error) return { success: false, message: result.error, model: testModel };
  if (!result.response) return { success: false, message: "未收到服务响应", model: testModel };
  if (!result.response.ok) {
    const errorData = await result.response.json().catch(() => ({}));
    return {
      success: false,
      message: getResponseError(result.response.status, errorData),
      model: testModel,
    };
  }

  const data = await result.response.json().catch(() => ({}));
  const failure = businessError(data);
  if (failure) return { success: false, message: failure, model: testModel };
  const actualModel = data.model || testModel;
  return { success: true, message: `模型 ${actualModel} 响应正常`, model: actualModel };
}

async function testEmbeddingConnection(options: TestConnectionOptions): Promise<ConnectionResult> {
  const testModel = options.model || "text-embedding-3-small";
  if (options.credentialError)
    return { success: false, message: options.credentialError, model: testModel };
  if (!options.apiKey?.trim()) {
    return { success: false, message: "Embedding API Key 不能为空", model: testModel };
  }

  const result = await requestWithTimeout(`${normalizeURL(options.baseURL)}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: testModel,
      input: "health-check",
    }),
  });

  if (result.error) return { success: false, message: result.error, model: testModel };
  if (!result.response) return { success: false, message: "未收到服务响应", model: testModel };
  if (!result.response.ok) {
    const errorData = await result.response.json().catch(() => ({}));
    return {
      success: false,
      message: getResponseError(result.response.status, errorData),
      model: testModel,
    };
  }

  const data = await result.response.json().catch(() => ({}));
  const failure = businessError(data);
  if (failure) return { success: false, message: failure, model: testModel };
  const vector = data.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    return { success: false, message: "服务返回了空向量", model: testModel };
  }

  return {
    success: true,
    message: `模型 ${data.model || testModel} 响应正常（${vector.length} 维）`,
    model: data.model || testModel,
    dimensions: vector.length,
  };
}

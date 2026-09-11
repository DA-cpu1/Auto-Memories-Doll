import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import Database from "better-sqlite3";

const port = process.argv[2] || "4173";
const projectRoot = process.cwd();
const memoryRoot = resolve(projectRoot, "e2e/.tmp/memory-root");
const sourceRoot = resolve(projectRoot, "e2e/.tmp/source");
const seedScript = resolve(projectRoot, "e2e/seed.mjs");
const nextCli = resolve(projectRoot, "node_modules/next/dist/bin/next");
const launcherPidPath = resolve(projectRoot, "e2e/.tmp/web-server.pid");
const shutdownRequestPath = resolve(projectRoot, "e2e/.tmp/stop-web-server");

const modelServer = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.headers.authorization !== "Bearer e2e-model-key") {
    response
      .writeHead(401)
      .end(JSON.stringify({ error: { message: "Test credentials rejected" } }));
    return;
  }
  if (request.url?.includes("embeddings")) {
    response
      .writeHead(503)
      .end(JSON.stringify({ error: { message: "Optional embedding unavailable" } }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const prompt = body.messages?.[0]?.content ?? "";
  const sourceText = prompt.split("原始内容：\n")[1]?.split("\n只回复 JSON")[0] ?? "测试响应";
  const title = prompt.match(/标题：([^\n]+)/)?.[1] ?? "测试笔记";
  const content = prompt.includes("话题分类器")
    ? JSON.stringify({ topic: "learning", confidence: 1 })
    : prompt.includes("记忆库的编辑")
      ? JSON.stringify({ memories: [{ title, summary: sourceText.slice(0,80), content: sourceText, tags: ["测试"] }] })
      : "{}";
  response.end(
    JSON.stringify({
      id: "e2e-completion",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
});
await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
const modelAddress = modelServer.address();

const seed = spawnSync(process.execPath, [seedScript], {
  env: process.env,
  stdio: "inherit",
});

if (seed.status !== 0) {
  process.exit(seed.status ?? 1);
}

const database = new Database(resolve(memoryRoot, "memory.db"));
database.exec(
  "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt TEXT NOT NULL)",
);
const tier = { model: "e2e-model", maxTokens: 1024, temperature: 0, timeout: 10000, maxRetries: 0 };
database
  .prepare("INSERT OR REPLACE INTO config VALUES ('ai', ?, ?)")
  .run(
    JSON.stringify({
      provider: "openai-compatible",
      baseURL: `http://127.0.0.1:${modelAddress.port}/v1`,
      apiKey: "e2e-model-key",
      budget: tier,
      standard: tier,
      flagship: tier,
      embedding: {
        enabled: false,
        model: "e2e-embedding",
        dimensions: 3,
        maxConcurrency: 1,
        queueTimeoutMs: 10000,
      },
    }),
    new Date().toISOString(),
  );
database.close();

writeFileSync(launcherPidPath, String(process.pid), "utf-8");
rmSync(shutdownRequestPath, { force: true });

const server = spawn(
  process.execPath,
  [nextCli, "dev", "--hostname", "127.0.0.1", "--port", port],
  {
    env: {
      ...process.env,
      MODEL_API_KEY: "e2e-model-key",
      MODEL_BASE_URL: `http://127.0.0.1:${modelAddress.port}/v1`,
    },
    stdio: "inherit",
    windowsHide: true,
  },
);

let stopping = false;

function stop(signal) {
  if (stopping) return;
  stopping = true;
  server.kill(signal);
}

const shutdownPoll = globalThis.setInterval(() => {
  if (!existsSync(shutdownRequestPath)) return;
  rmSync(shutdownRequestPath, { force: true });
  stop("SIGTERM");
}, 100);

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

server.on("exit", (code, signal) => {
  modelServer.close();
  globalThis.clearInterval(shutdownPoll);
  rmSync(launcherPidPath, { force: true });
  try {
    rmSync(memoryRoot, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  } catch {
    // Windows 仍持有 SQLite 文件时，下一次 seed 会重建同一隔离目录。
  }

  process.exit(stopping ? 0 : (code ?? (signal ? 1 : 0)));
});

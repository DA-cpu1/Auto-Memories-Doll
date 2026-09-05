import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const port = process.argv[2] || "4173";
const projectRoot = process.cwd();
const memoryRoot = resolve(projectRoot, "e2e/.tmp/memory-root");
const sourceRoot = resolve(projectRoot, "e2e/.tmp/source");
const seedScript = resolve(projectRoot, "e2e/seed.mjs");
const nextCli = resolve(projectRoot, "node_modules/next/dist/bin/next");
const launcherPidPath = resolve(projectRoot, "e2e/.tmp/web-server.pid");
const shutdownRequestPath = resolve(projectRoot, "e2e/.tmp/stop-web-server");

const seed = spawnSync(process.execPath, [seedScript], {
  env: process.env,
  stdio: "inherit",
});

if (seed.status !== 0) {
  process.exit(seed.status ?? 1);
}

writeFileSync(launcherPidPath, String(process.pid), "utf-8");
rmSync(shutdownRequestPath, { force: true });

const server = spawn(
  process.execPath,
  [nextCli, "dev", "--hostname", "127.0.0.1", "--port", port],
  {
    env: process.env,
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

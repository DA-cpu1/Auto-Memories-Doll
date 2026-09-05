import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const e2eMemoryRoot = join(process.cwd(), "e2e", ".tmp", "memory-root");
const e2eSourceRoot = join(process.cwd(), "e2e", ".tmp", "source");
const launcherPidPath = join(process.cwd(), "e2e", ".tmp", "web-server.pid");
const shutdownRequestPath = join(process.cwd(), "e2e", ".tmp", "stop-web-server");

export default async function globalTeardown() {
  if (process.platform === "win32") {
    writeFileSync(shutdownRequestPath, "stop", "utf-8");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!existsSync(launcherPidPath)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("E2E web server did not stop within 10 seconds");
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(e2eMemoryRoot, { recursive: true, force: true });
      rmSync(e2eSourceRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

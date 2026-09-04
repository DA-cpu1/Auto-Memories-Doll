import { KnowledgeAgent } from "../services/knowledge-agent";
import { RETRY_DELAYS } from "../../config/constants";
import { logger } from "../../lib/logger";

export class AuditWorker {
  private agent: KnowledgeAgent;
  private isRunning: boolean = false;

  constructor() {
    this.agent = new KnowledgeAgent();
  }

  async start(): Promise<void> {
    this.isRunning = true;
    // 上次进程退出时卡在 processing 的事件永远不会再被消费，启动时先恢复
    try {
      this.agent.recoverInterruptedEvents();
    } catch (error) {
      logger.audit.error("僵尸事件恢复失败（不阻塞启动）:", {
        error: (error as Error).message,
      });
    }
    await this.processLoop();
  }

  stop(): void {
    this.isRunning = false;
  }

  private async processLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.agent.processQueue();
      } catch (error) {
        logger.audit.error("Audit worker error:", { error: (error as Error).message });
      }
      await this.sleep(10000);
    }
  }

  async retryFailedEvents(): Promise<void> {
    const retried = this.agent.retryFailedEvents();
    if (retried > 0) {
      logger.audit.info(`重试 ${retried} 个失败事件`);
    }

    // 为重试事件设置递增延迟
    const pending = this.agent.getPendingEvents();
    for (const event of pending) {
      if (event.retryCount > 0) {
        const delay = RETRY_DELAYS[event.retryCount] || 60000;
        await this.sleep(delay);
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

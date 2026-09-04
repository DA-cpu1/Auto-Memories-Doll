import { KnowledgeAgent } from "../../server/services/knowledge-agent";

export class AuditReplayer {
  async replayPendingEvents(): Promise<void> {
    const agent = new KnowledgeAgent();

    try {
      await agent.processQueue();
    } finally {
      agent.close();
    }
  }
}

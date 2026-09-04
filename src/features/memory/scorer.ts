import { MemoryRecord } from "../../types/memory";
import { calculateHeatScore } from "../../config/scoring.config";

export class MemoryScorer {
  async calculateScore(memory: MemoryRecord, allMemories: MemoryRecord[]): Promise<number> {
    const maxAccessCount = Math.max(...allMemories.map((m) => m.accessCount), 1);
    return calculateHeatScore(memory.accessCount, memory.updatedAt, maxAccessCount);
  }

  calculateRecencyScore(updatedAt: string): number {
    const hoursSinceUpdate = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60);
    return Math.exp(-0.01 * hoursSinceUpdate);
  }

  calculateAccessScore(accessCount: number, maxAccessCount: number): number {
    if (maxAccessCount <= 0) return 0;
    return Math.log(1 + accessCount) / Math.log(1 + maxAccessCount);
  }
}

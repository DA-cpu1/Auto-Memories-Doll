import { writeFile } from "./file-manager";
import { getIndexMapPath } from "./path-resolver";
import { MemoryRecord } from "../../types/memory";

export const updateIndexMap = async (memories: MemoryRecord[]): Promise<void> => {
  const topics = new Map<string, string[]>();
  const tags = new Set<string>();

  memories.forEach((memory) => {
    const topic = memory.topic || memory.sourceType || "uncategorized";
    if (!topics.has(topic)) {
      topics.set(topic, []);
    }
    topics.get(topic)!.push(memory.id);
    memory.tags.forEach((tag) => tags.add(tag));
  });

  let content = "# 索引地图\n\n";
  content += "## 目录索引\n";
  topics.forEach((memoryIds, topic) => {
    content += `\n### ${topic}\n`;
    memoryIds.forEach((id) => {
      content += `- [${id}](./notes/${topic}/${id}.md)\n`;
    });
  });

  content += "\n## 标签索引\n";
  tags.forEach((tag) => {
    content += `- ${tag}\n`;
  });

  await writeFile(getIndexMapPath(), content);
};

import type { StudyGuide } from "../../types/study-guide";
import { studyGuideSchema } from "./schema";

const PAYLOAD_START = "<!-- study-guide-json";
const PAYLOAD_END = "-->";

export function formatStudyGuideMarkdown(guide: StudyGuide): string {
  const valid = studyGuideSchema.parse(guide);
  const lines = [
    "---",
    `schemaVersion: ${valid.schemaVersion}`,
    `topic: "${escapeYaml(valid.topic)}"`,
    `title: "${escapeYaml(valid.title)}"`,
    `memoryIds: [${valid.memoryIds.map((id) => `"${escapeYaml(id)}"`).join(", ")}]`,
    `contentHash: "${valid.contentHash}"`,
    `generatedAt: "${valid.generatedAt}"`,
    `modelAssisted: ${valid.modelAssisted}`,
    "---",
    "",
    `# ${valid.title}`,
    "",
    "## 大纲",
    "",
    ...valid.outline.map((item, index) => `${index + 1}. [${item.title}](#${item.sectionId})`),
    "",
    ...valid.sections.flatMap((section) => [
      `<a id="${section.id}"></a>`,
      `## ${section.title}`,
      "",
      section.content,
      "",
      "### 知识依据",
      "",
      ...section.memoryIds.map((id) => `- [[${id}]]`),
      "",
    ]),
    "## 来源版本",
    "",
    ...(valid.sourceVersions.length > 0
      ? valid.sourceVersions.map(
          (source) =>
            `- ${source.sourceType}: ${source.sourcePath || source.sourceId} @ ${source.revision} (${source.capturedAt})`,
        )
      : ["_现有知识未包含统一来源版本元数据_"]),
    "",
    PAYLOAD_START,
    JSON.stringify(valid),
    PAYLOAD_END,
    "",
  ];
  return lines.join("\n");
}

export function parseStudyGuideMarkdown(markdown: string): StudyGuide | null {
  const start = markdown.lastIndexOf(PAYLOAD_START);
  if (start < 0) return null;
  const payloadStart = start + PAYLOAD_START.length;
  const end = markdown.indexOf(PAYLOAD_END, payloadStart);
  if (end < 0) return null;
  try {
    return studyGuideSchema.parse(JSON.parse(markdown.slice(payloadStart, end).trim()));
  } catch {
    return null;
  }
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

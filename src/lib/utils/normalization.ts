import type {
  NormalizationReport,
  NormalizationResult,
  RemovedNoiseKind,
} from "../../types/normalization";

const TOOL_BOILERPLATE = [
  /^\s*(?:tool call|tool result|function call|function result)\s*:?\s*$/i,
  /^\s*<\/?(?:tool_call|tool_result|function_call|function_result)>\s*$/i,
  /^\s*\[tool(?: call| result)?\]\s*$/i,
];
const MESSAGE_HEADING = /^#{2,6}\s+(?:用户|AI|我|系统|user|assistant|system)\s*$/i;

export function normalizeTextWithReport(text: string): NormalizationResult {
  const counts = new Map<RemovedNoiseKind, number>();
  const add = (kind: RemovedNoiseKind, count = 1) =>
    counts.set(kind, (counts.get(kind) ?? 0) + count);
  let content = text.normalize("NFC").replace(/\r\n?/g, "\n");

  // Deliberately remove non-printing ASCII controls while preserving tab and newlines.
  // eslint-disable-next-line no-control-regex
  content = content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, () => {
    add("control-character");
    return "";
  });
  content = content.replace(/\uFFFD/g, () => {
    add("invalid-encoding");
    return "";
  });

  const lines = content.split("\n");
  const filteredLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/[ \t]+$/g, "");
    if (TOOL_BOILERPLATE.some((pattern) => pattern.test(line))) {
      add("tool-boilerplate");
      continue;
    }
    if (MESSAGE_HEADING.test(line) && !nextNonEmptyLine(lines, index + 1)) {
      add("empty-message");
      continue;
    }
    if (filteredLines.length > 0 && line && filteredLines.at(-1) === line && isLogLike(line)) {
      add("duplicate-log");
      continue;
    }
    filteredLines.push(line);
  }

  const blocks = filteredLines.join("\n").split(/\n{2,}/);
  const seen = new Set<string>();
  const uniqueBlocks: string[] = [];
  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;
    const identity = block.replace(/\s+/g, " ").toLocaleLowerCase();
    if (seen.has(identity)) {
      add("duplicate-block");
      continue;
    }
    seen.add(identity);
    uniqueBlocks.push(block);
  }

  content = uniqueBlocks.join("\n\n").trim();
  const report: NormalizationReport = {
    inputCharacters: text.length,
    outputCharacters: content.length,
    removedNoise: [...counts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => a.kind.localeCompare(b.kind)),
  };
  return { content, report };
}

export const normalizeText = (text: string): string => normalizeTextWithReport(text).content;

function nextNonEmptyLine(lines: string[], start: number): string | undefined {
  for (let index = start; index < lines.length; index += 1) {
    const value = lines[index].trim();
    if (!value) continue;
    return MESSAGE_HEADING.test(value) ? undefined : value;
  }
  return undefined;
}

function isLogLike(line: string): boolean {
  return /^(?:\[?\d{2}:\d{2}:\d{2}|(?:debug|info|warn|error|trace)\b|\s+at\s)/i.test(line);
}

export const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + "...";
};

export const sanitizeFilename = (filename: string): string => {
  return filename.replace(/[\\/:*?"<>|]/g, "_");
};

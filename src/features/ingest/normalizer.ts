import { InputEvent } from "../../types/event";
import { normalizeText, normalizeTextWithReport } from "../../lib/utils/normalization";
import type { NormalizationReport } from "../../types/normalization";
import { generateId } from "../../lib/utils/id";
import { getCurrentTime } from "../../lib/utils/date";

export class InputNormalizer {
  normalizeWithReport(input: unknown): { events: InputEvent[]; report: NormalizationReport } {
    const items = Array.isArray(input) ? input : [input];
    const normalized = items.map((item) => this.normalizeItemWithReport(item));
    return {
      events: normalized.map((item) => item.event),
      report: mergeReports(normalized.map((item) => item.report)),
    };
  }

  normalize(input: unknown): InputEvent[] {
    if (Array.isArray(input)) {
      return input.map((item) => this.normalizeItem(item));
    }

    return [this.normalizeItem(input)];
  }

  private normalizeItem(input: unknown): InputEvent {
    const now = getCurrentTime();

    if (typeof input === "string") {
      return {
        id: generateId(),
        source: "manual",
        sourceType: "manual",
        content: normalizeText(input),
        timestamp: now,
      };
    }

    if (input && typeof input === "object") {
      const obj = input as Record<string, any>;
      return {
        id: obj.id || generateId(),
        source: obj.source || "unknown",
        sourceType: obj.sourceType || "manual",
        content: normalizeText(obj.content || ""),
        timestamp: obj.timestamp || now,
        sessionId: obj.sessionId,
        metadata: obj.metadata,
      };
    }

    return {
      id: generateId(),
      source: "unknown",
      sourceType: "manual",
      content: "",
      timestamp: now,
    };
  }

  private normalizeItemWithReport(input: unknown): {
    event: InputEvent;
    report: NormalizationReport;
  } {
    const event = this.normalizeItem(input);
    const normalized = normalizeTextWithReport(
      typeof input === "string"
        ? input
        : input && typeof input === "object"
          ? String((input as Record<string, unknown>).content ?? "")
          : "",
    );
    return { event: { ...event, content: normalized.content }, report: normalized.report };
  }
}

function mergeReports(reports: NormalizationReport[]): NormalizationReport {
  const counts = new Map<string, number>();
  for (const report of reports) {
    for (const item of report.removedNoise) {
      counts.set(item.kind, (counts.get(item.kind) ?? 0) + item.count);
    }
  }
  return {
    inputCharacters: reports.reduce((sum, report) => sum + report.inputCharacters, 0),
    outputCharacters: reports.reduce((sum, report) => sum + report.outputCharacters, 0),
    removedNoise: [...counts.entries()].map(([kind, count]) => ({
      kind: kind as NormalizationReport["removedNoise"][number]["kind"],
      count,
    })),
  };
}

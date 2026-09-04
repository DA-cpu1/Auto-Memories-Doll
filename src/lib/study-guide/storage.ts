import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { StudyGuide } from "../../types/study-guide";
import { recordWrite } from "../storage/write-tracker";
import { ensureDirectory } from "../storage/file-manager";
import { formatStudyGuideMarkdown, parseStudyGuideMarkdown } from "./markdown";

export async function readStudyGuide(path: string): Promise<StudyGuide | null> {
  try {
    return parseStudyGuideMarkdown(await fs.readFile(path, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function publishStudyGuideAtomically(path: string, guide: StudyGuide): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const markdown = formatStudyGuideMarkdown(guide);
  try {
    await fs.writeFile(temporaryPath, markdown, { encoding: "utf-8", flag: "wx" });
    const verified = parseStudyGuideMarkdown(await fs.readFile(temporaryPath, "utf-8"));
    if (!verified || verified.contentHash !== guide.contentHash) {
      throw new Error("主题学习资料临时文件验证失败");
    }
    await fs.rename(temporaryPath, path);
    recordWrite(path);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

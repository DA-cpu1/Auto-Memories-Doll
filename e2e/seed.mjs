import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const memoryRoot = resolve(process.cwd(), "e2e/.tmp/memory-root");
const sourceRoot = resolve(process.cwd(), "e2e/.tmp/source");
rmSync(memoryRoot, { recursive: true, force: true });
rmSync(sourceRoot, { recursive: true, force: true });
mkdirSync(memoryRoot, { recursive: true });
mkdirSync(sourceRoot, { recursive: true });

writeFileSync(
  join(sourceRoot, "observable-agent-loop.md"),
  [
    "# 可观察的 KnowledgeAgent 循环",
    "",
    "来源文件先生成稳定 revision，再经过解析、去噪、分块和候选入队。",
    "模型不可用时质量判断必须 fail-closed 转入人工审核，不能直接发布。",
    "人工接受后，系统沿用同一 memoryId 写入 Markdown，并刷新关键词索引、向量索引和主题学习资料。",
    "主题资料中的每一节都保留知识 ID 与来源版本，便于追溯和重建。",
  ].join("\n"),
  "utf-8",
);

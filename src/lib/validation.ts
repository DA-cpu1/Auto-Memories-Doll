import { z } from "zod";

const modelTierSchema = z.object({
  model: z.string().min(1, "model 不能为空"),
  maxTokens: z.number().int().min(1).max(131072),
  temperature: z.number().min(0).max(2),
  timeout: z.number().int().min(1000).max(120000),
  maxRetries: z.number().int().min(0).max(10),
});

const embeddingSchema = z.object({
  model: z.string().min(1, "embedding model 不能为空"),
  dimensions: z.number().int().min(1).max(8192),
  maxConcurrency: z.number().int().min(1).max(50),
  queueTimeoutMs: z.number().int().min(1000).max(300000),
  // embedding 可走不同提供商：key/baseURL 可选，留空回落共享配置
  apiKey: z.string().optional(),
  baseURL: z
    .union([z.string().url("embedding baseURL 必须是有效的 URL"), z.literal("")])
    .optional(),
});

export const aiConfigSchema = z.object({
  provider: z.string().trim().min(1, "provider 不能为空"),
  baseURL: z.string().url("baseURL 必须是有效的 URL"),
  apiKey: z.string().min(1, "apiKey 不能为空"),
  flagship: modelTierSchema,
  standard: modelTierSchema,
  budget: modelTierSchema,
  embedding: embeddingSchema,
});

export const memoryCreateSchema = z.object({
  title: z.string().min(1, "标题不能为空"),
  content: z.string().min(1, "内容不能为空"),
  summary: z.string().default(""),
  tags: z.array(z.string()).default([]),
  sourceType: z.enum(["chat", "ingest", "manual", "mcp", "skill"]).default("manual"),
});

export const memoryUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sourceType: z.enum(["chat", "ingest", "manual", "mcp", "skill"]).optional(),
});

export const ingestRequestSchema = z.object({
  content: z.string().min(1, "内容不能为空"),
  format: z.enum(["text", "markdown", "json"]).default("text"),
});

const notesPathSchema = z
  .string()
  .trim()
  .min(1, "notesPath 不能为空")
  .refine(
    (notesPath) => notesPath !== "." && notesPath !== ".." && !notesPath.includes(".."),
    "路径不合法：不允许使用 .. 进行路径遍历",
  );

export const storageConfigUpdateSchema = z
  .object({
    notesPath: notesPathSchema,
    copyExisting: z.boolean().default(true),
  })
  .strict();

export const storageConfigPreviewSchema = z
  .object({
    notesPath: notesPathSchema,
  })
  .strict();

export const toolTypeSchema = z.enum([
  "codex",
  "claude-code",
  "cursor",
  "trae",
  "markdown",
  "text",
]);

const optionalTrimmedTextSchema = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional();

export const toolSourceCreateSchema = z
  .object({
    name: z.string().trim().min(1, "name 不能为空"),
    toolType: toolTypeSchema,
    path: z.string().trim().min(1, "path 不能为空"),
    filePattern: z.string().trim().min(1, "filePattern 不能为空").default("*.jsonl"),
    enabled: z.boolean().default(true),
    topic: optionalTrimmedTextSchema,
    description: optionalTrimmedTextSchema,
  })
  .strict();

export const toolSourceUpdateSchema = z
  .object({
    name: z.string().trim().min(1, "name 不能为空").optional(),
    toolType: toolTypeSchema.optional(),
    path: z.string().trim().min(1, "path 不能为空").optional(),
    filePattern: z.string().trim().min(1, "filePattern 不能为空").optional(),
    enabled: z.boolean().optional(),
    topic: optionalTrimmedTextSchema,
    description: optionalTrimmedTextSchema,
  })
  .strict()
  .refine((updates) => Object.keys(updates).length > 0, "至少提供一个可更新字段");

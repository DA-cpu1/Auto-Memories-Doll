import { z } from "zod";

export const studyGuideOutlineItemSchema = z.object({
  sectionId: z.string().min(1),
  title: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine((title) => !/[\r\n]/.test(title)),
});

export const studyGuideSectionSchema = z.object({
  id: z.string().min(1),
  title: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine((title) => !/[\r\n]/.test(title)),
  content: z.string().min(1),
  memoryIds: z.array(z.string().min(1)).min(1),
});

export const studyGuideSourceVersionSchema = z.object({
  sourceId: z.string().min(1),
  revision: z.string().min(1),
  sourceType: z.string().min(1),
  sourcePath: z.string().min(1).optional(),
  capturedAt: z.string().datetime(),
  memoryIds: z.array(z.string().min(1)).min(1),
});

export const studyGuideSchema = z
  .object({
    schemaVersion: z.literal(1),
    topic: z.string().min(1),
    title: z.string().min(1),
    outline: z.array(studyGuideOutlineItemSchema).min(1),
    sections: z.array(studyGuideSectionSchema).min(1),
    memoryIds: z.array(z.string().min(1)).min(1),
    sourceVersions: z.array(studyGuideSourceVersionSchema).min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    generatedAt: z.string().datetime(),
    modelAssisted: z.boolean(),
  })
  .superRefine((guide, ctx) => {
    const memoryIds = new Set(guide.memoryIds);
    const sectionIds = new Set(guide.sections.map((section) => section.id));
    const citedIds = guide.sections.flatMap((section) => section.memoryIds);

    if (sectionIds.size !== guide.sections.length) {
      ctx.addIssue({ code: "custom", path: ["sections"], message: "章节 ID 不得重复" });
    }
    if (guide.outline.some((item) => !sectionIds.has(item.sectionId))) {
      ctx.addIssue({ code: "custom", path: ["outline"], message: "大纲引用了不存在的章节" });
    }
    if (citedIds.some((id) => !memoryIds.has(id))) {
      ctx.addIssue({ code: "custom", path: ["sections"], message: "章节包含非法知识引用" });
    }
    if (
      memoryIds.size !== guide.memoryIds.length ||
      citedIds.length !== memoryIds.size ||
      new Set(citedIds).size !== memoryIds.size
    ) {
      ctx.addIssue({ code: "custom", path: ["memoryIds"], message: "知识引用必须完整且唯一" });
    }
    const sourcedIds = new Set(guide.sourceVersions.flatMap((source) => source.memoryIds));
    if (guide.memoryIds.some((id) => !sourcedIds.has(id))) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceVersions"],
        message: "每条知识必须关联来源版本",
      });
    }
  });

export const studyGuideGenerateRequestSchema = z
  .object({
    modelAssist: z.boolean().default(false),
    force: z.boolean().default(false),
  })
  .strict();

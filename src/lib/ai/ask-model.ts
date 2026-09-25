import { generateText, stepCountIs, streamText, tool, type ToolSet } from "ai";
import { ASK_MAX_STEPS, ASK_MODEL_TYPE, ASK_TIMEOUT_MS } from "../../config/ask.config";
import { AskLoopMode, AskToolTraceEntry, AskUsage } from "../../types/ask";
import { parseModelObject } from "./model-json";
import { createLanguageModel } from "./provider";
import {
  ASK_TOOL_DESCRIPTIONS,
  ASK_TOOL_NAMES,
  AskToolkit,
  readMemorySchema,
  readSourceDocumentSchema,
  readTopicGuideSchema,
  searchMemorySchema,
  summarizeToolResult,
} from "../../server/services/ask-tools";
import { KnowledgeConfigService } from "../../server/services/knowledge-config-service";

/**
 * 问答 Agent 的模型边界。与 KnowledgeModelAdapter（刻意非流式的知识加工边界）分离：
 * 这里需要 streamText + tools 的多步循环，且答案要流式回传前端。
 *
 * 执行链：原生流式工具循环 →（失败前无任何活动时）非流式缓冲循环 →（仍失败）JSON 手工循环。
 * "活动"指已发出的 token 或已执行的工具；一旦有活动就不再降级（重复执行会产生
 * 重复副作用与重复计费），直接把错误抛给上层。
 */

export const ASK_SYSTEM_PROMPT = `你是本地知识库的问答助手。回答用户提问时必须遵守：

1. 先用工具取证：任何事实性回答前，先调用 search_memory 检索候选记忆，再用 read_memory 读取原文；只有读到原文才能引用。
2. 只依据工具读到的内容回答，禁止使用你自己的参数化知识编造事实。
3. 用中文直接回答，不要复述问题。
4. 答案末尾必须附引用区块，格式严格为：
<citations>
[{"memoryId": "记忆ID", "quote": "原文片段"}]
</citations>
   - quote 必须是从 read_memory 读到的 content 或 summary 中逐字摘录的片段（至少 6 个字符），不得改写、不得拼接。
   - 每条支撑性结论都要有引用；多个来源用多个对象。
5. 如果检索与阅读后仍找不到可支撑答案的依据：直接说明"库内未找到依据"，并简述还缺什么信息（例如"未找到关于 X 的记录，可尝试导入相关会话"），引用区块写 []。
6. 回答主题全局性问题时可用 read_topic_guide；需要原始来源全文时可用 read_source_document。`;

export type AskLoopEvent =
  | { type: "tool_call"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; resultSummary: string }
  | { type: "token"; text: string };

export type AskLoopResult = {
  mode: AskLoopMode;
  answerText: string;
  usage: AskUsage;
  toolTrace: AskToolTraceEntry[];
  finishReason: string;
};

export type AskLoopOptions = {
  question: string;
  toolkit: AskToolkit;
  onEvent?: (event: AskLoopEvent) => void;
  signal?: AbortSignal;
};

/** 循环在产生任何活动（token/工具）之前失败——此时降级重试是安全的 */
class LoopFailedBeforeActivity extends Error {
  constructor(public readonly failure: unknown) {
    super("ask loop failed before producing any activity");
    this.name = "LoopFailedBeforeActivity";
  }
}

export function getAskModelId(): string {
  const service = new KnowledgeConfigService();
  try {
    const config = service.getAiConfig() || service.getDefaultAiConfig();
    return config[ASK_MODEL_TYPE].model;
  } finally {
    service.close();
  }
}

export async function runAskLoop(options: AskLoopOptions): Promise<AskLoopResult> {
  const trace: AskToolTraceEntry[] = [];
  try {
    return await runStreamLoop(options, trace);
  } catch (error) {
    if (!(error instanceof LoopFailedBeforeActivity)) throw error;
    return await runBufferedLoop(options, trace);
  }
}

async function runStreamLoop(
  options: AskLoopOptions,
  trace: AskToolTraceEntry[],
): Promise<AskLoopResult> {
  let sawActivity = false;
  const markActivity = () => {
    sawActivity = true;
  };

  const tools = buildTracedTools(options.toolkit, trace, options.onEvent, markActivity);
  const result = streamText({
    model: createLanguageModel(ASK_MODEL_TYPE),
    system: ASK_SYSTEM_PROMPT,
    prompt: options.question,
    tools,
    stopWhen: stepCountIs(ASK_MAX_STEPS),
    abortSignal: options.signal,
    timeout: ASK_TIMEOUT_MS,
  });

  let answerText = "";
  try {
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        markActivity();
        answerText += part.text;
        options.onEvent?.({ type: "token", text: part.text });
      } else if (part.type === "tool-call" || part.type === "tool-result") {
        markActivity();
      } else if (part.type === "error") {
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
      // reasoning-delta（<think> 块）刻意忽略：不进入答案也不回传前端
    }
  } catch (error) {
    if (sawActivity || trace.length > 0) throw error;
    throw new LoopFailedBeforeActivity(error);
  }

  const usage = await result.usage;
  return {
    mode: "stream",
    answerText,
    usage: toAskUsage(usage),
    toolTrace: trace,
    finishReason: String(await result.finishReason),
  };
}

async function runBufferedLoop(
  options: AskLoopOptions,
  trace: AskToolTraceEntry[],
): Promise<AskLoopResult> {
  try {
    const tools = buildTracedTools(options.toolkit, trace, options.onEvent, undefined);
    const result = await generateText({
      model: createLanguageModel(ASK_MODEL_TYPE),
      system: ASK_SYSTEM_PROMPT,
      prompt: options.question,
      tools,
      stopWhen: stepCountIs(ASK_MAX_STEPS),
      abortSignal: options.signal,
      timeout: ASK_TIMEOUT_MS,
    });

    return {
      mode: "buffered",
      answerText: result.text ?? "",
      usage: toAskUsage(result.usage),
      toolTrace: trace,
      finishReason: String(result.finishReason),
    };
  } catch {
    // tools 参数不被端点支持（或再次失败）时退到 JSON 手工循环；
    // 工具全部只读，此前已执行的调用保留在 trace 中不回滚
    return runJsonLoop(options, trace);
  }
}

/**
 * JSON 手工循环（ReAct 式）：模型不带 tools 参数，每轮只输出一个 JSON 指令
 * （调用工具或给出最终答案），由本层解析并执行。兼容不支持 function
 * calling 但支持纯文本生成的端点。
 */
async function runJsonLoop(
  options: AskLoopOptions,
  trace: AskToolTraceEntry[],
): Promise<AskLoopResult> {
  const model = createLanguageModel(ASK_MODEL_TYPE);
  const toolCatalog = Object.values(ASK_TOOL_NAMES)
    .map((name) => `- ${name}: ${ASK_TOOL_DESCRIPTIONS[name]}`)
    .join("\n");

  const system = `${ASK_SYSTEM_PROMPT}

【输出协议】你不具备原生工具调用能力。每轮只输出一个 JSON 对象（不要输出其他文字）：
- 需要调用工具时：{"action": {"tool": "<工具名>", "args": {<参数>}}}
- 能给出最终答案时：{"final": "<完整答案，含 <citations> 引用区块>"}
可用工具：
${toolCatalog}`;

  const conversation: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: options.question },
  ];
  const usage: AskUsage = { promptTokens: 0, completionTokens: 0 };

  for (let step = 0; step < ASK_MAX_STEPS; step++) {
    const result = await generateText({
      model,
      system,
      messages: conversation,
      abortSignal: options.signal,
      timeout: ASK_TIMEOUT_MS,
    });
    const stepUsage = toAskUsage(result.usage);
    usage.promptTokens += stepUsage.promptTokens;
    usage.completionTokens += stepUsage.completionTokens;

    const parsed = parseModelObject(result.text) as
      { action?: { tool?: string; args?: Record<string, unknown> } } | { final?: string } | null;

    if (parsed && "final" in parsed && typeof parsed.final === "string") {
      return {
        mode: "json-loop",
        answerText: parsed.final,
        usage,
        toolTrace: trace,
        finishReason: "stop",
      };
    }

    if (
      parsed &&
      "action" in parsed &&
      parsed.action &&
      typeof parsed.action.tool === "string" &&
      parsed.action.args &&
      typeof parsed.action.args === "object"
    ) {
      const executed = await executeToolInstruction(
        options.toolkit,
        trace,
        options.onEvent,
        parsed.action.tool,
        parsed.action.args,
      );
      conversation.push({ role: "assistant", content: result.text });
      conversation.push({
        role: "user",
        content: `工具执行结果（JSON）：\n${JSON.stringify(executed).slice(0, 8000)}\n\n请继续：需要更多信息就输出下一个 action JSON，证据足够就输出 final JSON。`,
      });
      continue;
    }

    throw new Error(`JSON 循环第 ${step + 1} 轮输出无法解析: ${result.text.slice(0, 200)}`);
  }

  throw new Error(`JSON 循环达到最大步数（${ASK_MAX_STEPS}）仍未给出最终答案`);
}

async function executeToolInstruction(
  toolkit: AskToolkit,
  trace: AskToolTraceEntry[],
  onEvent: ((event: AskLoopEvent) => void) | undefined,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const start = Date.now();
  onEvent?.({ type: "tool_call", tool: toolName, args });

  const result = await dispatchTool(toolkit, toolName, args);

  const resultSummary = summarizeToolResult(toolName, result);
  trace.push({ tool: toolName, args, resultSummary, durationMs: Date.now() - start });
  onEvent?.({ type: "tool_result", tool: toolName, resultSummary });
  return result;
}

function buildTracedTools(
  toolkit: AskToolkit,
  trace: AskToolTraceEntry[],
  onEvent: ((event: AskLoopEvent) => void) | undefined,
  markActivity: () => void = () => undefined,
): ToolSet {
  const traced = (toolName: string) => {
    const handler = async (input: object): Promise<unknown> => {
      markActivity();
      return executeToolInstruction(
        toolkit,
        trace,
        onEvent,
        toolName,
        input as Record<string, unknown>,
      );
    };
    return handler;
  };

  return {
    [ASK_TOOL_NAMES.searchMemory]: tool({
      description: ASK_TOOL_DESCRIPTIONS[ASK_TOOL_NAMES.searchMemory],
      inputSchema: searchMemorySchema,
      execute: traced(ASK_TOOL_NAMES.searchMemory),
    }),
    [ASK_TOOL_NAMES.readMemory]: tool({
      description: ASK_TOOL_DESCRIPTIONS[ASK_TOOL_NAMES.readMemory],
      inputSchema: readMemorySchema,
      execute: traced(ASK_TOOL_NAMES.readMemory),
    }),
    [ASK_TOOL_NAMES.readSourceDocument]: tool({
      description: ASK_TOOL_DESCRIPTIONS[ASK_TOOL_NAMES.readSourceDocument],
      inputSchema: readSourceDocumentSchema,
      execute: traced(ASK_TOOL_NAMES.readSourceDocument),
    }),
    [ASK_TOOL_NAMES.readTopicGuide]: tool({
      description: ASK_TOOL_DESCRIPTIONS[ASK_TOOL_NAMES.readTopicGuide],
      inputSchema: readTopicGuideSchema,
      execute: traced(ASK_TOOL_NAMES.readTopicGuide),
    }),
  };
}

async function dispatchTool(
  toolkit: AskToolkit,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case ASK_TOOL_NAMES.searchMemory:
      return toolkit.searchMemory(searchMemorySchema.parse(args));
    case ASK_TOOL_NAMES.readMemory:
      return toolkit.readMemory(readMemorySchema.parse(args));
    case ASK_TOOL_NAMES.readSourceDocument:
      return toolkit.readSourceDocument(readSourceDocumentSchema.parse(args));
    case ASK_TOOL_NAMES.readTopicGuide:
      return toolkit.readTopicGuide(readTopicGuideSchema.parse(args));
    default:
      return { ok: false, error: `未知工具: ${toolName}` };
  }
}

function toAskUsage(usage: { inputTokens?: number; outputTokens?: number } | undefined): AskUsage {
  return {
    promptTokens: usage?.inputTokens ?? 0,
    completionTokens: usage?.outputTokens ?? 0,
  };
}

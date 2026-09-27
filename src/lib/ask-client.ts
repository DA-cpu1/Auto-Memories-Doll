import { AskStreamEvent, AskStats } from "../types/ask";

/**
 * POST /api/ask 的 SSE 消费端。
 * 不走 requestApi（它强制 response.json()），直接读流并按空行分帧。
 */

export type AskStreamCallbacks = {
  onEvent: (event: AskStreamEvent) => void;
  signal?: AbortSignal;
};

export async function askQuestionStream(
  question: string,
  callbacks: AskStreamCallbacks,
): Promise<void> {
  const response = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
    signal: callbacks.signal,
  });

  if (!response.ok) {
    throw await toRequestError(response);
  }
  if (!response.body) {
    throw new Error("问答服务未返回流");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let hasOutcome = false;

  const flushFrame = (frame: string) => {
    for (const line of frame.split("\n")) {
      if (line.startsWith("data: ")) {
        let event: AskStreamEvent;
        try {
          event = JSON.parse(line.slice(6)) as AskStreamEvent;
        } catch {
          // 忽略无法解析的帧，保持流继续
          continue;
        }
        if (event.type === "citations" || event.type === "refusal" || event.type === "error")
          hasOutcome = true;
        callbacks.onEvent(event);
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex: number;
    while ((separatorIndex = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      flushFrame(frame);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) flushFrame(buffer);
  if (!hasOutcome) throw new Error("问答连接提前结束，请重试。");
}

export async function fetchAskStats(): Promise<AskStats> {
  const response = await fetch("/api/ask");
  if (!response.ok) {
    throw await toRequestError(response);
  }
  const payload = (await response.json()) as { success: boolean; data?: { stats: AskStats } };
  if (!payload.success || !payload.data) {
    throw new Error("问答统计不可用");
  }
  return payload.data.stats;
}

async function toRequestError(response: Response): Promise<Error> {
  try {
    const payload = (await response.json()) as { error?: { message?: string; code?: string } };
    if (payload.error?.message) {
      return new Error(payload.error.message);
    }
  } catch {
    // 非 JSON 错误体
  }
  return new Error(`问答请求失败（HTTP ${response.status}）`);
}

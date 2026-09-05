// Synthetic Desktop/CLI structures, observed locally on 2026-09-05.
export const event = (type: string, payload: Record<string, unknown>) => ({ type, payload });
export const meta = event("session_meta", {
  id: "synthetic-session",
  source: "vscode",
  thread_source: "user",
});
export const start = (turn_id = "turn-1") => event("event_msg", { type: "task_started", turn_id });
export const user = (message = "Explain the parser", turn_id = "turn-1") =>
  event("event_msg", { type: "user_message", message, turn_id });
export const final = (
  answer = "The parser selects completed dialogue.",
  phase = "final_answer",
  turn_id = "turn-1",
) =>
  event("response_item", {
    type: "message",
    role: "assistant",
    phase,
    turn_id,
    content: [{ type: "output_text", text: answer }],
  });
export const complete = (last_agent_message: string | null = null, turn_id = "turn-1") =>
  event("event_msg", { type: "task_complete", turn_id, last_agent_message });
export const item = (type: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  event("event_msg", {
    type: "item_completed",
    turn_id: "turn-1",
    item: { type, content, ...extra },
  });
export const responseUser = (texts: string[], kinds?: string[]) =>
  event("response_item", {
    type: "message",
    role: "user",
    content: texts.map((text) => ({ type: "input_text", text })),
    internal_chat_message_metadata_passthrough: { turn_id: "turn-1", content_item_kinds: kinds },
  });
export const jsonl = (...events: unknown[]) =>
  events.map((value) => JSON.stringify(value)).join("\n") + "\n";
export const sentinel = "EXCLUDED_UNIQUE_SENTINEL_927";
export const noise = [
  event("response_item", { type: "reasoning", summary: sentinel }),
  event("response_item", { type: "function_call_output", output: sentinel }),
  final(sentinel, "commentary"),
  final(sentinel, "analysis"),
  responseUser(
    [sentinel, sentinel],
    ["agents_md.instructions", "environments.environment_context"],
  ),
  event("event_msg", { type: "token_count", info: sentinel }),
];

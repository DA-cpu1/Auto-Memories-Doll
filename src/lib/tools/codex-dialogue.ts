import { z } from "zod";
import type { CodexDialogueDiagnostics } from "../../types/codex-dialogue";

const envelopeSchema = z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()) });
const metadataSchema = z.object({
  turn_id: z.string().optional(),
  content_item_kinds: z.array(z.string()).optional(),
});
const messageSchema = z.object({
  type: z.string(),
  id: z.string().nullish(),
  client_id: z.string().nullish(),
  role: z.string().optional(),
  phase: z.string().nullish(),
  content: z.array(z.unknown()),
  content_item_kinds: z.array(z.string()).optional(),
  internal_chat_message_metadata_passthrough: metadataSchema.nullish(),
});
const textSchema = z.object({
  type: z.enum(["text", "Text", "input_text", "output_text"]),
  text: z.string(),
});
const boundarySchema = z.object({ turn_id: z.string().min(1) });
const cliMessageSchema = z.object({ message: z.string(), phase: z.string().nullish() });
const completionSchema = boundarySchema.extend({ last_agent_message: z.string().nullish() });
const sessionSchema = z.object({
  id: z.string().optional(),
  session_id: z.string().optional(),
  source: z.enum(["cli", "vscode", "desktop"]),
  parent_thread_id: z.null().optional(),
  thread_source: z.literal("user").nullish(),
});

type Message = { role: "user" | "assistant"; content: string };
type User = Message & { ids: Set<string>; channels: Set<string> };
type Turn = { users: User[]; final?: string; closed: boolean; broken: boolean };

/** Pure, fail-closed adapter. Raw payloads never leave this function. */
export function parseCodexDialogue(raw: string): {
  messages: Message[];
  diagnostics: CodexDialogueDiagnostics;
} {
  const diagnostics: CodexDialogueDiagnostics = {
    policyVersion: "codex-final-dialogue-v1",
    retainedUsers: 0,
    retainedFinals: 0,
    completedTurns: 0,
    incompleteTurns: 0,
    orphanFinals: 0,
    truncated: false,
    excluded: {
      reasoning: 0,
      tool: 0,
      nonFinal: 0,
      context: 0,
      duplicate: 0,
      unknown: 0,
      invalid: 0,
    },
    reasons: [],
  };
  const counts = diagnostics.excluded;
  const turns = new Map<string, Turn>();
  const messageTurns = new Map<string, Turn>();
  const unresolvedFinals: Array<{ id: string; content: string }> = [];
  let current: string | undefined;
  let trustedSession = false;
  let unsupportedSession = false;
  let sessionId: string | undefined;
  const reason = (value: CodexDialogueDiagnostics["reasons"][number]) => {
    if (!diagnostics.reasons.includes(value)) diagnostics.reasons.push(value);
  };
  const breakBoundary = () => {
    const turn = current ? turns.get(current) : undefined;
    if (turn && !turn.final) turn.broken = true;
    current = undefined;
  };
  const text = (blocks: unknown[], kinds?: string[]): string =>
    blocks
      .flatMap((block, index) => {
        if (kinds && kinds[index] !== "user.text") {
          counts.context++;
          return [];
        }
        const parsed = textSchema.safeParse(block);
        if (!parsed.success) {
          counts.context++;
          return [];
        }
        return [parsed.data.text];
      })
      .join("\n")
      .trim();
  const addFinal = (turn: Turn | undefined, content: string) => {
    if (!content) return;
    if (!turn || !turn.users.length) {
      diagnostics.orphanFinals++;
      reason("orphan_final");
      return;
    }
    if (turn.final !== undefined) {
      if (turn.final === content) counts.duplicate++;
      else {
        turn.broken = true;
        reason("ambiguous_turn");
      }
    } else if (!turn.closed) turn.final = content;
  };
  const addUser = (turn: Turn | undefined, content: string, channel: string, id?: string) => {
    if (!turn || !content) {
      counts.context++;
      return;
    }
    const mirror =
      (id ? turn.users.find((user) => user.ids.has(id)) : undefined) ??
      turn.users.find((user) => user.content === content && !user.channels.has(channel));
    if (mirror) {
      if (mirror.content !== content) {
        turn.broken = true;
        reason("ambiguous_turn");
      } else {
        mirror.channels.add(channel);
        if (id) mirror.ids.add(id);
        counts.duplicate++;
      }
      return;
    }
    if (turn.closed || turn.final) {
      counts.context++;
      return;
    }
    turn.users.push({
      role: "user",
      content,
      ids: new Set(id ? [id] : []),
      channels: new Set([channel]),
    });
  };

  const lines = raw.split("\n");
  for (const [lineIndex, line] of lines.entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      counts.invalid++;
      if (lineIndex < lines.length - 1) breakBoundary();
      continue;
    }
    const envelope = envelopeSchema.safeParse(value);
    if (!envelope.success) {
      counts.invalid++;
      breakBoundary();
      continue;
    }
    const { type, payload: p } = envelope.data;
    if (type === "session_meta") {
      const session = sessionSchema.safeParse(p);
      if (!session.success || trustedSession) unsupportedSession = true;
      trustedSession = session.success;
      if (session.success) sessionId = session.data.session_id ?? session.data.id;
      continue;
    }
    if (!trustedSession || unsupportedSession) {
      counts.context++;
      reason("unsupported_format");
      continue;
    }
    if (typeof p.thread_id === "string" && sessionId && p.thread_id !== sessionId) {
      counts.context++;
      reason("unsupported_format");
      continue;
    }
    if (
      ["source", "message_source", "origin"].some(
        (key) => p[key] !== undefined && p[key] !== "user",
      )
    ) {
      counts.context++;
      continue;
    }
    const kind = type === "event_msg" ? p.type : type;
    if (kind === "task_started" || kind === "turn_context") {
      const boundary = boundarySchema.safeParse(p);
      if (!boundary.success) {
        counts.invalid++;
        breakBoundary();
        continue;
      }
      current = boundary.data.turn_id;
      if (!turns.has(current)) turns.set(current, { users: [], closed: false, broken: false });
      continue;
    }
    const meta = metadataSchema.safeParse(p.internal_chat_message_metadata_passthrough);
    const turnId =
      typeof p.turn_id === "string"
        ? p.turn_id
        : meta.success
          ? (meta.data.turn_id ?? current)
          : current;
    const turn = turnId ? turns.get(turnId) : undefined;
    if (kind === "task_complete") {
      const complete = completionSchema.safeParse(p);
      if (!complete.success) {
        counts.invalid++;
        breakBoundary();
        continue;
      }
      const target = turns.get(complete.data.turn_id);
      const snapshot = complete.data.last_agent_message?.trim();
      if (snapshot) addFinal(target, snapshot);
      if (target) target.closed = true;
      continue;
    }
    if (kind === "turn_aborted" || kind === "task_failed") {
      if (turn) turn.closed = true;
      current = undefined;
      continue;
    }
    if (kind === "user_message" || kind === "agent_message") {
      const parsed = cliMessageSchema.safeParse(p);
      if (!parsed.success) {
        counts.invalid++;
        continue;
      }
      if (kind === "user_message") addUser(turn, parsed.data.message.trim(), "cli");
      else if (parsed.data.phase === "final" || parsed.data.phase === "final_answer")
        addFinal(turn, parsed.data.message.trim());
      else {
        counts.nonFinal++;
      }
      continue;
    }
    if (type === "response_item" || kind === "item_completed") {
      const candidate = kind === "item_completed" ? p.item : p;
      const origin = z
        .object({ source: z.unknown().optional(), origin: z.unknown().optional() })
        .safeParse(candidate);
      if (
        origin.success &&
        [origin.data.source, origin.data.origin].some(
          (value) => value !== undefined && value !== "user",
        )
      ) {
        counts.context++;
        continue;
      }
      const parsed = messageSchema.safeParse(candidate);
      if (!parsed.success) {
        const itemType = z.object({ type: z.string() }).safeParse(candidate);
        const label = itemType.success ? itemType.data.type : "";
        if (["reasoning", "Reasoning"].includes(label)) counts.reasoning++;
        else if (
          [
            "function_call",
            "function_call_output",
            "custom_tool_call",
            "custom_tool_call_output",
            "CommandExecution",
            "McpToolCall",
            "WebSearch",
          ].includes(label)
        )
          counts.tool++;
        else counts.unknown++;
        continue;
      }
      const m = parsed.data;
      const channel = kind === "item_completed" ? "item" : "response";
      const isUser =
        channel === "item" ? m.type === "UserMessage" : m.type === "message" && m.role === "user";
      const isAssistant =
        channel === "item"
          ? m.type === "AgentMessage"
          : m.type === "message" && m.role === "assistant";
      if (isUser) {
        const kinds =
          m.content_item_kinds ?? m.internal_chat_message_metadata_passthrough?.content_item_kinds;
        if ((kinds && kinds.length !== m.content.length) || (channel === "response" && !kinds)) {
          counts.context++;
          continue;
        }
        addUser(turn, text(m.content, kinds), channel, m.client_id ?? m.id ?? undefined);
      } else if (isAssistant) {
        if (m.phase === "final" || m.phase === "final_answer") {
          const content = text(m.content);
          const identifiedTurn = m.id ? messageTurns.get(m.id) : undefined;
          if (channel === "item" && m.id && turn && !identifiedTurn) messageTurns.set(m.id, turn);
          if (identifiedTurn && turn && identifiedTurn !== turn) {
            identifiedTurn.broken = true;
            turn.broken = true;
          } else if (!turn && !identifiedTurn && m.id) {
            unresolvedFinals.push({ id: m.id, content });
          } else addFinal(identifiedTurn ?? turn, content);
        } else if (m.phase === "analysis" || m.phase === "commentary") counts.nonFinal++;
        else {
          counts.unknown++;
          reason("unsupported_format");
        }
      } else counts.context++;
      continue;
    }
    if (kind === "agent_reasoning") counts.reasoning++;
    else if (kind === "token_count") counts.context++;
    else counts.unknown++;
  }
  for (const message of unresolvedFinals) addFinal(messageTurns.get(message.id), message.content);
  const messages: Message[] = [];
  if (unsupportedSession || !trustedSession) reason("unsupported_format");
  else
    for (const turn of turns.values()) {
      if (turn.broken) {
        reason("ambiguous_turn");
        continue;
      }
      if (turn.users.length && turn.final) {
        messages.push(...turn.users.map(({ role, content }) => ({ role, content })), {
          role: "assistant",
          content: turn.final,
        });
        diagnostics.retainedUsers += turn.users.length;
        diagnostics.retainedFinals++;
        diagnostics.completedTurns++;
      } else if (turn.users.length) {
        diagnostics.incompleteTurns++;
        reason("no_final_answer");
      }
    }
  if (!messages.length && !diagnostics.reasons.length)
    reason(counts.unknown || counts.invalid ? "unsupported_format" : "no_dialogue");
  return { messages, diagnostics };
}

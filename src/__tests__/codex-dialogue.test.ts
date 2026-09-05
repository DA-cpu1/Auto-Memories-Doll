import { describe, expect, it } from "vitest";
import { parseCodexDialogue } from "../lib/tools/codex-dialogue";
import { parseSession } from "../lib/tools/session-parser";
import {
  complete,
  event,
  final,
  item,
  jsonl,
  meta,
  noise,
  responseUser,
  sentinel,
  start,
  user,
} from "./fixtures/codex-dialogue";

const parse = (...events: unknown[]) => parseCodexDialogue(jsonl(...events));

describe("Codex final dialogue v1", () => {
  it.each(["final", "final_answer"])("retains final phase %s and excludes all noise", (phase) => {
    const result = parse(
      meta,
      start(),
      user(),
      ...noise,
      final("Use analysis and tool commands.\n```sh\ntool result\n```", phase),
    );
    expect(result.messages).toEqual([
      { role: "user", content: "Explain the parser" },
      { role: "assistant", content: "Use analysis and tool commands.\n```sh\ntool result\n```" },
    ]);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result.diagnostics.completedTurns).toBe(1);
  });

  it("merges Desktop response/item/completion mirrors without losing blocks", () => {
    const result = parse(
      meta,
      start(),
      responseUser(["Question"], ["user.text"]),
      item("UserMessage", [{ type: "text", text: "Question" }], { id: "u1" }),
      final("First\nSecond"),
      item(
        "AgentMessage",
        [
          { type: "Text", text: "First" },
          { type: "reasoning", text: sentinel },
          { type: "Text", text: "Second" },
        ],
        { phase: "final_answer" },
      ),
      complete("First\nSecond"),
    );
    expect(result.messages.map((m) => m.content)).toEqual(["Question", "First\nSecond"]);
    expect(result.diagnostics.excluded.duplicate).toBe(3);
  });

  it("preserves same-channel repetitions, steering order, cross-turn and cross-file repetitions", async () => {
    const events = [
      meta,
      start(),
      user("Same"),
      user("Same"),
      user("Correction"),
      final(),
      complete(),
      start("turn-2"),
      user("Same", "turn-2"),
      final("Answer two", "final", "turn-2"),
    ];
    const a = parse(...events);
    expect(a.messages.map((m) => m.content)).toEqual([
      "Same",
      "Same",
      "Correction",
      "The parser selects completed dialogue.",
      "Same",
      "Answer two",
    ]);
    expect(parse(...events)).toEqual(a);
    const firstFile = await parseSession("first.jsonl", "codex", jsonl(...events));
    const secondFile = await parseSession("second.jsonl", "codex", jsonl(...events));
    expect(firstFile?.content).toBe(secondFile?.content);
    expect(firstFile?.sourceFile).toBe("first.jsonl");
    expect(secondFile?.sourceFile).toBe("second.jsonl");
  });

  it("retains completed prefix while waiting for a second turn", () => {
    const result = parse(
      meta,
      start(),
      user(),
      final(),
      complete(),
      start("turn-2"),
      user("Waiting", "turn-2"),
      ...noise,
    );
    expect(result.messages).toHaveLength(2);
    expect(result.diagnostics.reasons).toContain("no_final_answer");
  });

  it.each([undefined, "commentary", "analysis", "unknown"])(
    "does not accept assistant phase %s without completion",
    (phase) => {
      const result = parse(meta, start(), user(), final(sentinel, phase ?? ""));
      expect(result.messages).toEqual([]);
      expect(result.diagnostics.reasons).toContain("no_final_answer");
      if (!phase || phase === "unknown")
        expect(result.diagnostics.reasons).toContain("unsupported_format");
    },
  );

  it("supports explicit CLI completion fallback and excludes mismatched final mirrors", () => {
    expect(
      parse(
        meta,
        start(),
        user(),
        event("event_msg", { type: "agent_message", message: "Complete answer" }),
        complete("Complete answer"),
      ).messages.at(-1)?.content,
    ).toBe("Complete answer");
    const conflict = parse(meta, start(), user(), final("One"), complete("Two"));
    expect(conflict.messages).toEqual([]);
    expect(conflict.diagnostics.reasons).toContain("ambiguous_turn");
  });

  it("uses only structural user kinds and never guesses mismatched block positions", () => {
    const result = parse(
      meta,
      start(),
      responseUser(
        [sentinel, "<environment_context>my pasted log</environment_context>"],
        ["agents_md.instructions", "user.text"],
      ),
      final(),
    );
    expect(result.messages[0].content).toContain("my pasted log");
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(
      parse(meta, start(), responseUser([sentinel], ["user.text", "user.text"]), final()).messages,
    ).toEqual([]);
    expect(parse(meta, start(), responseUser([sentinel]), final()).messages).toEqual([]);
  });

  it("drops unknown origins, subagents, unknown formats and attachments", () => {
    for (const source of [undefined, "exec", { subagent: { other: "guardian" } }]) {
      const result = parse(event("session_meta", { source }), start(), user(sentinel), final());
      expect(result.messages).toEqual([]);
      expect(result.diagnostics.reasons).toContain("unsupported_format");
    }
    expect(
      parse(meta, start(), item("UserMessage", [{ type: "image", url: sentinel }]), final())
        .messages,
    ).toEqual([]);
    expect(
      parse(meta, { role: "user", content: sentinel }, { role: "assistant", content: sentinel })
        .messages,
    ).toEqual([]);
  });

  it("does not associate across damaged lines and recovers at a new boundary", () => {
    const raw =
      jsonl(meta, start(), user()) +
      "broken\n" +
      jsonl(
        final(),
        start("turn-2"),
        user("Good", "turn-2"),
        final("Good answer", "final", "turn-2"),
      );
    const result = parseCodexDialogue(raw);
    expect(result.messages.map((m) => m.content)).toEqual(["Good", "Good answer"]);
    expect(result.diagnostics.excluded.invalid).toBe(1);
  });

  it("waits for a partial JSON tail then emits exactly one completed turn", () => {
    const prefix = jsonl(meta, start(), user());
    const tail = JSON.stringify(final());
    expect(parseCodexDialogue(prefix + tail.slice(0, -4)).messages).toEqual([]);
    expect(parseCodexDialogue(prefix + tail).messages).toHaveLength(2);
  });

  it("ignores orphan finals, cancelled rounds and noise-only sessions with explicit reasons", () => {
    expect(parse(meta, final()).diagnostics.reasons).toContain("orphan_final");
    expect(
      parse(
        meta,
        start(),
        user(),
        event("event_msg", { type: "turn_aborted" }),
        complete("Late snapshot"),
      ).messages,
    ).toEqual([]);
    expect(parse(meta, ...noise).diagnostics.reasons).toContain("no_dialogue");
  });

  it("uses supplied snapshot without reading a later file and derives title only from user text", async () => {
    const parsed = await parseSession(
      "does-not-exist.jsonl",
      "codex",
      jsonl(meta, start(), ...noise, user("Real title"), final()),
    );
    expect(parsed?.title).toBe("Real title");
    expect(parsed?.messageCount).toBe(2);
    expect(JSON.stringify(parsed)).not.toContain(sentinel);
  });

  it("rejects internal message origins and foreign thread items inside a human session", () => {
    const internal = event("event_msg", {
      type: "user_message",
      message: sentinel,
      turn_id: "turn-1",
      source: "subagent",
    });
    const foreign = event("event_msg", {
      type: "item_completed",
      thread_id: "another-session",
      turn_id: "turn-1",
      item: { type: "UserMessage", content: [{ type: "text", text: sentinel }] },
    });
    expect(parse(meta, start(), internal, foreign, final()).messages).toEqual([]);
  });

  it("supports turn_context and CLI messages without per-message turn IDs", () => {
    const result = parse(
      event("session_meta", { id: "cli-session", source: "cli" }),
      event("turn_context", { turn_id: "turn-1" }),
      event("event_msg", { type: "user_message", message: "CLI question" }),
      event("event_msg", { type: "agent_message", message: "CLI final", phase: "final" }),
    );
    expect(result.messages.map((message) => message.content)).toEqual([
      "CLI question",
      "CLI final",
    ]);
  });

  it("remembers every mirror ID when a completed item is replayed", () => {
    const question = item("UserMessage", [{ type: "text", text: "Question" }], { id: "item-user" });
    const result = parse(
      meta,
      start(),
      responseUser(["Question"], ["user.text"]),
      question,
      question,
      final(),
    );
    expect(result.messages).toHaveLength(2);
    expect(result.diagnostics.retainedUsers).toBe(1);
  });

  it.each([true, false])(
    "matches Desktop internal response turns by item ID (response first: %s)",
    (responseFirst) => {
      const response = event("response_item", {
        type: "message",
        id: "answer-id",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Final answer" }],
        internal_chat_message_metadata_passthrough: { turn_id: "provider-subturn" },
      });
      const answer = item("AgentMessage", [{ type: "Text", text: "Final answer" }], {
        id: "answer-id",
        phase: "final_answer",
      });
      const result = parse(
        meta,
        start(),
        user(),
        ...(responseFirst ? [response, answer] : [answer, response]),
        complete("Final answer"),
      );
      expect(result.messages).toHaveLength(2);
      expect(result.diagnostics.orphanFinals).toBe(0);
      expect(result.diagnostics.excluded.duplicate).toBe(2);
    },
  );
});

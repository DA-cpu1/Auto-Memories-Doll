import { describe, it, expect } from "vitest";
import { parseModelObject } from "../lib/ai/model-json";

describe("final model JSON", () => {
  it("discards thinking examples and parses only the final object", () => {
    expect(
      parseModelObject(
        '<think>Record<Mode, { title: string }> and {"score":9}</think>\n{"score":5,"kind":"fact"}',
      ),
    ).toEqual({ score: 5, kind: "fact" });
  });
  it("supports a final fenced JSON object after closed thinking", () => {
    expect(
      parseModelObject('<think>{ broken example }</think>\n```json\n{"score":8}\n```'),
    ).toEqual({ score: 8 });
  });
  it.each([
    '<think>{"score":9}',
    '<think>{"score":9}</think>',
    '<think>{"score":9}</think>{"score":',
    '{"score":9}{"score":4}',
    "null",
    "[]",
  ])("rejects incomplete or ambiguous output: %s", (text) => {
    expect(parseModelObject(text)).toBeNull();
  });
  it("preserves literal tags and braces within final JSON strings", () => {
    const value = { content: 'Use "<think>" and { braces } literally.' };
    expect(parseModelObject(JSON.stringify(value))).toEqual(value);
  });
});

/** Only the final answer is eligible for domain validation, never a thinking example. */
export function parseModelObject(text: string): Record<string, unknown> | null {
  let answer = text.trim();
  while (answer.startsWith("<think>")) {
    const end = answer.indexOf("</think>", "<think>".length);
    if (end < 0) return null;
    answer = answer.slice(end + "</think>".length).trim();
  }
  const fence = answer.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) answer = fence[1];
  try {
    const value: unknown = JSON.parse(answer);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const deduplicateMemories = (memories: { id: string; content: string }[]): string[] => {
  const seenContent = new Set<string>();
  const duplicateIds: string[] = [];

  for (const memory of memories) {
    const normalizedContent = memory.content;

    if (seenContent.has(normalizedContent)) {
      duplicateIds.push(memory.id);
    } else {
      seenContent.add(normalizedContent);
    }
  }

  return duplicateIds;
};

export const detectDuplicates = (
  content: string,
  existingContents: string[],
): { isDuplicate: boolean; similarity: number } => {
  const isDuplicate = content.length > 0 && existingContents.includes(content);
  return { isDuplicate, similarity: isDuplicate ? 1 : 0 };
};

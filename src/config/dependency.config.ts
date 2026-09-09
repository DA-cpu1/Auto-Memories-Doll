export const dependencyConfig = {
  retryDelaysMs: [60_000, 300_000, 1_200_000],
  batchSize: 20,
  capabilityBackoffMs: 60_000,
} as const;

export const scoringConfig = {
  recencyLambda: 0.01,
  accessWeight: 0.55,
  recencyWeight: 0.45,
};

export const calculateHeatScore = (
  accessCount: number,
  updatedAt: string,
  maxAccessCount: number,
): number => {
  const accessScore =
    maxAccessCount > 0 ? Math.log(1 + accessCount) / Math.log(1 + maxAccessCount) : 0;

  const hoursSinceUpdate = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60);
  const recencyScore = Math.exp(-scoringConfig.recencyLambda * hoursSinceUpdate);

  return accessScore * scoringConfig.accessWeight + recencyScore * scoringConfig.recencyWeight;
};

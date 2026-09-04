export type RemovedNoiseKind =
  | "control-character"
  | "invalid-encoding"
  | "empty-message"
  | "duplicate-block"
  | "tool-boilerplate"
  | "duplicate-log";

export type RemovedNoise = {
  kind: RemovedNoiseKind;
  count: number;
};

export type NormalizationReport = {
  inputCharacters: number;
  outputCharacters: number;
  removedNoise: RemovedNoise[];
};

export type NormalizationResult = {
  content: string;
  report: NormalizationReport;
};

export type SourceChunk = {
  chunkId: string;
  hash: string;
  ordinal: number;
  content: string;
  locator?: string;
  boundary: "markdown-section" | "conversation-turn" | "paragraph" | "length-fallback";
};

export type StudyGuideOutlineItem = {
  sectionId: string;
  title: string;
};

export type StudyGuideSection = {
  id: string;
  title: string;
  content: string;
  memoryIds: string[];
};

export type StudyGuideSourceVersion = {
  sourceId: string;
  revision: string;
  sourceType: string;
  sourcePath?: string;
  capturedAt: string;
  memoryIds: string[];
};

export type StudyGuide = {
  schemaVersion: 1;
  topic: string;
  title: string;
  outline: StudyGuideOutlineItem[];
  sections: StudyGuideSection[];
  memoryIds: string[];
  sourceVersions: StudyGuideSourceVersion[];
  contentHash: string;
  generatedAt: string;
  modelAssisted: boolean;
};

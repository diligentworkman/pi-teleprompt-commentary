import type { AttemptResult } from "#/errors/index.ts";

export type ExistingFileReviewTarget = {
  type: "existing";
  canonicalPath: string;
};

export type NewFileReviewTarget = {
  type: "new";
  canonicalPath: string;
  nearestExistingAncestorPath: string;
  missingDirectoryPaths: Array<string>;
};

export type FileReviewTarget =
  | ExistingFileReviewTarget
  | NewFileReviewTarget;

export type FileReviewTargetClassification = AttemptResult<FileReviewTarget>;

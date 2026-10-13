import type { ResolvedCommand } from "#/config-loader/index.ts";
import type { ProcessRunner } from "#/process/index.ts";
import type { ExternalReviewOperation } from "#/review-coordinator/index.ts";

export type FileExternalReviewDecision =
  | { type: "unchanged" }
  | { type: "changed"; content: Buffer };

export type StartFileExternalReviewParameters = {
  input: {
    command: ResolvedCommand;
    proposalPath: string;
    originalProposal: Buffer;
  };
  dependencies: {
    processRunner: ProcessRunner;
    readProposal(path: string): Promise<Buffer>;
  };
};

export type FileExternalReviewOperation = ExternalReviewOperation<FileExternalReviewDecision>;

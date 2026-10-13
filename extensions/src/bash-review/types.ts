import type {
  ResolvedAction,
  ResolvedCommand,
} from "#/config-loader/index.ts";
import type { ProcessCompletion, ProcessRunner } from "#/process/index.ts";
import type { ExternalReviewOperation } from "#/review-coordinator/index.ts";
import type {
  ReviewDecisionInput,
  ReviewDecisionOutcome,
  ReviewFeedbackInput,
} from "#/review-prompts/index.ts";
import type { RuntimeTemporaryFileStore } from "#/runtime-temporary-files/index.ts";

export type BashExternalReviewDecision =
  | { type: "unchanged" }
  | { type: "changed"; suggestion: string };

export type BashExternalReviewFailure =
  | { type: "process-failed"; completion: ProcessCompletion }
  | { type: "process-observation-failed"; error: unknown }
  | { type: "command-file-read-failed"; error: unknown };

export type BashExternalReviewOutcome = Awaited<
  ExternalReviewOperation<BashExternalReviewDecision>["outcome"]
>;

export type BashExternalReviewCancellationOutcome = Awaited<
  ReturnType<ExternalReviewOperation<never>["cancel"]>
>;

export type StartBashExternalReviewInput = {
  command: ResolvedCommand;
  commandFilePath: string;
  originalCommand: string;
};

export type StartBashExternalReviewDependencies = {
  processRunner: ProcessRunner;
  readCommandFile(path: string): Promise<string>;
};

export type StartBashExternalReviewParameters = {
  input: StartBashExternalReviewInput;
  dependencies: StartBashExternalReviewDependencies;
};

export type BashReviewOutcome =
  | { type: "allowed"; feedback?: string }
  | { type: "edited"; command: string }
  | { type: "blocked"; reason: string };

export type ReviewBashCommandInput = {
  command: string;
  hasUI: boolean;
  signal?: AbortSignal;
};

export type ReviewBashCommandDependencies = {
  temporaryFileStore: RuntimeTemporaryFileStore;
  processRunner: ProcessRunner;
  resolveConfiguredAction({
    commandFilePath,
    commandString,
  }: {
    commandFilePath: string;
    commandString: string;
  }): Promise<ResolvedAction | undefined>;
  readCommandFile(path: string): Promise<string>;
  requestDecision(input: ReviewDecisionInput): Promise<ReviewDecisionOutcome>;
  requestFeedback(input: ReviewFeedbackInput): Promise<string | undefined>;
};

export type ReviewBashCommandParameters = {
  input: ReviewBashCommandInput;
  dependencies: ReviewBashCommandDependencies;
};

import type { ResolvedCommand } from "#/config-loader/index.ts";
import type {
  ReviewDecisionInput,
  ReviewDecisionOutcome,
  ReviewFeedbackInput,
} from "#/review-prompts/index.ts";

export type ReviewSubject = "file" | "command";

export type ReviewPolicyDecision = "allow" | "deny" | "prompt";

export type ReviewPolicy = ReviewPolicyDecision | ResolvedCommand;

export type ResolveReviewPolicyInput = {
  subject: ReviewSubject;
  configuredAction: ReviewPolicy | undefined;
};

export type PromptReviewInput = ReviewDecisionInput;

export type PromptReviewOutcome =
  | { type: "allowed"; feedback?: string }
  | { type: "blocked"; reason: string }
  | { type: "superseded" };

export type PromptReviewDependencies = {
  requestDecision(input: ReviewDecisionInput): Promise<ReviewDecisionOutcome>;
  requestFeedback(input: ReviewFeedbackInput): Promise<string | undefined>;
};

export type PromptReviewParameters = {
  input: PromptReviewInput;
  dependencies: PromptReviewDependencies;
};

export type ReviewPolicyEvaluationInput = {
  policy: ReviewPolicy;
  hasUI: boolean;
  signal?: AbortSignal;
};

export type ReviewPolicyEvaluationOutcome =
  | PromptReviewOutcome
  | { type: "external-review-required"; command: ResolvedCommand };

export type ReviewPolicyEvaluationDependencies = {
  conductPromptReview(input: PromptReviewInput): Promise<PromptReviewOutcome>;
};

export type ReviewPolicyEvaluationParameters = {
  input: ReviewPolicyEvaluationInput;
  dependencies: ReviewPolicyEvaluationDependencies;
};

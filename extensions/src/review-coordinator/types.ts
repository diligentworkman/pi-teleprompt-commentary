import type {
  ReviewDecisionInput,
  ReviewDecisionOutcome,
  ReviewFeedbackInput,
} from "#/review-prompts/index.ts";

export type ExternalReviewOutcome<T> =
  { type: "decided"; value: T } | { type: "failed"; error: unknown };

export type ExternalReviewCancellationOutcome =
  | { type: "not-started" }
  | { type: "cancelled" }
  | { type: "already-completed" }
  | { type: "unconfirmed"; error?: unknown };

export type ExternalReviewOperation<T> = {
  outcome: Promise<ExternalReviewOutcome<T>>;
  cancel(): Promise<ExternalReviewCancellationOutcome>;
};

export type CoordinatedReviewOutcome<T> =
  | {
      type: "prompt-accepted";
      feedback?: string;
      externalCancellation: ExternalReviewCancellationOutcome;
    }
  | {
      type: "prompt-rejected";
      feedback?: string;
      externalCancellation: ExternalReviewCancellationOutcome;
    }
  | { type: "external-decided"; value: T }
  | {
      type: "cancelled";
      externalCancellation: ExternalReviewCancellationOutcome;
    }
  | { type: "dismissed"; externalError: unknown }
  | { type: "unavailable"; externalError: unknown }
  | {
      type: "failed";
      promptFailure:
        | { type: "request-failed"; error: unknown }
        | { type: "unexpected-superseded" };
      externalError: unknown;
    };

export type CoordinateReviewInput = {
  hasUI: boolean;
  signal?: AbortSignal;
};

export type CoordinateReviewDependencies<T> = {
  startExternalReview(): ExternalReviewOperation<T>;
  requestDecision(input: ReviewDecisionInput): Promise<ReviewDecisionOutcome>;
  requestFeedback(input: ReviewFeedbackInput): Promise<string | undefined>;
};

export type CoordinateReviewParameters<T> = {
  input: CoordinateReviewInput;
  dependencies: CoordinateReviewDependencies<T>;
};

export type PromptState =
  | { type: "pending" }
  | { type: "dismissed" }
  | { type: "unavailable" }
  | { type: "superseded" }
  | { type: "failed"; error: unknown };

export type ExternalState =
  | { type: "pending" }
  | { type: "failed"; error: unknown };

export type CoordinationEvent<T> =
  | { source: "external"; outcome: ExternalReviewOutcome<T> }
  | {
      source: "prompt";
      outcome:
        | { type: "completed"; decision: ReviewDecisionOutcome }
        | { type: "failed"; error: unknown };
    }
  | { source: "caller"; type: "cancelled" };

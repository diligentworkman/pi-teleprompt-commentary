export type ReviewDecisionSelection = "Accept" | "Reject";

export type ReviewDecisionOutcome =
  | { type: "accepted" }
  | { type: "rejected" }
  | { type: "dismissed" }
  | { type: "superseded" }
  | { type: "unavailable" };

export type ReviewDecisionInput = {
  hasUI: boolean;
  signal?: AbortSignal;
};

export type ReviewDecisionDependencies = {
  selectReviewDecision({
    title,
    options,
    signal,
  }: {
    title: string;
    options: Array<string>;
    signal?: AbortSignal;
  }): Promise<string | undefined>;
};

export type ReviewDecisionParameters = {
  input: ReviewDecisionInput;
  dependencies: ReviewDecisionDependencies;
};

export type ReviewFeedbackDecision = "accepted" | "rejected";

export type ReviewFeedbackInput = {
  decision: ReviewFeedbackDecision;
  hasUI: boolean;
  signal?: AbortSignal;
};

export type ReviewFeedbackDependencies = {
  requestReviewFeedback({
    title,
    placeholder,
    signal,
  }: {
    title: string;
    placeholder: string;
    signal?: AbortSignal;
  }): Promise<string | undefined>;
};

export type ReviewFeedbackParameters = {
  input: ReviewFeedbackInput;
  dependencies: ReviewFeedbackDependencies;
};

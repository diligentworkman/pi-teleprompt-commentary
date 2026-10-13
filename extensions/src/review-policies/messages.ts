export const reviewPolicyBlockMessageTemplates = {
  denied() {
    return "Tool call denied by review policy.";
  },
  rejected(feedback?: string) {
    return feedback === undefined
      ? "Tool call rejected by user."
      : `Tool call rejected by user: ${feedback}`;
  },
  dismissed() {
    return "Tool call blocked because the review prompt was dismissed without a decision.";
  },
  unavailable() {
    return "Tool call blocked because interactive review is unavailable.";
  },
  superseded() {
    return "Tool call blocked because standalone review ended without a decision.";
  },
  externalReviewUnavailable() {
    return "Tool call blocked because its required external review workflow is unavailable.";
  },
  failed(errorMessage: string) {
    return `Tool call blocked because interactive review failed: ${errorMessage}`;
  },
} as const;

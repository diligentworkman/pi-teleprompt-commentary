import type {
  ReviewDecisionSelection,
  ReviewFeedbackDecision,
} from "./types.ts";

export const reviewDecisionMessages = {
  title: "Review tool call",
  options: ["Accept", "Reject"] as Array<ReviewDecisionSelection>,
} as const;

export const reviewFeedbackMessageTemplates = {
  title(decision: ReviewFeedbackDecision) {
    return decision === "accepted"
      ? "Optional acceptance feedback"
      : "Optional rejection feedback";
  },
  placeholder() {
    return "Leave blank to continue without feedback";
  },
} as const;

import { attempt, getErrorMessage } from "#/errors/index.ts";
import { reviewPolicyBlockMessageTemplates } from "./messages.ts";
import type {
  ReviewPolicyEvaluationOutcome,
  ReviewPolicyEvaluationParameters,
  PromptReviewOutcome,
  PromptReviewParameters,
  ResolveReviewPolicyInput,
  ReviewPolicy,
} from "./types.ts";

export { reviewPolicyBlockMessageTemplates } from "./messages.ts";

export type { ReviewPolicy } from "./types.ts";

export async function evaluateReviewPolicy({
  input: { policy, hasUI, signal },
  dependencies: { conductPromptReview },
}: ReviewPolicyEvaluationParameters): Promise<ReviewPolicyEvaluationOutcome> {
  if (Array.isArray(policy)) {
    return { type: "external-review-required", command: policy };
  }
  if (policy === "allow") {
    return { type: "allowed" };
  }
  if (policy === "deny") {
    return {
      type: "blocked",
      reason: reviewPolicyBlockMessageTemplates.denied(),
    };
  }

  return conductPromptReview({ hasUI, signal });
}

export async function conductPromptReview({
  input: { hasUI, signal },
  dependencies: { requestDecision, requestFeedback },
}: PromptReviewParameters): Promise<PromptReviewOutcome> {
  const decisionAttempt = await attempt(() =>
    requestDecision({ hasUI, signal }),
  );
  if (!decisionAttempt.success) {
    return {
      type: "blocked",
      reason: reviewPolicyBlockMessageTemplates.failed(
        getErrorMessage(decisionAttempt.error),
      ),
    };
  }
  const decision = decisionAttempt.value;
  if (decision.type === "superseded") {
    return { type: "superseded" };
  }
  if (decision.type === "dismissed") {
    return {
      type: "blocked",
      reason: reviewPolicyBlockMessageTemplates.dismissed(),
    };
  }
  if (decision.type === "unavailable") {
    return {
      type: "blocked",
      reason: reviewPolicyBlockMessageTemplates.unavailable(),
    };
  }
  const feedbackAttempt = await attempt(() =>
    requestFeedback({ decision: decision.type, hasUI, signal }),
  );
  const feedback = feedbackAttempt.success ? feedbackAttempt.value : undefined;
  if (decision.type === "rejected") {
    return {
      type: "blocked",
      reason: reviewPolicyBlockMessageTemplates.rejected(feedback),
    };
  }

  return feedback === undefined
    ? { type: "allowed" }
    : { type: "allowed", feedback };
}

export function resolveReviewPolicy({
  subject,
  configuredAction,
}: ResolveReviewPolicyInput): ReviewPolicy {
  if (configuredAction !== undefined) {
    return configuredAction;
  }

  return subject === "file" ? "prompt" : "allow";
}

export type {
  ReviewDecisionInput,
  ReviewDecisionOutcome,
  ReviewFeedbackInput,
} from "./types.ts";

import {
  reviewDecisionMessages,
  reviewFeedbackMessageTemplates,
} from "./messages.ts";
import type {
  ReviewDecisionOutcome,
  ReviewDecisionParameters,
  ReviewFeedbackParameters,
} from "./types.ts";

function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export async function requestOptionalReviewFeedback({
  input: { decision, hasUI, signal },
  dependencies: { requestReviewFeedback },
}: ReviewFeedbackParameters): Promise<string | undefined> {
  if (!hasUI || isSignalAborted(signal)) {
    return undefined;
  }
  const feedback = await requestReviewFeedback({
    title: reviewFeedbackMessageTemplates.title(decision),
    placeholder: reviewFeedbackMessageTemplates.placeholder(),
    signal,
  });

  return feedback === "" ? undefined : feedback;
}

export async function requestReviewDecision({
  input: { hasUI, signal },
  dependencies: { selectReviewDecision },
}: ReviewDecisionParameters): Promise<ReviewDecisionOutcome> {
  if (!hasUI) {
    return { type: "unavailable" };
  }
  if (isSignalAborted(signal)) {
    return { type: "superseded" };
  }
  const selection = await selectReviewDecision({
    title: reviewDecisionMessages.title,
    options: [...reviewDecisionMessages.options],
    signal,
  });
  if (isSignalAborted(signal)) {
    return { type: "superseded" };
  }
  if (selection === "Accept") {
    return { type: "accepted" };
  }
  if (selection === "Reject") {
    return { type: "rejected" };
  }

  return { type: "dismissed" };
}

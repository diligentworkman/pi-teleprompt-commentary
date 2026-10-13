import { attempt } from "#/errors/index.ts";
import type { ReviewDecisionOutcome } from "#/review-prompts/index.ts";
import type {
  CoordinatedReviewOutcome,
  CoordinationEvent,
  CoordinateReviewParameters,
  ExternalReviewCancellationOutcome,
  ExternalReviewOperation,
  ExternalState,
  PromptState,
} from "./types.ts";

export type { ExternalReviewOperation } from "./types.ts";

function createPendingEvent<T>(): Promise<T> {
  return new Promise(() => {});
}

function createCallerCancellationEvent(signal: AbortSignal | undefined): {
  event: Promise<CoordinationEvent<never>>;
  dispose(): void;
} {
  if (signal === undefined) {
    return { event: createPendingEvent(), dispose() {} };
  }
  let resolveEvent: (event: CoordinationEvent<never>) => void = () => {};
  const event = new Promise<CoordinationEvent<never>>((resolve) => {
    resolveEvent = resolve;
  });
  const onAbort = () => {
    resolveEvent({ source: "caller", type: "cancelled" });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }

  return {
    event,
    dispose() {
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function resolveExhaustedSources<T>({
  promptState,
  externalState,
}: {
  promptState: Exclude<PromptState, { type: "pending" }>;
  externalState: Extract<ExternalState, { type: "failed" }>;
}): CoordinatedReviewOutcome<T> {
  if (promptState.type === "dismissed") {
    return {
      type: "dismissed",
      externalError: externalState.error,
    };
  }
  if (promptState.type === "unavailable") {
    return {
      type: "unavailable",
      externalError: externalState.error,
    };
  }

  return {
    type: "failed",
    promptFailure:
      promptState.type === "failed"
        ? { type: "request-failed", error: promptState.error }
        : { type: "unexpected-superseded" },
    externalError: externalState.error,
  };
}

export async function coordinateReview<T>({
  input: { hasUI, signal },
  dependencies: { startExternalReview, requestDecision, requestFeedback },
}: CoordinateReviewParameters<T>): Promise<CoordinatedReviewOutcome<T>> {
  if (signal?.aborted) {
    return {
      type: "cancelled",
      externalCancellation: { type: "not-started" },
    };
  }
  const promptAbortController = new AbortController();
  let externalOperation: ExternalReviewOperation<T> | undefined;
  let externalCancellationPromise:
    Promise<ExternalReviewCancellationOutcome> | undefined;
  const cancelExternalReview =
    (): Promise<ExternalReviewCancellationOutcome> => {
      if (externalCancellationPromise !== undefined) {
        return externalCancellationPromise;
      }
      const operation = externalOperation;
      externalCancellationPromise =
        operation === undefined
          ? Promise.resolve<ExternalReviewCancellationOutcome>({
              type: "not-started",
            })
          : attempt(() => operation.cancel()).then(
              (cancellationAttempt): ExternalReviewCancellationOutcome => {
                return cancellationAttempt.success
                  ? cancellationAttempt.value
                  : {
                      type: "unconfirmed",
                      error: cancellationAttempt.error,
                    };
              },
            );

      return externalCancellationPromise;
    };
  const externalStartAttempt = attempt.sync(startExternalReview);
  let externalEvent: Promise<CoordinationEvent<T>>;
  if (externalStartAttempt.success) {
    const operation = externalStartAttempt.value;
    externalOperation = operation;
    externalEvent = attempt(() => operation.outcome).then(
      (outcomeAttempt): CoordinationEvent<T> => {
        return outcomeAttempt.success
          ? { source: "external", outcome: outcomeAttempt.value }
          : {
              source: "external",
              outcome: { type: "failed", error: outcomeAttempt.error },
            };
      },
    );
  } else {
    externalEvent = Promise.resolve({
      source: "external",
      outcome: { type: "failed", error: externalStartAttempt.error },
    });
  }
  let promptState: PromptState = hasUI
    ? { type: "pending" }
    : { type: "unavailable" };
  let promptEvent: Promise<CoordinationEvent<T>> = createPendingEvent();
  if (hasUI) {
    const decisionAttemptPromise = attempt(() =>
      requestDecision({
        hasUI,
        signal: promptAbortController.signal,
      }),
    );
    promptEvent = decisionAttemptPromise.then(
      (decisionAttempt): CoordinationEvent<T> => {
        return decisionAttempt.success
          ? {
              source: "prompt",
              outcome: {
                type: "completed",
                decision: decisionAttempt.value,
              },
            }
          : {
              source: "prompt",
              outcome: { type: "failed", error: decisionAttempt.error },
            };
      },
    );
  }
  let externalState: ExternalState = { type: "pending" };
  const callerCancellation = createCallerCancellationEvent(signal);
  try {
    while (true) {
      const event: CoordinationEvent<T> = await Promise.race([
        externalState.type === "pending"
          ? externalEvent
          : createPendingEvent<CoordinationEvent<T>>(),
        promptState.type === "pending"
          ? promptEvent
          : createPendingEvent<CoordinationEvent<T>>(),
        callerCancellation.event,
      ]);
      if (event.source === "caller") {
        promptAbortController.abort();
        const [, externalCancellation] = await Promise.all([
          promptState.type === "pending" ? promptEvent : Promise.resolve(),
          cancelExternalReview(),
        ]);

        return { type: "cancelled", externalCancellation };
      }
      if (event.source === "external") {
        if (event.outcome.type === "decided") {
          promptAbortController.abort();
          if (promptState.type === "pending") {
            await promptEvent;
          }

          return { type: "external-decided", value: event.outcome.value };
        }
        externalState = { type: "failed", error: event.outcome.error };
        if (promptState.type !== "pending") {
          return resolveExhaustedSources({ promptState, externalState });
        }
        continue;
      }
      if (event.outcome.type === "failed") {
        promptState = { type: "failed", error: event.outcome.error };
      } else {
        const decision: ReviewDecisionOutcome = event.outcome.decision;
        if (decision.type === "accepted" || decision.type === "rejected") {
          const cancellationPromise = cancelExternalReview();
          const feedbackAttemptPromise = attempt(() =>
            requestFeedback({
              decision: decision.type,
              hasUI,
              signal,
            }),
          );
          const [externalCancellation, feedbackAttempt] = await Promise.all([
            cancellationPromise,
            feedbackAttemptPromise,
          ]);
          const feedback = feedbackAttempt.success
            ? feedbackAttempt.value
            : undefined;
          if (decision.type === "accepted") {
            return feedback === undefined
              ? { type: "prompt-accepted", externalCancellation }
              : {
                  type: "prompt-accepted",
                  feedback,
                  externalCancellation,
                };
          }

          return feedback === undefined
            ? { type: "prompt-rejected", externalCancellation }
            : {
                type: "prompt-rejected",
                feedback,
                externalCancellation,
              };
        }
        if (decision.type === "dismissed") {
          promptState = { type: "dismissed" };
        } else if (decision.type === "superseded") {
          promptState = { type: "superseded" };
        } else {
          promptState = { type: "unavailable" };
        }
      }
      if (externalState.type === "failed") {
        return resolveExhaustedSources({ promptState, externalState });
      }
    }
  } finally {
    callerCancellation.dispose();
  }
}

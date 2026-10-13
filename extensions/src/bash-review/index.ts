import { attempt, getErrorMessage } from "#/errors/index.ts";
import { coordinateReview } from "#/review-coordinator/index.ts";
import type { ExternalReviewOperation } from "#/review-coordinator/index.ts";
import {
  conductPromptReview,
  evaluateReviewPolicy,
  resolveReviewPolicy,
  reviewPolicyBlockMessageTemplates,
} from "#/review-policies/index.ts";
import { bashReviewBlockMessageTemplates } from "./messages.ts";
import type {
  BashExternalReviewCancellationOutcome,
  BashExternalReviewDecision,
  BashExternalReviewOutcome,
  BashReviewOutcome,
  ReviewBashCommandParameters,
  StartBashExternalReviewParameters,
} from "./types.ts";

export function startBashExternalReview({
  input: { command, commandFilePath, originalCommand },
  dependencies: { processRunner, readCommandFile },
}: StartBashExternalReviewParameters): ExternalReviewOperation<BashExternalReviewDecision> {
  const runningProcess = processRunner.start({ command });
  const outcome = attempt(() => runningProcess.completion).then(
    async (completionAttempt): Promise<BashExternalReviewOutcome> => {
      if (!completionAttempt.success) {
        return {
          type: "failed",
          error: {
            type: "process-observation-failed",
            error: completionAttempt.error,
          },
        };
      }
      const completion = completionAttempt.value;
      const processSucceeded =
        completion.type === "exited" &&
        completion.exitCode === 0 &&
        completion.signal === null;
      if (!processSucceeded) {
        return {
          type: "failed",
          error: {
            type: "process-failed",
            completion,
          },
        };
      }
      const commandFileAttempt = await attempt(() =>
        readCommandFile(commandFilePath),
      );
      if (!commandFileAttempt.success) {
        return {
          type: "failed",
          error: {
            type: "command-file-read-failed",
            error: commandFileAttempt.error,
          },
        };
      }

      return commandFileAttempt.value === originalCommand
        ? {
            type: "decided",
            value: { type: "unchanged" },
          }
        : {
            type: "decided",
            value: {
              type: "changed",
              suggestion: commandFileAttempt.value,
            },
          };
    },
  );
  let cancellationPromise:
    Promise<BashExternalReviewCancellationOutcome> | undefined;

  return {
    outcome,
    cancel() {
      if (cancellationPromise !== undefined) {
        return cancellationPromise;
      }
      cancellationPromise = attempt(() => runningProcess.terminate()).then(
        (terminationAttempt): BashExternalReviewCancellationOutcome => {
          if (!terminationAttempt.success) {
            return {
              type: "unconfirmed",
              error: terminationAttempt.error,
            };
          }
          const termination = terminationAttempt.value;
          if (termination.type === "termination-observed") {
            return { type: "cancelled" };
          }
          if (termination.type === "already-exited") {
            return { type: "already-completed" };
          }
          if (termination.type === "termination-failed") {
            return {
              type: "unconfirmed",
              error: termination.error,
            };
          }

          return { type: "unconfirmed" };
        },
      );

      return cancellationPromise;
    },
  };
}

export async function reviewBashCommand({
  input: { command, hasUI, signal },
  dependencies,
}: ReviewBashCommandParameters): Promise<BashReviewOutcome> {
  const commandFileAttempt = await attempt(() =>
    dependencies.temporaryFileStore.createFile({
      kind: "command",
      content: command,
    }),
  );
  if (!commandFileAttempt.success) {
    return {
      type: "blocked",
      reason: bashReviewBlockMessageTemplates.workflowFailed(
        getErrorMessage(commandFileAttempt.error),
      ),
    };
  }
  const commandFile = commandFileAttempt.value;
  const reviewAttempt = await attempt(async (): Promise<BashReviewOutcome> => {
    const configuredAction = await dependencies.resolveConfiguredAction({
      commandFilePath: commandFile.path,
      commandString: command,
    });
    const policy = resolveReviewPolicy({
      subject: "command",
      configuredAction,
    });
    const evaluation = await evaluateReviewPolicy({
      input: { policy, hasUI, signal },
      dependencies: {
        conductPromptReview(input) {
          return conductPromptReview({
            input,
            dependencies: {
              requestDecision: dependencies.requestDecision,
              requestFeedback: dependencies.requestFeedback,
            },
          });
        },
      },
    });
    if (evaluation.type === "allowed" || evaluation.type === "blocked") {
      return evaluation;
    }
    if (evaluation.type === "superseded") {
      return {
        type: "blocked",
        reason: reviewPolicyBlockMessageTemplates.superseded(),
      };
    }
    const coordinatedOutcome = await coordinateReview({
      input: { hasUI, signal },
      dependencies: {
        startExternalReview() {
          return startBashExternalReview({
            input: {
              command: evaluation.command,
              commandFilePath: commandFile.path,
              originalCommand: command,
            },
            dependencies: {
              processRunner: dependencies.processRunner,
              readCommandFile: dependencies.readCommandFile,
            },
          });
        },
        requestDecision: dependencies.requestDecision,
        requestFeedback: dependencies.requestFeedback,
      },
    });
    if (coordinatedOutcome.type === "prompt-accepted") {
      if (coordinatedOutcome.externalCancellation.type === "unconfirmed") {
        return {
          type: "blocked",
          reason: bashReviewBlockMessageTemplates.editorTerminationUnconfirmed(),
        };
      }

      return coordinatedOutcome.feedback === undefined
        ? { type: "allowed" }
        : { type: "allowed", feedback: coordinatedOutcome.feedback };
    }
    if (coordinatedOutcome.type === "prompt-rejected") {
      return {
        type: "blocked",
        reason: reviewPolicyBlockMessageTemplates.rejected(
          coordinatedOutcome.feedback,
        ),
      };
    }
    if (coordinatedOutcome.type === "external-decided") {
      if (coordinatedOutcome.value.type === "unchanged") {
        return { type: "allowed" };
      }
      if (coordinatedOutcome.value.suggestion === "") {
        return {
          type: "blocked",
          reason: bashReviewBlockMessageTemplates.emptyCommand(),
        };
      }

      return { type: "edited", command: coordinatedOutcome.value.suggestion };
    }
    if (coordinatedOutcome.type === "cancelled") {
      return {
        type: "blocked",
        reason: bashReviewBlockMessageTemplates.cancelled(),
      };
    }

    return {
      type: "blocked",
      reason: bashReviewBlockMessageTemplates.externalReviewFailed(),
    };
  });
  const cleanupAttempt = await attempt(() => commandFile.cleanup());
  if (!cleanupAttempt.success) {
    return {
      type: "blocked",
      reason: bashReviewBlockMessageTemplates.cleanupFailed(
        getErrorMessage(cleanupAttempt.error),
      ),
    };
  }
  if (!reviewAttempt.success) {
    return {
      type: "blocked",
      reason: bashReviewBlockMessageTemplates.workflowFailed(
        getErrorMessage(reviewAttempt.error),
      ),
    };
  }

  return reviewAttempt.value;
}

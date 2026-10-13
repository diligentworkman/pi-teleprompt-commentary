import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runRestoredPiFilePreview, type PiFilePreviewInput } from "#/file-preview/index.ts";
import { attempt, getErrorMessage } from "#/errors/index.ts";
import type { ProcessRunner } from "#/process/index.ts";
import { coordinateReview } from "#/review-coordinator/index.ts";
import { conductPromptReview, evaluateReviewPolicy, reviewPolicyBlockMessageTemplates } from "#/review-policies/index.ts";
import type { ReviewDecisionInput, ReviewDecisionOutcome, ReviewFeedbackInput } from "#/review-prompts/index.ts";
import { readFile } from "node:fs/promises";
import { startFileExternalReview } from "./external.ts";
import type { PreparedFileReview } from "./policy-preparation.ts";

export type FileReviewOutcome =
  | { type: "allowed"; feedback?: string }
  | { type: "reviewed"; content: Buffer }
  | { type: "blocked"; reason: string };

export async function reviewPreparedFile({
  prepared,
  input: { canonicalPath, preview, toolCallId, ctx, hasUI, signal },
  dependencies: { processRunner, requestDecision, requestFeedback, readProposal = readFile },
}: {
  prepared: PreparedFileReview;
  input: {
    canonicalPath: string;
    preview: PiFilePreviewInput;
    toolCallId: string;
    ctx: ExtensionContext;
    hasUI: boolean;
    signal?: AbortSignal;
  };
  dependencies: {
    processRunner: ProcessRunner;
    requestDecision(input: ReviewDecisionInput): Promise<ReviewDecisionOutcome>;
    requestFeedback(input: ReviewFeedbackInput): Promise<string | undefined>;
    readProposal?(path: string): Promise<Buffer>;
  };
}): Promise<FileReviewOutcome> {
  const review = await attempt(async (): Promise<FileReviewOutcome> => {
    if (signal?.aborted) {
      return { type: "blocked", reason: "The file review was cancelled." };
    }
    if (prepared.snapshot.canonicalPath !== canonicalPath) {
      return { type: "blocked", reason: "The prepared file target does not match the review target." };
    }
    const evaluation = await evaluateReviewPolicy({
      input: { policy: prepared.policy, hasUI, signal },
      dependencies: {
        conductPromptReview(input) {
          return conductPromptReview({ input, dependencies: { requestDecision, requestFeedback } });
        },
      },
    });
    if (evaluation.type === "allowed" || evaluation.type === "blocked") return evaluation;
    if (evaluation.type === "superseded") {
      return { type: "blocked", reason: "The file review was superseded." };
    }
    let decision: FileReviewOutcome = {
      type: "blocked",
      reason: "The external file review did not complete.",
    };
    const previewOutcome = await runRestoredPiFilePreview({
      canonicalPath,
      preview,
      toolCallId,
      ctx,
      signal,
      snapshot: prepared.snapshot,
      async inspectProposal() {
        const originalProposal = await readProposal(canonicalPath);
        const coordinated = await coordinateReview({
          input: { hasUI, signal },
          dependencies: {
            startExternalReview() {
              return startFileExternalReview({
                input: {
                  command: evaluation.command,
                  proposalPath: canonicalPath,
                  originalProposal,
                },
                dependencies: { processRunner, readProposal },
              });
            },
            requestDecision,
            requestFeedback,
          },
        });
        if ("externalCancellation" in coordinated && coordinated.externalCancellation.type === "unconfirmed") {
          decision = { type: "blocked", reason: "The file editor's termination could not be confirmed; inspect the target before retrying." };
        } else if (coordinated.type === "prompt-accepted") {
          decision = { type: "allowed", ...(coordinated.feedback === undefined ? {} : { feedback: coordinated.feedback }) };
        } else if (coordinated.type === "prompt-rejected") {
          decision = { type: "blocked", reason: reviewPolicyBlockMessageTemplates.rejected(coordinated.feedback) };
        } else if (coordinated.type === "external-decided") {
          decision = coordinated.value.type === "unchanged"
            ? { type: "allowed" }
            : { type: "reviewed", content: coordinated.value.content };
        } else if (coordinated.type === "cancelled") {
          decision = { type: "blocked", reason: "The file review was cancelled." };
        }
      },
    });
    // With successful restoration, leave native failures to normal Pi execution.
    if (previewOutcome.type === "preview-failed" && !signal?.aborted) {
      return { type: "allowed" };
    }
    return previewOutcome.type === "previewed"
      ? decision
      : { type: "blocked", reason: `The file preview could not be restored or reviewed (${previewOutcome.type}).` };
  });
  const cleanup = prepared.originalContentFile === undefined
    ? attempt.value(undefined)
    : await attempt(() => prepared.originalContentFile!.cleanup());
  if (!cleanup.success) {
    return { type: "blocked", reason: `The original-content artifact could not be removed: ${getErrorMessage(cleanup.error)}` };
  }
  return review.success
    ? review.value
    : { type: "blocked", reason: `The file review failed: ${getErrorMessage(review.error)}` };
}

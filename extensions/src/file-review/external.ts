import { attempt } from "#/errors/index.ts";
import type { FileExternalReviewOperation, StartFileExternalReviewParameters } from "./types.ts";

export function startFileExternalReview({
  input: { command, proposalPath, originalProposal },
  dependencies: { processRunner, readProposal },
}: StartFileExternalReviewParameters): FileExternalReviewOperation {
  const process = processRunner.start({ command });
  const outcome: FileExternalReviewOperation["outcome"] = attempt(() =>
    process.completion,
  ).then(async (observed) => {
    if (!observed.success) {
      return { type: "failed", error: { type: "process-observation-failed", error: observed.error } };
    }
    const completion = observed.value;
    if (completion.type !== "exited" || completion.exitCode !== 0 || completion.signal !== null) {
      return { type: "failed", error: { type: "process-failed", completion } };
    }
    const read = await attempt(() => readProposal(proposalPath));
    if (!read.success) {
      return { type: "failed", error: { type: "proposal-read-failed", error: read.error } };
    }
    return {
      type: "decided",
      value: read.value.equals(originalProposal)
        ? { type: "unchanged" }
        : { type: "changed", content: read.value },
    };
  });
  let cancellation: ReturnType<FileExternalReviewOperation["cancel"]> | undefined;
  return {
    outcome,
    cancel() {
      cancellation ??= attempt(() => process.terminate()).then((result) => {
        if (!result.success) return { type: "unconfirmed" as const, error: result.error };
        if (result.value.type === "termination-observed") return { type: "cancelled" as const };
        if (result.value.type === "already-exited") return { type: "already-completed" as const };
        return result.value.type === "termination-failed"
          ? { type: "unconfirmed" as const, error: result.value.error }
          : { type: "unconfirmed" as const };
      });
      return cancellation;
    },
  };
}

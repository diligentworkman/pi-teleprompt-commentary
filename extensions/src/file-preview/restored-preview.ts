import { attempt } from "#/errors/index.ts";
import { resolveCanonicalPath, resolveInputPath } from "#/paths/index.ts";
import { homedir } from "node:os";
import {
  captureFilePreviewSnapshot,
  restoreExistingFilePreview,
  runPiFilePreview,
} from "./index.ts";
import {
  captureNewFilePreviewState,
  restoreNewFilePreview,
} from "./new-target-restoration.ts";
import type {
  RestoredPiFilePreviewOutcome,
  RunRestoredPiFilePreviewParameters,
} from "./types.ts";

export async function runRestoredPiFilePreview({
  canonicalPath,
  preview,
  toolCallId,
  ctx,
  signal,
  runPreview = runPiFilePreview,
  inspectProposal,
  snapshot: suppliedSnapshot,
}: RunRestoredPiFilePreviewParameters): Promise<RestoredPiFilePreviewOutcome> {
  const inputPathAttempt = attempt.sync(() => resolveInputPath({
    inputPath: preview.input.path,
    cwd: ctx.cwd,
    homeDirectory: homedir(),
  }));
  if (!inputPathAttempt.success) {
    return { type: "path-resolution-failed", error: inputPathAttempt.error };
  }
  const resolvedPath = await resolveCanonicalPath(inputPathAttempt.value);
  if (!resolvedPath.success) {
    return { type: "path-resolution-failed", error: resolvedPath.error };
  }
  if (resolvedPath.value !== canonicalPath) {
    return { type: "path-mismatch", resolvedPath: resolvedPath.value };
  }
  if (suppliedSnapshot !== undefined && suppliedSnapshot.canonicalPath !== canonicalPath) {
    return { type: "path-mismatch", resolvedPath: suppliedSnapshot.canonicalPath };
  }
  const snapshot = await captureFilePreviewSnapshot(canonicalPath);
  if (!snapshot.success) {
    return { type: "snapshot-failed", error: snapshot.error };
  }
  if (suppliedSnapshot !== undefined) {
    const current = snapshot.value;
    const unchanged = suppliedSnapshot.type === current.type && (
      suppliedSnapshot.type === "existing" && current.type === "existing"
        ? suppliedSnapshot.device === current.device &&
          suppliedSnapshot.inode === current.inode &&
          suppliedSnapshot.mode === current.mode &&
          suppliedSnapshot.modificationTime.getTime() === current.modificationTime.getTime() &&
          suppliedSnapshot.originalContent.equals(current.originalContent)
        : suppliedSnapshot.type === "new" && current.type === "new" &&
          suppliedSnapshot.ancestorIdentity.device === current.ancestorIdentity.device &&
          suppliedSnapshot.ancestorIdentity.inode === current.ancestorIdentity.inode &&
          suppliedSnapshot.missingDirectoryPaths.join("\0") === current.missingDirectoryPaths.join("\0")
    );
    if (!unchanged) return { type: "snapshot-stale" };
  }

  const capturedSnapshot = suppliedSnapshot ?? snapshot.value;
  const previewAttempt = await attempt(() =>
    runPreview({ preview, toolCallId, ctx, signal }),
  );
  const previewOutcome = previewAttempt.success
    ? { type: "succeeded" as const }
    : { type: "failed" as const, error: previewAttempt.error };

  // Capture new-target identities before the editor can change the proposal.
  const state = capturedSnapshot.type === "new"
    ? await captureNewFilePreviewState(capturedSnapshot)
    : undefined;
  if (state !== undefined && !state.success) {
    return {
      type: "cleanup-unconfirmed",
      error: state.error,
      preview: previewOutcome,
    };
  }
  const inspection = previewAttempt.success && inspectProposal !== undefined
    ? await attempt(() => inspectProposal(capturedSnapshot))
    : undefined;
  const inspectionFailure = inspection !== undefined && !inspection.success
    ? { inspection: { type: "failed" as const, error: inspection.error } }
    : {};

  if (capturedSnapshot.type === "new") {
    if (state === undefined || !state.success) {
      return {
        type: "cleanup-unconfirmed",
        error: new Error("Missing new-target preview state"),
        preview: previewOutcome,
        ...inspectionFailure,
      };
    }
    const restorationAttempt = await attempt(() => restoreNewFilePreview(state.value));
    if (!restorationAttempt.success) {
      return {
        type: "cleanup-unconfirmed",
        error: restorationAttempt.error,
        preview: previewOutcome,
        ...inspectionFailure,
      };
    }
    if (restorationAttempt.value.type === "incomplete") {
      return {
        type: "restoration-incomplete",
        restoration: restorationAttempt.value,
        preview: previewOutcome,
        ...inspectionFailure,
      };
    }
  } else {
    const restorationAttempt = await attempt(() => restoreExistingFilePreview(capturedSnapshot));
    if (!restorationAttempt.success) {
      return {
        type: "cleanup-unconfirmed",
        error: restorationAttempt.error,
        preview: previewOutcome,
        ...inspectionFailure,
      };
    }
    if (restorationAttempt.value.type !== "restored") {
      return {
        type: "restoration-incomplete",
        restoration: restorationAttempt.value,
        preview: previewOutcome,
        ...inspectionFailure,
      };
    }
  }

  if (inspectionFailure.inspection !== undefined) {
    return { type: "inspection-failed", error: inspectionFailure.inspection.error };
  }
  return previewAttempt.success
    ? { type: "previewed" }
    : { type: "preview-failed", error: previewAttempt.error };
}

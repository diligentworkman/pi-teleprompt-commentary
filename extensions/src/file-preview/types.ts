import type {
  EditToolInput,
  ExtensionContext,
  WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import type { AttemptResult } from "#/errors/index.ts";
import type { NewFileReviewTarget } from "#/file-review-targets/index.ts";

export type PiFilePreviewInput =
  | { toolName: "write"; input: WriteToolInput }
  | { toolName: "edit"; input: EditToolInput };

export type RunPiFilePreviewParameters = {
  preview: PiFilePreviewInput;
  toolCallId: string;
  ctx: ExtensionContext;
  signal?: AbortSignal;
};

export type ExistingFilePreviewSnapshot = {
  type: "existing";
  canonicalPath: string;
  originalContent: Buffer;
  device: number;
  inode: number;
  mode: number;
  accessTime: Date;
  modificationTime: Date;
};

export type FileIdentity = {
  device: number;
  inode: number;
};

export type NewFilePreviewSnapshot = NewFileReviewTarget & {
  ancestorIdentity: FileIdentity;
};

export type NewFilePreviewState = {
  snapshot: NewFilePreviewSnapshot;
  targetIdentity?: FileIdentity;
  directoryIdentities: Array<{ path: string; identity: FileIdentity }>;
};

export type NewFileRestorationIssue = {
  path: string;
  reason: "identity-changed" | "not-empty" | "failed";
  error?: unknown;
};

export type NewFileRestorationOutcome = {
  type: "restored" | "incomplete";
  issues: Array<NewFileRestorationIssue>;
};

export type FilePreviewSnapshot =
  | ExistingFilePreviewSnapshot
  | NewFilePreviewSnapshot;

export type FilePreviewSnapshotOutcome = AttemptResult<FilePreviewSnapshot>;

export type ExistingFileRestorationOutcome =
  | { type: "restored" }
  | { type: "identity-changed" }
  | { type: "failed"; error: unknown };

export type RestoredPiFilePreviewOutcome =
  | { type: "previewed" }
  | { type: "path-resolution-failed"; error: unknown }
  | { type: "path-mismatch"; resolvedPath: string }
  | { type: "snapshot-failed"; error: unknown }
  | { type: "snapshot-stale" }
  | { type: "preview-failed"; error: unknown }
  | { type: "inspection-failed"; error: unknown }
  | {
      type: "restoration-incomplete";
      restoration: ExistingFileRestorationOutcome | NewFileRestorationOutcome;
      preview: { type: "succeeded" } | { type: "failed"; error: unknown };
      inspection?: { type: "failed"; error: unknown };
    }
  | {
      type: "cleanup-unconfirmed";
      error: unknown;
      preview: { type: "succeeded" } | { type: "failed"; error: unknown };
      inspection?: { type: "failed"; error: unknown };
    };

export type RunRestoredPiFilePreviewParameters = RunPiFilePreviewParameters & {
  canonicalPath: string;
  snapshot?: FilePreviewSnapshot;
  runPreview?: (parameters: RunPiFilePreviewParameters) => Promise<void>;
  inspectProposal?: (snapshot: FilePreviewSnapshot) => Promise<void>;
};

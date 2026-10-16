import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { AttemptResult } from "#/errors/index.ts";

export type AppendUserFeedbackAction = {
  type: "append-user-feedback";
  feedback: string;
};

export type AnnotateEditedBashCommandAction = {
  type: "annotate-edited-bash-command";
  command: string;
};

export type ApplyReviewedContentAction = {
  type: "apply-reviewed-content";
  canonicalPath: string;
  content: Buffer;
  changeSummary?: AttemptResult<string | undefined>;
};

export type PostToolAction =
  | AppendUserFeedbackAction
  | AnnotateEditedBashCommandAction
  | ApplyReviewedContentAction;

export type AddPostToolActionInput = {
  toolCallId: string;
  action: PostToolAction;
};

export type PostToolActionRegistry = {
  add(input: AddPostToolActionInput): void;
  takeByToolCallId(toolCallId: string): Array<PostToolAction>;
  clearByToolCallId(toolCallId: string): void;
  clear(): void;
};

export type ToolResultContent = ToolResultEvent["content"];

export type ApplyPostToolActionsInput = {
  actions: ReadonlyArray<Exclude<PostToolAction, ApplyReviewedContentAction>>;
  content: ToolResultContent;
};

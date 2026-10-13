import { postToolActionMessageTemplates } from "./messages.ts";
import type {
  AddPostToolActionInput,
  ApplyPostToolActionsInput,
  PostToolAction,
  PostToolActionRegistry,
  ToolResultContent,
} from "./types.ts";

export type { ApplyReviewedContentAction, AppendUserFeedbackAction, ToolResultContent } from "./types.ts";

export function applyPostToolActions({
  actions,
  content,
}: ApplyPostToolActionsInput): ToolResultContent {
  if (actions.length === 0) {
    return content;
  }
  const appendedContent = actions.map((action) => ({
    type: "text" as const,
    text:
      action.type === "append-user-feedback"
        ? postToolActionMessageTemplates.userFeedback(action.feedback)
        : postToolActionMessageTemplates.editedBashCommand(action.command),
  }));

  return [...content, ...appendedContent];
}

export function createPostToolActionRegistry(): PostToolActionRegistry {
  const actionsByToolCallId = new Map<string, Array<PostToolAction>>();

  return {
    add({ toolCallId, action }: AddPostToolActionInput) {
      const actions = actionsByToolCallId.get(toolCallId) ?? [];
      actions.push(action);
      actionsByToolCallId.set(toolCallId, actions);
    },
    takeByToolCallId(toolCallId) {
      const actions = actionsByToolCallId.get(toolCallId);
      if (actions === undefined) {
        return [];
      }
      actionsByToolCallId.delete(toolCallId);

      return actions;
    },
    clearByToolCallId(toolCallId) {
      actionsByToolCallId.delete(toolCallId);
    },
    clear() {
      actionsByToolCallId.clear();
    },
  };
}

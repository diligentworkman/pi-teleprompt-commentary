import { getErrorMessage } from "#/errors/index.ts";
import type { ApplyReviewedContentAction, AppendUserFeedbackAction, ToolResultContent } from "#/post-tool-actions/index.ts";
import { applyReviewedFileContent } from "./apply-reviewed-content.ts";

export type FilePostToolAction = ApplyReviewedContentAction | AppendUserFeedbackAction;

export async function applyFilePostToolActions({
  actions,
  content,
  applyReviewedContent = applyReviewedFileContent,
}: {
  actions: ReadonlyArray<FilePostToolAction>;
  content: ToolResultContent;
  applyReviewedContent?: typeof applyReviewedFileContent;
}): Promise<ToolResultContent> {
  if (actions.length === 0) return content;
  const annotations: ToolResultContent = [];
  for (const action of actions) {
    if (action.type !== "apply-reviewed-content") continue;
    const result = await applyReviewedContent({
      canonicalPath: action.canonicalPath,
      content: action.content,
    });
    annotations.push({
      type: "text",
      text: result.success
        ? "The user's reviewed file content was applied after Pi's tool call."
        : `The user's reviewed file content could not be applied: ${getErrorMessage(result.error)}`,
    });
  }
  for (const action of actions) {
    if (action.type === "append-user-feedback") {
      annotations.push({ type: "text", text: `User feedback on approval: ${action.feedback}` });
    }
  }
  return [...content, ...annotations];
}

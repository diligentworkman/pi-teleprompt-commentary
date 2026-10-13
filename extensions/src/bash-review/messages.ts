export const bashReviewBlockMessageTemplates = {
  emptyCommand() {
    return "The command was blocked because the editor saved an empty command.";
  },
  cancelled() {
    return "The command was blocked because review was cancelled.";
  },
  editorTerminationUnconfirmed() {
    return "The command was blocked because the editor's termination could not be confirmed; close the editor before retrying.";
  },
  externalReviewFailed() {
    return "The command was blocked because external review ended without a decision.";
  },
  workflowFailed(errorMessage: string) {
    return `The command was blocked because review failed: ${errorMessage}`;
  },
  cleanupFailed(errorMessage: string) {
    return `The command was blocked because temporary review data could not be cleaned: ${errorMessage}`;
  },
} as const;

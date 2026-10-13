export const postToolActionMessageTemplates = {
  userFeedback(feedback: string) {
    return `User feedback on approval: ${feedback}`;
  },
  editedBashCommand(command: string) {
    return `The user edited the agent's proposed Bash command in the configured editor. Pi received the following exact command for execution instead:\n${command}`;
  },
} as const;

export const errorMessageTemplates = {
  terminationRequestFailed() {
    return "Node could not issue the process termination request.";
  },
} satisfies Record<string, (...args: any[]) => string>;

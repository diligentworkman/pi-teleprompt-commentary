export const errorMessages = {
  unsafeSessionId: "The session ID is not a safe artifact-directory name.",
  redirectedArtifactsDirectory: "The session artifact directory is redirected outside its expected location.",
  artifactsPathNotDirectory: "The session artifact path is not a directory.",
} as const;

export const contextMessages = {
  available: [
    "- Store session implementation plans, TODO lists, and task notes here, not project source files.",
    "- Use native file tools. This directory needs no outside-workspace approval; normal write/edit review still applies.",
    "- The directory is created when a file is written, not merely when its path is announced.",
    "- Artifacts persist after shutdown. Resume and /tree reuse this session's directory; /new, /fork, and /clone use separate directories.",
    "- Branches within the same session share these files. Tree navigation does not restore earlier artifact contents.",
    "- Other sessions' directories and symlink escapes have no automatic access exemption. This is not a Bash permission exemption or a sandbox.",
  ],
  disabled: "- Persistent artifacts are disabled for this run. Keep plans and TODOs in the conversation instead of creating a substitute persistent artifact directory.",
  unavailable: "- The session artifact directory could not be verified. Do not assume automatic artifact access or create a substitute directory; existing workspace permissions and review policies still apply.",
} as const;

export const warningMessageTemplates = {
  directoryUnavailable(errorMessage: string) {
    return `The session artifact directory is unavailable: ${errorMessage}`;
  },
};

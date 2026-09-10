export const workspaceEntryType = "teleprompt-commentary.workspaces";

export const commands = {
  add: {
    name: "tc:workspace-add",
    description: "Add a workspace to this session",
    inputTitle: "Add workspace",
    inputPlaceholder: "Directory path",
    confirmTitle: "Add workspace?",
  },
  remove: {
    name: "tc:workspace-remove",
    description: "Remove a workspace from this session",
    selectTitle: "Remove workspace",
    confirmTitle: "Remove workspace?",
  },
  list: {
    name: "tc:workspace-list",
    description: "List session workspaces",
  },
  open: {
    name: "tc:workspace-open",
    description: "Open one session workspace",
    selectTitle: "Open workspace",
  },
  openAll: {
    name: "tc:workspaces-open",
    description: "Open all session workspaces",
  },
} as const;

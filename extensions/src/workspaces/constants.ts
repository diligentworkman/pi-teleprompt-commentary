import type { Notification } from "./types.ts";

export const commands = {
  list: {
    name: "tc:workspace-list",
    description: "List session workspaces",
  },
} as const;

export const notifications = {
  wc: {
    message: "Workspace management is not implemented yet.",
    type: "info",
  },
} as const satisfies Record<string, Notification>;

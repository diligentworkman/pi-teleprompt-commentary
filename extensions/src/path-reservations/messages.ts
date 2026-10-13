import type { PathReservationConflictMessageInput } from "./types.ts";

export const pathReservationBlockMessageTemplates = {
  conflict({
    canonicalPath,
    currentOwnerToolCallId,
  }: PathReservationConflictMessageInput) {
    return `Tool call blocked because canonical path "${canonicalPath}" is already reserved by tool call "${currentOwnerToolCallId}".`;
  },
} as const;

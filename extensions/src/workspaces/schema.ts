import { isAbsolute } from "node:path";
import { z } from "zod";
import { errorMessageTemplates } from "./messages.ts";

export const workspaceSnapshotSchema = z.object({
  additionalWorkspaces: z
    .array(
      z.string().min(1).refine(isAbsolute, {
        message: errorMessageTemplates.workspacePathsMustBeAbsolute(),
      }),
    )
    .refine((paths) => {
      return new Set(paths).size === paths.length;
    }, {
      message: errorMessageTemplates.workspacePathsMustBeUnique(),
    }),
});

export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;

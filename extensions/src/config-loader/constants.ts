import type {
  HandlerCategory,
  HookName,
  RuleContext,
  VariableName,
} from "./types.ts";

export const variableNames = [
  "config_file_path",
  "new_file_path",
  "old_content_file_path",
  "new_content_file_path",
  "command_file_path",
  "command_string",
  "directory_path",
  "group_id",
  "assistant_message_text",
  "tool_name",
] as const;

export const handlerCategories = [
  "configuration_editor",
  "workspace_opener",
  "diff_editor",
  "new_file_editor",
  "command_editor",
] as const;

export const decisions = ["allow", "deny", "prompt"] as const;

export const hookNames = [
  "assistant_message_end",
  "tool_permission_request",
  "agent_settled",
] as const;

export const availableHandlerVariables = {
  configuration_editor: ["config_file_path"],
  workspace_opener: ["directory_path", "group_id"],
  diff_editor: ["old_content_file_path", "new_content_file_path"],
  new_file_editor: ["new_file_path"],
  command_editor: ["command_file_path", "command_string"],
} as const satisfies Record<HandlerCategory, readonly VariableName[]>;

export const availableHookVariables = {
  assistant_message_end: ["assistant_message_text"],
  tool_permission_request: ["tool_name"],
  agent_settled: [],
} as const satisfies Record<HookName, readonly VariableName[]>;

export const availableVariables = {
  ...availableHandlerVariables,
  ...availableHookVariables,
} as const satisfies Record<RuleContext, readonly VariableName[]>;

export const commandOnlyHandlerCategories = [
  "configuration_editor",
  "workspace_opener",
] as const satisfies readonly HandlerCategory[];

export const commandOnlyCategories = new Set<RuleContext>([
  ...commandOnlyHandlerCategories,
  ...hookNames,
]);

export const telepromptCommentaryConfigMetaData = {
  directoryName: "teleprompt-commentary",
  fileName: "config.toml",
};

import type { HandlerCategory, VariableName } from "./types.ts";

export const errorMessageTemplates = {
  commandVariableUnavailable(variableName: VariableName) {
    return `Cannot expand command because variable "${variableName}" is unavailable.`;
  },
  configurationFileReadFailed(errorMessage: string) {
    return `Failed to read configuration file: ${errorMessage}`;
  },
  configurationSourceInvalid(errorMessage: string) {
    return `Invalid configuration: ${errorMessage}`;
  },
  unsupportedHandlerCategory(categoryName: string) {
    return `Unsupported handler category "${categoryName}".`;
  },
  unsupportedHookName(hookName: string) {
    return `Unsupported hook name "${hookName}".`;
  },
  unsupportedRuleField({
    fieldName,
    category,
    ruleNumber,
  }: {
    fieldName: string;
    category: HandlerCategory;
    ruleNumber: number;
  }) {
    return `Unsupported field "${fieldName}" in ${category} rule ${ruleNumber}.`;
  },
  unknownConditionVariable({
    fieldName,
    category,
    ruleNumber,
  }: {
    fieldName: string;
    category: HandlerCategory;
    ruleNumber: number;
  }) {
    return `Unknown condition variable "${fieldName}" in ${category} rule ${ruleNumber}.`;
  },
  unavailableConditionVariable({
    variableName,
    category,
    ruleNumber,
  }: {
    variableName: VariableName;
    category: HandlerCategory;
    ruleNumber: number;
  }) {
    return `Condition variable "${variableName}" is unavailable in ${category} rule ${ruleNumber}.`;
  },
  invalidRegexFlags() {
    return "flags must be unique supported non-stateful flags and cannot combine u with v";
  },
  invalidRegexSpecification({
    fieldName,
    category,
    ruleNumber,
    reason,
  }: {
    fieldName: string;
    category: HandlerCategory;
    ruleNumber: number;
    reason: string;
  }) {
    return `Invalid regular expression for "${fieldName}" in ${category} rule ${ruleNumber}: ${reason}`;
  },
  missingRuleAction({
    category,
    ruleNumber,
  }: {
    category: HandlerCategory;
    ruleNumber: number;
  }) {
    return `Missing action in ${category} rule ${ruleNumber}.`;
  },
  invalidRuleAction({
    category,
    ruleNumber,
  }: {
    category: HandlerCategory;
    ruleNumber: number;
  }) {
    return `Invalid action in ${category} rule ${ruleNumber}: expected a string or array.`;
  },
  invalidDecisionAction({
    category,
    ruleNumber,
    reason,
  }: {
    category: HandlerCategory;
    ruleNumber: number;
    reason: string;
  }) {
    return `Invalid decision action in ${category} rule ${ruleNumber}: ${reason}`;
  },
  commandOnlyActionContext({
    category,
    ruleNumber,
  }: {
    category: HandlerCategory;
    ruleNumber: number;
  }) {
    return `Decision actions are not allowed in ${category} rule ${ruleNumber}.`;
  },
  emptyCommandAction({
    category,
    ruleNumber,
  }: {
    category: HandlerCategory;
    ruleNumber: number;
  }) {
    return `Command action in ${category} rule ${ruleNumber} must contain an executable.`;
  },
  invalidCommandExecutable({
    category,
    ruleNumber,
  }: {
    category: HandlerCategory;
    ruleNumber: number;
  }) {
    return `Command executable in ${category} rule ${ruleNumber} must be a non-empty string.`;
  },
  invalidCommandToken({
    category,
    ruleNumber,
    tokenNumber,
  }: {
    category: HandlerCategory;
    ruleNumber: number;
    tokenNumber: number;
  }) {
    return `Invalid command token ${tokenNumber} in ${category} rule ${ruleNumber}: expected a string or placeholder.`;
  },
  invalidPlaceholderToken({
    category,
    ruleNumber,
    tokenNumber,
    reason,
  }: {
    category: HandlerCategory;
    ruleNumber: number;
    tokenNumber: number;
    reason: string;
  }) {
    return `Invalid placeholder token ${tokenNumber} in ${category} rule ${ruleNumber}: ${reason}`;
  },
  unavailablePlaceholderVariable({
    variableName,
    category,
    ruleNumber,
    tokenNumber,
  }: {
    variableName: VariableName;
    category: HandlerCategory;
    ruleNumber: number;
    tokenNumber: number;
  }) {
    return `Placeholder variable "${variableName}" is unavailable in command token ${tokenNumber} of ${category} rule ${ruleNumber}.`;
  },
  ruleConditionMatchingNotImplemented() {
    return "Rule condition matching is not implemented yet.";
  },
} satisfies Record<string, (...args: any[]) => string>;

import { getErrorMessage, isErrorWithCode } from "#/errors/index.ts";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import {
  availableVariables,
  commandOnlyCategories,
  handlerCategories,
  telepromptCommentaryConfigMetaData,
} from "./constants.ts";
import { errorMessageTemplates } from "./messages.ts";
import {
  decisionSchema,
  hookNameSchema,
  placeholderSchema,
  rawConfigSchema,
  regexValueSchema,
  type RawConfigurationDocument,
  variableNameSchema,
} from "./schema.ts";
import type {
  ConfigurationConversionResult,
  ConfigurationIssue,
  ConfigurationLoaderDependencies,
  Command,
  CommandToken,
  Action,
  HandlerVariables,
  Placeholder,
  HandlerCategory,
  HookRule,
  RegexSpec,
  Rule,
  VariableName,
  TelepromptConfig,
  ResolvedCommand,
} from "./types.ts";

export function createEmptyConfiguration(): TelepromptConfig {
  return { handlers: {}, hooks: {} };
}

export function resolveConfigPath({
  piAgentDirectory,
  homeDirectory,
}: {
  piAgentDirectory: string | undefined;
  homeDirectory: string;
}): string {
  const effectivePiAgentDirectory =
    piAgentDirectory ?? join(homeDirectory, ".pi", "agent");

  return join(
    effectivePiAgentDirectory,
    telepromptCommentaryConfigMetaData.directoryName,
    telepromptCommentaryConfigMetaData.fileName,
  );
}

export function isMissingConfigurationFileError(error: unknown) {
  return isErrorWithCode({ error, code: "ENOENT" });
}

export async function loadConfiguration(
  dependencies: ConfigurationLoaderDependencies,
): Promise<TelepromptConfig> {
  let configurationSource: string;
  try {
    configurationSource = await dependencies.readConfigurationFile();
  } catch (error) {
    if (isMissingConfigurationFileError(error)) {
      return createEmptyConfiguration();
    }
    const errorMessage = getErrorMessage(error);
    dependencies.reportConfigurationWarning(
      errorMessageTemplates.configurationFileReadFailed(errorMessage),
    );

    return createEmptyConfiguration();
  }
  const conversionResult = parseConfigurationSource(configurationSource);
  if (conversionResult.issues.length > 0) {
    dependencies.reportConfigurationWarning(
      conversionResult.issues
        .map((issue) => {
          return issue.message;
        })
        .join("\n"),
    );
    return createEmptyConfiguration();
  }

  return conversionResult.configuration;
}

export function parseConfigurationSource(
  configurationSource: string,
): ConfigurationConversionResult {
  try {
    const parsedTomlDocument = parseTomlDocument(configurationSource);

    return convertTomlDocumentToConfiguration(parsedTomlDocument);
  } catch (error) {
    let errorMessage: string;
    if (error instanceof z.ZodError) {
      errorMessage = z.prettifyError(error);
    } else {
      errorMessage = getErrorMessage(error);
    }

    return {
      configuration: createEmptyConfiguration(),
      issues: [
        {
          message:
            errorMessageTemplates.configurationSourceInvalid(errorMessage),
        },
      ],
    };
  }
}

export function parseTomlDocument(configurationSource: string): unknown {
  return parseToml(configurationSource);
}

export function convertTomlDocumentToConfiguration(
  parsedTomlDocument: unknown,
): ConfigurationConversionResult {
  const rawConfigurationDocument = validateTomlDocument(parsedTomlDocument);

  return convertRawConfigurationDocument(rawConfigurationDocument);
}

export function validateTomlDocument(
  parsedTomlDocument: unknown,
): RawConfigurationDocument {
  return rawConfigSchema.parse(parsedTomlDocument);
}

export function convertRawConfigurationDocument(
  rawConfigurationDocument: RawConfigurationDocument,
): ConfigurationConversionResult {
  const issues: Array<ConfigurationIssue> = [];
  const configuration: TelepromptConfig = {
    handlers: convertHandlerRules({
      rawHandlers: rawConfigurationDocument.handlers,
      issues,
    }),
    hooks: convertHookRules({
      rawHooks: rawConfigurationDocument.hooks,
      issues,
    }),
  };

  return { configuration, issues };
}

export function convertHandlerRules({
  rawHandlers,
  issues,
}: {
  rawHandlers: RawConfigurationDocument["handlers"];
  issues: Array<ConfigurationIssue>;
}): TelepromptConfig["handlers"] {
  const convertedHandlers: TelepromptConfig["handlers"] = {};
  for (const [categoryName, rawRules] of Object.entries(rawHandlers ?? {})) {
    if (!isSupportedHandlerCategory(categoryName)) {
      issues.push({
        message: errorMessageTemplates.unsupportedHandlerCategory(categoryName),
      });
      continue;
    }
    convertedHandlers[categoryName] = convertHandlerCategoryRules({
      category: categoryName,
      rawRules,
      issues,
    });
  }

  return convertedHandlers;
}

export function convertHookRules({
  rawHooks,
  issues,
}: {
  rawHooks: RawConfigurationDocument["hooks"];
  issues: Array<ConfigurationIssue>;
}): TelepromptConfig["hooks"] {
  const convertedHooks: TelepromptConfig["hooks"] = {};
  for (const [hookName, rawRules] of Object.entries(rawHooks ?? {})) {
    const parsedHookName = hookNameSchema.safeParse(hookName);
    if (!parsedHookName.success) {
      issues.push({
        message: errorMessageTemplates.unsupportedHookName(hookName),
      });
      continue;
    }
    const convertedRules: Array<HookRule> = [];
    for (const [ruleIndex, rawRule] of rawRules.entries()) {
      const convertedRule = convertRawRule({
        category: parsedHookName.data as HandlerCategory,
        rawRule,
        ruleIndex,
        issues,
      });
      if (convertedRule !== undefined) {
        convertedRules.push(convertedRule as HookRule);
      }
    }
    convertedHooks[parsedHookName.data] = convertedRules;
  }

  return convertedHooks;
}

export function isSupportedHandlerCategory(
  categoryName: string,
): categoryName is HandlerCategory {
  return handlerCategories.some((handlerCategory) => {
    return handlerCategory === categoryName;
  });
}

export function convertHandlerCategoryRules({
  category,
  rawRules,
  issues,
}: {
  category: HandlerCategory;
  rawRules: Array<Record<string, unknown>>;
  issues: Array<ConfigurationIssue>;
}): Array<Rule> {
  const convertedRules: Array<Rule> = [];
  for (const [ruleIndex, rawRule] of rawRules.entries()) {
    const convertedRule = convertRawRule({
      category,
      rawRule,
      ruleIndex,
      issues,
    });
    if (convertedRule !== undefined) {
      convertedRules.push(convertedRule);
    }
  }

  return convertedRules;
}

export function convertRawRule({
  category,
  rawRule,
  ruleIndex,
  issues,
}: {
  category: HandlerCategory;
  rawRule: Record<string, unknown>;
  ruleIndex: number;
  issues: Array<ConfigurationIssue>;
}): Rule | undefined {
  if (!validateRawRuleFields({ category, rawRule, ruleIndex, issues })) {
    return undefined;
  }
  const conditions = convertRuleConditions({
    category,
    rawRule,
    ruleIndex,
    issues,
  });
  const action = convertRuleAction({ category, rawRule, ruleIndex, issues });
  if (conditions === undefined || action === undefined) {
    return undefined;
  }

  return { conditions, action };
}

export function validateRawRuleFields({
  category,
  rawRule,
  ruleIndex,
  issues,
}: {
  category: HandlerCategory;
  rawRule: Record<string, unknown>;
  ruleIndex: number;
  issues: Array<ConfigurationIssue>;
}): boolean {
  let hasOnlySupportedFields = true;
  for (const fieldName of Object.keys(rawRule)) {
    const isCondition = fieldName.startsWith("var:");
    const isAction = fieldName === "action";
    if (isAction || isCondition) {
      continue;
    }
    issues.push({
      message: errorMessageTemplates.unsupportedRuleField({
        fieldName,
        category,
        ruleNumber: ruleIndex + 1,
      }),
    });
    hasOnlySupportedFields = false;
  }

  return hasOnlySupportedFields;
}

function convertRuleConditions({
  category,
  rawRule,
  ruleIndex,
  issues,
}: {
  category: HandlerCategory;
  rawRule: Record<string, unknown>;
  ruleIndex: number;
  issues: Array<ConfigurationIssue>;
}): Rule["conditions"] | undefined {
  const conditions: Rule["conditions"] = {};
  let hasValidConditions = true;
  for (const [fieldName, rawRegexValue] of Object.entries(rawRule)) {
    if (!fieldName.startsWith("var:")) {
      continue;
    }
    const variableName = convertConditionVariableName({
      category,
      fieldName,
      ruleIndex,
      issues,
    });
    const regexSpecification = convertRegexSpecification({
      rawRegexValue,
      fieldName,
      category,
      ruleIndex,
      issues,
    });
    if (variableName === undefined || regexSpecification === undefined) {
      hasValidConditions = false;
      continue;
    }
    conditions[variableName] = regexSpecification;
  }
  if (!hasValidConditions) {
    return undefined;
  }

  return conditions;
}

export function convertConditionVariableName({
  category,
  fieldName,
  ruleIndex,
  issues,
}: {
  category: HandlerCategory;
  fieldName: string;
  ruleIndex: number;
  issues: Array<ConfigurationIssue>;
}): VariableName | undefined {
  const parsedVariableName = variableNameSchema.safeParse(
    fieldName.slice("var:".length),
  );
  if (!parsedVariableName.success) {
    issues.push({
      message: errorMessageTemplates.unknownConditionVariable({
        fieldName,
        category,
        ruleNumber: ruleIndex + 1,
      }),
    });

    return undefined;
  }
  const variableName = parsedVariableName.data;
  const categoryVariableNames: ReadonlyArray<VariableName> =
    availableVariables[category];
  if (!categoryVariableNames.includes(variableName)) {
    issues.push({
      message: errorMessageTemplates.unavailableConditionVariable({
        variableName,
        category,
        ruleNumber: ruleIndex + 1,
      }),
    });

    return undefined;
  }

  return variableName;
}

export function convertRegexSpecification({
  rawRegexValue,
  fieldName,
  category,
  ruleIndex,
  issues,
}: {
  rawRegexValue: unknown;
  fieldName: string;
  category: HandlerCategory;
  ruleIndex: number;
  issues: Array<ConfigurationIssue>;
}): RegexSpec | undefined {
  const parsedRegexValue = regexValueSchema.safeParse(rawRegexValue);
  if (!parsedRegexValue.success) {
    issues.push({
      message: errorMessageTemplates.invalidRegexSpecification({
        fieldName,
        category,
        ruleNumber: ruleIndex + 1,
        reason: z.prettifyError(parsedRegexValue.error),
      }),
    });

    return undefined;
  }
  const regexParts =
    typeof parsedRegexValue.data === "string"
      ? [parsedRegexValue.data]
      : parsedRegexValue.data;
  const [source, ...flagParts] = regexParts;
  const flags = flagParts.join("");
  const hasUnsupportedFlag = [...flags].some((flag) => {
    return !"dimsuv".includes(flag);
  });
  const hasDuplicateFlag = new Set(flags).size !== flags.length;
  const combinesUnicodeModes = flags.includes("u") && flags.includes("v");
  if (hasUnsupportedFlag || hasDuplicateFlag || combinesUnicodeModes) {
    issues.push({
      message: errorMessageTemplates.invalidRegexSpecification({
        fieldName,
        category,
        ruleNumber: ruleIndex + 1,
        reason: errorMessageTemplates.invalidRegexFlags(),
      }),
    });

    return undefined;
  }
  try {
    new RegExp(source, flags);
  } catch (error) {
    const reason = getErrorMessage(error);
    issues.push({
      message: errorMessageTemplates.invalidRegexSpecification({
        fieldName,
        category,
        ruleNumber: ruleIndex + 1,
        reason,
      }),
    });

    return undefined;
  }

  return { source, flags };
}

function convertRuleAction({
  category,
  rawRule,
  ruleIndex,
  issues,
}: {
  category: HandlerCategory;
  rawRule: Record<string, unknown>;
  ruleIndex: number;
  issues: Array<ConfigurationIssue>;
}): Action | undefined {
  const rawAction = convertRawActionValue({
    rawRule,
    category,
    ruleIndex,
    issues,
  });
  if (rawAction === undefined) {
    return undefined;
  }
  if (typeof rawAction === "string") {
    return convertDecisionAction({
      rawAction,
      category,
      ruleIndex,
      issues,
    });
  }

  return convertCommandAction({
    rawAction,
    category,
    ruleIndex,
    issues,
  });
}

export function convertRawActionValue({
  rawRule,
  category,
  ruleIndex,
  issues,
}: {
  rawRule: Record<string, unknown>;
  category: HandlerCategory;
  ruleIndex: number;
  issues: Array<ConfigurationIssue>;
}): string | Array<unknown> | undefined {
  const rawAction = rawRule.action;
  if (rawAction === undefined) {
    issues.push({
      message: errorMessageTemplates.missingRuleAction({
        category,
        ruleNumber: ruleIndex + 1,
      }),
    });

    return undefined;
  }
  if (typeof rawAction !== "string" && !Array.isArray(rawAction)) {
    issues.push({
      message: errorMessageTemplates.invalidRuleAction({
        category,
        ruleNumber: ruleIndex + 1,
      }),
    });

    return undefined;
  }

  return rawAction;
}

export function convertDecisionAction({
  rawAction,
  category,
  ruleIndex,
  issues,
}: {
  rawAction: string;
  category: HandlerCategory;
  ruleIndex: number;
  issues: Array<ConfigurationIssue>;
}): Action | undefined {
  const parsedDecision = decisionSchema.safeParse(rawAction);
  if (!parsedDecision.success) {
    issues.push({
      message: errorMessageTemplates.invalidDecisionAction({
        category,
        ruleNumber: ruleIndex + 1,
        reason: z.prettifyError(parsedDecision.error),
      }),
    });

    return undefined;
  }
  if (commandOnlyCategories.has(category)) {
    issues.push({
      message: errorMessageTemplates.commandOnlyActionContext({
        category,
        ruleNumber: ruleIndex + 1,
      }),
    });

    return undefined;
  }

  return parsedDecision.data;
}

export function convertCommandAction({
  rawAction,
  category,
  ruleIndex,
  issues,
}: {
  rawAction: Array<unknown>;
  category: HandlerCategory;
  ruleIndex: number;
  issues: Array<ConfigurationIssue>;
}): Command | undefined {
  const rawCommand = validateRawCommand({
    rawAction,
    category,
    ruleIndex,
    issues,
  });
  if (rawCommand === undefined) {
    return undefined;
  }
  const convertedCommandTokens: Array<CommandToken> = [rawCommand[0]];
  let hasValidCommandTokens = true;
  for (const [tokenIndex, rawToken] of rawCommand.slice(1).entries()) {
    const commandToken = convertCommandToken({
      rawToken,
      category,
      ruleIndex,
      tokenIndex: tokenIndex + 1,
      issues,
    });
    if (commandToken === undefined) {
      hasValidCommandTokens = false;
      continue;
    }
    convertedCommandTokens.push(commandToken);
  }
  if (!hasValidCommandTokens) {
    return undefined;
  }

  return convertedCommandTokens as Command;
}

export function validateRawCommand({
  rawAction,
  category,
  ruleIndex,
  issues,
}: {
  rawAction: Array<unknown>;
  category: HandlerCategory;
  ruleIndex: number;
  issues: Array<ConfigurationIssue>;
}): [string, ...Array<unknown>] | undefined {
  if (rawAction.length === 0) {
    issues.push({
      message: errorMessageTemplates.emptyCommandAction({
        category,
        ruleNumber: ruleIndex + 1,
      }),
    });

    return undefined;
  }
  const [executable] = rawAction;
  if (typeof executable !== "string" || executable.length === 0) {
    issues.push({
      message: errorMessageTemplates.invalidCommandExecutable({
        category,
        ruleNumber: ruleIndex + 1,
      }),
    });

    return undefined;
  }

  return [executable, ...rawAction.slice(1)];
}

export function convertCommandToken({
  rawToken,
  category,
  ruleIndex,
  tokenIndex,
  issues,
}: {
  rawToken: unknown;
  category: HandlerCategory;
  ruleIndex: number;
  tokenIndex: number;
  issues: Array<ConfigurationIssue>;
}): CommandToken | undefined {
  if (typeof rawToken === "string") {
    return rawToken;
  }
  if (typeof rawToken === "object" && rawToken !== null) {
    return convertPlaceholderToken({
      rawToken,
      category,
      ruleIndex,
      tokenIndex,
      issues,
    });
  }
  issues.push({
    message: errorMessageTemplates.invalidCommandToken({
      category,
      ruleNumber: ruleIndex + 1,
      tokenNumber: tokenIndex + 1,
    }),
  });

  return undefined;
}

function convertPlaceholderToken({
  rawToken,
  category,
  ruleIndex,
  tokenIndex,
  issues,
}: {
  rawToken: object;
  category: HandlerCategory;
  ruleIndex: number;
  tokenIndex: number;
  issues: Array<ConfigurationIssue>;
}): Placeholder | undefined {
  const parsedPlaceholder = validatePlaceholderToken({
    rawToken,
    category,
    ruleIndex,
    tokenIndex,
    issues,
  });
  if (parsedPlaceholder === undefined) {
    return undefined;
  }

  return validatePlaceholderVariable({
    placeholder: parsedPlaceholder,
    category,
    ruleIndex,
    tokenIndex,
    issues,
  });
}

export function validatePlaceholderToken({
  rawToken,
  category,
  ruleIndex,
  tokenIndex,
  issues,
}: {
  rawToken: object;
  category: HandlerCategory;
  ruleIndex: number;
  tokenIndex: number;
  issues: Array<ConfigurationIssue>;
}): Placeholder | undefined {
  const parsedPlaceholder = placeholderSchema.safeParse(rawToken);
  if (!parsedPlaceholder.success) {
    issues.push({
      message: errorMessageTemplates.invalidPlaceholderToken({
        category,
        ruleNumber: ruleIndex + 1,
        tokenNumber: tokenIndex + 1,
        reason: z.prettifyError(parsedPlaceholder.error),
      }),
    });

    return undefined;
  }

  return parsedPlaceholder.data;
}

export function validatePlaceholderVariable({
  placeholder,
  category,
  ruleIndex,
  tokenIndex,
  issues,
}: {
  placeholder: Placeholder;
  category: HandlerCategory;
  ruleIndex: number;
  tokenIndex: number;
  issues: Array<ConfigurationIssue>;
}): Placeholder | undefined {
  const categoryVariableNames: ReadonlyArray<VariableName> =
    availableVariables[category];
  if (!categoryVariableNames.includes(placeholder.var)) {
    issues.push({
      message: errorMessageTemplates.unavailablePlaceholderVariable({
        variableName: placeholder.var,
        category,
        ruleNumber: ruleIndex + 1,
        tokenNumber: tokenIndex + 1,
      }),
    });
    return undefined;
  }

  return placeholder;
}

export function resolveRawAction<TAction extends Action>({
  rules,
  variables,
}: {
  rules: Array<Rule<TAction>>;
  variables: HandlerVariables;
}): TAction | undefined {
  let resolvedAction: TAction | undefined;
  for (const rule of rules) {
    if (!ruleConditionsMatch({ conditions: rule.conditions, variables })) {
      continue;
    }
    resolvedAction = rule.action;
  }

  return resolvedAction;
}

export function ruleConditionsMatch({
  conditions,
  variables,
}: {
  conditions: Rule["conditions"];
  variables: HandlerVariables;
}): boolean {
  for (const [variableName, regexSpecification] of Object.entries(conditions)) {
    const variableValue = variables[variableName as VariableName];
    if (variableValue === undefined) {
      return false;
    }
    const regularExpression = new RegExp(
      regexSpecification.source,
      regexSpecification.flags,
    );
    if (!regularExpression.test(variableValue)) {
      return false;
    }
  }

  return true;
}

export function expandCommand({
  command,
  variables,
}: {
  command: Command;
  variables: HandlerVariables;
}) {
  const expandedCommand: Array<string> = [];
  for (const commandToken of command) {
    if (typeof commandToken === "string") {
      expandedCommand.push(commandToken);
      continue;
    }
    const variableValue = variables[commandToken.var];
    if (variableValue === undefined) {
      throw new Error(
        errorMessageTemplates.commandVariableUnavailable(commandToken.var),
      );
    }
    expandedCommand.push(
      `${commandToken.prepend ?? ""}${variableValue}${commandToken.append ?? ""}`,
    );
  }

  return expandedCommand as ResolvedCommand;
}

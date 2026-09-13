import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";
import { errorMessageTemplates } from "#/config-loader/messages.ts";
import { decisionSchema, placeholderSchema } from "#/config-loader/schema.ts";
import type { Command, ConfigurationIssue } from "#/config-loader/types.ts";
import {
  convertCommandAction,
  convertCommandToken,
  convertConditionVariableName,
  convertTomlDocumentToConfiguration,
  convertDecisionAction,
  convertHandlerCategoryRules,
  convertHandlerRules,
  convertHookRules,
  convertRawConfigurationDocument,
  convertRawActionValue,
  convertRawRule,
  convertRegexSpecification,
  createEmptyConfiguration,
  expandCommand,
  validatePlaceholderToken,
  validatePlaceholderVariable,
  validateRawCommand,
  isMissingConfigurationFileError,
  isSupportedHandlerCategory,
  loadConfiguration,
  parseConfigurationSource,
  parseTomlDocument,
  resolveConfigPath,
  resolveRawAction,
  ruleConditionsMatch,
  validateRawRuleFields,
  validateTomlDocument,
} from "#/config-loader/utils.ts";

const invalidConfigurationMessagePrefix = new RegExp(
  `^${errorMessageTemplates.configurationSourceInvalid("")}`,
);

function createLoadConfigurationHarness(
  readConfigurationFile: () => Promise<string>,
) {
  const warnings: Array<string> = [];

  return {
    warnings,
    dependencies: {
      readConfigurationFile,
      reportConfigurationWarning(message: string) {
        warnings.push(message);
      },
    },
  };
}

describe("configuration loader utilities", () => {
  describe("resolveConfigPath", () => {
    const homeDirectory = "/home/user";
    const extensionConfigPath = join("teleprompt-commentary", "config.toml");
    it("uses Pi's configured agent directory", () => {
      const piAgentDirectory = "/custom/pi";
      assert.equal(
        resolveConfigPath({ piAgentDirectory, homeDirectory }),
        join(piAgentDirectory, extensionConfigPath),
      );
    });
    it("defaults to Pi's agent directory below home", () => {
      assert.equal(
        resolveConfigPath({
          piAgentDirectory: undefined,
          homeDirectory,
        }),
        join(homeDirectory, ".pi", "agent", extensionConfigPath),
      );
    });
  });
  describe("createEmptyConfiguration", () => {
    it("creates empty handler and hook maps", () => {
      assert.deepEqual(createEmptyConfiguration(), { handlers: {}, hooks: {} });
    });
  });
  describe("isMissingConfigurationFileError", () => {
    it("recognizes Node's missing-file error code", () => {
      const missingFileError = Object.assign(new Error("missing"), {
        code: "ENOENT",
      });
      assert.equal(isMissingConfigurationFileError(missingFileError), true);
      assert.equal(
        isMissingConfigurationFileError(new Error("permission denied")),
        false,
      );
      assert.equal(isMissingConfigurationFileError(undefined), false);
    });
  });
  describe("isSupportedHandlerCategory", () => {
    it("recognizes supported handler categories", () => {
      assert.equal(isSupportedHandlerCategory("command_editor"), true);
      assert.equal(isSupportedHandlerCategory("unknown_handler"), false);
    });
  });
  describe("validateRawRuleFields", () => {
    it("rejects unsupported fields while retaining action conditions", () => {
      const issues: Array<ConfigurationIssue> = [];
      assert.equal(
        validateRawRuleFields({
          category: "new_file_editor",
          rawRule: {
            action: "prompt",
            "var:new_file_path": "\\.md$",
            handler: "prompt",
            event: "assistant_message_end",
          },
          ruleIndex: 0,
          issues,
        }),
        false,
      );
      assert.deepEqual(issues, [
        {
          message: errorMessageTemplates.unsupportedRuleField({
            fieldName: "handler",
            category: "new_file_editor",
            ruleNumber: 1,
          }),
        },
        {
          message: errorMessageTemplates.unsupportedRuleField({
            fieldName: "event",
            category: "new_file_editor",
            ruleNumber: 1,
          }),
        },
      ]);
    });
  });
  describe("convertConditionVariableName", () => {
    it("converts a known condition variable available to its category", () => {
      const issues: Array<ConfigurationIssue> = [];
      assert.equal(
        convertConditionVariableName({
          category: "new_file_editor",
          fieldName: "var:new_file_path",
          ruleIndex: 0,
          issues,
        }),
        "new_file_path",
      );
      assert.deepEqual(issues, []);
    });
    it("rejects unknown and unavailable condition variables", () => {
      const issues: Array<ConfigurationIssue> = [];
      assert.equal(
        convertConditionVariableName({
          category: "new_file_editor",
          fieldName: "var:unknown",
          ruleIndex: 0,
          issues,
        }),
        undefined,
      );
      assert.equal(
        convertConditionVariableName({
          category: "new_file_editor",
          fieldName: "var:command_string",
          ruleIndex: 1,
          issues,
        }),
        undefined,
      );
      assert.deepEqual(issues, [
        {
          message: errorMessageTemplates.unknownConditionVariable({
            fieldName: "var:unknown",
            category: "new_file_editor",
            ruleNumber: 1,
          }),
        },
        {
          message: errorMessageTemplates.unavailableConditionVariable({
            variableName: "command_string",
            category: "new_file_editor",
            ruleNumber: 2,
          }),
        },
      ]);
    });
  });
  describe("convertRegexSpecification", () => {
    const fieldName = "var:command_string";
    const category = "command_editor";

    it("converts a regex source and supported flags", () => {
      const issues: Array<ConfigurationIssue> = [];
      assert.deepEqual(
        convertRegexSpecification({
          rawRegexValue: ["^remove", "i", "s"],
          fieldName,
          category,
          ruleIndex: 0,
          issues,
        }),
        { source: "^remove", flags: "is" },
      );
      assert.deepEqual(
        convertRegexSpecification({
          rawRegexValue: [".", "u"],
          fieldName,
          category,
          ruleIndex: 1,
          issues,
        }),
        { source: ".", flags: "u" },
      );
      assert.deepEqual(
        convertRegexSpecification({
          rawRegexValue: [".", "v"],
          fieldName,
          category,
          ruleIndex: 2,
          issues,
        }),
        { source: ".", flags: "v" },
      );
      assert.deepEqual(issues, []);
    });
    it("rejects stateful and incompatible regex flags", () => {
      const regexSource = ".*";
      const issues: Array<ConfigurationIssue> = [];
      assert.equal(
        convertRegexSpecification({
          rawRegexValue: [regexSource, "g"],
          fieldName,
          category,
          ruleIndex: 0,
          issues,
        }),
        undefined,
      );
      assert.equal(
        convertRegexSpecification({
          rawRegexValue: [regexSource, "y"],
          fieldName,
          category,
          ruleIndex: 1,
          issues,
        }),
        undefined,
      );
      assert.equal(
        convertRegexSpecification({
          rawRegexValue: [regexSource, "u", "v"],
          fieldName,
          category,
          ruleIndex: 2,
          issues,
        }),
        undefined,
      );
      assert.deepEqual(
        issues,
        [1, 2, 3].map((ruleNumber) => {
          return {
            message: errorMessageTemplates.invalidRegexSpecification({
              fieldName,
              category,
              ruleNumber,
              reason: errorMessageTemplates.invalidRegexFlags(),
            }),
          };
        }),
      );
    });
  });
  describe("convertRawActionValue", () => {
    const category = "new_file_editor";
    it("rejects missing and malformed actions", () => {
      const issues: Array<ConfigurationIssue> = [];
      assert.equal(
        convertRawActionValue({
          rawRule: {},
          category,
          ruleIndex: 0,
          issues,
        }),
        undefined,
      );
      assert.equal(
        convertRawActionValue({
          rawRule: { action: true },
          category,
          ruleIndex: 1,
          issues,
        }),
        undefined,
      );
      assert.deepEqual(issues, [
        {
          message: errorMessageTemplates.missingRuleAction({
            category,
            ruleNumber: 1,
          }),
        },
        {
          message: errorMessageTemplates.invalidRuleAction({
            category,
            ruleNumber: 2,
          }),
        },
      ]);
    });
  });
  describe("convertDecisionAction", () => {
    const decisionCategory = "new_file_editor";
    it("converts decisions allowed by their action context", () => {
      const issues: Array<ConfigurationIssue> = [];
      assert.equal(
        convertDecisionAction({
          rawAction: "prompt",
          category: decisionCategory,
          ruleIndex: 0,
          issues,
        }),
        "prompt",
      );
      assert.deepEqual(issues, []);
    });
    it("rejects invalid decisions and decisions in command-only categories", () => {
      const commandOnlyCategory = "configuration_editor";
      const issues: Array<ConfigurationIssue> = [];
      const invalidDecision = decisionSchema.safeParse("review");
      assert.equal(
        convertDecisionAction({
          rawAction: "review",
          category: decisionCategory,
          ruleIndex: 0,
          issues,
        }),
        undefined,
      );
      assert.equal(
        convertDecisionAction({
          rawAction: "allow",
          category: commandOnlyCategory,
          ruleIndex: 1,
          issues,
        }),
        undefined,
      );
      assert.ok(!invalidDecision.success);
      assert.deepEqual(issues, [
        {
          message: errorMessageTemplates.invalidDecisionAction({
            category: decisionCategory,
            ruleNumber: 1,
            reason: z.prettifyError(invalidDecision.error),
          }),
        },
        {
          message: errorMessageTemplates.commandOnlyActionContext({
            category: commandOnlyCategory,
            ruleNumber: 2,
          }),
        },
      ]);
    });
  });
  describe("validateRawCommand", () => {
    const category = "new_file_editor";
    it("validates command executables", () => {
      const issues: Array<ConfigurationIssue> = [];
      assert.deepEqual(
        validateRawCommand({
          rawAction: ["code", "--wait"],
          category,
          ruleIndex: 0,
          issues,
        }),
        ["code", "--wait"],
      );
      assert.equal(
        validateRawCommand({
          rawAction: [],
          category,
          ruleIndex: 1,
          issues,
        }),
        undefined,
      );
      assert.equal(
        validateRawCommand({
          rawAction: [""],
          category,
          ruleIndex: 2,
          issues,
        }),
        undefined,
      );
      assert.deepEqual(issues, [
        {
          message: errorMessageTemplates.emptyCommandAction({
            category,
            ruleNumber: 2,
          }),
        },
        {
          message: errorMessageTemplates.invalidCommandExecutable({
            category,
            ruleNumber: 3,
          }),
        },
      ]);
    });
  });
  describe("validatePlaceholderToken", () => {
    const category = "new_file_editor";
    it("validates strict placeholder tokens", () => {
      const validPlaceholder = {
        var: "new_file_path",
        prepend: "--file=",
        append: ".bak",
      };
      const invalidPlaceholder = { var: "new_file_path", unknown: true };
      const invalidPlaceholderResult =
        placeholderSchema.safeParse(invalidPlaceholder);
      const issues: Array<ConfigurationIssue> = [];
      assert.deepEqual(
        validatePlaceholderToken({
          rawToken: validPlaceholder,
          category,
          ruleIndex: 0,
          tokenIndex: 1,
          issues,
        }),
        validPlaceholder,
      );
      assert.equal(
        validatePlaceholderToken({
          rawToken: invalidPlaceholder,
          category,
          ruleIndex: 1,
          tokenIndex: 2,
          issues,
        }),
        undefined,
      );
      assert.ok(!invalidPlaceholderResult.success);
      assert.deepEqual(issues, [
        {
          message: errorMessageTemplates.invalidPlaceholderToken({
            category,
            ruleNumber: 2,
            tokenNumber: 3,
            reason: z.prettifyError(invalidPlaceholderResult.error),
          }),
        },
      ]);
    });
  });
  describe("validatePlaceholderVariable", () => {
    const category = "new_file_editor";
    it("validates placeholder variable availability", () => {
      const availablePlaceholder = { var: "new_file_path" } as const;
      const unavailablePlaceholder = { var: "command_string" } as const;
      const issues: Array<ConfigurationIssue> = [];
      assert.deepEqual(
        validatePlaceholderVariable({
          placeholder: availablePlaceholder,
          category,
          ruleIndex: 0,
          tokenIndex: 1,
          issues,
        }),
        availablePlaceholder,
      );
      assert.equal(
        validatePlaceholderVariable({
          placeholder: unavailablePlaceholder,
          category,
          ruleIndex: 1,
          tokenIndex: 2,
          issues,
        }),
        undefined,
      );
      assert.deepEqual(issues, [
        {
          message: errorMessageTemplates.unavailablePlaceholderVariable({
            variableName: unavailablePlaceholder.var,
            category,
            ruleNumber: 2,
            tokenNumber: 3,
          }),
        },
      ]);
    });
  });
  describe("convertCommandToken", () => {
    const category = "new_file_editor";
    it("converts literal and available placeholder command tokens", () => {
      const literalToken = "--wait";
      const placeholderToken = { var: "new_file_path" };
      const ruleIndex = 0;
      const tokenIndex = 1;
      const issues: Array<ConfigurationIssue> = [];
      assert.equal(
        convertCommandToken({
          rawToken: literalToken,
          category,
          ruleIndex,
          tokenIndex,
          issues,
        }),
        literalToken,
      );
      assert.deepEqual(
        convertCommandToken({
          rawToken: placeholderToken,
          category,
          ruleIndex,
          tokenIndex,
          issues,
        }),
        placeholderToken,
      );
      assert.deepEqual(issues, []);
    });
    it("rejects non-string, non-placeholder command tokens", () => {
      const ruleIndex = 1;
      const tokenIndex = 2;
      const issues: Array<ConfigurationIssue> = [];
      assert.equal(
        convertCommandToken({
          rawToken: true,
          category,
          ruleIndex,
          tokenIndex,
          issues,
        }),
        undefined,
      );
      assert.deepEqual(issues, [
        {
          message: errorMessageTemplates.invalidCommandToken({
            category,
            ruleNumber: ruleIndex + 1,
            tokenNumber: tokenIndex + 1,
          }),
        },
      ]);
    });
  });
  describe("convertCommandAction", () => {
    const category = "new_file_editor";
    it("preserves token order in a valid command action", () => {
      const rawAction = ["code", "--wait", { var: "new_file_path" }];
      const issues: Array<ConfigurationIssue> = [];
      assert.deepEqual(
        convertCommandAction({
          rawAction,
          category,
          ruleIndex: 0,
          issues,
        }),
        rawAction,
      );
      assert.deepEqual(issues, []);
    });
    it("rejects a command action with an invalid token", () => {
      const ruleIndex = 1;
      const tokenIndex = 1;
      const issues: Array<ConfigurationIssue> = [];
      assert.equal(
        convertCommandAction({
          rawAction: ["code", true, "--wait"],
          category,
          ruleIndex,
          issues,
        }),
        undefined,
      );
      assert.deepEqual(issues, [
        {
          message: errorMessageTemplates.invalidCommandToken({
            category,
            ruleNumber: ruleIndex + 1,
            tokenNumber: tokenIndex + 1,
          }),
        },
      ]);
    });
  });
  describe("convertRawRule", () => {
    const category = "new_file_editor";
    it("converts a complete rule", () => {
      const regexSource = "\\.md$";
      const action = ["code", "--wait", { var: "new_file_path" }];
      const rawRule = {
        "var:new_file_path": regexSource,
        action,
      };
      const issues: Array<ConfigurationIssue> = [];
      assert.deepEqual(
        convertRawRule({ category, rawRule, ruleIndex: 0, issues }),
        {
          conditions: {
            new_file_path: { source: regexSource, flags: "" },
          },
          action,
        },
      );
      assert.deepEqual(issues, []);
    });
    it("returns no partial rule when fields are unsupported", () => {
      const ruleIndex = 1;
      const rawRule = { action: "prompt", event: "agent_settled" };
      const issues: Array<ConfigurationIssue> = [];
      assert.equal(
        convertRawRule({ category, rawRule, ruleIndex, issues }),
        undefined,
      );
      assert.deepEqual(issues, [
        {
          message: errorMessageTemplates.unsupportedRuleField({
            fieldName: "event",
            category,
            ruleNumber: ruleIndex + 1,
          }),
        },
      ]);
    });
  });
  describe("convertHandlerCategoryRules", () => {
    it("preserves valid rule order while retaining invalid-rule issues", () => {
      const category = "new_file_editor";
      const rawRules = [
        { action: "prompt" },
        { action: "deny", event: "agent_settled" },
        { action: "allow" },
      ];
      const issues: Array<ConfigurationIssue> = [];
      assert.deepEqual(
        convertHandlerCategoryRules({ category, rawRules, issues }),
        [
          { conditions: {}, action: "prompt" },
          { conditions: {}, action: "allow" },
        ],
      );
      assert.deepEqual(issues, [
        {
          message: errorMessageTemplates.unsupportedRuleField({
            fieldName: "event",
            category,
            ruleNumber: 2,
          }),
        },
      ]);
    });
  });
  describe("convertHandlerRules", () => {
    it("converts supported categories and reports unknown categories", () => {
      const category = "new_file_editor";
      const unknownCategory = "unsupported_editor";
      const issues: Array<ConfigurationIssue> = [];
      assert.deepEqual(
        convertHandlerRules({
          rawHandlers: {
            [category]: [{ action: "prompt" }],
            [unknownCategory]: [],
          },
          issues,
        }),
        {
          [category]: [{ conditions: {}, action: "prompt" }],
        },
      );
      assert.deepEqual(issues, [
        {
          message:
            errorMessageTemplates.unsupportedHandlerCategory(unknownCategory),
        },
      ]);
    });
  });
  describe("convertHookRules", () => {
    const supportedHookRules = [
      { action: ["notify-send", { var: "assistant_message_text" }] },
    ];
    const convertedSupportedHookRules = [
      {
        conditions: {},
        action: ["notify-send", { var: "assistant_message_text" }],
      },
    ];
    it("converts command-only rules for a supported hook", () => {
      const issues: Array<ConfigurationIssue> = [];
      assert.deepEqual(
        convertHookRules({
          rawHooks: { assistant_message_end: supportedHookRules },
          issues,
        }),
        { assistant_message_end: convertedSupportedHookRules },
      );
      assert.deepEqual(issues, []);
    });

    it("preserves supported hooks while reporting unknown hook names", () => {
      const unknownHookName = "tool_complete";
      const issues: Array<ConfigurationIssue> = [];
      assert.deepEqual(
        convertHookRules({
          rawHooks: {
            assistant_message_end: supportedHookRules,
            [unknownHookName]: [],
          },
          issues,
        }),
        { assistant_message_end: convertedSupportedHookRules },
      );
      assert.deepEqual(issues, [
        {
          message: errorMessageTemplates.unsupportedHookName(unknownHookName),
        },
      ]);
    });
  });
  describe("convertRawConfigurationDocument", () => {
    it("returns converted configuration alongside validation issues", () => {
      const unknownCategory = "unsupported_editor";
      assert.deepEqual(
        convertRawConfigurationDocument({
          handlers: {
            new_file_editor: [{ action: "prompt" }],
            [unknownCategory]: [],
          },
        }),
        {
          configuration: {
            handlers: {
              new_file_editor: [{ conditions: {}, action: "prompt" }],
            },
            hooks: {},
          },
          issues: [
            {
              message:
                errorMessageTemplates.unsupportedHandlerCategory(
                  unknownCategory,
                ),
            },
          ],
        },
      );
    });
  });
  describe("parseTomlDocument", () => {
    it("parses a valid TOML document", () => {
      assert.deepEqual(parseTomlDocument("enabled = true"), { enabled: true });
    });
    it("throws for invalid TOML syntax", () => {
      assert.throws(() => parseTomlDocument("enabled = ["));
    });
  });
  describe("validateTomlDocument", () => {
    it("accepts a structurally valid TOML document", () => {
      const document = {
        handlers: { command_editor: [] },
        future: true,
      };
      assert.deepEqual(validateTomlDocument(document), document);
    });
    it("rejects an invalid handlers value", () => {
      assert.throws(() => validateTomlDocument({ handlers: "invalid" }));
    });
  });
  describe("convertTomlDocumentToConfiguration", () => {
    it("converts a structurally valid handler document", () => {
      const parsedTomlDocument = {
        handlers: {
          new_file_editor: [{ action: "prompt" }],
        },
      };
      assert.deepEqual(convertTomlDocumentToConfiguration(parsedTomlDocument), {
        configuration: {
          handlers: {
            new_file_editor: [{ conditions: {}, action: "prompt" }],
          },
          hooks: {},
        },
        issues: [],
      });
    });
    it("converts a structurally valid hook document", () => {
      const parsedTomlDocument = {
        hooks: {
          agent_settled: [{ action: ["notify-send"] }],
        },
      };
      assert.deepEqual(convertTomlDocumentToConfiguration(parsedTomlDocument), {
        configuration: {
          handlers: {},
          hooks: {
            agent_settled: [{ conditions: {}, action: ["notify-send"] }],
          },
        },
        issues: [],
      });
    });
  });
  describe("parseConfigurationSource", () => {
    it("parses TOML source into a configuration conversion result", () => {
      const configurationSource = [
        "[[handlers.new_file_editor]]",
        'action = "prompt"',
      ].join("\n");
      assert.deepEqual(parseConfigurationSource(configurationSource), {
        configuration: {
          handlers: {
            new_file_editor: [{ conditions: {}, action: "prompt" }],
          },
          hooks: {},
        },
        issues: [],
      });
    });
    it("returns an issue instead of throwing for malformed TOML", () => {
      const result = parseConfigurationSource("handlers = [");
      assert.deepEqual(result.configuration, createEmptyConfiguration());
      assert.equal(result.issues.length, 1);
      assert.match(result.issues[0].message, invalidConfigurationMessagePrefix);
    });
    it("returns an issue instead of throwing for invalid TOML structure", () => {
      const result = parseConfigurationSource('handlers = "invalid"');
      assert.deepEqual(result.configuration, createEmptyConfiguration());
      assert.equal(result.issues.length, 1);
      assert.match(result.issues[0].message, invalidConfigurationMessagePrefix);
    });
  });
  describe("loadConfiguration", () => {
    it("uses the empty configuration without warning when the file is absent", async () => {
      const missingFileError = Object.assign(new Error("missing"), {
        code: "ENOENT",
      });
      const { dependencies, warnings } = createLoadConfigurationHarness(
        async () => {
          throw missingFileError;
        },
      );
      const configuration = await loadConfiguration(dependencies);
      assert.deepEqual(configuration, createEmptyConfiguration());
      assert.deepEqual(warnings, []);
    });
    it("reports non-missing configuration read failures", async () => {
      const readError = new Error("permission denied");
      const { dependencies, warnings } = createLoadConfigurationHarness(
        async () => {
          throw readError;
        },
      );
      const configuration = await loadConfiguration(dependencies);
      assert.deepEqual(configuration, createEmptyConfiguration());
      assert.deepEqual(warnings, [
        errorMessageTemplates.configurationFileReadFailed(readError.message),
      ]);
    });
    it("reports current invalid-source warnings on every load", async () => {
      const invalidConfigurationSource = "handlers = [";
      const expectedWarning = parseConfigurationSource(
        invalidConfigurationSource,
      ).issues[0].message;
      const { dependencies, warnings } = createLoadConfigurationHarness(
        async () => {
          return invalidConfigurationSource;
        },
      );
      assert.deepEqual(
        await loadConfiguration(dependencies),
        createEmptyConfiguration(),
      );
      assert.deepEqual(
        await loadConfiguration(dependencies),
        createEmptyConfiguration(),
      );
      assert.deepEqual(warnings, [expectedWarning, expectedWarning]);
    });
    it("falls back when a rule contains an invalid regex", async () => {
      const invalidRegexConfigurationSource = [
        "[[handlers.new_file_editor]]",
        '"var:new_file_path" = "["',
        'action = "prompt"',
      ].join("\n");
      const category = "new_file_editor";
      const fieldName = "var:new_file_path";
      const ruleNumber = 1;
      const { dependencies, warnings } = createLoadConfigurationHarness(
        async () => {
          return invalidRegexConfigurationSource;
        },
      );
      const configuration = await loadConfiguration(dependencies);
      assert.deepEqual(configuration, createEmptyConfiguration());
      assert.equal(warnings.length, 1);
      assert.ok(
        warnings[0].startsWith(
          errorMessageTemplates.invalidRegexSpecification({
            fieldName,
            category,
            ruleNumber,
            reason: "",
          }),
        ),
      );
    });
  });
  describe("ruleConditionsMatch", () => {
    it("matches empty conditions and every matching condition", () => {
      const conditions = {
        new_file_path: { source: "\\.md$", flags: "i" },
        command_string: { source: "^write", flags: "" },
      };
      const matchingVariables = {
        new_file_path: "/workspace/README.MD",
        command_string: "write README.MD",
      };
      assert.equal(
        ruleConditionsMatch({ conditions: {}, variables: {} }),
        true,
      );
      assert.equal(
        ruleConditionsMatch({ conditions, variables: matchingVariables }),
        true,
      );
    });
    it("requires every condition variable to match", () => {
      const conditions = {
        new_file_path: { source: "\\.md$", flags: "" },
        command_string: { source: "^write", flags: "" },
      };
      assert.equal(
        ruleConditionsMatch({
          conditions,
          variables: {
            new_file_path: "/workspace/README.md",
            command_string: "read README.md",
          },
        }),
        false,
      );
      assert.equal(
        ruleConditionsMatch({
          conditions,
          variables: { new_file_path: "/workspace/README.md" },
        }),
        false,
      );
    });
  });
  describe("resolveRawAction", () => {
    it("resolves the final matching decision action", () => {
      const rules = [
        { conditions: {}, action: "prompt" as const },
        {
          conditions: {
            new_file_path: { source: "\\.md$", flags: "" },
          },
          action: "allow" as const,
        },
        { conditions: {}, action: "deny" as const },
      ];
      assert.equal(
        resolveRawAction({
          rules,
          variables: { new_file_path: "/workspace/README.md" },
        }),
        "deny",
      );
    });
    it("resolves the final matching hook command", () => {
      const rules = [
        { conditions: {}, action: ["notify-first"] as [string] },
        { conditions: {}, action: ["notify-final"] as [string] },
      ];
      assert.deepEqual(resolveRawAction({ rules, variables: {} }), [
        "notify-final",
      ]);
    });
  });
  describe("expandCommand", () => {
    it("throws when a required placeholder variable is missing", () => {
      const command = [
        "notify-send",
        { var: "assistant_message_text" },
      ] satisfies Command;
      assert.throws(
        () => expandCommand({ command, variables: {} }),
        new Error(
          errorMessageTemplates.commandVariableUnavailable("assistant_message_text"),
        ),
      );
    });
    it("preserves an intentionally empty placeholder value", () => {
      const command = [
        "notify-send",
        { var: "assistant_message_text" },
      ] satisfies Command;
      assert.deepEqual(
        expandCommand({ command, variables: { assistant_message_text: "" } }),
        ["notify-send", ""],
      );
    });
    it("expands every placeholder into one argv element", () => {
      const command = [
        "code",
        { var: "new_file_path", prepend: "--file=", append: ".bak" },
        "--wait",
      ] satisfies Command;
      const variables = { new_file_path: "/workspace/file with spaces" };
      assert.deepEqual(expandCommand({ command, variables }), [
        "code",
        "--file=/workspace/file with spaces.bak",
        "--wait",
      ]);
    });
  });
});

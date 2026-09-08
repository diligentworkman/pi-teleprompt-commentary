import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  decisions,
  handlerCategories,
  hookNames,
  variableNames,
} from "#/config-loader/constants.ts";
import type { TelepromptConfig } from "#/config-loader/types.ts";
import type { ConfigurationFileSystem } from "#/config-editor/types.ts";
import {
  createEmptyConfiguration,
  parseConfigurationSource,
} from "#/config-loader/utils.ts";
import {
  configurationFileSystem,
  createStarterConfigurationSource,
  ensureConfigurationFile,
  isConfigurationFileAlreadyExistsError,
  readStarterConfigurationReference,
  readStarterConfigurationSource,
  writeConfigurationFileAtomically,
} from "#/config-editor/utils.ts";

async function createTemporaryDirectory(
  testContext: TestContext,
): Promise<string> {
  const directoryPath = await mkdtemp(join(tmpdir(), "teleprompt-commentary-"));
  testContext.after(async () => {
    await rm(directoryPath, { recursive: true, force: true });
  });

  return directoryPath;
}

function createFailingFileSystem(error: Error): ConfigurationFileSystem {
  return {
    async createDirectory() {},
    async createFileExclusively() {
      throw error;
    },
    async readFile() {
      throw new Error("A failed creation must not read the file.");
    },
  };
}

function getRules(configuration: TelepromptConfig) {
  return [
    ...Object.values(configuration.handlers),
    ...Object.values(configuration.hooks),
  ].flatMap((rules) => rules ?? []);
}

function getDocumentedVariableNames(configuration: TelepromptConfig) {
  const documentedVariableNames = new Set<string>();
  for (const rule of getRules(configuration)) {
    for (const variable of Object.keys(rule.conditions)) {
      documentedVariableNames.add(variable);
    }
    if (Array.isArray(rule.action)) {
      for (const token of rule.action) {
        if (typeof token === "object") {
          documentedVariableNames.add(token.var);
        }
      }
    }
  }

  return [...documentedVariableNames];
}

function getPlaceholders(configuration: TelepromptConfig) {
  return getRules(configuration).flatMap((rule) => {
    if (!Array.isArray(rule.action)) {
      return [];
    }

    return rule.action.filter((token) => {
      return typeof token === "object";
    });
  });
}

describe("configuration editor utilities", () => {
  const configFileName = "config.toml";
  describe("isConfigurationFileAlreadyExistsError", () => {
    it("recognizes only filesystem errors for an existing path", () => {
      const existingPathError = Object.assign(new Error("already exists"), {
        code: "EEXIST",
      });
      assert.equal(
        isConfigurationFileAlreadyExistsError(existingPathError),
        true,
      );
      assert.equal(
        isConfigurationFileAlreadyExistsError(new Error("write failed")),
        false,
      );
      assert.equal(isConfigurationFileAlreadyExistsError("EEXIST"), false);
    });
  });
  describe("ensureConfigurationFile", () => {
    const starterSource = "starter";
    it("creates the parent directory and starter file exclusively", async (testContext) => {
      const temporaryDirectory = await createTemporaryDirectory(testContext);
      const configFilePath = join(temporaryDirectory, "nested", configFileName);
      const result = await ensureConfigurationFile({
        configFilePath,
        starterSource,
        fileSystem: configurationFileSystem,
      });
      assert.equal(await readFile(configFilePath, "utf8"), starterSource);
      assert.deepEqual(result, { source: starterSource, created: true });
    });
    it("preserves and reads an existing configuration", async (testContext) => {
      const temporaryDirectory = await createTemporaryDirectory(testContext);
      const configFilePath = join(temporaryDirectory, configFileName);
      const existingSource = "existing";
      await writeFile(configFilePath, existingSource, "utf8");
      const result = await ensureConfigurationFile({
        configFilePath,
        starterSource,
        fileSystem: configurationFileSystem,
      });
      assert.equal(await readFile(configFilePath, "utf8"), existingSource);
      assert.deepEqual(result, { source: existingSource, created: false });
    });
    it("does not hide unexpected creation failures", async () => {
      const error = new Error("permission denied");
      await assert.rejects(
        ensureConfigurationFile({
          configFilePath: `/config/${configFileName}`,
          starterSource,
          fileSystem: createFailingFileSystem(error),
        }),
        error,
      );
    });
  });
  describe("writeConfigurationFileAtomically", () => {
    it("replaces the existing configuration without leaving a temporary file", async (testContext) => {
      const temporaryDirectory = await createTemporaryDirectory(testContext);
      const configFilePath = join(temporaryDirectory, configFileName);
      const updatedSource = "updated";
      await writeFile(configFilePath, "existing", "utf8");
      await writeConfigurationFileAtomically({
        configFilePath,
        source: updatedSource,
      });
      assert.equal(await readFile(configFilePath, "utf8"), updatedSource);
      assert.deepEqual(await readdir(temporaryDirectory), [configFileName]);
    });
    it("preserves intentionally empty editor content", async (testContext) => {
      const temporaryDirectory = await createTemporaryDirectory(testContext);
      const configFilePath = join(temporaryDirectory, configFileName);
      await writeFile(configFilePath, "existing", "utf8");
      await writeConfigurationFileAtomically({ configFilePath, source: "" });
      assert.equal(await readFile(configFilePath, "utf8"), "");
    });
  });
  describe("starter configuration reference", () => {
    it("is a valid configuration", async () => {
      const reference = await readStarterConfigurationReference();
      assert.deepEqual(parseConfigurationSource(reference).issues, []);
    });
    it("covers every supported context and variable", async () => {
      const reference = await readStarterConfigurationReference();
      const { configuration } = parseConfigurationSource(reference);
      assert.deepEqual(
        Object.keys(configuration.handlers).sort(),
        [...handlerCategories].sort(),
      );
      assert.deepEqual(
        Object.keys(configuration.hooks).sort(),
        [...hookNames].sort(),
      );
      assert.deepEqual(
        getDocumentedVariableNames(configuration).sort(),
        [...variableNames].sort(),
      );
    });
    it("demonstrates every decision and both placeholder modifiers", async () => {
      const reference = await readStarterConfigurationReference();
      const { configuration } = parseConfigurationSource(reference);
      const documentedDecisions = [
        ...new Set(
          getRules(configuration)
            .map(({ action }) => action)
            .filter((action) => typeof action === "string"),
        ),
      ].sort();
      const placeholders = getPlaceholders(configuration);
      assert.deepEqual(documentedDecisions, [...decisions].sort());
      assert.equal(
        placeholders.some(({ prepend }) => prepend !== undefined),
        true,
      );
      assert.equal(
        placeholders.some(({ append }) => append !== undefined),
        true,
      );
    });
  });
  describe("createStarterConfigurationSource", () => {
    it("distinguishes documentation from disabled configuration", () => {
      const source = createStarterConfigurationSource(
        '# Documentation\naction = "prompt"\n',
      );
      assert.equal(source, '## Documentation\n# action = "prompt"\n');
    });
  });
  describe("readStarterConfigurationSource", () => {
    it("loads a safe configuration with no active rules", async () => {
      const source = await readStarterConfigurationSource();
      assert.deepEqual(parseConfigurationSource(source), {
        configuration: createEmptyConfiguration(),
        issues: [],
      });
    });
  });
});

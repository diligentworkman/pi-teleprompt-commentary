import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  rootInstructionFileNames,
  systemPromptAppendRelativePath,
} from "#/workspace-context/constants.ts";
import {
  warningMessageTemplates,
  workspaceStatusMessageTemplates,
} from "#/workspace-context/messages.ts";
import type { WorkspaceContextFileSystem } from "#/workspace-context/types.ts";
import { selectWorkspaceContextSources } from "#/workspace-context/source-selection.ts";

type PathResult = "directory" | "file" | "other" | Error;

function createMissingPathError(path: string) {
  return Object.assign(new Error(`Path does not exist: ${path}`), {
    code: "ENOENT",
  });
}

function createFileSystem(pathResults: ReadonlyMap<string, PathResult>) {
  const inspectedPaths: Array<string> = [];
  const fileSystem: WorkspaceContextFileSystem = {
    async stat(path) {
      inspectedPaths.push(path);
      const result = pathResults.get(path) ?? createMissingPathError(path);
      if (result instanceof Error) {
        throw result;
      }

      return {
        isDirectory() {
          return result === "directory";
        },
        isFile() {
          return result === "file";
        },
      };
    },
  };

  return { fileSystem, inspectedPaths };
}

async function createTemporaryDirectory(testContext: TestContext) {
  const directory = await mkdtemp(
    join(tmpdir(), "teleprompt-workspace-context-"),
  );
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return realpath(directory);
}

describe("workspace context source selection", () => {
  const workspacePath = "/workspaces/project";
  const overridePath = join(workspacePath, rootInstructionFileNames[0]);
  const agentsPath = join(workspacePath, rootInstructionFileNames[1]);
  const claudePath = join(workspacePath, rootInstructionFileNames[2]);
  const systemPromptAppendPath = join(
    workspacePath,
    systemPromptAppendRelativePath,
  );
  it("selects the highest-precedence root file and system prompt append independently", async () => {
    const pathResults = new Map<string, PathResult>([
      [workspacePath, "directory"],
      [overridePath, "file"],
      [agentsPath, "file"],
      [systemPromptAppendPath, "file"],
    ]);
    const { fileSystem, inspectedPaths } = createFileSystem(pathResults);
    const warnings: Array<string> = [];
    const selection = await selectWorkspaceContextSources({
      workspacePath,
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(selection, {
      workspacePath,
      availability: "available",
      instructionPath: overridePath,
      systemPromptAppendPath,
    });
    assert.deepEqual(inspectedPaths, [
      workspacePath,
      overridePath,
      systemPromptAppendPath,
    ]);
    assert.deepEqual(warnings, []);
  });
  it("continues precedence only past missing root files", async () => {
    const pathResults = new Map<string, PathResult>([
      [workspacePath, "directory"],
      [agentsPath, "file"],
    ]);
    const { fileSystem, inspectedPaths } = createFileSystem(pathResults);
    const warnings: Array<string> = [];
    const selection = await selectWorkspaceContextSources({
      workspacePath,
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(selection, {
      workspacePath,
      availability: "available",
      instructionPath: agentsPath,
    });
    assert.deepEqual(inspectedPaths, [
      workspacePath,
      overridePath,
      agentsPath,
      systemPromptAppendPath,
    ]);
    assert.deepEqual(warnings, []);
  });
  it("falls back to CLAUDE.md when both AGENTS files are missing", async () => {
    const pathResults = new Map<string, PathResult>([
      [workspacePath, "directory"],
      [claudePath, "file"],
    ]);
    const { fileSystem, inspectedPaths } = createFileSystem(pathResults);
    const warnings: Array<string> = [];
    const selection = await selectWorkspaceContextSources({
      workspacePath,
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(selection, {
      workspacePath,
      availability: "available",
      instructionPath: claudePath,
    });
    assert.deepEqual(inspectedPaths, [
      workspacePath,
      overridePath,
      agentsPath,
      claudePath,
      systemPromptAppendPath,
    ]);
    assert.deepEqual(warnings, []);
  });
  it("stops root fallback after an unreadable higher-precedence path", async () => {
    const inspectionError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const pathResults = new Map<string, PathResult>([
      [workspacePath, "directory"],
      [overridePath, inspectionError],
      [agentsPath, "file"],
      [systemPromptAppendPath, "file"],
    ]);
    const { fileSystem, inspectedPaths } = createFileSystem(pathResults);
    const warnings: Array<string> = [];
    const selection = await selectWorkspaceContextSources({
      workspacePath,
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(selection, {
      workspacePath,
      availability: "available",
      systemPromptAppendPath,
    });
    assert.deepEqual(inspectedPaths, [
      workspacePath,
      overridePath,
      systemPromptAppendPath,
    ]);
    assert.deepEqual(warnings, [
      warningMessageTemplates.contextSourcePathInspectionFailed({
        sourcePath: overridePath,
        reason: inspectionError.message,
      }),
    ]);
  });
  it("stops root fallback when a higher-precedence path is not a file", async () => {
    const pathResults = new Map<string, PathResult>([
      [workspacePath, "directory"],
      [overridePath, "other"],
      [agentsPath, "file"],
    ]);
    const { fileSystem, inspectedPaths } = createFileSystem(pathResults);
    const warnings: Array<string> = [];
    const selection = await selectWorkspaceContextSources({
      workspacePath,
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(selection, {
      workspacePath,
      availability: "available",
    });
    assert.deepEqual(inspectedPaths, [
      workspacePath,
      overridePath,
      systemPromptAppendPath,
    ]);
    assert.deepEqual(warnings, [
      warningMessageTemplates.contextSourcePathNotFile(overridePath),
    ]);
  });
  it("reports a missing workspace without checking its instruction files", async () => {
    const { fileSystem, inspectedPaths } = createFileSystem(new Map());
    const warnings: Array<string> = [];
    const selection = await selectWorkspaceContextSources({
      workspacePath,
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(selection, {
      workspacePath,
      availability: "unavailable",
      reason: workspaceStatusMessageTemplates.pathDoesNotExist(),
    });
    assert.deepEqual(inspectedPaths, [workspacePath]);
    assert.deepEqual(warnings, [
      warningMessageTemplates.additionalWorkspaceUnavailable({
        workspacePath,
        reason: workspaceStatusMessageTemplates.pathDoesNotExist(),
      }),
    ]);
  });
  it("selects a symlinked instruction file transparently", async (testContext) => {
    const directory = await createTemporaryDirectory(testContext);
    const targetPath = join(directory, "shared-instructions.md");
    const linkedInstructionPath = join(directory, rootInstructionFileNames[0]);
    await writeFile(targetPath, "Shared instructions", "utf8");
    await symlink(targetPath, linkedInstructionPath, "file");
    const warnings: Array<string> = [];
    const selection = await selectWorkspaceContextSources({
      workspacePath: directory,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(selection, {
      workspacePath: directory,
      availability: "available",
      instructionPath: linkedInstructionPath,
    });
    assert.deepEqual(warnings, []);
  });
});

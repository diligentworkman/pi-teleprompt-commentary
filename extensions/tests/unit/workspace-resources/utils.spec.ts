import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { warningMessageTemplates } from "#/workspace-resources/messages.ts";
import type { WorkspaceResourceFileSystem } from "#/workspace-resources/types.ts";
import { discoverWorkspaceResources } from "#/workspace-resources/index.ts";

type PathResult = "directory" | "file" | Error;

function createMissingPathError(path: string) {
  return Object.assign(new Error(`Path does not exist: ${path}`), {
    code: "ENOENT",
  });
}

function createFileSystem(pathResults: ReadonlyMap<string, PathResult>) {
  const inspectedPaths: Array<string> = [];
  const fileSystem: WorkspaceResourceFileSystem = {
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
      };
    },
  };

  return { fileSystem, inspectedPaths };
}

describe("workspace resource discovery", () => {
  const firstWorkspace = "/workspaces/first";
  const secondWorkspace = "/workspaces/second";
  const firstPiSkills = join(firstWorkspace, ".pi/skills");
  const firstAgentSkills = join(firstWorkspace, ".agents/skills");
  const firstPrompts = join(firstWorkspace, ".pi/prompts");
  const secondPiSkills = join(secondWorkspace, ".pi/skills");
  const secondAgentSkills = join(secondWorkspace, ".agents/skills");
  const secondPrompts = join(secondWorkspace, ".pi/prompts");
  it("returns existing resource directories in workspace and source order", async () => {
    const pathResults = new Map<string, PathResult>([
      [firstWorkspace, "directory"],
      [firstPiSkills, "directory"],
      [firstAgentSkills, "directory"],
      [firstPrompts, "directory"],
      [secondWorkspace, "directory"],
      [secondPiSkills, "directory"],
      [secondAgentSkills, "directory"],
      [secondPrompts, "directory"],
    ]);
    const { fileSystem, inspectedPaths } = createFileSystem(pathResults);
    const warnings: Array<string> = [];
    const resources = await discoverWorkspaceResources({
      additionalWorkspaces: [firstWorkspace, secondWorkspace],
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(resources, {
      skillPaths: [
        firstPiSkills,
        firstAgentSkills,
        secondPiSkills,
        secondAgentSkills,
      ],
      promptPaths: [firstPrompts, secondPrompts],
    });
    assert.deepEqual(inspectedPaths, [
      firstWorkspace,
      firstPiSkills,
      firstAgentSkills,
      firstPrompts,
      secondWorkspace,
      secondPiSkills,
      secondAgentSkills,
      secondPrompts,
    ]);
    assert.deepEqual(warnings, []);
  });
  it("silently excludes missing resource directories", async () => {
    const pathResults = new Map<string, PathResult>([
      [firstWorkspace, "directory"],
      [firstAgentSkills, "directory"],
    ]);
    const { fileSystem } = createFileSystem(pathResults);
    const warnings: Array<string> = [];
    const resources = await discoverWorkspaceResources({
      additionalWorkspaces: [firstWorkspace],
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(resources, {
      skillPaths: [firstAgentSkills],
      promptPaths: [],
    });
    assert.deepEqual(warnings, []);
  });
  it("warns once and skips children when an additional workspace is missing", async () => {
    const { fileSystem, inspectedPaths } = createFileSystem(new Map());
    const warnings: Array<string> = [];
    const resources = await discoverWorkspaceResources({
      additionalWorkspaces: [firstWorkspace],
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(resources, { skillPaths: [], promptPaths: [] });
    assert.deepEqual(inspectedPaths, [firstWorkspace]);
    assert.deepEqual(warnings, [
      warningMessageTemplates.additionalWorkspaceUnavailable({
        workspacePath: firstWorkspace,
        reason: "path does not exist",
      }),
    ]);
  });
  it("warns and skips children when a workspace path is not a directory", async () => {
    const { fileSystem, inspectedPaths } = createFileSystem(
      new Map([[firstWorkspace, "file"]]),
    );
    const warnings: Array<string> = [];
    const resources = await discoverWorkspaceResources({
      additionalWorkspaces: [firstWorkspace],
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(resources, { skillPaths: [], promptPaths: [] });
    assert.deepEqual(inspectedPaths, [firstWorkspace]);
    assert.deepEqual(warnings, [
      warningMessageTemplates.additionalWorkspaceUnavailable({
        workspacePath: firstWorkspace,
        reason: "path is not a directory",
      }),
    ]);
  });
  it("warns for malformed and unreadable resource paths while continuing", async () => {
    const inspectionError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const pathResults = new Map<string, PathResult>([
      [firstWorkspace, "directory"],
      [firstPiSkills, "file"],
      [firstAgentSkills, inspectionError],
      [firstPrompts, "directory"],
      [secondWorkspace, "directory"],
      [secondPiSkills, "directory"],
    ]);
    const { fileSystem } = createFileSystem(pathResults);
    const warnings: Array<string> = [];
    const resources = await discoverWorkspaceResources({
      additionalWorkspaces: [firstWorkspace, secondWorkspace],
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(resources, {
      skillPaths: [secondPiSkills],
      promptPaths: [firstPrompts],
    });
    assert.deepEqual(warnings, [
      warningMessageTemplates.resourcePathNotDirectory(firstPiSkills),
      warningMessageTemplates.resourcePathInspectionFailed({
        resourcePath: firstAgentSkills,
        reason: inspectionError.message,
      }),
    ]);
  });
});

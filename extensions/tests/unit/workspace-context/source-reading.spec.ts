import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  warningMessageTemplates,
  workspaceStatusMessageTemplates,
} from "#/workspace-context/messages.ts";
import { readWorkspaceContextSources } from "#/workspace-context/source-reading.ts";
import type { WorkspaceContextSourceReader } from "#/workspace-context/types.ts";

function createReader(results: ReadonlyMap<string, string | Error>) {
  const readPaths: Array<string> = [];
  const fileSystem: WorkspaceContextSourceReader = {
    async readFile(path) {
      readPaths.push(path);
      const result = results.get(path);
      if (result === undefined) {
        throw new Error(`Unexpected context source read: ${path}`);
      }
      if (result instanceof Error) {
        throw result;
      }

      return result;
    },
  };

  return { fileSystem, readPaths };
}

describe("workspace context source reading", () => {
  const workspacePath = "/workspaces/project";
  const instructionPath = join(workspacePath, "AGENTS.override.md");
  const systemPromptAppendPath = join(workspacePath, ".pi/APPEND_SYSTEM.md");
  const instructionContent = "Apply these project rules.\n";
  const systemPromptAppendContent = "Additional guidance.\n";
  const sourceSelection = {
    workspacePath,
    availability: "available" as const,
    instructionPath,
    systemPromptAppendPath,
  };
  it("reads instructions then the system prompt append with source attribution", async () => {
    const { fileSystem, readPaths } = createReader(
      new Map([
        [instructionPath, instructionContent],
        [systemPromptAppendPath, systemPromptAppendContent],
      ]),
    );
    const warnings: Array<string> = [];
    const contextSources = await readWorkspaceContextSources({
      sourceSelection,
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(readPaths, [instructionPath, systemPromptAppendPath]);
    assert.deepEqual(contextSources, [
      {
        kind: "instructions",
        workspacePath,
        sourcePath: instructionPath,
        content: instructionContent,
      },
      {
        kind: "system-prompt-append",
        workspacePath,
        sourcePath: systemPromptAppendPath,
        content: systemPromptAppendContent,
      },
    ]);
    assert.deepEqual(warnings, []);
  });
  it("preserves an intentionally empty instruction file", async () => {
    const { fileSystem } = createReader(new Map([[instructionPath, ""]]));
    const warnings: Array<string> = [];
    const contextSources = await readWorkspaceContextSources({
      sourceSelection: {
        workspacePath,
        availability: "available",
        instructionPath,
      },
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(contextSources, [
      {
        kind: "instructions",
        workspacePath,
        sourcePath: instructionPath,
        content: "",
      },
    ]);
    assert.deepEqual(warnings, []);
  });
  it("warns for disappeared selected instructions and still reads the system prompt append", async () => {
    const readError = Object.assign(new Error("Selected file disappeared"), {
      code: "ENOENT",
    });
    const { fileSystem, readPaths } = createReader(
      new Map<string, string | Error>([
        [instructionPath, readError],
        [systemPromptAppendPath, systemPromptAppendContent],
      ]),
    );
    const warnings: Array<string> = [];
    const contextSources = await readWorkspaceContextSources({
      sourceSelection,
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(readPaths, [instructionPath, systemPromptAppendPath]);
    assert.deepEqual(contextSources, [
      {
        kind: "system-prompt-append",
        workspacePath,
        sourcePath: systemPromptAppendPath,
        content: systemPromptAppendContent,
      },
    ]);
    assert.deepEqual(warnings, [
      warningMessageTemplates.contextSourceReadFailed({
        sourcePath: instructionPath,
        reason: readError.message,
      }),
    ]);
  });
  it("retains instructions when reading the system prompt append fails", async () => {
    const readError = Object.assign(new Error("Permission denied"), {
      code: "EACCES",
    });
    const { fileSystem } = createReader(
      new Map<string, string | Error>([
        [instructionPath, instructionContent],
        [systemPromptAppendPath, readError],
      ]),
    );
    const warnings: Array<string> = [];
    const contextSources = await readWorkspaceContextSources({
      sourceSelection,
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(contextSources, [
      {
        kind: "instructions",
        workspacePath,
        sourcePath: instructionPath,
        content: instructionContent,
      },
    ]);
    assert.deepEqual(warnings, [
      warningMessageTemplates.contextSourceReadFailed({
        sourcePath: systemPromptAppendPath,
        reason: readError.message,
      }),
    ]);
  });
  it("does not read files or repeat selection warnings for an unavailable workspace", async () => {
    const { fileSystem, readPaths } = createReader(new Map());
    const warnings: Array<string> = [];
    const contextSources = await readWorkspaceContextSources({
      sourceSelection: {
        workspacePath,
        availability: "unavailable",
        reason: workspaceStatusMessageTemplates.pathDoesNotExist(),
      },
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(contextSources, []);
    assert.deepEqual(readPaths, []);
    assert.deepEqual(warnings, []);
  });
  it("returns no context sources when no files were selected", async () => {
    const { fileSystem, readPaths } = createReader(new Map());
    const warnings: Array<string> = [];
    const contextSources = await readWorkspaceContextSources({
      sourceSelection: { workspacePath, availability: "available" },
      fileSystem,
      reportWarning(message) {
        warnings.push(message);
      },
    });
    assert.deepEqual(contextSources, []);
    assert.deepEqual(readPaths, []);
    assert.deepEqual(warnings, []);
  });
  it("rereads a symlink target on every call while retaining its selected source path", async (testContext) => {
    const directory = await mkdtemp(
      join(tmpdir(), "teleprompt-source-reading-"),
    );
    testContext.after(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    const targetPath = join(directory, "shared.md");
    const sourcePath = join(directory, "AGENTS.md");
    await writeFile(targetPath, instructionContent, "utf8");
    await symlink(targetPath, sourcePath, "file");
    const warnings: Array<string> = [];
    const request = {
      sourceSelection: {
        workspacePath: directory,
        availability: "available" as const,
        instructionPath: sourcePath,
      },
      reportWarning(message: string) {
        warnings.push(message);
      },
    };
    const firstRead = await readWorkspaceContextSources(request);
    await writeFile(targetPath, systemPromptAppendContent, "utf8");
    const secondRead = await readWorkspaceContextSources(request);
    assert.deepEqual(firstRead, [
      {
        kind: "instructions",
        workspacePath: directory,
        sourcePath,
        content: instructionContent,
      },
    ]);
    assert.deepEqual(secondRead, [
      {
        kind: "instructions",
        workspacePath: directory,
        sourcePath,
        content: systemPromptAppendContent,
      },
    ]);
    assert.deepEqual(warnings, []);
  });
});

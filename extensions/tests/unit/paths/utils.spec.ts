import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  extractToolPaths,
  isPathWithinWorkspace,
  resolveCanonicalPath,
  resolveInputPath,
} from "#/paths/utils.ts";

async function createTemporaryDirectory(testContext: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "teleprompt-paths-"));
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return realpath(directory);
}

describe("path utilities", () => {
  describe("extractToolPaths", () => {
    const cwd = resolve("/workspace/primary");
    const path = join(cwd, "target");
    const toolCallId = "tool-call";
    it("extracts the explicit path from each supported built-in tool", () => {
      const events = [
        {
          type: "tool_call",
          toolCallId,
          toolName: "read",
          input: { path },
        },
        {
          type: "tool_call",
          toolCallId,
          toolName: "write",
          input: { path, content: "content" },
        },
        {
          type: "tool_call",
          toolCallId,
          toolName: "edit",
          input: { path, edits: [] },
        },
        {
          type: "tool_call",
          toolCallId,
          toolName: "grep",
          input: { path, pattern: "pattern" },
        },
        {
          type: "tool_call",
          toolCallId,
          toolName: "find",
          input: { path, pattern: "*.ts" },
        },
        {
          type: "tool_call",
          toolCallId,
          toolName: "ls",
          input: { path },
        },
      ] satisfies Array<ToolCallEvent>;
      for (const event of events) {
        assert.deepEqual(extractToolPaths({ event, cwd }), [path]);
      }
    });
    it("uses cwd when a search or listing tool omits its path", () => {
      const events = [
        {
          type: "tool_call",
          toolCallId,
          toolName: "grep",
          input: { pattern: "pattern" },
        },
        {
          type: "tool_call",
          toolCallId,
          toolName: "find",
          input: { pattern: "*.ts" },
        },
        {
          type: "tool_call",
          toolCallId,
          toolName: "ls",
          input: {},
        },
      ] satisfies Array<ToolCallEvent>;
      for (const event of events) {
        assert.deepEqual(extractToolPaths({ event, cwd }), [cwd]);
      }
    });
    it("does not infer path semantics for a custom tool", () => {
      const event = {
        type: "tool_call",
        toolCallId,
        toolName: "deploy",
        input: { path },
      } satisfies ToolCallEvent;
      assert.deepEqual(extractToolPaths({ event, cwd }), []);
    });
  });
  describe("resolveInputPath", () => {
    const root = resolve("/");
    const cwd = join(root, "workspace", "primary");
    const homeDirectory = join(root, "users", "example");
    const directoryName = "project with spaces";
    it("resolves relative paths against the supplied cwd and normalizes dot segments", () => {
      assert.equal(
        resolveInputPath({
          inputPath: `./unused/../${directoryName}`,
          cwd,
          homeDirectory,
        }),
        join(cwd, directoryName),
      );
    });
    it("preserves an absolute path independently of cwd", () => {
      const absolutePath = join(root, "elsewhere", directoryName);
      assert.equal(
        resolveInputPath({ inputPath: absolutePath, cwd, homeDirectory }),
        absolutePath,
      );
    });
    it("expands a bare tilde to the supplied home directory", () => {
      assert.equal(
        resolveInputPath({ inputPath: "~", cwd, homeDirectory }),
        homeDirectory,
      );
    });
    it("expands a home-relative path without splitting spaces", () => {
      assert.equal(
        resolveInputPath({
          inputPath: `~/${directoryName}`,
          cwd,
          homeDirectory,
        }),
        join(homeDirectory, directoryName),
      );
    });
    it("strips a leading at-sign before resolving a relative path", () => {
      assert.equal(
        resolveInputPath({
          inputPath: `@${directoryName}`,
          cwd,
          homeDirectory,
        }),
        join(cwd, directoryName),
      );
    });
    it("strips a leading at-sign before expanding the tilde", () => {
      assert.equal(
        resolveInputPath({
          inputPath: `@~/${directoryName}`,
          cwd,
          homeDirectory,
        }),
        join(homeDirectory, directoryName),
      );
    });
    it("strips only one leading at-sign", () => {
      assert.equal(
        resolveInputPath({ inputPath: "@@project", cwd, homeDirectory }),
        join(cwd, "@project"),
      );
    });
    it("treats backslash as a tilde separator only on Windows", () => {
      const inputPath = "~\\project";
      const expectedPath =
        sep === "\\" ? join(homeDirectory, "project") : join(cwd, inputPath);
      assert.equal(
        resolveInputPath({ inputPath, cwd, homeDirectory }),
        expectedPath,
      );
    });
    describe("literal input", () => {
      const literalCases = [
        { name: "another user's tilde prefix", inputPath: "~someone/project" },
        { name: "an embedded tilde", inputPath: "project/~/child" },
        { name: "an embedded at-sign", inputPath: "project@name" },
        { name: "an environment variable", inputPath: "$HOME/project" },
        { name: "a glob", inputPath: "projects/*" },
        { name: "surrounding spaces", inputPath: " project " },
      ];
      for (const { name, inputPath } of literalCases) {
        it(`preserves ${name} without shell expansion or trimming`, () => {
          assert.equal(
            resolveInputPath({ inputPath, cwd, homeDirectory }),
            join(cwd, inputPath),
          );
        });
      }
    });
  });
  describe("resolveCanonicalPath", () => {
    it("resolves an existing target through a directory symlink", async (testContext) => {
      const directory = await createTemporaryDirectory(testContext);
      const targetDirectory = join(directory, "target");
      const targetPath = join(targetDirectory, "existing.txt");
      const linkedDirectory = join(directory, "linked");
      await mkdir(targetDirectory);
      await writeFile(targetPath, "existing", "utf8");
      await symlink(targetDirectory, linkedDirectory, "junction");
      assert.deepEqual(
        await resolveCanonicalPath(join(linkedDirectory, "existing.txt")),
        {
          success: true,
          value: await realpath(targetPath),
          error: undefined,
        },
      );
    });
    it("resolves a missing target beneath a symlinked ancestor", async (testContext) => {
      const directory = await createTemporaryDirectory(testContext);
      const targetDirectory = join(directory, "target");
      const linkedDirectory = join(directory, "linked");
      await mkdir(targetDirectory);
      await symlink(targetDirectory, linkedDirectory, "junction");
      assert.deepEqual(
        await resolveCanonicalPath(
          join(linkedDirectory, "missing", "new-file.txt"),
        ),
        {
          success: true,
          value: join(targetDirectory, "missing", "new-file.txt"),
          error: undefined,
        },
      );
    });
    it("preserves a missing suffix beneath an ordinary existing ancestor", async (testContext) => {
      const directory = await createTemporaryDirectory(testContext);
      const missingPath = join(directory, "missing", "nested", "file.txt");

      assert.deepEqual(await resolveCanonicalPath(missingPath), {
        success: true,
        value: missingPath,
        error: undefined,
      });
    });
    it("returns an explicit failure when the path cannot be resolved", async () => {
      const resolution = await resolveCanonicalPath("\0");
      assert.equal(resolution.success, false);
      if (resolution.success) {
        assert.fail("Expected canonical path resolution to fail");
      }
      assert.ok(resolution.error instanceof Error);
    });
  });
  describe("isPathWithinWorkspace", () => {
    const root = resolve("/");
    const workspacePath = join(root, "workspaces", "project");
    it("includes the workspace root itself", () => {
      assert.equal(
        isPathWithinWorkspace({ path: workspacePath, workspacePath }),
        true,
      );
    });
    it("includes direct and nested descendants", () => {
      assert.equal(
        isPathWithinWorkspace({
          path: join(workspacePath, "src", "feature.ts"),
          workspacePath,
        }),
        true,
      );
    });
    it("excludes the workspace parent", () => {
      assert.equal(
        isPathWithinWorkspace({
          path: join(workspacePath, ".."),
          workspacePath,
        }),
        false,
      );
    });
    it("excludes a sibling whose name starts with the workspace name", () => {
      assert.equal(
        isPathWithinWorkspace({
          path: `${workspacePath}-archive`,
          workspacePath,
        }),
        false,
      );
    });
  });
});

import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { resolveInputPath } from "#/paths/utils.ts";

describe("path utilities", () => {
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
});

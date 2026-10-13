import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import {
  assessWorkspacePaths,
  findOutsideWorkspacePaths,
} from "#/path-permissions/utils.ts";

describe("path permission utilities", () => {
  describe("assessWorkspacePaths", () => {
    const root = resolve("/");
    const cwd = join(root, "workspaces", "primary");
    const homeDirectory = join(root, "users", "example");
    it("normalizes, canonicalizes, and classifies all requested paths", async () => {
      const primaryPath = join(cwd, "src", "feature.ts");
      const homePath = join(homeDirectory, "shared.json");
      const outsidePath = join(root, "workspaces", "outside.txt");
      assert.deepEqual(
        await assessWorkspacePaths({
          requestedPaths: ["src/feature.ts", "~/shared.json", "../outside.txt"],
          workspacePaths: [cwd, homeDirectory],
          cwd,
          homeDirectory,
        }),
        {
          type: "outside",
          canonicalPaths: [primaryPath, homePath, outsidePath],
          outsidePaths: [outsidePath],
        },
      );
    });
    it("returns inside when every requested path belongs to a workspace", async () => {
      const canonicalPath = join(cwd, "src", "feature.ts");
      assert.deepEqual(
        await assessWorkspacePaths({
          requestedPaths: [canonicalPath],
          workspacePaths: [cwd],
          cwd,
          homeDirectory,
        }),
        { type: "inside", canonicalPaths: [canonicalPath] },
      );
    });
    for (const workspaceKind of ["primary", "additional"] as const) {
      it(`preserves a Unicode-space ${workspaceKind} workspace without permitting its ordinary-space sibling`, async (testContext) => {
        const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "teleprompt-workspace-identity-")));
        testContext.after(async () => {
          await rm(temporaryRoot, { recursive: true, force: true });
        });
        const literalWorkspace = join(temporaryRoot, "my\u00A0project");
        const siblingWorkspace = join(temporaryRoot, "my project");
        await mkdir(literalWorkspace);
        await mkdir(siblingWorkspace);
        const literalFile = join(literalWorkspace, "file.txt");
        const siblingFile = join(siblingWorkspace, "file.txt");
        await writeFile(literalFile, "permitted");
        await writeFile(siblingFile, "outside");
        const currentDirectory = workspaceKind === "primary" ? literalWorkspace : temporaryRoot;
        const inside = await assessWorkspacePaths({
          requestedPaths: [workspaceKind === "primary" ? "file.txt" : pathToFileURL(literalFile).href],
          workspacePaths: [literalWorkspace],
          cwd: currentDirectory,
          homeDirectory: temporaryRoot,
        });
        assert.deepEqual(inside, { type: "inside", canonicalPaths: [literalFile] });
        const outside = await assessWorkspacePaths({
          requestedPaths: [siblingFile],
          workspacePaths: [literalWorkspace],
          cwd: currentDirectory,
          homeDirectory: temporaryRoot,
        });
        assert.deepEqual(outside, {
          type: "outside",
          canonicalPaths: [siblingFile],
          outsidePaths: [siblingFile],
        });
      });
    }
    it("returns a typed failure for a malformed requested file URL", async () => {
      const path = "file:///%ZZ";
      const assessment = await assessWorkspacePaths({
        requestedPaths: [path],
        workspacePaths: [cwd],
        cwd,
        homeDirectory,
      });
      assert.equal(assessment.type, "resolution-failed");
      if (assessment.type !== "resolution-failed") {
        assert.fail("Expected a typed normalization failure");
      }
      assert.equal(assessment.path, path);
      assert.ok(assessment.error instanceof URIError);
    });
    it("attributes an explicit failure to the path that could not be resolved", async () => {
      const path = "\0";
      const assessment = await assessWorkspacePaths({
        requestedPaths: [path],
        workspacePaths: [cwd],
        cwd,
        homeDirectory,
      });
      assert.equal(assessment.type, "resolution-failed");
      if (assessment.type !== "resolution-failed") {
        assert.fail("Expected workspace path assessment to fail");
      }
      assert.equal(assessment.path, path);
      assert.ok(assessment.error instanceof Error);
    });
  });
  describe("findOutsideWorkspacePaths", () => {
    const root = resolve("/");
    const primaryWorkspacePath = join(root, "workspaces", "primary");
    const additionalWorkspacePath = join(root, "workspaces", "additional");
    const workspacePaths = [primaryWorkspacePath, additionalWorkspacePath];
    it("returns no paths when every path is within a workspace", () => {
      assert.deepEqual(
        findOutsideWorkspacePaths({
          paths: [
            primaryWorkspacePath,
            join(primaryWorkspacePath, "src", "feature.ts"),
            join(additionalWorkspacePath, "shared.json"),
          ],
          workspacePaths,
        }),
        [],
      );
    });
    it("returns only paths outside every workspace in request order", () => {
      const firstOutsidePath = join(root, "external", "first.txt");
      const secondOutsidePath = join(root, "external", "second.txt");
      assert.deepEqual(
        findOutsideWorkspacePaths({
          paths: [
            firstOutsidePath,
            join(primaryWorkspacePath, "inside.txt"),
            secondOutsidePath,
          ],
          workspacePaths,
        }),
        [firstOutsidePath, secondOutsidePath],
      );
    });
    it("returns every path when no workspaces are available", () => {
      const paths = [
        join(primaryWorkspacePath, "first.txt"),
        join(additionalWorkspacePath, "second.txt"),
      ];
      assert.deepEqual(
        findOutsideWorkspacePaths({ paths, workspacePaths: [] }),
        paths,
      );
    });
    it("does not mistake a similarly prefixed sibling for a workspace descendant", () => {
      const siblingPath = join(`${primaryWorkspacePath}-archive`, "file.txt");
      assert.deepEqual(
        findOutsideWorkspacePaths({ paths: [siblingPath], workspacePaths }),
        [siblingPath],
      );
    });
  });
});

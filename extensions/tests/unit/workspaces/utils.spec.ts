import type {
  CustomEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { workspaceEntryType } from "#/workspaces/constants.ts";
import { errorMessageTemplates } from "#/workspaces/messages.ts";
import {
  addWorkspace,
  formatWorkspaceList,
  removeWorkspace,
  resolveWorkspaceDirectory,
  restoreWorkspaceSnapshot,
} from "#/workspaces/utils.ts";

const entryTimestamp = "2026-01-01T00:00:00.000Z";

function createWorkspaceBranch(snapshots: ReadonlyArray<unknown>) {
  return snapshots.map((data, index) => {
    return {
      type: "custom",
      customType: workspaceEntryType,
      id: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      timestamp: entryTimestamp,
      data,
    } satisfies CustomEntry;
  });
}

async function createTemporaryDirectory(testContext: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "teleprompt-workspaces-"));
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

function createFailingWorkspaceFileSystem(
  scenario:
    | { type: "realpath-fails"; error: Error }
    | { type: "stat-fails"; canonicalPath: string; error: Error },
) {
  const metadataRequests: Array<string> = [];
  const fileSystem = {
    async realpath() {
      if (scenario.type === "realpath-fails") {
        throw scenario.error;
      }

      return scenario.canonicalPath;
    },
    async stat(path: string) {
      metadataRequests.push(path);
      if (scenario.type === "stat-fails") {
        throw scenario.error;
      }

      return {
        isDirectory() {
          return true;
        },
      };
    },
  };

  return { fileSystem, metadataRequests };
}

describe("workspace utilities", () => {
  const primaryWorkspace = "/workspace/primary";
  const additionalWorkspace = "/workspace/additional";
  describe("formatWorkspaceList", () => {
    it("separates primary and additional workspaces while preserving order and spaces", () => {
      const workspaceWithSpaces = "/workspace/project with spaces";
      const state = {
        primaryWorkspace: {
          path: primaryWorkspace,
          availability: "available" as const,
        },
        additionalWorkspaces: [workspaceWithSpaces, additionalWorkspace],
      };
      assert.equal(
        formatWorkspaceList(state),
        `Primary workspace:
  ${primaryWorkspace}

Additional workspaces:
  ${workspaceWithSpaces}
  ${additionalWorkspace}`,
      );
    });
    it("shows None for an empty additional list while retaining the primary", () => {
      const state = {
        primaryWorkspace: {
          path: primaryWorkspace,
          availability: "available" as const,
        },
        additionalWorkspaces: [],
      };
      assert.equal(
        formatWorkspaceList(state),
        `Primary workspace:
  ${primaryWorkspace}

Additional workspaces:
  None`,
      );
    });
    it("marks an unavailable primary without hiding additional workspaces", () => {
      const state = {
        primaryWorkspace: {
          path: primaryWorkspace,
          availability: "unavailable" as const,
        },
        additionalWorkspaces: [additionalWorkspace],
      };
      assert.equal(
        formatWorkspaceList(state),
        `Primary workspace:
  ${primaryWorkspace} (unavailable)

Additional workspaces:
  ${additionalWorkspace}`,
      );
    });
  });
  describe("restoreWorkspaceSnapshot", () => {
    const earlierSnapshot = { additionalWorkspaces: [additionalWorkspace] };
    const emptySnapshot = { additionalWorkspaces: [] };
    const latestSnapshot = { additionalWorkspaces: ["/workspace/latest"] };
    it("defaults to an empty additional list for an empty branch", () => {
      assert.deepEqual(restoreWorkspaceSnapshot([]), emptySnapshot);
    });
    it("selects the nearest valid snapshot to the active leaf", () => {
      const branch = createWorkspaceBranch([earlierSnapshot, latestSnapshot]);
      assert.deepEqual(restoreWorkspaceSnapshot(branch), latestSnapshot);
    });
    it("does not reorder the supplied branch", () => {
      const branch = createWorkspaceBranch([earlierSnapshot, latestSnapshot]);
      const originalEntryOrder = [...branch];
      restoreWorkspaceSnapshot(branch);
      assert.deepEqual(branch, originalEntryOrder);
    });
    it("honors an empty snapshot instead of reviving earlier workspaces", () => {
      const branch = createWorkspaceBranch([earlierSnapshot, emptySnapshot]);
      assert.deepEqual(restoreWorkspaceSnapshot(branch), emptySnapshot);
    });
    describe("unrelated entries", () => {
      const [workspaceEntry] = createWorkspaceBranch([earlierSnapshot]);
      const otherExtensionEntry = {
        type: "custom",
        customType: "another-extension",
        id: "other-extension",
        parentId: workspaceEntry.id,
        timestamp: entryTimestamp,
        data: emptySnapshot,
      } satisfies CustomEntry;
      const sessionInfoEntry = {
        type: "session_info",
        id: "session-info",
        parentId: workspaceEntry.id,
        timestamp: entryTimestamp,
        name: "Session name",
      } satisfies SessionEntry;
      it("ignores another extension's entry even when its data is a valid snapshot", () => {
        const branch = [workspaceEntry, otherExtensionEntry];
        assert.deepEqual(restoreWorkspaceSnapshot(branch), earlierSnapshot);
      });
      it("ignores ordinary Pi session metadata after a workspace snapshot", () => {
        const branch = [workspaceEntry, sessionInfoEntry];
        assert.deepEqual(restoreWorkspaceSnapshot(branch), earlierSnapshot);
      });
      it("defaults to an empty list when the branch contains only another extension's entry", () => {
        const branch = [{ ...otherExtensionEntry, parentId: null }];
        assert.deepEqual(restoreWorkspaceSnapshot(branch), emptySnapshot);
      });
      it("defaults to an empty list when the branch contains only Pi session metadata", () => {
        const branch = [{ ...sessionInfoEntry, parentId: null }];
        assert.deepEqual(restoreWorkspaceSnapshot(branch), emptySnapshot);
      });
    });
    it("preserves stored order and parent/child overlaps", () => {
      const snapshot = {
        additionalWorkspaces: [
          `${additionalWorkspace}/child`,
          "/workspace",
          additionalWorkspace,
        ],
      };
      const branch = createWorkspaceBranch([snapshot]);
      assert.deepEqual(restoreWorkspaceSnapshot(branch), snapshot);
    });
    it("ignores extra fields and restores only additional workspaces", () => {
      const snapshotWithExtraFields = {
        ...earlierSnapshot,
        primaryWorkspace,
        extra: "ignored",
      };
      const branch = createWorkspaceBranch([snapshotWithExtraFields]);
      assert.deepEqual(restoreWorkspaceSnapshot(branch), earlierSnapshot);
    });
    it("restores a workspace after its directory has been deleted", async (testContext) => {
      const directory = await createTemporaryDirectory(testContext);
      const workspacePath = join(directory, "deleted-workspace");
      await mkdir(workspacePath);
      const snapshot = { additionalWorkspaces: [workspacePath] };
      const branch = createWorkspaceBranch([snapshot]);
      await rm(workspacePath, { recursive: true });
      assert.deepEqual(restoreWorkspaceSnapshot(branch), snapshot);
    });
    describe("invalid snapshots", () => {
      const invalidCases = [
        { name: "missing data", data: undefined },
        { name: "null data", data: null },
        { name: "a missing additional list", data: {} },
        {
          name: "a non-array additional list",
          data: { additionalWorkspaces: additionalWorkspace },
        },
        {
          name: "a non-string path",
          data: { additionalWorkspaces: [42] },
        },
        {
          name: "an empty path",
          data: { additionalWorkspaces: [""] },
        },
        {
          name: "a relative path",
          data: { additionalWorkspaces: ["relative/workspace"] },
        },
        {
          name: "exact duplicates",
          data: {
            additionalWorkspaces: [additionalWorkspace, additionalWorkspace],
          },
        },
      ];
      for (const { name, data } of invalidCases) {
        it(`skips ${name} and restores the earlier valid snapshot`, () => {
          const branch = createWorkspaceBranch([earlierSnapshot, data]);
          assert.deepEqual(restoreWorkspaceSnapshot(branch), earlierSnapshot);
        });
        it(`defaults to an empty list when only ${name} is available`, () => {
          const branch = createWorkspaceBranch([data]);
          assert.deepEqual(restoreWorkspaceSnapshot(branch), emptySnapshot);
        });
      }
    });
  });
  describe("resolveWorkspaceDirectory", () => {
    it("returns the canonical path of an existing directory", async (testContext) => {
      const workspacePath = await createTemporaryDirectory(testContext);
      assert.equal(
        await resolveWorkspaceDirectory({ workspacePath }),
        await realpath(workspacePath),
      );
    });
    it("resolves a directory link to its target", async (testContext) => {
      const directory = await createTemporaryDirectory(testContext);
      const targetPath = join(directory, "target");
      const linkPath = join(directory, "link");
      await mkdir(targetPath);
      await symlink(
        targetPath,
        linkPath,
        process.platform === "win32" ? "junction" : "dir",
      );
      assert.equal(
        await resolveWorkspaceDirectory({ workspacePath: linkPath }),
        await realpath(targetPath),
      );
    });
    it("rejects a regular file as a workspace", async (testContext) => {
      const directory = await createTemporaryDirectory(testContext);
      const workspacePath = join(directory, "file.txt");
      await writeFile(workspacePath, "not a directory");
      await assert.rejects(
        resolveWorkspaceDirectory({ workspacePath }),
        new Error(
          errorMessageTemplates.workspacePathNotDirectory(workspacePath),
        ),
      );
    });
    it("rejects a missing directory", async (testContext) => {
      const directory = await createTemporaryDirectory(testContext);
      await assert.rejects(
        resolveWorkspaceDirectory({
          workspacePath: join(directory, "missing"),
        }),
        { code: "ENOENT" },
      );
    });
    it("propagates canonicalization failures without inspecting metadata", async () => {
      const error = new Error("canonicalization failed");
      const { fileSystem, metadataRequests } = createFailingWorkspaceFileSystem(
        {
          type: "realpath-fails",
          error,
        },
      );
      await assert.rejects(
        resolveWorkspaceDirectory({
          workspacePath: additionalWorkspace,
          fileSystem,
        }),
        (actualError) => {
          assert.equal(actualError, error);

          return true;
        },
      );
      assert.deepEqual(metadataRequests, []);
    });
    it("inspects the canonical target and propagates metadata failures", async () => {
      const canonicalPath = "/canonical/workspace";
      const error = new Error("metadata read failed");
      const { fileSystem, metadataRequests } = createFailingWorkspaceFileSystem(
        {
          type: "stat-fails",
          canonicalPath,
          error,
        },
      );
      await assert.rejects(
        resolveWorkspaceDirectory({
          workspacePath: additionalWorkspace,
          fileSystem,
        }),
        (actualError) => {
          assert.equal(actualError, error);

          return true;
        },
      );
      assert.deepEqual(metadataRequests, [canonicalPath]);
    });
  });
  describe("removeWorkspace", () => {
    it("distinguishes the primary workspace from an absent workspace", () => {
      const state = {
        primaryWorkspace,
        additionalWorkspaces: [additionalWorkspace],
      };
      const outcome = removeWorkspace({
        state,
        workspacePath: primaryWorkspace,
      });
      assert.deepEqual(outcome, {
        type: "primary-workspace-not-removable",
        state,
      });
      assert.equal(outcome.state, state);
      assert.deepEqual(state, {
        primaryWorkspace,
        additionalWorkspaces: [additionalWorkspace],
      });
    });
    it("returns unchanged state for an absent additional workspace", () => {
      const state = {
        primaryWorkspace,
        additionalWorkspaces: [additionalWorkspace],
      };
      const outcome = removeWorkspace({
        state,
        workspacePath: "/workspace/missing",
      });
      assert.deepEqual(outcome, { type: "workspace-not-found", state });
      assert.equal(outcome.state, state);
      assert.deepEqual(state.additionalWorkspaces, [additionalWorkspace]);
    });
    it("removes the final additional workspace while preserving the primary", () => {
      const state = {
        primaryWorkspace,
        additionalWorkspaces: [additionalWorkspace],
      };
      assert.deepEqual(
        removeWorkspace({ state, workspacePath: additionalWorkspace }),
        {
          type: "workspace-removed",
          state: { primaryWorkspace, additionalWorkspaces: [] },
        },
      );
      assert.deepEqual(state.additionalWorkspaces, [additionalWorkspace]);
    });
    it("reports an absent path when no additional workspaces remain", () => {
      const state = { primaryWorkspace, additionalWorkspaces: [] };
      const outcome = removeWorkspace({
        state,
        workspacePath: additionalWorkspace,
      });
      assert.deepEqual(outcome, { type: "workspace-not-found", state });
      assert.equal(outcome.state, state);
    });
    it("removes only the exact match, preserving overlap order without mutation", () => {
      const parentWorkspace = "/workspace";
      const childWorkspace = `${additionalWorkspace}/child`;
      const additionalWorkspaces = Object.freeze([
        parentWorkspace,
        additionalWorkspace,
        childWorkspace,
      ]);
      const state = Object.freeze({ primaryWorkspace, additionalWorkspaces });
      const outcome = removeWorkspace({
        state,
        workspacePath: additionalWorkspace,
      });
      assert.deepEqual(outcome, {
        type: "workspace-removed",
        state: {
          primaryWorkspace,
          additionalWorkspaces: [parentWorkspace, childWorkspace],
        },
      });
      assert.notEqual(outcome.state, state);
      assert.notEqual(outcome.state.additionalWorkspaces, additionalWorkspaces);
      assert.deepEqual(state, {
        primaryWorkspace,
        additionalWorkspaces: [
          parentWorkspace,
          additionalWorkspace,
          childWorkspace,
        ],
      });
    });
  });
  describe("addWorkspace", () => {
    it("adds the first additional workspace without changing the primary", () => {
      const state = { primaryWorkspace, additionalWorkspaces: [] };
      assert.deepEqual(
        addWorkspace({ state, workspacePath: additionalWorkspace }),
        {
          type: "workspace-added",
          state: {
            primaryWorkspace,
            additionalWorkspaces: [additionalWorkspace],
          },
        },
      );
    });
    it("rejects the primary workspace as an additional workspace", () => {
      const state = { primaryWorkspace, additionalWorkspaces: [] };
      const outcome = addWorkspace({ state, workspacePath: primaryWorkspace });
      assert.deepEqual(outcome, { type: "workspace-already-present", state });
      assert.equal(outcome.state, state);
    });
    it("rejects an exact additional-workspace duplicate without changing state", () => {
      const state = {
        primaryWorkspace,
        additionalWorkspaces: [additionalWorkspace],
      };
      const outcome = addWorkspace({
        state,
        workspacePath: additionalWorkspace,
      });
      assert.deepEqual(outcome, { type: "workspace-already-present", state });
      assert.equal(outcome.state, state);
      assert.deepEqual(state.additionalWorkspaces, [additionalWorkspace]);
    });
    it("appends in insertion order without mutating the input state or array", () => {
      const nextWorkspace = "/workspace/next";
      const additionalWorkspaces = Object.freeze([additionalWorkspace]);
      const state = Object.freeze({ primaryWorkspace, additionalWorkspaces });
      const outcome = addWorkspace({ state, workspacePath: nextWorkspace });
      assert.deepEqual(outcome, {
        type: "workspace-added",
        state: {
          primaryWorkspace,
          additionalWorkspaces: [additionalWorkspace, nextWorkspace],
        },
      });
      assert.notEqual(outcome.state, state);
      assert.notEqual(outcome.state.additionalWorkspaces, additionalWorkspaces);
      assert.deepEqual(state, {
        primaryWorkspace,
        additionalWorkspaces: [additionalWorkspace],
      });
    });
    describe("overlapping workspaces", () => {
      const parentWorkspace = "/workspace";
      const overlapCases = [
        {
          name: "a shared parent of primary and additional workspaces",
          workspacePath: parentWorkspace,
        },
        {
          name: "a child of the primary workspace",
          workspacePath: `${primaryWorkspace}/child`,
        },
        {
          name: "a child of an additional workspace",
          workspacePath: `${additionalWorkspace}/child`,
        },
      ];
      for (const { name, workspacePath } of overlapCases) {
        it(`preserves ${name} as a separate entry`, () => {
          const state = {
            primaryWorkspace,
            additionalWorkspaces: [additionalWorkspace],
          };
          assert.deepEqual(addWorkspace({ state, workspacePath }), {
            type: "workspace-added",
            state: {
              primaryWorkspace,
              additionalWorkspaces: [additionalWorkspace, workspacePath],
            },
          });
        });
      }
    });
  });
});

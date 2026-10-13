import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { createRuntimeTemporaryFileStore } from "#/runtime-temporary-files/index.ts";

async function createTemporaryRoot(testContext: TestContext): Promise<string> {
  const temporaryRootPath = await mkdtemp(
    join(tmpdir(), "teleprompt-runtime-files-"),
  );
  testContext.after(async () => {
    await rm(temporaryRootPath, { recursive: true, force: true });
  });

  return realpath(temporaryRootPath);
}

function createFileIdFactory(fileIds: Array<string>): () => string {
  return () => {
    const fileId = fileIds.shift();
    if (fileId === undefined) {
      throw new Error("The test did not provide enough temporary file IDs.");
    }

    return fileId;
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

function createFailingFileOpener({ writeError, closeError, operations }: {
  writeError?: Error;
  closeError?: Error;
  operations: Array<string>;
}) {
  return async (filePath: string) => {
    const handle = await open(filePath, "wx", 0o600);

    return {
      async writeFile(content: string | Uint8Array) {
        operations.push("write");
        await handle.writeFile(content);
        if (writeError !== undefined) {
          throw writeError;
        }
      },
      async close() {
        operations.push("close");
        await handle.close();
        if (closeError !== undefined) {
          throw closeError;
        }
      },
    };
  };
}

describe("runtime temporary file storage", () => {
  describe("when artifact creation fails", () => {
    for (const failure of ["write", "close", "write-and-close"] as const) {
      it(`closes and removes the owned artifact after ${failure} failure while preserving the first error`, async (testContext) => {
        const temporaryRootPath = await createTemporaryRoot(testContext);
        const writeError = failure === "close" ? undefined : new Error("write failed");
        const closeError = failure === "write" ? undefined : new Error("close failed");
        const expectedError = writeError ?? closeError;
        const operations: Array<string> = [];
        const store = createRuntimeTemporaryFileStore({
          temporaryRootPath,
          createFileId() {
            return "failed-artifact";
          },
          openFile: createFailingFileOpener({ writeError, closeError, operations }),
        });
        await assert.rejects(store.createFile({ kind: "command", content: "owned content" }), (error) => {
          assert.equal(error, expectedError);

          return true;
        });
        assert.deepEqual(operations, ["write", "close"]);
        const directories = await readdir(temporaryRootPath);
        assert.equal(directories.length, 1);
        assert.deepEqual(await readdir(join(temporaryRootPath, directories[0]!)), []);
        await store.cleanup();
        assert.deepEqual(await readdir(temporaryRootPath), []);
      });
    }
    it("preserves an existing owned artifact when exclusive creation collides", async (testContext) => {
      const temporaryRootPath = await createTemporaryRoot(testContext);
      const store = createRuntimeTemporaryFileStore({ temporaryRootPath, createFileId: () => "same" });
      const original = await store.createFile({ kind: "command", content: "original" });
      await assert.rejects(store.createFile({ kind: "command", content: "replacement" }), { code: "EEXIST" });
      assert.equal(await readFile(original.path, "utf8"), "original");
      await store.cleanup();
      assert.deepEqual(await readdir(temporaryRootPath), []);
    });

    it("removes an exclusively created artifact when writing its content fails", async (testContext) => {
      const temporaryRootPath = await createTemporaryRoot(testContext);
      const store = createRuntimeTemporaryFileStore({ temporaryRootPath, createFileId: () => "invalid-content" });
      await assert.rejects(store.createFile({ kind: "command", content: null as unknown as string }), TypeError);
      const directories = await readdir(temporaryRootPath);
      assert.equal(directories.length, 1);
      assert.deepEqual(await readdir(join(temporaryRootPath, directories[0]!)), []);
      await store.cleanup();
      assert.deepEqual(await readdir(temporaryRootPath), []);
    });
  });
  describe("when the first runtime artifact is created", () => {
    it("lazily creates one private runtime directory and an exclusive private file", async (testContext) => {
      const temporaryRootPath = await createTemporaryRoot(testContext);
      const store = createRuntimeTemporaryFileStore({
        temporaryRootPath,
        createFileId: createFileIdFactory(["command-id"]),
      });
      assert.deepEqual(await readdir(temporaryRootPath), []);
      const file = await store.createFile({
        kind: "command",
        content: "printf 'hello world'",
      });
      const runtimeDirectoryPath = dirname(file.path);
      assert.equal(dirname(runtimeDirectoryPath), temporaryRootPath);
      assert.match(
        basename(runtimeDirectoryPath),
        /^pi-teleprompt-commentary-/,
      );
      assert.equal(basename(file.path), "command-command-id.txt");
      assert.equal(await readFile(file.path, "utf8"), "printf 'hello world'");
      if (process.platform !== "win32") {
        assert.equal((await stat(runtimeDirectoryPath)).mode & 0o777, 0o700);
        assert.equal((await stat(file.path)).mode & 0o777, 0o600);
      }
    });
  });
  describe("when several artifacts belong to one runtime", () => {
    it("shares one directory across concurrent first uses and removes all artifacts at shutdown", async (testContext) => {
      const temporaryRootPath = await createTemporaryRoot(testContext);
      const store = createRuntimeTemporaryFileStore({
        temporaryRootPath,
        createFileId: createFileIdFactory(["first", "second", "third"]),
      });
      const files = await Promise.all([
        store.createFile({ kind: "original-content", content: "first" }),
        store.createFile({ kind: "original-content", content: "second" }),
        store.createFile({ kind: "command", content: "third" }),
      ]);
      assert.equal(new Set(files.map((file) => dirname(file.path))).size, 1);
      assert.equal((await readdir(temporaryRootPath)).length, 1);
      await store.cleanup();
      assert.deepEqual(await readdir(temporaryRootPath), []);
    });
    it("creates unique text and byte files beneath the same runtime directory", async (testContext) => {
      const temporaryRootPath = await createTemporaryRoot(testContext);
      const store = createRuntimeTemporaryFileStore({
        temporaryRootPath,
        createFileId: createFileIdFactory(["command-id", "snapshot-id"]),
      });
      const commandFile = await store.createFile({
        kind: "command",
        content: "echo exact command\n",
      });
      const originalContent = Uint8Array.from([0, 1, 2, 255]);
      const snapshotFile = await store.createFile({
        kind: "original-content",
        content: originalContent,
      });
      assert.equal(dirname(commandFile.path), dirname(snapshotFile.path));
      assert.equal(
        await readFile(commandFile.path, "utf8"),
        "echo exact command\n",
      );
      assert.deepEqual(
        [...(await readFile(snapshotFile.path))],
        [...originalContent],
      );
      assert.deepEqual((await readdir(dirname(commandFile.path))).sort(), [
        "command-command-id.txt",
        "original-content-snapshot-id.txt",
      ]);
    });
  });
  describe("when owned artifacts are cleaned", () => {
    it("removes one file idempotently without removing unrelated runtime files", async (testContext) => {
      const temporaryRootPath = await createTemporaryRoot(testContext);
      const store = createRuntimeTemporaryFileStore({
        temporaryRootPath,
        createFileId: createFileIdFactory(["first", "second"]),
      });
      const firstFile = await store.createFile({
        kind: "command",
        content: "first",
      });
      const secondFile = await store.createFile({
        kind: "command",
        content: "second",
      });
      await firstFile.cleanup();
      await firstFile.cleanup();
      assert.equal(await pathExists(firstFile.path), false);
      assert.equal(await readFile(secondFile.path, "utf8"), "second");
    });
    it("removes the complete runtime directory idempotently and can lazily create a new one", async (testContext) => {
      const temporaryRootPath = await createTemporaryRoot(testContext);
      const store = createRuntimeTemporaryFileStore({
        temporaryRootPath,
        createFileId: createFileIdFactory(["before", "after"]),
      });
      const firstFile = await store.createFile({
        kind: "command",
        content: "before cleanup",
      });
      const firstRuntimeDirectoryPath = dirname(firstFile.path);
      await store.cleanup();
      await store.cleanup();
      assert.equal(await pathExists(firstRuntimeDirectoryPath), false);
      const secondFile = await store.createFile({
        kind: "command",
        content: "after cleanup",
      });
      assert.notEqual(dirname(secondFile.path), firstRuntimeDirectoryPath);
      assert.equal(await readFile(secondFile.path, "utf8"), "after cleanup");
    });
  });
});

import { createWriteToolDefinition, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, type TestContext } from "node:test";
import { resolveInputPath } from "#/paths/index.ts";

async function fixture(testContext: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teleprompt-path-compatibility-")));
  testContext.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

describe("local Pi write path compatibility", () => {
  for (const kind of ["unicode-space", "file-url", "at-prefix", "absolute", "relative"] as const) {
    it(`resolves a ${kind} input to the same file Pi actually writes`, async (testContext) => {
      const root = await fixture(testContext);
      const target = join(root, "file with spaces.txt");
      const inputPath = kind === "unicode-space" ? "file\u202Fwith\u00A0spaces.txt"
        : kind === "file-url" ? pathToFileURL(target).href
        : kind === "at-prefix" ? "@file with spaces.txt"
        : kind === "absolute" ? target
        : "./file with spaces.txt";
      const resolved = resolveInputPath({ inputPath, cwd: root, homeDirectory: root });
      assert.equal(resolved, target);
      await createWriteToolDefinition(root).execute(
        "path-compatibility", { path: inputPath, content: "native write" },
        undefined, undefined, { cwd: root } as ExtensionToolContext,
      );
      assert.equal(await readFile(resolved, "utf8"), "native write");
    });
  }
});

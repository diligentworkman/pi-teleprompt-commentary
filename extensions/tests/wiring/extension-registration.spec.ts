import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commands as configEditorCommands } from "#/config-editor/index.ts";
import telepromptCommentary from "#/index.ts";
import { commands as workspaceCommands } from "#/workspaces/index.ts";

function collectEntryPointCommandNames() {
  const commandNames: Array<string> = [];
  telepromptCommentary({
    on() {},
    registerCommand(name: string) {
      commandNames.push(name);
    },
  } as any);

  return commandNames;
}

describe("extension registration", () => {
  describe("extension entry point", () => {
    it("registers namespaced commands", () => {
      assert.deepEqual(collectEntryPointCommandNames(), [
        configEditorCommands.edit.name,
        workspaceCommands.add.name,
        workspaceCommands.remove.name,
        workspaceCommands.open.name,
        workspaceCommands.openAll.name,
        workspaceCommands.list.name,
      ]);
    });
  });
});

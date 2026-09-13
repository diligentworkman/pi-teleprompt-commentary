import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createConfigLoader } from "#/config-loader/index.ts";

function createConfigLoaderHarness(
  readConfigurationFile: () => Promise<string>,
) {
  const warnings: Array<string> = [];
  const loader = createConfigLoader({
    readConfigurationFile,
    reportConfigurationWarning(message) {
      warnings.push(message);
    },
  });

  return { loader, warnings };
}

describe("configuration loader", () => {
  it("rereads the current configuration source on every load", async () => {
    let configurationSource = [
      "[[handlers.new_file_editor]]",
      'action = "prompt"',
    ].join("\n");
    const { loader, warnings } = createConfigLoaderHarness(async () => {
      return configurationSource;
    });
    const initialConfiguration = await loader.load();
    configurationSource = [
      "[[handlers.new_file_editor]]",
      'action = "deny"',
    ].join("\n");
    const updatedConfiguration = await loader.load();
    assert.equal(
      initialConfiguration.handlers.new_file_editor?.[0].action,
      "prompt",
    );
    assert.equal(
      updatedConfiguration.handlers.new_file_editor?.[0].action,
      "deny",
    );
    assert.deepEqual(warnings, []);
  });

  it("resolves and expands a selected command action", async () => {
    const configurationSource = [
      "[[handlers.new_file_editor]]",
      'action = ["code", { var = "new_file_path", prepend = "--file=" }]',
    ].join("\n");
    const variables = { new_file_path: "/workspace/file with spaces" };
    const { loader, warnings } = createConfigLoaderHarness(async () => {
      return configurationSource;
    });
    assert.deepEqual(
      await loader.resolveHandler({
        category: "new_file_editor",
        variables,
      }),
      ["code", "--file=/workspace/file with spaces"],
    );
    assert.deepEqual(warnings, []);
  });

  it("resolves and expands a hook command action", async () => {
    const configurationSource = [
      "[[hooks.assistant_message_end]]",
      'action = ["notify-send", { var = "assistant_message_text" }]',
    ].join("\n");
    const variables = { assistant_message_text: "Finished" };
    const { loader, warnings } = createConfigLoaderHarness(async () => {
      return configurationSource;
    });
    assert.deepEqual(
      await loader.resolveHook({
        hook: "assistant_message_end",
        variables,
      }),
      ["notify-send", "Finished"],
    );
    assert.deepEqual(warnings, []);
  });
});

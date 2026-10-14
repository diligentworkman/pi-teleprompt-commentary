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
  it("matches and expands the full configuration and workspace variable names without splitting arguments", async () => {
    const configurationFilePath = "/configuration/with spaces.toml";
    const workspaceDirectoryPath = "/workspace/with spaces";
    const workspaceGroupId = "group with spaces";
    const { loader, warnings } = createConfigLoaderHarness(async () => {
      return `
[[handlers.configuration_editor]]
"var:configuration_file_path" = '\\.toml$'
action = ["editor", { var = "configuration_file_path" }]
[[handlers.workspace_opener]]
"var:workspace_directory_path" = '^/workspace/'
"var:workspace_group_id" = '^group '
action = ["opener", { var = "workspace_directory_path" }, { var = "workspace_group_id", prepend = "--group=" }]
`;
    });
    assert.deepEqual(await loader.resolveHandler({
      category: "configuration_editor",
      variables: { configuration_file_path: configurationFilePath },
    }), ["editor", configurationFilePath]);
    assert.deepEqual(await loader.resolveHandler({
      category: "workspace_opener",
      variables: { workspace_directory_path: workspaceDirectoryPath, workspace_group_id: workspaceGroupId },
    }), ["opener", workspaceDirectoryPath, `--group=${workspaceGroupId}`]);
    assert.equal(await loader.resolveHandler({
      category: "workspace_opener",
      variables: { workspace_directory_path: "/outside", workspace_group_id: workspaceGroupId },
    }), undefined);
    assert.equal(await loader.resolveHandler({
      category: "workspace_opener",
      variables: { workspace_directory_path: workspaceDirectoryPath, workspace_group_id: "unmatched" },
    }), undefined);
    assert.deepEqual(warnings, []);
  });
  it("resolves all matching hooks in declaration order with direct-argv placeholder expansion", async () => {
    const { loader, warnings } = createConfigLoaderHarness(async () => `
[[hooks.assistant_message_end]]
action = ["first", { var = "assistant_message_text", prepend = "<", append = ">" }]
[[hooks.assistant_message_end]]
"var:assistant_message_text" = '^unmatched$'
action = ["skip"]
[[hooks.assistant_message_end]]
"var:assistant_message_text" = '^Finished'
action = ["second", "fixed argument"]
`);
    assert.deepEqual(await loader.resolveHooks({
      hook: "assistant_message_end",
      variables: { assistant_message_text: "Finished with spaces\nand newline" },
    }), [["first", "<Finished with spaces\nand newline>"], ["second", "fixed argument"]]);
    assert.deepEqual(warnings, []);
  });

  it("returns no hooks for an unmatched category and keeps handler precedence unchanged", async () => {
    const { loader } = createConfigLoaderHarness(async () => `
[[handlers.new_file_editor]]
action = "allow"
[[handlers.new_file_editor]]
action = "deny"
[[hooks.tool_permission_request]]
"var:tool_name" = '^edit$'
action = ["notify"]
`);
    assert.deepEqual(await loader.resolveHooks({ hook: "agent_settled", variables: {} }), []);
    assert.deepEqual(await loader.resolveHooks({ hook: "tool_permission_request", variables: { tool_name: "write" } }), []);
    assert.equal(await loader.resolveHandler({ category: "new_file_editor", variables: { new_file_path: "/file" } }), "deny");
  });
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
      await loader.resolveHooks({
        hook: "assistant_message_end",
        variables,
      }),
      [["notify-send", "Finished"]],
    );
    assert.deepEqual(warnings, []);
  });
});

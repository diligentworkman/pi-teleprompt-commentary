import type { ConfigLoader } from "#/config-loader/index.ts";
import type {
  ConfigEditor,
  ConfigEditorDependencies,
  ConfigEditOutcome,
} from "./types.ts";

export { commands } from "./constants.ts";
export { configEditMessages, errorMessageTemplates } from "./messages.ts";
export type {
  ConfigEditor,
  ConfigEditorDependencies,
  ConfigEditOutcome,
  ConfigurationFileSystem,
} from "./types.ts";
export {
  configurationFileSystem,
  ensureConfigurationFile,
  readStarterConfigurationSource,
  writeConfigurationFileAtomically,
} from "./utils.ts";

export function resolveConfigurationEditorCommand({
  configLoader,
  configFilePath,
}: {
  configLoader: ConfigLoader;
  configFilePath: string;
}) {
  return configLoader.resolveHandler({
    category: "configuration_editor",
    variables: { config_file_path: configFilePath },
  });
}

export function createConfigEditor(
  dependencies: ConfigEditorDependencies,
): ConfigEditor {
  const {
    ensureConfigurationFile,
    resolveConfigurationEditor,
    processRunner,
    reportConfiguredEditorFailure,
    readConfigurationFile,
    openPiEditor,
    saveConfiguration,
    revalidateConfiguration,
  } = dependencies;
  async function finish(outcome: ConfigEditOutcome) {
    await revalidateConfiguration();

    return outcome;
  }

  return {
    async edit() {
      let { source } = await ensureConfigurationFile();
      const configuredEditor = await resolveConfigurationEditor();
      if (configuredEditor !== undefined) {
        const completion = await processRunner.start({
          command: configuredEditor,
        }).completion;

        const exitedCleanly =
          completion.type === "exited" &&
          completion.exitCode === 0 &&
          completion.signal === null;
        if (exitedCleanly || openPiEditor === undefined) {
          return finish({ type: "configured-editor-finished", completion });
        }
        reportConfiguredEditorFailure(completion);
        source = await readConfigurationFile();
      }
      if (openPiEditor === undefined) {
        return finish({ type: "editor-unavailable" });
      }
      const editedSource = await openPiEditor(source);
      if (editedSource === undefined) {
        return finish({ type: "pi-editor-cancelled" });
      }
      await saveConfiguration(editedSource);

      return finish({ type: "pi-editor-saved" });
    },
  };
}

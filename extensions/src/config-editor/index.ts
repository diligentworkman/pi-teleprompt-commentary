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
    isShuttingDown,
    ensureConfigurationFile,
    resolveConfigurationEditor,
    processRunner,
    reportConfiguredEditorFailure,
    readConfigurationFile,
    openPiEditor,
    saveConfiguration,
    revalidateConfiguration,
  } = dependencies;
  async function finish(outcome: ConfigEditOutcome): Promise<ConfigEditOutcome> {
    if (isShuttingDown?.()) {
      return { type: "shutdown" };
    }
    await revalidateConfiguration();

    return outcome;
  }

  return {
    async edit() {
      if (isShuttingDown?.()) {
        return { type: "shutdown" };
      }
      let { source } = await ensureConfigurationFile();
      if (isShuttingDown?.()) {
        return { type: "shutdown" };
      }
      const configuredEditor = await resolveConfigurationEditor();
      // Resolution may finish after the runtime has cleaned up its children.
      if (isShuttingDown?.()) {
        return { type: "shutdown" };
      }
      if (configuredEditor !== undefined) {
        const completion = await processRunner.start({
          command: configuredEditor,
        }).completion;
        if (isShuttingDown?.()) {
          return { type: "shutdown" };
        }
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
      if (isShuttingDown?.()) {
        return { type: "shutdown" };
      }
      if (openPiEditor === undefined) {
        return finish({ type: "editor-unavailable" });
      }
      const editedSource = await openPiEditor(source);
      if (isShuttingDown?.()) {
        return { type: "shutdown" };
      }
      if (editedSource === undefined) {
        return finish({ type: "pi-editor-cancelled" });
      }
      await saveConfiguration(editedSource);

      return finish({ type: "pi-editor-saved" });
    },
  };
}

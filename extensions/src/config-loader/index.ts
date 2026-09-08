import type { ConfigLoader, ConfigurationLoaderDependencies } from "./types.ts";
import {
  expandCommand,
  loadConfiguration,
  resolveConfigPath,
  resolveRawAction,
} from "./utils.ts";

export { resolveConfigPath };
export type {
  ConfigLoader,
  ConfigurationLoaderDependencies,
  ResolvedCommand,
  VariablesFor,
} from "./types.ts";

export function createConfigLoader(
  dependencies: ConfigurationLoaderDependencies,
): ConfigLoader {
  return {
    load() {
      return loadConfiguration(dependencies);
    },
    async resolveHandler({ category, variables }) {
      const rawAction = resolveRawAction({
        rules: (await loadConfiguration(dependencies)).handlers[category] ?? [],
        variables,
      });
      if (rawAction === undefined || typeof rawAction === "string") {
        return rawAction;
      }

      return expandCommand({ command: rawAction, variables });
    },
    async resolveHook({ hook, variables }) {
      const rawAction = resolveRawAction({
        rules: (await loadConfiguration(dependencies)).hooks[hook] ?? [],
        variables,
      });
      if (rawAction === undefined) {
        return undefined;
      }

      return expandCommand({ command: rawAction, variables });
    },
  };
}

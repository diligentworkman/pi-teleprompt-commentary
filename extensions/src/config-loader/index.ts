import type {
  ConfigLoader,
  ConfigurationLoaderDependencies,
  HandlerCategory,
  ResolvedHandlerAction,
  VariablesFor,
} from "./types.ts";
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
    async resolveHandler<TCategory extends HandlerCategory>({
      category,
      variables,
    }: {
      category: TCategory;
      variables: VariablesFor<TCategory>;
    }): Promise<ResolvedHandlerAction<TCategory> | undefined> {
      const rawAction = resolveRawAction({
        rules: (await loadConfiguration(dependencies)).handlers[category] ?? [],
        variables,
      });
      if (rawAction === undefined || typeof rawAction === "string") {
        return rawAction as ResolvedHandlerAction<TCategory> | undefined;
      }

      return expandCommand({
        command: rawAction,
        variables,
      }) as ResolvedHandlerAction<TCategory>;
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

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
  ruleConditionsMatch,
} from "./utils.ts";

export { resolveConfigPath };
export type {
  ConfigLoader,
  ConfigurationLoaderDependencies,
  ResolvedAction,
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
    async resolveHooks({ hook, variables }) {
      const rules = (await loadConfiguration(dependencies)).hooks[hook] ?? [];
      return rules
        .filter((rule) => ruleConditionsMatch({ conditions: rule.conditions, variables }))
        .map((rule) => expandCommand({ command: rule.action, variables }));
    },
  };
}

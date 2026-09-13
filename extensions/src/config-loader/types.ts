import type {
  availableVariables,
  commandOnlyHandlerCategories,
  decisions,
  handlerCategories,
  hookNames,
  variableNames,
} from "./constants.ts";

export type VariableName = (typeof variableNames)[number];

export type HandlerCategory = (typeof handlerCategories)[number];

export type Decision = (typeof decisions)[number];

export type HookName = (typeof hookNames)[number];

export type RuleContext = HandlerCategory | HookName;

export type Placeholder = {
  var: VariableName;
  prepend?: string;
  append?: string;
};

export type CommandToken = string | Placeholder;

export type Command = [string, ...Array<CommandToken>];

export type Action = Decision | Command;

export type ResolvedCommand = [executable: string, ...args: Array<string>];

export type ResolvedAction = Decision | ResolvedCommand;

export type CommandOnlyHandlerCategory =
  (typeof commandOnlyHandlerCategories)[number];

export type ResolvedHandlerAction<TCategory extends HandlerCategory> =
  TCategory extends CommandOnlyHandlerCategory
    ? ResolvedCommand
    : ResolvedAction;

export type RegexSpec = {
  source: string;
  flags: string;
};

export type HandlerVariables = Partial<Record<VariableName, string>>;

type AvailableVariableName<TContext extends RuleContext> =
  (typeof availableVariables)[TContext][number];

export type VariablesFor<TContext extends RuleContext> = Record<
  AvailableVariableName<TContext>,
  string
> &
  Partial<
    Record<
      Exclude<VariableName, AvailableVariableName<TContext>>,
      never
    >
  >;

export type Rule<TAction extends Action = Action> = {
  conditions: Partial<Record<VariableName, RegexSpec>>;
  action: TAction;
};

export type HandlerRule = Rule;

export type HookRule = Rule<Command>;

export type TelepromptConfig = {
  handlers: Partial<Record<HandlerCategory, Array<HandlerRule>>>;
  hooks: Partial<Record<HookName, Array<HookRule>>>;
};

export type ConfigurationIssue = {
  message: string;
};

export type ConfigurationConversionResult = {
  configuration: TelepromptConfig;
  issues: Array<ConfigurationIssue>;
};

export type ConfigurationLoaderDependencies = {
  readConfigurationFile: () => Promise<string>;
  reportConfigurationWarning: (message: string) => void;
};

export type ConfigLoader = {
  load(): Promise<TelepromptConfig>;
  resolveHandler<TCategory extends HandlerCategory>({
    category,
    variables,
  }: {
    category: TCategory;
    variables: VariablesFor<TCategory>;
  }): Promise<ResolvedHandlerAction<TCategory> | undefined>;
  resolveHook<THook extends HookName>({
    hook,
    variables,
  }: {
    hook: THook;
    variables: VariablesFor<THook>;
  }): Promise<ResolvedCommand | undefined>;
};

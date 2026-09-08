import type {
  availableVariables,
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

export type Command = [string, ...CommandToken[]];

export type Action = Decision | Command;

export type ResolvedCommand = [executable: string, ...args: string[]];

export type ResolvedAction = Decision | ResolvedCommand;

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
  handlers: Partial<Record<HandlerCategory, HandlerRule[]>>;
  hooks: Partial<Record<HookName, HookRule[]>>;
};

export type ConfigurationIssue = {
  message: string;
};

export type ConfigurationConversionResult = {
  configuration: TelepromptConfig;
  issues: ConfigurationIssue[];
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
  }): Promise<ResolvedAction | undefined>;
  resolveHook<THook extends HookName>({
    hook,
    variables,
  }: {
    hook: THook;
    variables: VariablesFor<THook>;
  }): Promise<ResolvedCommand | undefined>;
};

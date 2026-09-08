import { z } from "zod";
import { decisions, hookNames, variableNames } from "./constants.ts";

export const variableNameSchema = z.enum(variableNames);

export const decisionSchema = z.enum(decisions);

export const hookNameSchema = z.enum(hookNames);

export const regexValueSchema = z.union([
  z.string(),
  z.array(z.string()).min(1),
]);

export const placeholderSchema = z.strictObject({
  var: variableNameSchema,
  prepend: z.string().optional(),
  append: z.string().optional(),
});

export const commandTokenSchema = z.union([z.string(), placeholderSchema]);

export const commandSchema = z
  .tuple([z.string().min(1)])
  .rest(commandTokenSchema);

export const actionSchema = z.union([decisionSchema, commandSchema]);

export const rawRuleSchema = z.record(z.string(), z.unknown());

export const rawConfigSchema = z.looseObject({
  handlers: z.record(z.string(), z.array(rawRuleSchema)).optional(),
  hooks: z.record(z.string(), z.array(rawRuleSchema)).optional(),
});

/**
 * The permissive top-level TOML shape validated before rule conversion.
 */
export type RawConfigurationDocument = z.infer<typeof rawConfigSchema>;

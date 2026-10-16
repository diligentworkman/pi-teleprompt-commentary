import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { commentarySystemPrompt } from "#/commentary/index.ts";
import { dispatchHookCommands } from "#/event-hooks/index.ts";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { reviewBashCommand } from "#/bash-review/index.ts";
import { applyFilePostToolActions, prepareFileReview, reviewPreparedFile } from "#/file-review/index.ts";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  commands as configEditorCommands,
  configurationFileSystem,
  errorMessageTemplates as configEditorErrorMessageTemplates,
  configEditMessages,
  createConfigEditor,
  ensureConfigurationFile,
  readStarterConfigurationSource,
  resolveConfigurationEditorCommand,
  writeConfigurationFileAtomically,
  type ConfigurationFileSystem,
  type ConfigEditOutcome,
} from "#/config-editor/index.ts";
import {
  createConfigLoader,
  resolveConfigPath,
} from "#/config-loader/index.ts";
import { attempt, getErrorMessage } from "#/errors/index.ts";
import {
  assessWorkspacePaths,
  requestWorkspacePathPermission,
} from "#/path-permissions/index.ts";
import { extractToolPaths, resolveInputPath } from "#/paths/index.ts";
import { createPathReservationRegistry, pathReservationBlockMessageTemplates } from "#/path-reservations/index.ts";
import {
  applyPostToolActions,
  createPostToolActionRegistry,
} from "#/post-tool-actions/index.ts";
import { createProcessRunner, type ProcessRunner } from "#/process/index.ts";
import {
  requestOptionalReviewFeedback,
  requestReviewDecision,
} from "#/review-prompts/index.ts";
import {
  createRuntimeTemporaryFileStore,
  type RuntimeTemporaryFileStore,
} from "#/runtime-temporary-files/index.ts";
import {
  formatWorkspaceContext,
  readWorkspaceContextSources,
  selectWorkspaceContextSources,
  type WorkspaceContextSource,
  type WorkspaceContextSourceSelection,
  type WorkspaceContextStatus,
} from "#/workspace-context/index.ts";
import { discoverWorkspaceResources } from "#/workspace-resources/index.ts";
import {
  addWorkspace,
  commands as workspaceCommands,
  confirmationMessageTemplates as workspaceConfirmationMessageTemplates,
  errorMessageTemplates as workspaceErrorMessageTemplates,
  formatWorkspaceList,
  infoMessageTemplates as workspaceInfoMessageTemplates,
  openWorkspace,
  removeWorkspace,
  resolveWorkspaceDirectory,
  restoreWorkspaceSnapshot,
  warningMessageTemplates as workspaceWarningMessageTemplates,
  workspaceEntryType,
} from "#/workspaces/index.ts";

export type TelepromptCommentaryDependencies = {
  configFilePath: string;
  fileSystem: ConfigurationFileSystem;
  processRunner: ProcessRunner;
  readConfigurationFile(): Promise<string>;
  readStarterConfigurationSource(): Promise<string>;
  saveConfiguration(source: string): Promise<void>;
  createWorkspaceGroupId?(): string;
  temporaryFileStore?: RuntimeTemporaryFileStore;
};

function reportConfigEditOutcome({
  outcome,
  notify,
}: {
  outcome: ConfigEditOutcome;
  notify(message: string, level: "info" | "warning"): void;
}): void {
  if (outcome.type === "shutdown") {
    return;
  }
  if (outcome.type === "pi-editor-saved") {
    notify(configEditMessages.saved, "info");
  } else if (outcome.type === "pi-editor-cancelled") {
    notify(configEditMessages.cancelled, "info");
  } else if (outcome.type === "editor-unavailable") {
    notify(configEditMessages.editorUnavailable, "warning");
  } else if (
    outcome.completion.type === "exited" &&
    outcome.completion.exitCode === 0 &&
    outcome.completion.signal === null
  ) {
    notify(configEditMessages.configuredEditorFinished, "info");
  } else {
    notify(
      configEditorErrorMessageTemplates.configuredEditorDidNotExitCleanly(
        outcome.completion,
      ),
      "warning",
    );
  }
}

export function registerTelepromptCommentary({
  pi,
  dependencies,
}: {
  pi: ExtensionAPI;
  dependencies: TelepromptCommentaryDependencies;
}): void {
  let additionalWorkspaces: ReadonlyArray<string> = [];
  let workspaceRevision = 0;
  const pathReservationRegistry = createPathReservationRegistry();
  const postToolActionRegistry = createPostToolActionRegistry();
  const temporaryFileStore =
    dependencies.temporaryFileStore ?? createRuntimeTemporaryFileStore();
  const activeBashReviews = new Map<AbortController, Promise<unknown>>();
  const activeFileReviews = new Map<AbortController, Promise<unknown>>();
  let shuttingDown = false;
  const createLoader = (
    reportConfigurationWarning: (message: string) => void,
  ) => {
    return createConfigLoader({
      readConfigurationFile: dependencies.readConfigurationFile,
      reportConfigurationWarning,
    });
  };
  const canContinueWorkspaceChange = ({ expectedRevision, ctx }: {
    expectedRevision: number;
    ctx: ExtensionCommandContext;
  }): boolean => {
    if (shuttingDown) {
      return false;
    }
    if (expectedRevision !== workspaceRevision) {
      if (ctx.hasUI) {
        ctx.ui.notify(workspaceWarningMessageTemplates.workspaceStateChanged(), "warning");
      }

      return false;
    }

    return true;
  };
  const resolveAvailableWorkspacePaths = async (
    ctx: ExtensionCommandContext,
  ) => {
    let primaryWorkspace: string | undefined;
    try {
      primaryWorkspace = await resolveWorkspaceDirectory({
        workspacePath: ctx.cwd,
      });
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          workspaceWarningMessageTemplates.primaryWorkspaceUnavailable({
            workspacePath: ctx.cwd,
            errorMessage: getErrorMessage(error),
          }),
          "warning",
        );
      }
    }

    return {
      primaryWorkspace,
      workspacePaths:
        primaryWorkspace === undefined
          ? [...additionalWorkspaces]
          : [primaryWorkspace, ...additionalWorkspaces],
    };
  };
  pi.on("session_start", async (_event, ctx) => {
    additionalWorkspaces = restoreWorkspaceSnapshot(
      ctx.sessionManager.getBranch(),
    ).additionalWorkspaces;
    workspaceRevision += 1;
    const configLoader = createLoader((message) => {
      if (ctx.hasUI) {
        ctx.ui.notify(message, "warning");
      }
    });
    await configLoader.load();
  });
  pi.on("message_end", async (event, ctx) => {
    if (shuttingDown || event.message.role !== "assistant") return;
    const toolSummaries = event.message.content
      .filter((block) => block.type === "toolCall")
      .map((block) => `Tool "${block.name}" is being called.`);
    const descriptions = event.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text);
    const text = [...toolSummaries, ...descriptions].join("\n");
    if (text.trim() === "") return;
    await dispatchHookCommands({
      processRunner: dependencies.processRunner,
      shouldDispatch: () => !shuttingDown,
      resolveCommands: () => createLoader((message) => {
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
      }).resolveHooks({
        hook: "assistant_message_end",
        variables: { assistant_message_text: text },
      }),
    });
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (shuttingDown) return;
    await dispatchHookCommands({
      processRunner: dependencies.processRunner,
      shouldDispatch: () => !shuttingDown,
      resolveCommands: () => createLoader((message) => {
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
      }).resolveHooks({ hook: "agent_settled", variables: {} }),
    });
  });
  pi.on("session_tree", (_event, ctx) => {
    additionalWorkspaces = restoreWorkspaceSnapshot(
      ctx.sessionManager.getBranch(),
    ).additionalWorkspaces;
    workspaceRevision += 1;
  });
  pi.on("tool_call", async (event, ctx) => {
    if (shuttingDown && (event.toolName === "write" || event.toolName === "edit")) {
      return {
        block: true,
        reason: "The file review was blocked because review is shutting down.",
      };
    }
    if (
      event.toolName === "bash" &&
      typeof event.input.command === "string"
    ) {
      if (shuttingDown) {
        return { block: true, reason: "The command was blocked because review is shutting down." };
      }
      const reviewController = new AbortController();
      const review = reviewBashCommand({
        input: {
          command: event.input.command,
          hasUI: ctx.hasUI,
          signal: reviewController.signal,
        },
        dependencies: {
          temporaryFileStore,
          processRunner: dependencies.processRunner,
          async resolveConfiguredAction({
            commandFilePath,
            commandString,
          }) {
            const configLoader = createLoader((message) => {
              if (ctx.hasUI) {
                ctx.ui.notify(message, "warning");
              }
            });
            const action = await configLoader.resolveHandler({
              category: "command_editor",
              variables: {
                command_file_path: commandFilePath,
                command_string: commandString,
              },
            });
            return action;
          },
          readCommandFile(path) {
            return readFile(path, "utf8");
          },
          async requestDecision(input) {
            if (input.hasUI && !input.signal?.aborted) {
              await dispatchHookCommands({
                processRunner: dependencies.processRunner,
                shouldDispatch: () => !shuttingDown && !input.signal?.aborted,
                resolveCommands: () => createLoader((message) => ctx.ui.notify(message, "warning")).resolveHooks({
                  hook: "tool_permission_request",
                  variables: { tool_name: event.toolName },
                }),
              });
            }
            return requestReviewDecision({
              input,
              dependencies: {
                selectReviewDecision({ title, options, signal }) {
                  return ctx.ui.select(title, options, { signal });
                },
              },
            });
          },
          requestFeedback(input) {
            return requestOptionalReviewFeedback({
              input,
              dependencies: {
                requestReviewFeedback({ title, placeholder, signal }) {
                  return ctx.ui.input(title, placeholder, { signal });
                },
              },
            });
          },
        },
      });
      activeBashReviews.set(reviewController, review);
      let outcome: Awaited<typeof review>;
      try {
        outcome = await review;
      } finally {
        activeBashReviews.delete(reviewController);
      }
      if (shuttingDown) {
        return { block: true, reason: "The command was blocked because review is shutting down." };
      }
      if (outcome.type === "edited") {
        event.input.command = outcome.command;
        postToolActionRegistry.add({
          toolCallId: event.toolCallId,
          action: {
            type: "annotate-edited-bash-command",
            command: outcome.command,
          },
        });

        return;
      }
      if (outcome.type === "allowed") {
        if (outcome.feedback !== undefined) {
          postToolActionRegistry.add({
            toolCallId: event.toolCallId,
            action: {
              type: "append-user-feedback",
              feedback: outcome.feedback,
            },
          });
        }

        return;
      }

      return { block: true, reason: outcome.reason };
    }

    const requestedPaths = extractToolPaths({ event, cwd: ctx.cwd });
    if (requestedPaths.length === 0) {
      return;
    }
    const assessment = await assessWorkspacePaths({
      requestedPaths,
      toolName: event.toolName,
      workspacePaths: [ctx.cwd, ...additionalWorkspaces],
      cwd: ctx.cwd,
      homeDirectory: homedir(),
    });
    const permission = await requestWorkspacePathPermission({
      input: {
        assessment,
        toolName: event.toolName,
        hasUI: ctx.hasUI,
      },
      dependencies: {
        async runPermissionRequestHook(toolName) {
          const configLoader = createLoader((message) => {
            if (ctx.hasUI) {
              ctx.ui.notify(message, "warning");
            }
          });
          await dispatchHookCommands({
            processRunner: dependencies.processRunner,
            shouldDispatch: () => !shuttingDown,
            resolveCommands: () => configLoader.resolveHooks({
              hook: "tool_permission_request",
              variables: { tool_name: toolName },
            }),
          });
        },
        confirmOutsideWorkspaceAccess({ title, message }) {
          return ctx.ui.confirm(title, message);
        },
      },
    });
    if (permission.type === "blocked") {
      return { block: true, reason: permission.reason };
    }
    if (
      (event.toolName === "write" || event.toolName === "edit") &&
      assessment.type !== "resolution-failed"
    ) {
      // Permission/path assessment can yield while shutdown begins.
      if (shuttingDown) {
        return { block: true, reason: "The file review was blocked because review is shutting down." };
      }
      for (const canonicalPath of assessment.canonicalPaths) {
        const acquisition = pathReservationRegistry.acquire({
          canonicalPath,
          toolCallId: event.toolCallId,
        });
        if (acquisition.type === "conflict") {
          pathReservationRegistry.releaseByToolCallId(event.toolCallId);

          return {
            block: true,
            reason: pathReservationBlockMessageTemplates.conflict(acquisition),
          };
        }
      }
      const configLoader = createLoader((message) => {
        if (ctx.hasUI) {
          ctx.ui.notify(message, "warning");
        }
      });
      const canonicalPath = assessment.canonicalPaths[0];
      if (canonicalPath === undefined) {
        pathReservationRegistry.releaseByToolCallId(event.toolCallId);
        return { block: true, reason: "The file target could not be resolved for review." };
      }
      const preview = isToolCallEventType("write", event)
        ? { toolName: "write" as const, input: event.input }
        : isToolCallEventType("edit", event)
          ? { toolName: "edit" as const, input: event.input }
          : undefined;
      if (preview === undefined) {
        pathReservationRegistry.releaseByToolCallId(event.toolCallId);
        return { block: true, reason: "The file tool input could not be reviewed." };
      }
      const controller = new AbortController();
      const review = attempt(async () => {
        const prepared = await prepareFileReview({
          canonicalPath,
          temporaryFileStore,
          resolveConfiguredAction(input) {
            return input.type === "existing"
              ? configLoader.resolveHandler({
                  category: "diff_editor",
                  variables: {
                    old_content_file_path: input.oldContentFilePath,
                    new_content_file_path: input.newContentFilePath,
                  },
                })
              : configLoader.resolveHandler({
                  category: "new_file_editor",
                  variables: { new_file_path: input.newFilePath },
                });
          },
        });
        if (prepared.type === "failed") {
          return { type: "blocked" as const, reason: `The file review could not be prepared: ${getErrorMessage(prepared.error)}` };
        }
        return reviewPreparedFile({
          prepared: prepared.value,
          input: {
            canonicalPath,
            preview,
            toolCallId: event.toolCallId,
            ctx,
            hasUI: ctx.hasUI,
            signal: controller.signal,
          },
          dependencies: {
            processRunner: dependencies.processRunner,
            async requestDecision(input) {
              if (input.hasUI && !input.signal?.aborted) {
                await dispatchHookCommands({
                  processRunner: dependencies.processRunner,
                  shouldDispatch: () => !shuttingDown && !input.signal?.aborted,
                  resolveCommands: () => configLoader.resolveHooks({
                    hook: "tool_permission_request",
                    variables: { tool_name: event.toolName },
                  }),
                });
              }
              return requestReviewDecision({
                input,
                dependencies: {
                  selectReviewDecision({ title, options, signal }) {
                    return ctx.ui.select(title, options, { signal });
                  },
                },
              });
            },
            requestFeedback(input) {
              return requestOptionalReviewFeedback({
                input,
                dependencies: {
                  requestReviewFeedback({ title, placeholder, signal }) {
                    return ctx.ui.input(title, placeholder, { signal });
                  },
                },
              });
            },
          },
        });
      });
      activeFileReviews.set(controller, review);
      let completed: Awaited<typeof review>;
      try {
        completed = await review;
      } finally {
        activeFileReviews.delete(controller);
      }
      if (shuttingDown || !completed.success || completed.value.type === "blocked") {
        postToolActionRegistry.clearByToolCallId(event.toolCallId);
        pathReservationRegistry.releaseByToolCallId(event.toolCallId);
        return {
          block: true,
          reason: shuttingDown
            ? "The file review was blocked because review is shutting down."
            : !completed.success
              ? `The file review failed: ${getErrorMessage(completed.error)}`
              : completed.value.type === "blocked"
                ? completed.value.reason
                : "The file review was blocked.",
        };
      }
      if (completed.value.type === "reviewed") {
        postToolActionRegistry.add({
          toolCallId: event.toolCallId,
          action: {
            type: "apply-reviewed-content",
            canonicalPath,
            content: completed.value.content,
            changeSummary: completed.value.changeSummary,
          },
        });
      } else if (completed.value.feedback !== undefined) {
        postToolActionRegistry.add({
          toolCallId: event.toolCallId,
          action: { type: "append-user-feedback", feedback: completed.value.feedback },
        });
      }
      return;
    }
  });
  pi.on("tool_result", async (event) => {
    const actions = postToolActionRegistry.takeByToolCallId(event.toolCallId);
    try {
      if (actions.length === 0) return;
      if (!actions.some((action) => action.type === "apply-reviewed-content")) {
        return {
          content: applyPostToolActions({
            actions: actions.filter((action) => action.type !== "apply-reviewed-content"),
            content: event.content,
          }),
        };
      }
      const fileApplication = await attempt(() => applyFilePostToolActions({
        actions: actions.filter((action) => action.type !== "annotate-edited-bash-command"),
        content: event.content,
      }));
      const content = fileApplication.success
        ? fileApplication.value
        : applyPostToolActions({
            actions: actions.filter((action) => action.type === "append-user-feedback"),
            content: [
              ...event.content,
              {
                type: "text" as const,
                text: `The user's reviewed file content could not be applied: ${getErrorMessage(fileApplication.error)}`,
              },
            ],
          });
      return {
        content: applyPostToolActions({
          actions: actions.filter((action) => action.type === "annotate-edited-bash-command"),
          content,
        }),
      };
    } finally {
      pathReservationRegistry.releaseByToolCallId(event.toolCallId);
    }
  });
  pi.on("tool_execution_end", (event) => {
    postToolActionRegistry.clearByToolCallId(event.toolCallId);
    pathReservationRegistry.releaseByToolCallId(event.toolCallId);
  });
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    postToolActionRegistry.clear();
    pathReservationRegistry.clear();
    const reviews = [...activeBashReviews.entries(), ...activeFileReviews.entries()];
    for (const [controller] of reviews) {
      controller.abort();
    }
    await attempt(() => dependencies.processRunner.cleanup());
    await Promise.allSettled(reviews.map(([, review]) => review));
    await attempt(() => temporaryFileStore.cleanup());
  });
  pi.on("resources_discover", async (_event, ctx) => {
    return discoverWorkspaceResources({
      additionalWorkspaces,
      reportWarning(message) {
        if (ctx.hasUI) {
          ctx.ui.notify(message, "warning");
        }
      },
    });
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const reportWarning = (message: string) => {
      if (ctx.hasUI) {
        ctx.ui.notify(message, "warning");
      }
    };
    let primaryWorkspaceStatus: WorkspaceContextStatus;
    try {
      primaryWorkspaceStatus = {
        workspacePath: await resolveWorkspaceDirectory({
          workspacePath: ctx.cwd,
        }),
        availability: "available",
      };
    } catch (error) {
      const reason = getErrorMessage(error);
      primaryWorkspaceStatus = {
        workspacePath: ctx.cwd,
        availability: "unavailable",
        reason,
      };
      reportWarning(
        workspaceWarningMessageTemplates.primaryWorkspaceUnavailable({
          workspacePath: ctx.cwd,
          errorMessage: reason,
        }),
      );
    }
    const additionalWorkspaceSelections: Array<WorkspaceContextSourceSelection> =
      [];
    const contextSources: Array<WorkspaceContextSource> = [];
    for (const workspacePath of additionalWorkspaces) {
      const sourceSelection = await selectWorkspaceContextSources({
        workspacePath,
        reportWarning,
      });
      additionalWorkspaceSelections.push(sourceSelection);
      contextSources.push(
        ...(await readWorkspaceContextSources({
          sourceSelection,
          reportWarning,
        })),
      );
    }
    const workspaceContext = formatWorkspaceContext({
      primaryWorkspaceStatus,
      additionalWorkspaceSelections,
      contextSources,
    });

    return { systemPrompt: `${event.systemPrompt}\n\n${commentarySystemPrompt}\n\n${workspaceContext}` };
  });
  pi.registerCommand(configEditorCommands.edit.name, {
    description: configEditorCommands.edit.description,
    handler: async (args, ctx) => {
      if (shuttingDown) {
        return;
      }
      if (args.trim() !== "") {
        if (ctx.hasUI) {
          ctx.ui.notify(configEditMessages.usage, "warning");
        }

        return;
      }
      const configLoader = createLoader((message) => {
        if (ctx.hasUI && !shuttingDown) {
          ctx.ui.notify(message, "warning");
        }
      });
      const configEditor = createConfigEditor({
        isShuttingDown: () => shuttingDown,
        async ensureConfigurationFile() {
          return ensureConfigurationFile({
            configFilePath: dependencies.configFilePath,
            starterSource: await dependencies.readStarterConfigurationSource(),
            fileSystem: dependencies.fileSystem,
          });
        },
        resolveConfigurationEditor() {
          return resolveConfigurationEditorCommand({
            configLoader,
            configFilePath: dependencies.configFilePath,
          });
        },
        processRunner: dependencies.processRunner,
        readConfigurationFile: dependencies.readConfigurationFile,
        reportConfiguredEditorFailure(completion) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              configEditorErrorMessageTemplates.configuredEditorDidNotExitCleanly(
                completion,
              ),
              "warning",
            );
          }
        },
        openPiEditor: ctx.hasUI
          ? (source) =>
              ctx.ui.editor(configEditorCommands.edit.editorTitle, source)
          : undefined,
        saveConfiguration: dependencies.saveConfiguration,
        async revalidateConfiguration() {
          await configLoader.load();
        },
      });
      const outcome = await configEditor.edit();
      if (ctx.hasUI && !shuttingDown) {
        reportConfigEditOutcome({
          outcome,
          notify(message, level) {
            ctx.ui.notify(message, level);
          },
        });
      }
    },
  });
  pi.registerCommand(workspaceCommands.add.name, {
    description: workspaceCommands.add.description,
    handler: async (args, ctx) => {
      if (shuttingDown) {
        return;
      }
      const expectedRevision = workspaceRevision;
      let inputPath = args.trim();
      if (inputPath === "") {
        if (!ctx.hasUI) {
          return;
        }
        inputPath =
          (
            await ctx.ui.input(
              workspaceCommands.add.inputTitle,
              workspaceCommands.add.inputPlaceholder,
            )
          )?.trim() ?? "";
        if (inputPath === "") {
          return;
        }
      }
      if (!canContinueWorkspaceChange({ expectedRevision, ctx })) {
        return;
      }
      let primaryWorkspace: string;
      let workspacePath: string;
      try {
        primaryWorkspace = await resolveWorkspaceDirectory({
          workspacePath: ctx.cwd,
        });
        workspacePath = await resolveWorkspaceDirectory({
          workspacePath: resolveInputPath({
            inputPath,
            cwd: ctx.cwd,
            homeDirectory: homedir(),
          }),
        });
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceErrorMessageTemplates.workspaceAddFailed(
              getErrorMessage(error),
            ),
            "warning",
          );
        }

        return;
      }
      if (!canContinueWorkspaceChange({ expectedRevision, ctx })) {
        return;
      }
      const outcome = addWorkspace({
        state: { primaryWorkspace, additionalWorkspaces },
        workspacePath,
      });
      if (outcome.type === "workspace-already-present") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceInfoMessageTemplates.workspaceAlreadyPresent(
              workspacePath,
            ),
            "info",
          );
        }

        return;
      }
      if (!ctx.hasUI) {
        return;
      }
      const confirmed = await ctx.ui.confirm(
        workspaceCommands.add.confirmTitle,
        workspaceConfirmationMessageTemplates.addWorkspace(workspacePath),
      );
      if (!confirmed || !canContinueWorkspaceChange({ expectedRevision, ctx })) {
        return;
      }
      try {
        pi.appendEntry(workspaceEntryType, {
          additionalWorkspaces: outcome.state.additionalWorkspaces,
        });
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceErrorMessageTemplates.workspaceAddFailed(
              getErrorMessage(error),
            ),
            "warning",
          );
        }

        return;
      }
      additionalWorkspaces = outcome.state.additionalWorkspaces;
      workspaceRevision += 1;
      await ctx.reload();
    },
  });
  pi.registerCommand(workspaceCommands.remove.name, {
    description: workspaceCommands.remove.description,
    handler: async (args, ctx) => {
      if (shuttingDown) {
        return;
      }
      const expectedRevision = workspaceRevision;
      let workspacePath = args.trim();
      if (workspacePath === "") {
        if (!ctx.hasUI) {
          return;
        }
        if (additionalWorkspaces.length === 0) {
          ctx.ui.notify(
            workspaceWarningMessageTemplates.noAdditionalWorkspacesToRemove(),
            "warning",
          );

          return;
        }
        workspacePath =
          (await ctx.ui.select(workspaceCommands.remove.selectTitle, [
            ...additionalWorkspaces,
          ])) ?? "";
        if (workspacePath === "") {
          return;
        }
      }
      if (!canContinueWorkspaceChange({ expectedRevision, ctx })) {
        return;
      }
      let primaryWorkspace: string;
      try {
        primaryWorkspace = await resolveWorkspaceDirectory({
          workspacePath: ctx.cwd,
        });
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceErrorMessageTemplates.workspaceRemoveFailed(
              getErrorMessage(error),
            ),
            "warning",
          );
        }

        return;
      }
      if (!canContinueWorkspaceChange({ expectedRevision, ctx })) {
        return;
      }
      const outcome = removeWorkspace({
        state: { primaryWorkspace, additionalWorkspaces },
        workspacePath,
      });
      if (outcome.type === "primary-workspace-not-removable") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceWarningMessageTemplates.primaryWorkspaceNotRemovable(
              workspacePath,
            ),
            "warning",
          );
        }

        return;
      }
      if (outcome.type === "workspace-not-found") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceWarningMessageTemplates.workspaceNotFound(workspacePath),
            "warning",
          );
        }

        return;
      }
      if (!ctx.hasUI) {
        return;
      }
      const confirmed = await ctx.ui.confirm(
        workspaceCommands.remove.confirmTitle,
        workspaceConfirmationMessageTemplates.removeWorkspace(workspacePath),
      );
      if (!confirmed || !canContinueWorkspaceChange({ expectedRevision, ctx })) {
        return;
      }
      try {
        pi.appendEntry(workspaceEntryType, {
          additionalWorkspaces: outcome.state.additionalWorkspaces,
        });
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceErrorMessageTemplates.workspaceRemoveFailed(
              getErrorMessage(error),
            ),
            "warning",
          );
        }

        return;
      }
      additionalWorkspaces = outcome.state.additionalWorkspaces;
      workspaceRevision += 1;
      await ctx.reload();
    },
  });
  pi.registerCommand(workspaceCommands.open.name, {
    description: workspaceCommands.open.description,
    handler: async (args, ctx) => {
      if (shuttingDown) {
        return;
      }
      const suppliedWorkspacePath = args.trim();
      if (suppliedWorkspacePath === "" && !ctx.hasUI) {
        return;
      }
      const { workspacePaths } = await resolveAvailableWorkspacePaths(ctx);
      if (shuttingDown) {
        return;
      }
      let workspacePath = suppliedWorkspacePath;
      if (workspacePath === "") {
        if (workspacePaths.length === 0) {
          ctx.ui.notify(
            workspaceWarningMessageTemplates.noWorkspacesAvailableToOpen(),
            "warning",
          );

          return;
        }
        workspacePath =
          (await ctx.ui.select(
            workspaceCommands.open.selectTitle,
            workspacePaths,
          )) ?? "";
        if (shuttingDown || workspacePath === "") {
          return;
        }
      } else if (!workspacePaths.includes(workspacePath)) {
        if (ctx.hasUI && suppliedWorkspacePath !== ctx.cwd) {
          ctx.ui.notify(
            workspaceWarningMessageTemplates.workspaceNotFound(workspacePath),
            "warning",
          );
        }

        return;
      }
      const configLoader = createLoader((message) => {
        if (ctx.hasUI) {
          ctx.ui.notify(message, "warning");
        }
      });
      await openWorkspace({
        isShuttingDown: () => shuttingDown,
        workspacePath,
        groupId: dependencies.createWorkspaceGroupId?.() ?? randomUUID(),
        configLoader,
        processRunner: dependencies.processRunner,
        reportWarning(message) {
          if (ctx.hasUI) {
            ctx.ui.notify(message, "warning");
          }
        },
      });
    },
  });
  pi.registerCommand(workspaceCommands.openAll.name, {
    description: workspaceCommands.openAll.description,
    handler: async (args, ctx) => {
      if (shuttingDown) {
        return;
      }
      if (args.trim() !== "") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceWarningMessageTemplates.workspacesOpenDoesNotAcceptArguments(),
            "warning",
          );
        }

        return;
      }
      const { workspacePaths } = await resolveAvailableWorkspacePaths(ctx);
      if (shuttingDown) {
        return;
      }
      if (workspacePaths.length === 0) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            workspaceWarningMessageTemplates.noWorkspacesAvailableToOpen(),
            "warning",
          );
        }

        return;
      }
      const groupId = dependencies.createWorkspaceGroupId?.() ?? randomUUID();
      const configLoader = createLoader((message) => {
        if (ctx.hasUI) {
          ctx.ui.notify(message, "warning");
        }
      });
      await Promise.all(
        workspacePaths.map((workspacePath) =>
          openWorkspace({
            isShuttingDown: () => shuttingDown,
            workspacePath,
            groupId,
            configLoader,
            processRunner: dependencies.processRunner,
            reportWarning(message) {
              if (ctx.hasUI) {
                ctx.ui.notify(message, "warning");
              }
            },
          }),
        ),
      );
    },
  });
  pi.registerCommand(workspaceCommands.list.name, {
    description: workspaceCommands.list.description,
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }
      let canonicalPrimaryWorkspace: string | undefined;
      try {
        canonicalPrimaryWorkspace = await resolveWorkspaceDirectory({
          workspacePath: ctx.cwd,
        });
      } catch (error) {
        ctx.ui.notify(
          workspaceWarningMessageTemplates.primaryWorkspaceUnavailable({
            workspacePath: ctx.cwd,
            errorMessage: getErrorMessage(error),
          }),
          "warning",
        );
      }
      ctx.ui.notify(
        formatWorkspaceList({
          primaryWorkspace:
            canonicalPrimaryWorkspace === undefined
              ? { path: ctx.cwd, availability: "unavailable" }
              : {
                  path: canonicalPrimaryWorkspace,
                  availability: "available",
                },
          additionalWorkspaces,
        }),
        "info",
      );
    },
  });
}

export default function telepromptCommentary(pi: ExtensionAPI): void {
  const configFilePath = resolveConfigPath({
    piAgentDirectory: process.env.PI_CODING_AGENT_DIR,
    homeDirectory: homedir(),
  });
  registerTelepromptCommentary({
    pi,
    dependencies: {
      configFilePath,
      fileSystem: configurationFileSystem,
      processRunner: createProcessRunner(),
      async readConfigurationFile() {
        return readFile(configFilePath, "utf8");
      },
      readStarterConfigurationSource,
      saveConfiguration(source) {
        return writeConfigurationFileAtomically({ configFilePath, source });
      },
    },
  });
}

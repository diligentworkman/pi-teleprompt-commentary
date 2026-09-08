import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createConfigEditor } from "#/config-editor/index.ts";
import type { ProcessCompletion, ProcessRunner } from "#/process/index.ts";

type PiEditorOutcome =
  { type: "unavailable" } | { type: "returns"; source: string | undefined };

function createEditorHarness({
  configuredEditor,
  piEditorOutcome,
  completion = { type: "exited", exitCode: 0, signal: null },
  currentSource = "current configuration",
}: {
  configuredEditor?: [string, ...string[]];
  piEditorOutcome: PiEditorOutcome;
  completion?: ProcessCompletion;
  currentSource?: string;
}) {
  const existingSource = "existing configuration";
  const events: string[] = [];
  const savedSources: string[] = [];
  const failures: ProcessCompletion[] = [];
  const processRunner: ProcessRunner = {
    start({ command }) {
      events.push(`start:${JSON.stringify(command)}`);

      return {
        completion: Promise.resolve(completion),
        async terminate() {
          return { type: "already-exited" };
        },
      };
    },
    async cleanup() {
      return [];
    },
  };
  const openPiEditor =
    piEditorOutcome.type === "unavailable"
      ? undefined
      : async (source: string) => {
          events.push(`edit:${source}`);

          return piEditorOutcome.source;
        };
  const editor = createConfigEditor({
    async ensureConfigurationFile() {
      events.push("ensure");

      return { source: existingSource, created: false };
    },
    async resolveConfigurationEditor() {
      events.push("resolve");

      return configuredEditor;
    },
    processRunner,
    reportConfiguredEditorFailure(completion) {
      events.push("warn");
      failures.push(completion);
    },
    async readConfigurationFile() {
      events.push("read");

      return currentSource;
    },
    openPiEditor,
    async saveConfiguration(source) {
      events.push("save");
      savedSources.push(source);
    },
    async revalidateConfiguration() {
      events.push("revalidate");
    },
  });

  return { editor, events, savedSources, existingSource, failures };
}

describe("configuration editor", () => {
  describe("configured-editor failure recovery", () => {
    const configuredEditor: [string] = ["editor"];
    const currentSource = "externally changed configuration";
    const failureCases = [
      {
        name: "spawn failure",
        completion: {
          type: "spawn-failed",
          error: new Error("missing editor"),
        },
      },
      {
        name: "nonzero exit",
        completion: { type: "exited", exitCode: 7, signal: null },
      },
      {
        name: "signal termination",
        completion: { type: "exited", exitCode: null, signal: "SIGTERM" },
      },
    ] satisfies Array<{ name: string; completion: ProcessCompletion }>;
    for (const { name, completion } of failureCases) {
      it(`warns, rereads, and saves Pi editor content after ${name}`, async () => {
        const { editor, events, savedSources, failures } = createEditorHarness({
          configuredEditor,
          completion,
          currentSource,
          piEditorOutcome: { type: "returns", source: "" },
        });
        assert.deepEqual(await editor.edit(), { type: "pi-editor-saved" });
        assert.deepEqual(failures, [completion]);
        assert.deepEqual(savedSources, [""]);
        assert.deepEqual(events, [
          "ensure",
          "resolve",
          `start:${JSON.stringify(configuredEditor)}`,
          "warn",
          "read",
          `edit:${currentSource}`,
          "save",
          "revalidate",
        ]);
      });
      it(`preserves current content when Pi fallback is cancelled after ${name}`, async () => {
        const { editor, events, savedSources, failures } = createEditorHarness({
          configuredEditor,
          completion,
          currentSource,
          piEditorOutcome: { type: "returns", source: undefined },
        });
        assert.deepEqual(await editor.edit(), { type: "pi-editor-cancelled" });
        assert.deepEqual(failures, [completion]);
        assert.deepEqual(savedSources, []);
        assert.deepEqual(events, [
          "ensure",
          "resolve",
          `start:${JSON.stringify(configuredEditor)}`,
          "warn",
          "read",
          `edit:${currentSource}`,
          "revalidate",
        ]);
      });
      it(`retains the failure outcome without UI after ${name}`, async () => {
        const { editor, events, failures } = createEditorHarness({
          configuredEditor,
          completion,
          piEditorOutcome: { type: "unavailable" },
        });
        assert.deepEqual(await editor.edit(), {
          type: "configured-editor-finished",
          completion,
        });
        assert.deepEqual(failures, []);
        assert.deepEqual(events, [
          "ensure",
          "resolve",
          `start:${JSON.stringify(configuredEditor)}`,
          "revalidate",
        ]);
      });
    }
  });
  it("runs a configured direct-argv editor and reports its completion", async () => {
    const configuredEditor: [string, ...string[]] = [
      "editor",
      "--wait",
      "path with spaces",
    ];
    const completion: ProcessCompletion = {
      type: "exited",
      exitCode: 0,
      signal: null,
    };
    const { editor, events } = createEditorHarness({
      configuredEditor,
      piEditorOutcome: { type: "returns", source: "must not be used" },
      completion,
    });
    assert.deepEqual(await editor.edit(), {
      type: "configured-editor-finished",
      completion,
    });
    assert.deepEqual(events, [
      "ensure",
      "resolve",
      `start:${JSON.stringify(configuredEditor)}`,
      "revalidate",
    ]);
  });
  it("saves text returned by Pi's editor, including empty text", async () => {
    const { editor, events, savedSources, existingSource } =
      createEditorHarness({
        piEditorOutcome: { type: "returns", source: "" },
      });
    assert.deepEqual(await editor.edit(), { type: "pi-editor-saved" });
    assert.deepEqual(savedSources, [""]);
    assert.deepEqual(events, [
      "ensure",
      "resolve",
      `edit:${existingSource}`,
      "save",
      "revalidate",
    ]);
  });
  it("preserves the configuration when Pi's editor is cancelled", async () => {
    const { editor, events, savedSources, existingSource } =
      createEditorHarness({
        piEditorOutcome: { type: "returns", source: undefined },
      });
    assert.deepEqual(await editor.edit(), {
      type: "pi-editor-cancelled",
    });
    assert.deepEqual(savedSources, []);
    assert.deepEqual(events, [
      "ensure",
      "resolve",
      `edit:${existingSource}`,
      "revalidate",
    ]);
  });
  it("exits without editing when no editor is available", async () => {
    const { editor, events, savedSources } = createEditorHarness({
      piEditorOutcome: { type: "unavailable" },
    });
    assert.deepEqual(await editor.edit(), { type: "editor-unavailable" });
    assert.deepEqual(savedSources, []);
    assert.deepEqual(events, ["ensure", "resolve", "revalidate"]);
  });
});

export const commands = {
  edit: {
    name: "tc:edit-config",
    description: "Edit the Teleprompt Commentary configuration",
    editorTitle: "Edit Teleprompt Commentary configuration",
  },
} as const;

export const starterConfigurationReferenceUrl = new URL(
  "./assets/starter-reference.toml",
  import.meta.url,
);

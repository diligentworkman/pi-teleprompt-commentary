import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type Notification = {
  message: Parameters<ExtensionUIContext["notify"]>[0];
  type: Parameters<ExtensionUIContext["notify"]>[1];
};

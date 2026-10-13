export type PathReservationConflictMessageInput = {
  canonicalPath: string;
  currentOwnerToolCallId: string;
};

export type AcquirePathReservationInput = {
  canonicalPath: string;
  toolCallId: string;
};

export type PathReservationAcquisitionOutcome =
  | {
      type: "acquired";
    }
  | {
      type: "conflict";
      canonicalPath: string;
      currentOwnerToolCallId: string;
    };

export type PathReservationRegistry = {
  acquire(
    input: AcquirePathReservationInput,
  ): PathReservationAcquisitionOutcome;
  releaseByToolCallId(toolCallId: string): void;
  clear(): void;
};

export interface CorrelatedContainerOutput {
  readonly inputTurnId?: string;
  ipcReceipts?: Array<{ deliveryId: string }>;
}

/** Resolve one immutable input identity; never consult mutable "latest" state. */
export function resolveContainerOutputInputTurnId(
  output: CorrelatedContainerOutput,
  coldStartInputTurnId: string,
): string {
  return (
    output.inputTurnId ??
    output.ipcReceipts?.[output.ipcReceipts.length - 1]?.deliveryId ??
    coldStartInputTurnId
  );
}

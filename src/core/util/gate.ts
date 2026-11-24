// A gate that a restart holds closed until the runtime it lands on is known: a request it cut off waits there, then
// runs on that runtime rather than the one the restart is leaving. vscode-free.

export class SettleGate {
  private settling: Promise<void> = Promise.resolve();
  private release: (() => void) | undefined;

  /** Close the gate (a restart begins). Closing a closed gate keeps it closed: its waiters wait for the next open. */
  close(): void {
    if (this.release) return;
    this.settling = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  /** Open it (the runtime is resolved, or the restart ended without one). Opening an open gate does nothing. */
  open(): void {
    this.release?.();
    this.release = undefined;
  }

  /** Resolves once the gate is open: now, when it is. */
  settled(): Promise<void> {
    return this.settling;
  }
}

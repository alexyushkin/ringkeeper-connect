// Asks the person to allow an action one of Ringkeeper Connect's own tools wants to take
// (pausing Meta ads), in a window of its own, one question at a time. No answer within
// the wait counts as "Don't allow", and so does closing the window.
import type { ApprovalRequest } from "@ringkeeper/gateway";

/** A little under the tools' own 2-minute wait, so the answer still reaches them. */
export const APPROVAL_TIMEOUT_MS = 115_000;

export interface AskWindow {
  /** Shows the question; resolves with the button chosen (0 = Allow, 1 = Don't allow). The signal closes it unanswered. */
  ask(q: { message: string; detail: string; buttons: string[] }, signal: AbortSignal): Promise<number>;
}

/** The question as the window shows it: the client in the headline, the details below. */
export function approvalText(q: ApprovalRequest): { message: string; detail: string; buttons: string[] } {
  const [first, ...rest] = q.message.trim().split("\n");
  return {
    message: `${q.clientName}: ${first ?? "Allow this?"}`,
    detail: `${rest.join("\n").trim()}\n\nYour AI app asked for this through ${q.connectionName}. Nothing changes unless you click Allow.`.trim(),
    buttons: ["Allow", "Don't allow"],
  };
}

export class Approvals {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly window: AskWindow,
    private readonly timeoutMs = APPROVAL_TIMEOUT_MS,
  ) {}

  /** True only if the person clicked Allow in time. */
  approve(q: ApprovalRequest): Promise<boolean> {
    const next = this.queue.then(() => this.askOne(q));
    this.queue = next.catch(() => false);
    return next;
  }

  private async askOne(q: ApprovalRequest): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = new AbortController();
    const late = new Promise<number>((resolve) => {
      timer = setTimeout(() => {
        stop.abort();
        resolve(-1);
      }, this.timeoutMs);
    });
    try {
      const chosen = await Promise.race([this.window.ask(approvalText(q), stop.signal), late]);
      return chosen === 0;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

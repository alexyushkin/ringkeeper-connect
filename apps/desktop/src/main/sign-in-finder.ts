// Where a web connection has no key and its server supports signing in, offer
// "Sign in" instead of "needs a key": no key to make, nothing to copy or
// update elsewhere. Covers connections brought in from AI apps (whose own
// sign-in can't be copied), ones added by address, and older ones.
import { offersSignIn, type ClientStore, type Logger } from "@ringkeeper/gateway";

export class SignInFinder {
  /** One look per address per run. */
  private readonly answers = new Map<string, Promise<boolean>>();
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;
  private again = false;

  constructor(
    private readonly deps: {
      store: ClientStore;
      probe?: (url: string) => Promise<boolean>;
      log?: Logger;
    },
  ) {}

  /** Look again shortly (after the connections changed). */
  schedule(delayMs = 500): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delayMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /** Switch every keyless web connection whose server supports sign-in. Returns how many were switched. */
  async run(): Promise<number> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass().finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        this.schedule(0);
      }
    });
    return this.running;
  }

  private keyless() {
    return this.deps.store
      .list()
      .flatMap((cl) => cl.connections.map((c) => ({ clientId: cl.id, conn: c })))
      .filter((x) => x.conn.kind === "remote" && !x.conn.auth && x.conn.fields.length === 0);
  }

  private async pass(): Promise<number> {
    const probe = this.deps.probe ?? ((u: string) => offersSignIn(u));
    let switched = 0;
    for (const { clientId, conn } of this.keyless()) {
      if (conn.kind !== "remote") continue;
      let answer = this.answers.get(conn.url);
      if (!answer) {
        answer = probe(conn.url).catch(() => false);
        this.answers.set(conn.url, answer);
      }
      if (!(await answer)) continue;
      // Still the same, keyless connection? (The user may have changed it meanwhile.)
      const now = this.keyless().find((x) => x.clientId === clientId && x.conn.id === conn.id);
      if (!now || now.conn.kind !== "remote" || now.conn.url !== conn.url) continue;
      try {
        this.deps.store.updateConnection(clientId, conn.id, {
          kind: "remote",
          name: conn.name,
          url: conn.url,
          ...(conn.transport ? { transport: conn.transport } : {}),
          auth: "oauth",
          fields: [],
        });
        switched++;
        this.deps.log?.({ ev: "sign_in_offered", client: clientId, conn: conn.id });
      } catch {
        // Removed or changed meanwhile: nothing to do.
      }
    }
    return switched;
  }
}

// On a client's page: how much the AI may do for this client, and what it did.
// Plain words only. The list never shows what was sent or what came back.
import { useEffect, useState } from "react";
import type { Activity, ClientGuard, ClientView, Result } from "../shared/api";

const api = window.ringkeeper;

type Run = <T>(p: Promise<Result<T>>) => Promise<{ value: T } | null>;

export const GUARD_CHOICES: Array<{ id: ClientGuard; label: string; detail: string }> = [
  {
    id: "ask_delete",
    label: "Ask me before it deletes anything (recommended)",
    detail: "Ringkeeper Connect asks you first, whichever AI app it is. Everything else is left to your AI app's own permission setting.",
  },
  {
    id: "free",
    label: "Work freely",
    detail: "Your AI app's own permission setting decides what it asks you about. Ringkeeper Connect doesn't ask.",
  },
  {
    id: "look_only",
    label: "Look only",
    detail: "The AI can read, but can't change, send or delete anything for this client.",
  },
];

/** What happened, in a few words. */
export function activityWords(a: Pick<Activity, "kind" | "outcome">): { text: string; tone: "ok" | "warn" | "bad" } {
  if (a.outcome === "ran") return { text: a.kind === "read" ? "Looked" : a.kind === "delete" ? "Deleted" : "Changed", tone: a.kind === "delete" ? "warn" : "ok" };
  if (a.outcome === "failed") return { text: "Didn't work", tone: "warn" };
  if (a.outcome === "not_allowed") return { text: "Not run: you didn't allow the deletion", tone: "bad" };
  if (a.outcome === "look_only") return { text: "Not run: this client is Look only", tone: "bad" };
  return { text: "Not run: the AI named a different client", tone: "bad" };
}

export function activityTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? `Today ${time}` : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function ClientSafety(props: { client: ClientView; activityCount: number; run: Run }) {
  const { client } = props;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Activity[] | null>(null);

  // A different client: start closed, with nothing left over from the last one.
  useEffect(() => {
    setOpen(false);
    setItems(null);
  }, [client.id]);

  // While it's open, reload whenever something new is recorded.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    void api.clientActivity(client.id).then((r) => {
      if (!stale) setItems(r.ok ? r.value : []);
    });
    return () => {
      stale = true;
    };
  }, [open, client.id, props.activityCount]);

  return (
    <>
      <div className="section-title">
        <h2>What the AI may do for {client.name}</h2>
      </div>
      <div className="guard" role="radiogroup" aria-label={`What the AI may do for ${client.name}`}>
        {GUARD_CHOICES.map((g) => (
          <label key={g.id} className={`guard-choice ${client.guard === g.id ? "chosen" : ""}`}>
            <input type="radio" name={`guard-${client.id}`} checked={client.guard === g.id} onChange={() => void props.run(api.setClientGuard(client.id, g.id))} />
            <span>
              <strong>{g.label}</strong>
              <span className="muted small">{g.detail}</span>
            </span>
          </label>
        ))}
      </div>

      <details className="activity" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>What AI apps did for {client.name}</summary>
        {items === null ? (
          <p className="muted small">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted small">Nothing yet. Each time an AI app uses one of {client.name}'s tools, it's listed here.</p>
        ) : (
          <>
            <p className="muted small">
              Newest first, the last {items.length === 1 ? "one" : items.length}. It shows which tool was used and how it ended, never what was sent or what came back.
            </p>
            <ul className="activity-list">
              {items.map((a, i) => {
                const w = activityWords(a);
                return (
                  <li key={`${a.at}-${i}`}>
                    <span className="activity-when">{activityTime(a.at)}</span>
                    <span className="activity-what">
                      <strong>{a.connectionName}</strong> <span className="activity-tool">{a.tool}</span>
                    </span>
                    <span className={`activity-how ${w.tone}`}>{w.text}</span>
                    <span className="activity-app muted">{a.app}</span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </details>
    </>
  );
}

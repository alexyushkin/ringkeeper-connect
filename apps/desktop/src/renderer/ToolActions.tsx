// Per tool: which of its actions the AI apps get, and moving a tool to or from
// "For every client". Plain words only.
import { useEffect, useMemo, useState } from "react";
import { EVERY_CLIENT_ID, type ActionInfo, type ClientView, type ConnectionView, type Result } from "../shared/api";
import { matchesWords } from "./search";
import { sameToolIn } from "./tool-actions-text";

export { actionsNote, sameToolIn } from "./tool-actions-text";

const api = window.ringkeeper;

type Run = <T>(p: Promise<Result<T>>) => Promise<{ value: T } | null>;

const KIND_WORDS: Record<ActionInfo["kind"], string> = { read: "reads", change: "changes", delete: "deletes" };

function Modal(props: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={props.title}>
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

type Mode = "all" | "read" | "chosen";

/** Choose which of a tool's actions the AI apps get. */
export function ActionsDialog(props: { client: ClientView; conn: ConnectionView; onClose: () => void; run: Run }) {
  const { client, conn } = props;
  const [actions, setActions] = useState<ActionInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(conn.actions === "read" ? "read" : Array.isArray(conn.actions) ? "chosen" : "all");
  const [chosen, setChosen] = useState<Set<string>>(new Set(Array.isArray(conn.actions) ? conn.actions : []));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const owner = client.id === EVERY_CLIENT_ID ? `${conn.name} (for every client)` : `${client.name}'s ${conn.name}`;

  useEffect(() => {
    let stale = false;
    void api.connectionActions(client.id, conn.id).then((r) => {
      if (stale) return;
      if (r.ok) setActions(r.value);
      else setLoadError(r.error);
    });
    return () => {
      stale = true;
    };
  }, [client.id, conn.id]);

  const reading = actions?.filter((a) => a.kind === "read").length ?? 0;
  const shown = useMemo(() => (actions ?? []).filter((a) => matchesWords(`${a.name} ${a.description}`, query.trim())), [actions, query]);
  const setAll = (names: string[], on: boolean) =>
    setChosen((c) => {
      const next = new Set(c);
      for (const n of names) {
        if (on) next.add(n);
        else next.delete(n);
      }
      return next;
    });

  async function save() {
    setBusy(true);
    const choice = mode === "all" ? "all" : mode === "read" ? "read" : [...chosen];
    const done = await props.run(api.setConnectionActions(client.id, conn.id, choice));
    setBusy(false);
    if (done) props.onClose();
  }

  return (
    <Modal title={`Which actions the AI gets from ${owner}`} onClose={props.onClose} wide>
      <p className="muted small">
        Fewer actions make the AI quicker and better at picking the right one. An action left out isn't shown to the AI and isn't run.
      </p>
      <fieldset className="choice">
        <legend className="sr-only">Which actions</legend>
        <label>
          <input type="radio" checked={mode === "all"} onChange={() => setMode("all")} /> All of them{actions ? ` (${actions.length})` : ""}
        </label>
        <label>
          <input type="radio" checked={mode === "read"} onChange={() => setMode("read")} /> Only the ones that read{actions ? ` (${reading})` : ""}
          <span className="hint"> The AI can look, but can't change, send or delete anything with {conn.name}.</span>
        </label>
        <label>
          <input type="radio" checked={mode === "chosen"} disabled={!actions} onChange={() => setMode("chosen")} /> Only the ones I choose
        </label>
      </fieldset>

      {loadError && (
        <div className="notice warn small" role="alert">
          {loadError} Its actions can be chosen once it works.
        </div>
      )}
      {!actions && !loadError && <p className="muted small">Starting {conn.name} to see its actions…</p>}

      {actions && mode === "chosen" && (
        <div className="action-picker">
          <div className="action-picker-bar">
            <input type="search" placeholder="Search actions" aria-label="Search actions" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button type="button" className="link" onClick={() => setAll(shown.map((a) => a.name), true)}>
              Tick {query.trim() ? "these" : "all"}
            </button>
            <button type="button" className="link" onClick={() => setAll(shown.filter((a) => a.kind === "read").map((a) => a.name), true)}>
              Tick the ones that read
            </button>
            <button type="button" className="link" onClick={() => setAll(shown.map((a) => a.name), false)}>
              Untick {query.trim() ? "these" : "all"}
            </button>
          </div>
          <ul className="action-list">
            {shown.map((a) => (
              <li key={a.name}>
                <label>
                  <input type="checkbox" checked={chosen.has(a.name)} onChange={(e) => setAll([a.name], e.target.checked)} />
                  <span className="action-text">
                    <span className="action-name">{a.name}</span>
                    <span className={`action-kind ${a.kind}`}>{KIND_WORDS[a.kind]}</span>
                    {a.description && <span className="muted small action-desc">{a.description}</span>}
                  </span>
                </label>
              </li>
            ))}
            {shown.length === 0 && <li className="muted small">No action matches "{query}".</li>}
          </ul>
          <p className="muted small">
            {chosen.size === 0 ? "Tick at least one, or turn the tool off instead." : `${chosen.size} chosen.`}
          </p>
        </div>
      )}

      <div className="modal-actions">
        <button type="button" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={busy || (mode === "chosen" && chosen.size === 0)} onClick={() => void save()}>
          Save
        </button>
      </div>
    </Modal>
  );
}

/** Move a client's tool to "For every client", and optionally remove the same tool from other clients. */
export function MoveToEveryDialog(props: { client: ClientView; conn: ConnectionView; clients: ClientView[]; onClose: () => void; run: Run }) {
  const { client, conn } = props;
  const others = sameToolIn(props.clients, conn, client.id);
  const [remove, setRemove] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const key = (x: { client: ClientView; conn: ConnectionView }) => `${x.client.id}/${x.conn.id}`;

  async function move() {
    setBusy(true);
    const done = await props.run(api.moveConnection(client.id, conn.id, EVERY_CLIENT_ID));
    if (done) {
      for (const x of others.filter((o) => remove.has(key(o)))) await props.run(api.removeConnection(x.client.id, x.conn.id));
      props.onClose();
    }
    setBusy(false);
  }

  return (
    <Modal title={`Use ${conn.name} for every client?`} onClose={props.onClose}>
      <p>
        {conn.name} moves out of {client.name}, keys included, and every client gets it, whichever one is active.
      </p>
      <p className="muted small">
        Only do this for a tool that isn't {client.name}'s own account, like a browser helper or web search. What each client allows
        ("What the AI may do") applies to it too.
      </p>
      {others.length > 0 && (
        <fieldset className="choice">
          <legend>The same tool is also in:</legend>
          {others.map((o) => (
            <label key={key(o)}>
              <input
                type="checkbox"
                checked={remove.has(key(o))}
                onChange={(e) =>
                  setRemove((r) => {
                    const next = new Set(r);
                    if (e.target.checked) next.add(key(o));
                    else next.delete(key(o));
                    return next;
                  })
                }
              />{" "}
              Remove {o.conn.name} from {o.client.name}
              <span className="hint"> Its saved keys are deleted too.</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="modal-actions">
        <button type="button" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void move()}>
          Use for every client
        </button>
      </div>
    </Modal>
  );
}

/** Move a tool from "For every client" to one client. */
export function MoveToClientDialog(props: { conn: ConnectionView; clients: ClientView[]; onClose: () => void; run: Run }) {
  const [toId, setToId] = useState(props.clients.find((c) => c.active)?.id ?? props.clients[0]?.id ?? "");
  const to = props.clients.find((c) => c.id === toId);
  return (
    <Modal title={`Move ${props.conn.name} to one client`} onClose={props.onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await props.run(api.moveConnection(EVERY_CLIENT_ID, props.conn.id, toId))) props.onClose();
        }}
      >
        <p className="muted small">It moves with its keys. The other clients don't get it anymore.</p>
        <label className="field">
          <span>Move to</span>
          <select value={toId} onChange={(e) => setToId(e.target.value)}>
            {props.clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="modal-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!toId}>
            Move to {to?.name ?? "client"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** A small menu of less-used actions on a tool. */
export function MoreMenu(props: { label: string; items: Array<{ label: string; onClick: () => void; danger?: boolean; hidden?: boolean }> }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest(".more-menu")) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const items = props.items.filter((i) => !i.hidden);
  return (
    <div className="more-menu">
      <button aria-haspopup="menu" aria-expanded={open} aria-label={props.label} onClick={() => setOpen((o) => !o)}>
        More…
      </button>
      {open && (
        <ul className="menu" role="menu">
          {items.map((i) => (
            <li key={i.label} role="none">
              <button
                role="menuitem"
                className={i.danger ? "danger-text" : ""}
                onClick={() => {
                  setOpen(false);
                  i.onClick();
                }}
              >
                {i.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

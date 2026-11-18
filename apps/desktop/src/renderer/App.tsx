import { useEffect, useMemo, useState } from "react";
import logo from "./assets/logo.png";
import { AppsSection, FoundBanner, Setup } from "./Setup";
import { AddFromCatalog, SignIn } from "./Catalog";
import { CLIENT_SEARCH_FROM, matchesWords } from "./search";
import { Help } from "./Help";
import { restoreBody } from "./restore-text";
import type { AppState, ClientView, ConnectionInput, ConnectionView, HostView, RingkeeperApi, Result } from "../shared/api";

declare global {
  interface Window {
    ringkeeper: RingkeeperApi;
  }
}
const api = window.ringkeeper;

// Same rule as the main process uses (packages/gateway/src/store/client-store.ts).
const looksSecret = (n: string) => /key|token|secret|password|passwd|auth|credential|bearer|cookie|session/i.test(n);

const STATUS: Record<string, { word: string; tone: "ok" | "muted" | "warn" | "bad" }> = {
  ready: { word: "Ready", tone: "ok" },
  idle: { word: "Starts when needed", tone: "muted" },
  starting: { word: "Starting…", tone: "muted" },
  stopped: { word: "Stopped", tone: "muted" },
  needs_key: { word: "Needs a key", tone: "warn" },
  needs_signin: { word: "Needs sign-in", tone: "warn" },
  error: { word: "Not working", tone: "bad" },
};

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  // Setup stays on screen until the user leaves it, even after it marks itself done.
  const [showSetup, setShowSetup] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [clientQuery, setClientQuery] = useState("");
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    void api.getState().then((s) => {
      setState(s);
      if (!s.setupDone) setShowSetup(true);
      // First run with only an empty client: offer to bring in what the AI apps already use (once).
      else if (s.clients.length === 1 && s.clients[0]!.connections.length === 0 && !s.settings.bringInOffered) {
        setShowSetup(true);
        void api.updateSettings({ bringInOffered: true });
      }
    });
    return api.onStateChanged(setState);
  }, []);

  const clients = state?.clients ?? [];
  const selected = clients.find((c) => c.id === selectedId) ?? clients.find((c) => c.active) ?? clients[0];
  // A search box once the list is long; a short list needs none.
  const searchable = clients.length >= CLIENT_SEARCH_FROM;
  const query = searchable ? clientQuery.trim() : "";
  const shownClients = clients.filter((c) => matchesWords(c.name, query));

  /** Run an action; show its plain-language error if it fails. */
  async function run<T>(p: Promise<Result<T>>): Promise<Done<T> | null> {
    const r = await p;
    if (!r.ok) {
      setError(r.error);
      return null;
    }
    setError(null);
    setState(await api.getState());
    return { value: r.value };
  }

  if (!state) return <div className="loading">Loading…</div>;

  if (showSetup) {
    return (
      <div className="setup-page">
        {error && (
          <div className="banner" role="alert">
            <span>{error}</span>
            <button className="link" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}
        <Setup
          clients={clients}
          hosts={state.hosts}
          run={run}
          onDone={() => {
            setShowSetup(false);
            void api.getState().then(setState);
          }}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src={logo} alt="" width={24} height={24} />
          Ringkeeper Connect
        </div>
        <div className="sidebar-label">Clients</div>
        {searchable && (
          <input
            className="client-search"
            type="search"
            placeholder="Search clients"
            aria-label="Search clients"
            value={clientQuery}
            onChange={(e) => setClientQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shownClients[0]) setSelectedId(shownClients[0].id);
              if (e.key === "Escape") setClientQuery("");
            }}
          />
        )}
        <ul className={`client-list ${searchable ? "long" : ""}`}>
          {shownClients.map((c) => (
            <li key={c.id}>
              <button className={`client-item ${selected?.id === c.id ? "selected" : ""}`} onClick={() => setSelectedId(c.id)}>
                <span className="client-name">{c.name}</span>
                {c.active && <span className="badge">Active</span>}
              </button>
            </li>
          ))}
          {shownClients.length === 0 && <li className="muted small no-match">No client matches "{query}".</li>}
        </ul>
        <button className="add-client" onClick={() => setDialog({ kind: "add-client" })}>
          + Add client
        </button>
        <AppsSection
          state={state}
          run={run}
          onSetup={() => setShowSetup(true)}
          onRestore={() => setDialog({ kind: "restore" })}
          onHelp={() => setShowHelp(true)}
          onHint={setHint}
        />
        <label className="setting">
          <input
            type="checkbox"
            checked={state.settings.requireClientArg}
            onChange={(e) => void run(api.updateSettings({ requireClientArg: e.target.checked }))}
          />
          <span>Ask AI apps to name the client on every action (recommended)</span>
        </label>
        {state.packaged && (
          <label className="setting tight">
            <input type="checkbox" checked={state.settings.startAtLogin} onChange={(e) => void run(api.updateSettings({ startAtLogin: e.target.checked }))} />
            <span>Start when I log in, so AI apps can always reach my clients</span>
          </label>
        )}
        <div className="version">Version {state.version}</div>
      </aside>

      <main className="main">
        {error && (
          <div className="banner" role="alert">
            <span>{error}</span>
            <button className="link" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {hint && (
          <div className="banner info" role="status">
            <span>{hint}</span>
            <button className="link" onClick={() => setHint(null)}>
              OK
            </button>
          </div>
        )}
        {state.updateReady && (
          <div className="banner info" role="status">
            <span>Version {state.updateReady} is ready. It installs the next time Ringkeeper Connect restarts.</span>
            <button className="link" onClick={() => void run(api.restartToUpdate())}>
              Restart now
            </button>
          </div>
        )}
        <FoundBanner state={state} run={run} />

        {!selected ? (
          <Empty onAdd={() => setDialog({ kind: "add-client" })} />
        ) : (
          <ClientPanel
            client={selected}
            clients={clients}
            statuses={state.statuses}
            onActivate={() => void run(api.setActiveClient(selected.id))}
            onRename={() => setDialog({ kind: "rename-client", client: selected })}
            onDelete={() => setDialog({ kind: "delete-client", client: selected })}
            onAddConnection={() => setDialog({ kind: "add", client: selected })}
            onAddTool={(toolId) => setDialog({ kind: "add", client: selected, toolId })}
            pendingTools={(state.settings.pendingTools ?? []).filter((p) => p.clientId === selected.id).map((p) => p.toolId)}
            run={run}
            onBringIn={() => setShowSetup(true)}
            onSignIn={(conn) => setDialog({ kind: "signin", client: selected, conn })}
            onEditConnection={(conn) => setDialog({ kind: "connection", client: selected, conn })}
            onCopyConnection={(conn) => setDialog({ kind: "copy", client: selected, conn })}
            onRemoveConnection={(conn) => setDialog({ kind: "remove-connection", client: selected, conn })}
          />
        )}
      </main>

      {showHelp && <Help hosts={state.hosts} onClose={() => setShowHelp(false)} />}
      {dialog && (
        <Dialogs
          dialog={dialog}
          clients={clients}
          hosts={state.hosts}
          close={() => setDialog(null)}
          run={run}
          onClientAdded={(id) => setSelectedId(id)}
          onHint={setHint}
          onAdvanced={(client) => setDialog({ kind: "connection", client })}
        />
      )}
    </div>
  );
}

function Empty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="empty">
      <h1>Add your first client</h1>
      <p>
        A client is one of the businesses you work for. Give each client its own connections (their n8n, their Airtable, …) once, and
        Claude, Cursor and Claude Code will always use the right ones.
      </p>
      <button className="primary" onClick={onAdd}>
        Add client
      </button>
    </div>
  );
}

function ClientPanel(props: {
  client: ClientView;
  clients: ClientView[];
  statuses: AppState["statuses"];
  onActivate: () => void;
  onRename: () => void;
  onDelete: () => void;
  onAddConnection: () => void;
  onEditConnection: (c: ConnectionView) => void;
  onCopyConnection: (c: ConnectionView) => void;
  onRemoveConnection: (c: ConnectionView) => void;
  onSignIn: (c: ConnectionView) => void;
  onBringIn: () => void;
  /** Tools picked in the wizard that still need a sign-in or key. */
  pendingTools: string[];
  onAddTool: (toolId: string) => void;
  run: Run;
}) {
  const { client } = props;
  const [toolNames, setToolNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!props.pendingTools.length) return;
    void props.run(api.catalogServices()).then((r) => r && setToolNames(Object.fromEntries(r.value.map((s) => [s.id, s.name]))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pendingTools.join(",")]);
  return (
    <section>
      <header className="client-header">
        <div>
          <h1>{client.name}</h1>
          {client.active ? (
            <p className="active-note">AI apps are working on {client.name} right now, in every chat.</p>
          ) : (
            <p className="muted">Not active. AI apps can't use {client.name}'s connections until you switch to it.</p>
          )}
        </div>
        <div className="header-actions">
          {!client.active && (
            <button className="primary" onClick={props.onActivate}>
              Switch to {client.name}
            </button>
          )}
          <button onClick={props.onRename}>Rename</button>
          <button className="danger-quiet" onClick={props.onDelete}>
            Delete
          </button>
        </div>
      </header>

      {props.pendingTools.length > 0 && (
        <div className="notice info pending-tools">
          <strong>Still to add for {client.name}:</strong>
          <ul>
            {props.pendingTools.map((id) => (
              <li key={id}>
                <span>{toolNames[id] ?? id}</span>
                <button className="link" onClick={() => props.onAddTool(id)}>
                  Add
                </button>
                <button className="link muted" onClick={() => void props.run(api.dismissPendingTool(client.id, id))}>
                  Not needed
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="section-title">
        <h2>Tools for {client.name}</h2>
        {client.connections.length > 0 && <button onClick={props.onAddConnection}>+ Add a tool</button>}
      </div>

      {client.connections.length === 0 ? (
        <div className="empty">
          <p className="muted">
            {client.name} has no tools yet. Bring in the ones you already use, or add one.
          </p>
          <div className="empty-actions">
            <button className="primary" onClick={props.onBringIn}>
              Bring in the ones you already use
            </button>
            <button onClick={props.onAddConnection}>Add one</button>
          </div>
        </div>
      ) : (
        <ul className="connections">
          {client.connections.map((conn) => {
            const s = props.statuses.find((x) => x.clientId === client.id && x.connectionId === conn.id);
            const notSignedIn = conn.kind === "remote" && conn.auth === "oauth" && !conn.signedIn;
            const status = STATUS[conn.missingKeys.length ? "needs_key" : notSignedIn ? "needs_signin" : (s?.status ?? "idle")] ?? STATUS.idle!;
            // Inside the app, say what to do here rather than repeating "in Ringkeeper Connect".
            const problem = conn.missingKeys.length
              ? `Add ${conn.missingKeys.join(" and ")} with Edit to use it.`
              : notSignedIn || s?.status === "needs_signin"
                ? `Sign in with ${client.name}'s account to use it.`
                : s?.problem;
            return (
              <li key={conn.id} className="connection">
                <div className="connection-main">
                  <div className="connection-name">{conn.name}</div>
                  <div className="connection-where" title={conn.kind === "remote" ? conn.url : undefined}>
                    {conn.kind === "remote" ? conn.url : "Program on this computer"}
                  </div>
                  {problem && status.tone !== "ok" && <div className={`problem ${status.tone}`}>{problem}</div>}
                </div>
                <span className={`status ${status.tone}`}>{status.word}</span>
                <div className="connection-actions">
                  {conn.kind === "remote" && conn.auth === "oauth" && (s?.status === "needs_signin" || !conn.signedIn) && (
                    <button className="primary" onClick={() => props.onSignIn(conn)}>
                      Sign in
                    </button>
                  )}
                  <button onClick={() => props.onEditConnection(conn)}>Edit</button>
                  {props.clients.length > 1 && <button onClick={() => props.onCopyConnection(conn)}>Copy to…</button>}
                  <button className="danger-quiet" onClick={() => props.onRemoveConnection(conn)}>
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------- dialogs ----------

/** Returned by run() on success, so even actions without a result can be told apart from failures. */
type Done<T> = { value: T };
type Run = <T>(p: Promise<Result<T>>) => Promise<Done<T> | null>;

type DialogState =
  | { kind: "add-client" }
  | { kind: "rename-client"; client: ClientView }
  | { kind: "delete-client"; client: ClientView }
  | { kind: "connection"; client: ClientView; conn?: ConnectionView }
  | { kind: "copy"; client: ClientView; conn: ConnectionView }
  | { kind: "remove-connection"; client: ClientView; conn: ConnectionView }
  | { kind: "restore" }
  | { kind: "add"; client: ClientView; toolId?: string }
  | { kind: "signin"; client: ClientView; conn: ConnectionView };

function Dialogs(props: {
  dialog: DialogState;
  clients: ClientView[];
  hosts: HostView[];
  close: () => void;
  run: Run;
  onClientAdded: (id: string) => void;
  onHint: (text: string) => void;
  onAdvanced: (client: ClientView) => void;
}) {
  const { dialog, close, run } = props;
  switch (dialog.kind) {
    case "add-client":
      return (
        <NameDialog
          title="Add a client"
          label="Client name"
          placeholder="e.g. Acme"
          confirm="Add client"
          onClose={close}
          onSubmit={async (name) => {
            const c = await run(api.addClient(name));
            if (c) {
              props.onClientAdded(c.value.id);
              close();
            }
          }}
        />
      );
    case "rename-client":
      return (
        <NameDialog
          title={`Rename ${dialog.client.name}`}
          label="New name"
          initial={dialog.client.name}
          confirm="Rename"
          onClose={close}
          onSubmit={async (name) => {
            if (await run(api.renameClient(dialog.client.id, name))) close();
          }}
        />
      );
    case "delete-client":
      return (
        <Confirm
          title={`Delete ${dialog.client.name}?`}
          body={`This removes ${dialog.client.name} and its ${dialog.client.connections.length} connection(s), including their saved keys. It can't be undone.`}
          confirm={`Delete ${dialog.client.name}`}
          danger
          onClose={close}
          onConfirm={async () => {
            if (await run(api.removeClient(dialog.client.id))) close();
          }}
        />
      );
    case "remove-connection":
      return (
        <Confirm
          title={`Remove ${dialog.conn.name} from ${dialog.client.name}?`}
          body="Its saved keys are deleted too. It can't be undone."
          confirm="Remove"
          danger
          onClose={close}
          onConfirm={async () => {
            if (await run(api.removeConnection(dialog.client.id, dialog.conn.id))) close();
          }}
        />
      );
    case "add":
      return (
        <AddFromCatalog
          client={dialog.client}
          initialToolId={dialog.toolId}
          run={run}
          onClose={close}
          onAdvanced={() => props.onAdvanced(dialog.client)}
        />
      );
    case "signin":
      return <SignIn client={dialog.client} connectionId={dialog.conn.id} name={dialog.conn.name} run={run} onClose={close} />;
    case "restore":
      return (
        <Confirm
          title="Restore your AI apps' original settings?"
          body={restoreBody(props.hosts)}
          confirm="Restore"
          danger
          onClose={close}
          onConfirm={async () => {
            const r = await run(api.restoreApps());
            if (r) {
              props.onHint(
                r.value.problems.length
                  ? r.value.problems.join(" ")
                  : r.value.restored.length
                    ? `Restored ${r.value.restored.join(", ")}. Restart them to finish.`
                    : "There was nothing to restore.",
              );
              close();
            }
          }}
        />
      );
    case "connection":
      return <ConnectionDialog client={dialog.client} conn={dialog.conn} onClose={close} run={run} />;
    case "copy":
      return <CopyDialog from={dialog.client} conn={dialog.conn} clients={props.clients} onClose={close} run={run} />;
  }
}

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

function NameDialog(props: {
  title: string;
  label: string;
  confirm: string;
  placeholder?: string;
  initial?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(props.initial ?? "");
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void props.onSubmit(name);
        }}
      >
        <label className="field">
          <span>{props.label}</span>
          <input autoFocus value={name} placeholder={props.placeholder} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!name.trim()}>
            {props.confirm}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Confirm(props: { title: string; body: string; confirm: string; danger?: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <p>{props.body}</p>
      <div className="modal-actions">
        <button onClick={props.onClose}>Cancel</button>
        <button className={props.danger ? "danger" : "primary"} onClick={() => void props.onConfirm()}>
          {props.confirm}
        </button>
      </div>
    </Modal>
  );
}

interface FieldRow {
  name: string;
  value: string;
  secret: boolean;
  /** A saved secret we don't show; empty value means "keep it". */
  saved: boolean;
  /** The user ticked or unticked "Keep secret" themselves; stop guessing. */
  chosen: boolean;
}

function ConnectionDialog(props: {
  client: ClientView;
  conn?: ConnectionView;
  onClose: () => void;
  run: Run;
}) {
  const { client, conn } = props;
  const [name, setName] = useState(conn?.name ?? "");
  const [kind, setKind] = useState<"local" | "remote">(conn?.kind ?? "remote");
  const [url, setUrl] = useState(conn?.kind === "remote" ? conn.url : "");
  const [command, setCommand] = useState(conn?.kind === "local" ? conn.command : "");
  const [args, setArgs] = useState(conn?.kind === "local" ? conn.args.join("\n") : "");
  const [rows, setRows] = useState<FieldRow[]>(
    conn?.fields.map((f) => ({ name: f.name, value: f.value ?? "", secret: f.secret, saved: f.secret && f.isSet, chosen: true })) ?? [],
  );

  const update = (i: number, patch: Partial<FieldRow>) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  async function save() {
    const fields = rows
      .filter((r) => r.name.trim())
      .map((r) => ({ name: r.name.trim(), secret: r.secret, value: r.secret && r.saved && r.value === "" ? undefined : r.value }));
    const input: ConnectionInput =
      kind === "remote"
        ? { kind, name, url, fields }
        : { kind, name, command, args: args.split("\n").map((a) => a.trim()).filter(Boolean), fields };
    const done = await props.run(conn ? api.updateConnection(client.id, conn.id, input) : api.addConnection(client.id, input));
    if (done) props.onClose();
  }

  return (
    <Modal title={conn ? `Edit ${conn.name} for ${client.name}` : `Add a tool for ${client.name}`} onClose={props.onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} placeholder="e.g. n8n" onChange={(e) => setName(e.target.value)} />
        </label>

        <fieldset className="choice">
          <legend>How do you connect to it?</legend>
          <label>
            <input type="radio" checked={kind === "remote"} onChange={() => setKind("remote")} /> With a web address the service gave you
          </label>
          <label>
            <input type="radio" checked={kind === "local"} onChange={() => setKind("local")} /> With a program on this computer (advanced)
          </label>
        </fieldset>

        {kind === "remote" ? (
          <label className="field">
            <span>Web address</span>
            <input value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />
          </label>
        ) : (
          <>
            <label className="field">
              <span>Program</span>
              <input value={command} placeholder="e.g. npx" onChange={(e) => setCommand(e.target.value)} />
            </label>
            <label className="field">
              <span>Program options, one per line</span>
              <textarea rows={3} value={args} onChange={(e) => setArgs(e.target.value)} />
            </label>
          </>
        )}

        <div className="fields-head">
          <span>{kind === "remote" ? "Keys and other settings sent with each request" : "Keys and other settings"}</span>
          <button type="button" className="link" onClick={() => setRows((r) => [...r, { name: "", value: "", secret: true, saved: false, chosen: false }])}>
            + Add
          </button>
        </div>
        {rows.length === 0 && <p className="muted small">Most services need at least one key. Add it here using {client.name}'s own account.</p>}
        {rows.map((row, i) => (
          <div className="field-row" key={i}>
            <input
              className="field-name"
              placeholder={kind === "remote" ? "e.g. Authorization" : "e.g. N8N_API_KEY"}
              value={row.name}
              onChange={(e) => update(i, { name: e.target.value, ...(row.chosen ? {} : { secret: e.target.value === "" || looksSecret(e.target.value) }) })}
            />
            <input
              className="field-value"
              type={row.secret ? "password" : "text"}
              placeholder={row.saved ? "Saved. Type to replace" : "Value"}
              value={row.value}
              onChange={(e) => update(i, { value: e.target.value })}
            />
            <label className="secret-toggle" title="Keys are stored encrypted and never shown again">
              <input type="checkbox" checked={row.secret} onChange={(e) => update(i, { secret: e.target.checked, chosen: true })} /> Keep secret
            </label>
            <button type="button" className="link danger-text" onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}

        <div className="modal-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!name.trim()}>
            {conn ? "Save" : "Add tool"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CopyDialog(props: {
  from: ClientView;
  conn: ConnectionView;
  clients: ClientView[];
  onClose: () => void;
  run: Run;
}) {
  const targets = useMemo(() => props.clients.filter((c) => c.id !== props.from.id), [props.clients, props.from.id]);
  const [toId, setToId] = useState(targets[0]?.id ?? "");
  const secretFields = props.conn.fields.filter((f) => f.secret);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const to = targets.find((c) => c.id === toId);

  return (
    <Modal title={`Copy ${props.conn.name} to another client`} onClose={props.onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const done = await props.run(api.cloneConnection(props.from.id, props.conn.id, toId, keys));
          if (done) props.onClose();
        }}
      >
        <label className="field">
          <span>Copy to</span>
          <select value={toId} onChange={(e) => setToId(e.target.value)}>
            {targets.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {secretFields.length > 0 && (
          <>
            <p className="small">
              Settings are copied. Keys are not: {to?.name ?? "the other client"} needs its own. You can also add them later.
            </p>
            {secretFields.map((f) => (
              <label className="field" key={f.name}>
                <span>
                  {to?.name ?? "New"}'s {f.name}
                </span>
                <input type="password" value={keys[f.name] ?? ""} onChange={(e) => setKeys((k) => ({ ...k, [f.name]: e.target.value }))} />
              </label>
            ))}
          </>
        )}
        <div className="modal-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!toId}>
            Copy to {to?.name ?? "client"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

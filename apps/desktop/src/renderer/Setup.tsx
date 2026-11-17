import { useEffect, useState } from "react";
import type { AppState, ClientView, HostView, ImportScan, Result, SetupOutcome } from "../shared/api";

type Run = <T>(p: Promise<Result<T>>) => Promise<{ value: T } | null>;

/** How an AI app's status reads to people. "Connected" only once the app has really contacted us. */
export function appStatusText(h: Pick<HostView, "id" | "label" | "status">): { word: string; tone: "ok" | "warn" | "bad" | "muted" } {
  switch (h.status) {
    case "connected":
      return { word: "Connected", tone: "ok" };
    case "added":
      return { word: h.id === "claude-code" ? "Added, start a new session to finish" : `Added, restart ${h.label} to finish`, tone: "warn" };
    case "not_seeing":
      return { word: "Not seeing us yet", tone: "bad" };
    case "missing":
      return { word: "Entry missing", tone: "bad" };
    case "unreadable":
      return { word: "Can't read its settings", tone: "bad" };
    case "not_installed":
      return { word: "Not installed", tone: "muted" };
    default:
      return { word: "Not connected", tone: "muted" };
  }
}

const SETUP_LIST_WORD: Partial<Record<HostView["status"], string>> = { not_connected: "Found" };

/** First-run setup: bring the apps' existing connections into a client and connect the apps. */
export function Setup(props: { clients: ClientView[]; hosts: HostView[]; run: Run; onDone: () => void }) {
  const { run } = props;
  const [scan, setScan] = useState<ImportScan | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string>(props.clients[0]?.id ?? "new");
  const [newName, setNewName] = useState("Default");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SetupOutcome | null>(null);

  useEffect(() => {
    void run(window.ringkeeper.scanApps()).then((r) => {
      if (!r) return;
      setScan(r.value);
      setChecked(new Set(r.value.candidates.filter((c) => !c.problem).map((c) => c.key)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (outcome) return <SetupDone outcome={outcome} hosts={props.hosts} onDone={props.onDone} />;
  if (!scan) return <div className="setup"><p className="muted">Looking for your AI apps…</p></div>;

  const installed = scan.hosts.filter((h) => h.status !== "not_installed");
  const usable = scan.candidates.filter((c) => !c.problem);
  const toggle = (key: string) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  async function connect() {
    setBusy(true);
    const client = target === "new" ? { newName: newName.trim() || "Default" } : { id: target };
    const r = await run(window.ringkeeper.runSetup({ client, take: [...checked] }));
    setBusy(false);
    if (r) setOutcome(r.value);
  }

  return (
    <div className="setup">
      <h1>Connect your AI apps</h1>
      <p className="lead">
        Ringkeeper Connect sits between your AI apps and your clients' tools, so each app needs just one connection: Ringkeeper Connect.
      </p>

      <h2>Your AI apps</h2>
      <ul className="host-list">
        {scan.hosts.map((h) => (
          <li key={h.id} className={`host ${h.status}`}>
            <span className="host-name">{h.label}</span>
            <span className={`status ${appStatusText(h).tone}`}>{SETUP_LIST_WORD[h.status] ?? appStatusText(h).word}</span>
            {h.problem && <div className="problem bad">{h.problem} Ringkeeper Connect won't change it.</div>}
          </li>
        ))}
      </ul>
      {installed.length === 0 && (
        <p className="muted">None of Claude Desktop, Cursor or Claude Code is installed yet. Install one, then choose "Connect" next to it in Ringkeeper Connect.</p>
      )}

      {installed.length > 0 && (
        <>
          <h2>Tools already in those apps</h2>
          {scan.candidates.length === 0 ? (
            <p className="muted">There's nothing to bring in. You'll add each client's connections in Ringkeeper Connect.</p>
          ) : (
            <>
              <p className="muted small">Ticked connections move into Ringkeeper Connect, so your AI apps reach them through it. Unticked ones stay where they are.</p>
              <ul className="candidates">
                {scan.candidates.map((c) => (
                  <li key={c.key} className={c.problem ? "disabled" : ""}>
                    <label>
                      <input type="checkbox" disabled={!!c.problem} checked={checked.has(c.key)} onChange={() => toggle(c.key)} />
                      <span className="cand-name">{c.name}</span>
                      {c.service && <span className="badge">{c.service}</span>}
                      <span className="muted small">in {c.from.join(" and ")}</span>
                    </label>
                    {c.problem && <div className="problem warn">{c.problem}</div>}
                    {c.warnings.map((w) => (
                      <div key={w} className="problem warn">
                        {w}
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
              {usable.length > 0 && checked.size > 0 && (
                <div className="target">
                  <label className="field">
                    <span>Put them in this client</span>
                    <select value={target} onChange={(e) => setTarget(e.target.value)}>
                      {props.clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                      <option value="new">A new client…</option>
                    </select>
                  </label>
                  {target === "new" && (
                    <label className="field">
                      <span>New client's name</span>
                      <input value={newName} onChange={(e) => setNewName(e.target.value)} />
                    </label>
                  )}
                  <p className="muted small">You can move connections to other clients later with "Copy to…".</p>
                </div>
              )}
            </>
          )}
          <p className="muted small">
            Ringkeeper Connect keeps a backup of each app's settings before changing them. "Restore original settings" undoes everything.
          </p>
        </>
      )}

      <div className="setup-actions">
        <button
          onClick={async () => {
            if (await run(window.ringkeeper.skipSetup())) props.onDone();
          }}
        >
          Not now
        </button>
        {installed.some((h) => h.status !== "unreadable") && (
          <button className="primary" disabled={busy} onClick={() => void connect()}>
            {busy ? "Connecting…" : "Connect apps"}
          </button>
        )}
      </div>
    </div>
  );
}

function SetupDone(props: { outcome: SetupOutcome; hosts: HostView[]; onDone: () => void }) {
  const { outcome } = props;
  // Live: each app turns to Connected when it actually contacts Ringkeeper.
  const apps = props.hosts.filter((h) => ["added", "connected", "not_seeing", "missing"].includes(h.status));
  const allConnected = apps.length > 0 && apps.every((h) => h.status === "connected");
  return (
    <div className="setup">
      <h1>{outcome.problems.length ? "Almost done" : allConnected ? "Your AI apps are connected" : "Almost done: restart your AI apps"}</h1>
      {outcome.imported.length > 0 && <p className="lead">Brought in: {outcome.imported.join(", ")}.</p>}
      {outcome.problems.length > 0 && (
        <div className="notice bad">
          {outcome.problems.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      )}
      {apps.length > 0 && (
        <>
          <h2>To finish</h2>
          <ul className="steps">
            {apps.map((h) => {
              const s = appStatusText(h);
              const hint = outcome.restart.find((r) => r.startsWith(h.label));
              return (
                <li key={h.id} className="finish-row">
                  <span className={`status ${s.tone}`}>{s.word}</span>
                  {h.status !== "connected" && hint && <span>{hint}</span>}
                </li>
              );
            })}
          </ul>
          <p className="muted small">This updates by itself as each app starts using Ringkeeper Connect.</p>
        </>
      )}
      {outcome.overlaps.length > 0 && (
        <>
          <h2>One more thing</h2>
          {outcome.overlaps.map((o) => (
            <div key={o} className="notice warn">
              {o}
            </div>
          ))}
        </>
      )}
      <div className="setup-actions">
        <button className="primary" onClick={props.onDone}>
          Go to my clients
        </button>
      </div>
    </div>
  );
}

/** Sidebar section: whether each AI app really uses Ringkeeper, plus set up again and Restore. */
export function AppsSection(props: { state: AppState; run: Run; onSetup: () => void; onRestore: () => void; onHint: (text: string) => void }) {
  const apps = props.state.hosts.filter((h) => h.status !== "not_installed");
  const [checking, setChecking] = useState<HostView | null>(null);
  return (
    <div className="apps-section">
      <div className="sidebar-label">AI apps</div>
      {apps.length === 0 && <p className="muted small pad">No AI apps found on this computer.</p>}
      <ul className="apps">
        {apps.map((h) => {
          const s = appStatusText(h);
          return (
            <li key={h.id} title={h.problem ?? h.note}>
              <div className="app-row">
                <span>{h.label}</span>
                {h.status === "not_connected" && (
                  <button
                    className="link"
                    onClick={async () => {
                      const r = await props.run(window.ringkeeper.connectApp(h.id));
                      if (r) props.onHint(`${h.label}: Ringkeeper Connect was added. ${r.value.join(" ")}`);
                    }}
                  >
                    Connect
                  </button>
                )}
                {h.status === "missing" && (
                  <button className="link" onClick={() => void props.run(window.ringkeeper.fixApp(h.id))}>
                    Fix
                  </button>
                )}
              </div>
              {h.status !== "not_connected" && <span className={`dot ${s.tone}`}>{s.word}</span>}
              {(h.status === "added" || h.status === "not_seeing" || h.status === "missing") && (
                <button className="link small left" onClick={() => setChecking(h)}>
                  Show me how to check
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {checking && <HowToCheck host={props.state.hosts.find((h) => h.id === checking.id) ?? checking} run={props.run} onClose={() => setChecking(null)} />}
      <button className="link small" onClick={props.onSetup}>
        Bring in connections from apps…
      </button>
      <button className="link small danger-text" onClick={props.onRestore}>
        Restore original settings…
      </button>
    </div>
  );
}

/** "New connection found" prompts. */
export function FoundBanner(props: { state: AppState; run: Run }) {
  const [targets, setTargets] = useState<Record<string, string>>({});
  if (!props.state.found.length || !props.state.clients.length) return null;
  const active = props.state.clients.find((c) => c.active)?.id ?? props.state.clients[0]!.id;
  return (
    <>
      {props.state.found.map((f) => {
        const key = `${f.host}:${f.name}`;
        const target = targets[key] ?? active;
        return (
          <div key={key} className="found">
            <span>
              New connection <strong>{f.name}</strong> found in {f.hostLabel}. Add it to
            </span>
            <select value={target} onChange={(e) => setTargets((t) => ({ ...t, [key]: e.target.value }))}>
              {props.state.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className="primary" onClick={() => void props.run(window.ringkeeper.moveFound(f.host, f.name, target))}>
              Add
            </button>
            <button onClick={() => void props.run(window.ringkeeper.leaveFound(f.host, f.name))}>Leave it in {f.hostLabel}</button>
          </div>
        );
      })}
    </>
  );
}

/** Plain steps to check an AI app really uses Ringkeeper, with the status updating live. */
function HowToCheck(props: { host: HostView; run: Run; onClose: () => void }) {
  const { host } = props;
  const s = appStatusText(host);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <h2>Check that {host.label} uses Ringkeeper Connect</h2>
        <p>
          Right now: <span className={`status ${s.tone}`}>{s.word}</span>
        </p>
        <ol className="how-to">
          {host.howToCheck.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {host.note && <p className="muted small">{host.note}</p>}
        <div className="modal-actions">
          <button onClick={() => void props.run(window.ringkeeper.showAppSettingsFile(host.id))}>Show the settings file</button>
          {host.status === "missing" && (
            <button onClick={() => void props.run(window.ringkeeper.fixApp(host.id))}>Fix</button>
          )}
          <button className="primary" onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

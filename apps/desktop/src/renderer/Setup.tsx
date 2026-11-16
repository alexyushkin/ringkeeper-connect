import { useEffect, useState } from "react";
import type { AppState, ClientView, ImportScan, Result, SetupOutcome } from "../shared/api";

type Run = <T>(p: Promise<Result<T>>) => Promise<{ value: T } | null>;

const HOST_STATUS: Record<string, string> = {
  connected: "Connected",
  not_connected: "Found",
  not_installed: "Not installed",
  unreadable: "Can't read its settings",
};

/** First-run setup: bring the apps' existing connections into a client and connect the apps. */
export function Setup(props: { clients: ClientView[]; run: Run; onDone: () => void }) {
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

  if (outcome) return <SetupDone outcome={outcome} onDone={props.onDone} />;
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
            <span className={`status ${h.status === "unreadable" ? "bad" : h.status === "not_installed" ? "muted" : "ok"}`}>{HOST_STATUS[h.status]}</span>
            {h.problem && <div className="problem bad">{h.problem} Ringkeeper Connect won't change it.</div>}
          </li>
        ))}
      </ul>
      {installed.length === 0 && (
        <p className="muted">None of Claude Desktop, Cursor or Claude Code is installed yet. Install one, then choose "Connect" next to it in Ringkeeper Connect.</p>
      )}

      {installed.length > 0 && (
        <>
          <h2>Connections already in those apps</h2>
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

function SetupDone(props: { outcome: SetupOutcome; onDone: () => void }) {
  const { outcome } = props;
  return (
    <div className="setup">
      <h1>{outcome.problems.length ? "Almost done" : "Your AI apps are connected"}</h1>
      {outcome.imported.length > 0 && <p className="lead">Brought in: {outcome.imported.join(", ")}.</p>}
      {outcome.problems.length > 0 && (
        <div className="notice bad">
          {outcome.problems.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      )}
      {outcome.restart.length > 0 && (
        <>
          <h2>To finish</h2>
          <ul className="steps">
            {outcome.restart.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
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

const APP_STATUS: Record<string, { word: string; tone: string }> = {
  connected: { word: "Connected", tone: "ok" },
  not_connected: { word: "Not connected", tone: "warn" },
  unreadable: { word: "Can't read", tone: "bad" },
};

/** Sidebar section: each AI app's link to Ringkeeper, plus set up again and Restore. */
export function AppsSection(props: { state: AppState; run: Run; onSetup: () => void; onRestore: () => void; onHint: (text: string) => void }) {
  const apps = props.state.hosts.filter((h) => h.status !== "not_installed");
  return (
    <div className="apps-section">
      <div className="sidebar-label">AI apps</div>
      {apps.length === 0 && <p className="muted small pad">No AI apps found on this computer.</p>}
      <ul className="apps">
        {apps.map((h) => (
          <li key={h.id} title={h.problem}>
            <span>{h.label}</span>
            {h.status === "not_connected" ? (
              <button
                className="link"
                onClick={async () => {
                  const r = await props.run(window.ringkeeper.connectApp(h.id));
                  if (r) props.onHint(`${h.label} is connected. ${r.value.join(" ")}`);
                }}
              >
                Connect
              </button>
            ) : (
              <span className={`dot ${APP_STATUS[h.status]?.tone}`}>{APP_STATUS[h.status]?.word}</span>
            )}
          </li>
        ))}
      </ul>
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

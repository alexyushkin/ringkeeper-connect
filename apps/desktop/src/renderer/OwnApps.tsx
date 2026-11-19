import { useEffect, useState } from "react";
import { GOOGLE_APIS, GOOGLE_CONSOLE, type OwnAppView, type Result } from "../shared/api";

type Run = <T>(p: Promise<Result<T>>) => Promise<{ value: T } | null>;
const api = () => window.ringkeeper;

/** Google's limit for an app it hasn't checked, over the app's whole life. */
const ACCOUNT_CAP = 100;
const HOMEPAGE = "https://yushkin.us/ringkeeper-connect";
const PRIVACY = "https://yushkin.us/ringkeeper-connect/privacy";

/**
 * "Your own Google apps": a Google app in the agency's own Google Cloud project, which
 * Google account tools can sign in through instead of Ringkeeper Connect's.
 * The body of a dialog; the caller puts it in one.
 */
export function OwnGoogleApps(props: { run: Run; onDone: () => void; doneLabel?: string }) {
  const [apps, setApps] = useState<OwnAppView[] | null>(null);
  const [editing, setEditing] = useState<OwnAppView | "new" | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  // Shown here, where the user is looking.
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const r = await api().listOwnApps();
    if (r.ok) setApps(r.value);
    else setError(r.error);
  }

  useEffect(() => {
    void reload();
    // The permissions to paste into Google's Data access page: the Google account tool's.
    void api()
      .catalogServices()
      .then((r) => {
        const access = r.ok ? r.value.find((s) => s.id === "google")?.options[0]?.access : undefined;
        if (access) setScopes(["openid", "https://www.googleapis.com/auth/userinfo.email", ...access.map((a) => a.scope)]);
      });
  }, []);

  async function remove(app: OwnAppView) {
    setError(null);
    const r = await api().removeOwnApp(app.id);
    if (!r.ok) setError(r.error);
    await reload();
  }

  if (editing) {
    return (
      <AppForm
        app={editing === "new" ? undefined : editing}
        scopes={scopes}
        run={props.run}
        onDone={() => {
          setEditing(null);
          void reload();
        }}
      />
    );
  }

  return (
    <>
      <h2>Your own Google apps</h2>
      <p className="muted small">
        Google account tools sign in through Ringkeeper Connect's own Google app. Use one in your own Google Cloud project instead when you'll connect more than {ACCOUNT_CAP} Google
        accounts (Google's limit for an app it hasn't checked), when a client's Workspace admin only trusts apps in their own project, or to show your agency's name on Google's
        sign-in page.
      </p>
      {error && (
        <div className="notice bad" role="alert">
          {error}
        </div>
      )}
      {!apps ? (
        <p className="muted">Loading…</p>
      ) : apps.length === 0 ? (
        <p className="muted small">None yet.</p>
      ) : (
        <ul className="own-apps">
          {apps.map((a) => (
            <li key={a.id}>
              <div>
                <strong>{a.name}</strong>
                <div className="hint">{a.clientId}</div>
                <div className="hint">{a.usedBy.length ? `Used by ${a.usedBy.join(", ")}` : "Not used by any tool yet"}</div>
              </div>
              <div className="own-app-actions">
                <button type="button" onClick={() => setEditing(a)}>
                  Edit
                </button>
                <button type="button" onClick={() => void remove(a)} disabled={a.usedBy.length > 0} title={a.usedBy.length ? "Remove the tools that use it first" : undefined}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="modal-actions">
        <button type="button" onClick={() => setEditing("new")}>
          + Add a Google app
        </button>
        <button type="button" className="primary" onClick={props.onDone}>
          {props.doneLabel ?? "Done"}
        </button>
      </div>
    </>
  );
}

function AppForm(props: { app?: OwnAppView; scopes: string[]; run: Run; onDone: () => void }) {
  const editing = props.app;
  const [name, setName] = useState(editing?.name ?? "");
  const [clientId, setClientId] = useState(editing?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inUse = !!editing?.usedBy.length;

  async function save() {
    setBusy(true);
    setError(null);
    const input = { name, clientId, clientSecret: secret };
    const r = editing ? await api().updateOwnApp(editing.id, input) : await api().addOwnApp(input);
    setBusy(false);
    if (r.ok) props.onDone();
    else setError(r.error);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2>{editing ? `Edit ${editing.name}` : "Add your own Google app"}</h2>
      {!editing && <SetupSteps scopes={props.scopes} run={props.run} />}
      <label className="field">
        <span>Name in Ringkeeper Connect</span>
        <input value={name} placeholder="e.g. Our agency's Google app" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Client ID</span>
        <input value={clientId} autoComplete="off" placeholder="…apps.googleusercontent.com" disabled={inUse} onChange={(e) => setClientId(e.target.value)} />
        {inUse && <span className="hint">Tools sign in through this client, so it can't change. Add a new client as another app.</span>}
      </label>
      <label className="field">
        <span>Client secret</span>
        <input type="password" value={secret} autoComplete="off" placeholder={editing ? "Leave empty to keep the saved one" : ""} onChange={(e) => setSecret(e.target.value)} />
        <span className="hint">Kept encrypted on this computer. Ringkeeper Connect checks both with Google before saving.</span>
      </label>
      {error && (
        <div className="notice bad" role="alert">
          {error}
        </div>
      )}
      <div className="modal-actions">
        <button type="button" onClick={props.onDone}>
          Back
        </button>
        <button type="submit" className="primary" disabled={busy || !name.trim() || !clientId.trim() || (!editing && !secret.trim())}>
          {busy ? "Checking with Google…" : "Save"}
        </button>
      </div>
    </form>
  );
}

/** How to create a Google app in a Google Cloud project (Ringkeeper's steps), and what to expect of it. */
function SetupSteps(props: { scopes: string[]; run: Run }) {
  const open = (path: string) => void props.run(api().openLink(`${GOOGLE_CONSOLE}${path}`));
  const Link = (p: { path: string; children: React.ReactNode }) => (
    <button type="button" className="link inline" onClick={() => open(p.path)}>
      {p.children} ↗
    </button>
  );
  return (
    <details className="own-app-steps">
      <summary>How to create one (about 10 minutes, free)</summary>
      <ol className="steps">
        <li>
          Open the <Link path="/projectcreate">Google Cloud console</Link> signed in with your own Google account, and create a project (any name). No billing is needed.
        </li>
        <li>
          Turn on these APIs (each opens its page: click Enable):{" "}
          {GOOGLE_APIS.map(([label, id], i) => (
            <span key={id}>
              {i ? ", " : ""}
              <Link path={`/apis/library/${id}`}>{label}</Link>
            </span>
          ))}
          .
        </li>
        <li>
          Open <Link path="/auth/branding">Branding</Link> and click Get started: an app name (your agency's), your email as support email, Audience: External, your email as
          contact, agree, Create. Then fill in the home page ({HOMEPAGE} or your own), the privacy policy ({PRIVACY} or your own) and the authorized domain of those pages, and
          Save.
        </li>
        <li>
          Open <Link path="/auth/audience">Audience</Link> and click Publish app. Left in "Testing", Google signs every account out after 7 days.
        </li>
        <li>
          Open <Link path="/auth/scopes">Data access</Link>, Add or remove scopes, paste these into "Manually add scopes", Add to table, Update, Save:
          <pre className="scopes">{props.scopes.join("\n")}</pre>
          <button type="button" className="link small left" onClick={() => void navigator.clipboard.writeText(props.scopes.join("\n"))}>
            Copy them
          </button>
        </li>
        <li>
          Open <Link path="/auth/clients">Clients</Link>, Create client: Application type <strong>Desktop app</strong>, any name, Create. Copy the Client ID and the Client secret.
        </li>
        <li>Paste both below.</li>
      </ol>
      <div className="notice info small">
        Your app stays "unverified": each account you sign in sees "Google hasn't verified this app". Click Advanced, then Go to (your app's name). It's your own app, so that's
        expected. Google allows an unverified app up to {ACCOUNT_CAP} accounts over its whole life.
      </div>
    </details>
  );
}

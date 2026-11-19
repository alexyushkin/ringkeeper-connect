import { useEffect, useState } from "react";
import { ENTRA_APP_REGISTRATIONS, GOOGLE_APIS, GOOGLE_CONSOLE, META_APPS, META_RETURN_PAGE, MICROSOFT_RETURN_ADDRESS, type OwnAppView, type Result } from "../shared/api";

type Run = <T>(p: Promise<Result<T>>) => Promise<{ value: T } | null>;
type Vendor = OwnAppView["vendor"];
const api = () => window.ringkeeper;

/** Google's limit for an app it hasn't checked, over the app's whole life. */
const ACCOUNT_CAP = 100;
const HOMEPAGE = "https://yushkin.us/ringkeeper-connect";
const PRIVACY = "https://yushkin.us/ringkeeper-connect/privacy";
const LABEL: Record<Vendor, string> = { google: "Google", microsoft: "Microsoft", meta: "Meta" };
/** What every Microsoft sign-in asks for, before what's ticked. */
const MICROSOFT_ALWAYS = ["openid", "profile", "email", "offline_access", "User.Read"];

/**
 * "Your own apps": an app in the agency's own Google Cloud project, Microsoft Entra
 * directory or Meta for Developers account, which Google, Microsoft 365 and Meta Ads tools
 * sign in through (instead of Ringkeeper Connect's; Meta Ads always needs one). With a vendor, only that one's apps (from "Add a tool").
 * The body of a dialog; the caller puts it in one.
 */
export function OwnApps(props: { run: Run; onDone: () => void; doneLabel?: string; vendor?: Vendor }) {
  const [apps, setApps] = useState<OwnAppView[] | null>(null);
  const [editing, setEditing] = useState<{ vendor: Vendor; app?: OwnAppView } | null>(null);
  const [scopes, setScopes] = useState<Record<Vendor, string[]>>({ google: [], microsoft: [], meta: [] });
  // Shown here, where the user is looking.
  const [error, setError] = useState<string | null>(null);
  const vendors: Vendor[] = props.vendor ? [props.vendor] : ["google", "microsoft", "meta"];

  async function reload() {
    const r = await api().listOwnApps();
    if (r.ok) setApps(r.value);
    else setError(r.error);
  }

  useEffect(() => {
    void reload();
    // The permissions the setup steps list: those of the Google and Microsoft account tools.
    void api()
      .catalogServices()
      .then((r) => {
        if (!r.ok) return;
        const of = (id: string) => (r.value.find((s) => s.id === id)?.options[0]?.access ?? []).flatMap((a) => a.scope.split(/\s+/));
        const google = of("google");
        const microsoft = of("microsoft");
        // Meta Ads' sign-in: its fixed permission and each tick box's.
        const signin = r.value.find((s) => s.id === "meta_ads")?.options.find((o) => o.app === "meta");
        const meta = [...new Set([signin?.scope ?? "", ...(signin?.access ?? []).map((a) => a.scope)].flatMap((x) => x.split(/\s+/)).filter(Boolean))];
        setScopes({
          google: google.length ? ["openid", "https://www.googleapis.com/auth/userinfo.email", ...new Set(google)] : [],
          microsoft: microsoft.length ? [...new Set([...MICROSOFT_ALWAYS, ...microsoft])] : [],
          meta,
        });
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
        vendor={editing.vendor}
        app={editing.app}
        scopes={scopes[editing.vendor]}
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
      <h2>{props.vendor ? `Your own ${LABEL[props.vendor]} apps` : "Your own apps"}</h2>
      {vendors.includes("google") && (
        <p className="muted small">
          Google account tools sign in through Ringkeeper Connect's own Google app. Use one in your own Google Cloud project instead when you'll connect more than {ACCOUNT_CAP}{" "}
          Google accounts (Google's limit for an app it hasn't checked), or to show your agency's name on Google's sign-in page.
        </p>
      )}
      {vendors.includes("microsoft") && (
        <p className="muted small">
          Microsoft 365 tools sign in through Ringkeeper Connect's own Microsoft app. Use one in your own Microsoft Entra directory (or a client's) when a client's IT admin only
          approves apps they know, or to show your agency's name on Microsoft's sign-in page.
        </p>
      )}
      {vendors.includes("meta") && (
        <p className="muted small">
          Meta Ads signs in through a Meta app of your own: Meta lets only the AI apps it approved sign in to its ads server directly.
        </p>
      )}
      {error && (
        <div className="notice bad" role="alert">
          {error}
        </div>
      )}
      {!apps ? (
        <p className="muted">Loading…</p>
      ) : (
        vendors.map((vendor) => {
          const theirs = apps.filter((a) => a.vendor === vendor);
          return (
            <section key={vendor} className="own-apps-group">
              {!props.vendor && <h3>{LABEL[vendor]}</h3>}
              {theirs.length === 0 ? (
                <p className="muted small">None yet.</p>
              ) : (
                <ul className="own-apps">
                  {theirs.map((a) => (
                    <li key={a.id}>
                      <div>
                        <strong>{a.name}</strong>
                        <div className="hint">
                          {a.clientId}
                          {a.tenant && a.tenant !== "common" ? ` (directory ${a.tenant})` : ""}
                        </div>
                        <div className="hint">{a.usedBy.length ? `Used by ${a.usedBy.join(", ")}` : "Not used by any tool yet"}</div>
                      </div>
                      <div className="own-app-actions">
                        <button type="button" onClick={() => setEditing({ vendor, app: a })}>
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void remove(a)}
                          disabled={a.usedBy.length > 0}
                          title={a.usedBy.length ? "Remove the tools that use it first" : undefined}
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="link small left" onClick={() => setEditing({ vendor })}>
                + Add a {LABEL[vendor]} app
              </button>
            </section>
          );
        })
      )}
      <div className="modal-actions">
        <button type="button" className="primary" onClick={props.onDone}>
          {props.doneLabel ?? "Done"}
        </button>
      </div>
    </>
  );
}

function AppForm(props: { vendor: Vendor; app?: OwnAppView; scopes: string[]; run: Run; onDone: () => void }) {
  const editing = props.app;
  const microsoft = props.vendor === "microsoft";
  const meta = props.vendor === "meta";
  const label = LABEL[props.vendor];
  const [name, setName] = useState(editing?.name ?? "");
  const [clientId, setClientId] = useState(editing?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [tenant, setTenant] = useState(editing?.tenant && editing.tenant !== "common" ? editing.tenant : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inUse = !!editing?.usedBy.length;
  const needsSecret = !microsoft && !editing;

  async function save() {
    setBusy(true);
    setError(null);
    const input = microsoft ? { vendor: props.vendor, name, clientId, tenant } : { vendor: props.vendor, name, clientId, clientSecret: secret };
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
      <h2>{editing ? `Edit ${editing.name}` : `Add your own ${label} app`}</h2>
      {!editing &&
        (microsoft ? (
          <MicrosoftSteps scopes={props.scopes} run={props.run} />
        ) : meta ? (
          <MetaSteps scopes={props.scopes} run={props.run} />
        ) : (
          <GoogleSteps scopes={props.scopes} run={props.run} />
        ))}
      <label className="field">
        <span>Name in Ringkeeper Connect</span>
        <input value={name} placeholder={`e.g. Our agency's ${label} app`} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>{microsoft ? "Application (client) ID" : meta ? "App ID" : "Client ID"}</span>
        <input
          value={clientId}
          autoComplete="off"
          placeholder={microsoft ? "1a2b3c4d-…" : meta ? "1234567890123456" : "…apps.googleusercontent.com"}
          disabled={inUse}
          onChange={(e) => setClientId(e.target.value)}
        />
        {inUse && <span className="hint">Tools sign in through this app, so it can't change. Add a new one as another app.</span>}
      </label>
      {microsoft ? (
        <label className="field">
          <span>Directory (tenant) ID (optional)</span>
          <input value={tenant} autoComplete="off" placeholder="Empty: any account" disabled={inUse} onChange={(e) => setTenant(e.target.value)} />
          <span className="hint">
            Leave it empty if the app takes accounts from any organization. If it only takes one organization's accounts, paste the Directory (tenant) ID from its Overview page.
            Ringkeeper Connect checks the app with Microsoft before saving.
          </span>
        </label>
      ) : (
        <label className="field">
          <span>{meta ? "App secret" : "Client secret"}</span>
          <input type="password" value={secret} autoComplete="off" placeholder={editing ? "Leave empty to keep the saved one" : ""} onChange={(e) => setSecret(e.target.value)} />
          <span className="hint">Kept encrypted on this computer. Ringkeeper Connect checks both with {label} before saving.</span>
        </label>
      )}
      {error && (
        <div className="notice bad" role="alert">
          {error}
        </div>
      )}
      <div className="modal-actions">
        <button type="button" onClick={props.onDone}>
          Back
        </button>
        <button type="submit" className="primary" disabled={busy || !name.trim() || !clientId.trim() || (needsSecret && !secret.trim())}>
          {busy ? `Checking with ${label}…` : "Save"}
        </button>
      </div>
    </form>
  );
}

function Scopes(props: { scopes: string[] }) {
  return (
    <>
      <pre className="scopes">{props.scopes.join("\n")}</pre>
      <button type="button" className="link small left" onClick={() => void navigator.clipboard.writeText(props.scopes.join("\n"))}>
        Copy them
      </button>
    </>
  );
}

function Copyable(props: { text: string }) {
  return (
    <>
      <code>{props.text}</code>{" "}
      <button type="button" className="link inline" onClick={() => void navigator.clipboard.writeText(props.text)}>
        Copy
      </button>
    </>
  );
}

/** How to create a Google app in a Google Cloud project (Ringkeeper's steps), and what to expect of it. */
function GoogleSteps(props: { scopes: string[]; run: Run }) {
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
          <Scopes scopes={props.scopes} />
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

/** How to register a Microsoft app in an Entra directory (as Ringkeeper Connect's own is), and what to expect of it. */
function MicrosoftSteps(props: { scopes: string[]; run: Run }) {
  return (
    <details className="own-app-steps">
      <summary>How to create one (about 5 minutes, free)</summary>
      <ol className="steps">
        <li>
          Open{" "}
          <button type="button" className="link inline" onClick={() => void props.run(api().openLink(ENTRA_APP_REGISTRATIONS))}>
            App registrations ↗
          </button>{" "}
          in the Microsoft Entra admin center, signed in with your work Microsoft account, and click New registration. Name: your agency's.
        </li>
        <li>
          Supported account types: the one that takes accounts in <strong>any organization's directory and personal Microsoft accounts</strong>, so each client's account can sign
          in through this one app. (An app for one client's organization only: choose that organization's directory, and paste its Directory (tenant) ID below.)
        </li>
        <li>
          Redirect URI: platform <strong>Public client/native (mobile &amp; desktop)</strong>, address <Copyable text={MICROSOFT_RETURN_ADDRESS} />. Register. (If it won't take
          that address, open Manifest and add <code>{`{ "url": "${MICROSOFT_RETURN_ADDRESS}", "type": "InstalledClient" }`}</code> to replyUrlsWithType, then Save.)
        </li>
        <li>
          Open API permissions, Add a permission, Microsoft Graph, Delegated permissions, and add these. Don't click "Grant admin consent" unless all the accounts are in your own
          organization:
          <Scopes scopes={props.scopes} />
        </li>
        <li>No client secret is needed: like Ringkeeper Connect's own, this app runs on your computer. Copy the Application (client) ID from the Overview page and paste it below.</li>
      </ol>
      <div className="notice info small">
        A client's IT admin may have to approve your app once before their accounts can sign in (Microsoft says "Need admin approval"). Personal Microsoft accounts sign in
        straight away.
      </div>
    </details>
  );
}

/** How to make a Meta app for Meta Ads (as Ringkeeper's), and what to expect of it. */
function MetaSteps(props: { scopes: string[]; run: Run }) {
  return (
    <details className="own-app-steps">
      <summary>How to create one (about 10 minutes, free)</summary>
      <ol className="steps">
        <li>
          Open{" "}
          <button type="button" className="link inline" onClick={() => void props.run(api().openLink(META_APPS))}>
            My Apps on Meta for Developers ↗
          </button>{" "}
          signed in with your own Facebook account, and click Create app. Name it after your agency.
        </li>
        <li>
          Under Use cases, add <strong>Create &amp; manage ads with Marketing API</strong>. Click Customize and add each of these permissions (a missing one stops the
          sign-in with "Invalid Scopes"):
          <Scopes scopes={props.scopes} />
        </li>
        <li>
          Open App settings, then Basic. Type <Copyable text="yushkin.us" /> under App Domains. At the bottom, click Add platform, choose Website, and enter{" "}
          <Copyable text="https://yushkin.us/" /> as Site URL. Save changes.
        </li>
        <li>
          Open Facebook Login for Business, then Settings (add that product first if it isn't there). Paste <Copyable text={META_RETURN_PAGE} /> under Valid OAuth Redirect
          URIs, then Save changes. That page hands the sign-in straight back to this computer and keeps nothing.
        </li>
        <li>Keep yourself under App roles: until Meta reviews the app, only people with a role can sign in.</li>
        <li>Back in App settings, then Basic: copy the App ID, and the App secret (click Show), and paste both below.</li>
      </ol>
      <div className="notice info small">
        Ad accounts your own business owns work straight away. A client's ad accounts may need Meta's app review for your app first (Advanced Access to ads_read and
        ads_management). Each sign-in lasts about 60 days, then you sign in again. Have a System User token? Skip all this: add Meta Ads with "Use an access token".
      </div>
    </details>
  );
}

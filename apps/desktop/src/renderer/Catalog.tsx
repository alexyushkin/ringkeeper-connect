import { useEffect, useMemo, useState } from "react";
import { NOT_APPROVED, type CatalogService, type ClientView, type Result } from "../shared/api";
import { matchesWords } from "./search";
import { OwnApps } from "./OwnApps";
import { KeyTest } from "./KeyTest";

type Run = <T>(p: Promise<Result<T>>) => Promise<{ value: T } | null>;
const api = () => window.ringkeeper;

/** Add a known service to a client: pick it, answer its few questions, sign in if it uses sign-in. */
export function AddFromCatalog(props: { client: ClientView; run: Run; onAdvanced: () => void; onClose: () => void; initialToolId?: string }) {
  const [services, setServices] = useState<CatalogService[] | null>(null);
  const [service, setService] = useState<CatalogService | null>(null);
  const [signing, setSigning] = useState<{ connectionId: string; name: string } | null>(null);
  // "Your own Google (or Microsoft) apps", opened from that account's form; back to the form after.
  const [managingApps, setManagingApps] = useState<"google" | "microsoft" | "meta" | null>(null);

  async function reloadServices() {
    const r = await props.run(api().catalogServices());
    if (!r) return;
    setServices(r.value);
    setService((s) => (s ? (r.value.find((x) => x.id === s.id) ?? s) : s));
  }

  useEffect(() => {
    void props.run(api().catalogServices()).then((r) => {
      if (!r) return;
      setServices(r.value);
      // Opened for one tool (from "Still to add"): go straight to its form.
      const first = props.initialToolId ? r.value.find((s) => s.id === props.initialToolId) : undefined;
      if (first) setService(first);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (signing) {
    return <SignIn client={props.client} connectionId={signing.connectionId} name={signing.name} run={props.run} onClose={props.onClose} />;
  }

  if (managingApps) {
    return (
      <Overlay onClose={props.onClose}>
        <OwnApps
          run={props.run}
          vendor={managingApps}
          doneLabel="Back"
          onDone={() => {
            setManagingApps(null);
            void reloadServices();
          }}
        />
      </Overlay>
    );
  }

  return (
    <Overlay onClose={props.onClose}>
      {!service ? (
        <>
          <h2>Add a tool for {props.client.name}</h2>
          <p className="muted small">Pick the service. You'll use {props.client.name}'s own account or keys.</p>
          {!services ? (
            <p className="muted">Loading…</p>
          ) : (
            <ToolPicker services={services} onPick={setService} onAdvanced={props.onAdvanced} run={props.run} />
          )}
          <div className="modal-actions">
            <button onClick={props.onClose}>Cancel</button>
          </div>
        </>
      ) : (
        <ServiceForm
          client={props.client}
          service={service}
          run={props.run}
          onBack={() => setService(null)}
          onClose={props.onClose}
          onNeedsSignIn={(connectionId, name) => setSigning({ connectionId, name })}
          onOwnApps={(vendor) => setManagingApps(vendor)}
        />
      )}
    </Overlay>
  );
}

/** The order "Add a tool" shows its groups in (the catalog's own order). */
const GROUP_ORDER = [
  "Data",
  "Automations",
  "CRM and sales",
  "Marketing and email",
  "Websites",
  "Payments",
  "Accounting",
  "Work and projects",
  "Scheduling",
  "Developers",
  "Voice and research",
  "Other",
];

function matches(s: CatalogService, q: string): boolean {
  return matchesWords(`${s.name} ${s.group} ${s.description} ${(s.tags ?? []).join(" ")}`, q);
}

/** Short facts and Beta, shown on a tile and above the form. */
export function ToolTags(props: { service: CatalogService }) {
  const { service } = props;
  if (!service.beta && !service.tags?.length) return null;
  return (
    <span className="tool-tags">
      {service.beta && (
        <span className="badge beta" title="Not yet tried with a real sign-in. Tell us if something doesn't work.">
          Beta
        </span>
      )}
      {service.tags?.map((t) => (
        <span key={t} className="badge tag">
          {t}
        </span>
      ))}
    </span>
  );
}

/** Search and groups over the catalog, with "Something else" and "Request a tool". */
export function ToolPicker(props: { services: CatalogService[]; onPick: (s: CatalogService) => void; onAdvanced?: () => void; run: Run }) {
  const [q, setQ] = useState("");
  const shown = props.services.filter((s) => matches(s, q.trim()));
  const groups = GROUP_ORDER.map((g) => ({ group: g, items: shown.filter((s) => s.group === g) })).filter((g) => g.items.length);
  return (
    <div className="tool-picker">
      <input
        className="tool-search"
        type="search"
        placeholder="Search tools, like CRM or WordPress"
        value={q}
        autoFocus
        onChange={(e) => setQ(e.target.value)}
      />
      {groups.map((g) => (
        <section key={g.group}>
          <h3 className="group-title">{g.group}</h3>
          <div className="service-grid">
            {g.items.map((s) => (
              <button key={s.id} className="service" onClick={() => props.onPick(s)}>
                <span className="service-name">
                  {s.name} <ToolTags service={s} />
                </span>
                <span className="muted small">{s.description}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {groups.length === 0 && <p className="muted">No tool matches "{q.trim()}".</p>}
      {props.onAdvanced && (
        <div className="service-grid">
          <button className="service other" onClick={props.onAdvanced}>
            <span className="service-name">Something else</span>
            <span className="muted small">Set it up yourself with a web address or a program (advanced).</span>
          </button>
        </div>
      )}
      <p className="muted small request-tool">
        Missing a tool your clients use?{" "}
        <button type="button" className="link small" onClick={() => void props.run(api().requestTool(q.trim()))}>
          Request a tool
        </button>
      </p>
    </div>
  );
}

function uniqueName(client: ClientView, base: string): string {
  const taken = new Set(client.connections.map((c) => c.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

function ServiceForm(props: {
  client: ClientView;
  service: CatalogService;
  run: Run;
  onBack: () => void;
  onClose: () => void;
  onNeedsSignIn: (connectionId: string, name: string) => void;
  /** Opens "Your own Google apps" or "Your own Microsoft apps". */
  onOwnApps: (vendor: "google" | "microsoft" | "meta") => void;
}) {
  const { service, client } = props;
  const options = useMemo(() => [...service.options].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended)), [service]);
  const [optionId, setOptionId] = useState(options[0]!.id);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [name, setName] = useState(() => uniqueName(client, service.name));
  const [busy, setBusy] = useState(false);
  // Shown inside the form, where the user is looking.
  const [error, setError] = useState<string | null>(null);
  const option = options.find((o) => o.id === optionId)!;
  const usesSignIn = option.auth === "oauth";
  // Needs a registered app (Google, Microsoft, Meta) this build doesn't have and the user hasn't added.
  const unavailable = !!option.unavailable;
  const vendor = option.app === "microsoft" ? "Microsoft" : option.app === "meta" ? "Meta" : "Google";
  // What the AI may do (a Google account): one tick box each, some ticked to begin with.
  const [access, setAccess] = useState<Record<string, Set<string>>>({});
  const ticked = access[option.id] ?? new Set((option.access ?? []).filter((a) => a.default).map((a) => a.id));
  const toggle = (id: string, on: boolean) =>
    setAccess((all) => {
      const next = new Set(ticked);
      if (on) next.add(id);
      else next.delete(id);
      return { ...all, [option.id]: next };
    });
  const nothingTicked = !!option.access && ticked.size === 0;
  // Which app it signs in through: Ringkeeper Connect's, or one of the user's own.
  const appChoices = option.signInApps ?? [];
  const [appId, setAppId] = useState<string | undefined>(undefined);
  const chosenApp = appChoices.find((a) => a.id === appId)?.id ?? appChoices[0]?.id;
  const ownAppsVendor = option.app === "google" || option.app === "microsoft" || option.app === "meta" ? option.app : undefined;

  async function submit() {
    setBusy(true);
    const chosen = option.access ? option.access.filter((a) => ticked.has(a.id)).map((a) => a.id) : undefined;
    const r = await api().addFromCatalog(client.id, service.id, option.id, answers, name, chosen, option.app ? chosenApp : undefined);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (r.value.needsSignIn) props.onNeedsSignIn(r.value.connectionId, name);
    else props.onClose();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2>
        Connect {client.name}'s {service.name}
      </h2>
      <ToolTags service={service} />
      {service.beta && (
        <div className="notice info small">This tool is new in Ringkeeper Connect. If signing in or using it doesn't work, use "Request a tool" to tell us.</div>
      )}
      {service.notes?.map((n) => (
        <div key={n} className="notice info small">
          {n}
        </div>
      ))}

      {options.length > 1 && (
        <fieldset className="choice">
          <legend>How do you want to connect?</legend>
          {options.map((o) => (
            <label key={o.id}>
              <input type="radio" checked={o.id === optionId} onChange={() => setOptionId(o.id)} /> {o.label}
              {o.recommended && <span className="badge">Recommended</span>}
            </label>
          ))}
        </fieldset>
      )}

      <label className="field">
        <span>Name in Ringkeeper Connect</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      {option.fields.map((f) => (
        <div className="field" key={f.id}>
          <label htmlFor={`f-${f.id}`}>
            <span>{f.label}</span>
          </label>
          <input
            id={`f-${f.id}`}
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            placeholder={f.placeholder}
            value={answers[f.id] ?? ""}
            onChange={(e) => setAnswers((a) => ({ ...a, [f.id]: e.target.value }))}
          />
          {f.help && <span className="hint">{f.help}</span>}
          {f.where && (
            <button type="button" className="link small left" onClick={() => void props.run(api().openLink(f.where!.url))}>
              {f.where.label} ↗
            </button>
          )}
        </div>
      ))}

      {option.check && (
        <KeyTest
          test={() => api().testKey(service.id, option.id, answers)}
          resetOn={`${option.id}:${JSON.stringify(answers)}`}
          disabled={option.fields.some((f) => f.required && !(answers[f.id] ?? "").trim())}
        />
      )}

      {option.access && (
        <fieldset className="choice access">
          <legend>What may the AI do?</legend>
          {option.access.map((a) => (
            <label key={a.id}>
              <input type="checkbox" checked={ticked.has(a.id)} onChange={(e) => toggle(a.id, e.target.checked)} /> {a.label}
              {a.note && <span className="hint"> {a.note}</span>}
            </label>
          ))}
          {nothingTicked && <span className="hint">Tick at least one.</span>}
        </fieldset>
      )}

      {error && (
        <div className="notice bad" role="alert">
          {error}
        </div>
      )}

      {usesSignIn && !unavailable && option.app && appChoices.length > 1 && (
        <fieldset className="choice">
          <legend>Sign in through</legend>
          {appChoices.map((a) => (
            <label key={a.id}>
              <input type="radio" checked={a.id === chosenApp} onChange={() => setAppId(a.id)} /> {a.name}
            </label>
          ))}
        </fieldset>
      )}

      {unavailable && option.app === "meta" && (
        <div className="notice info">Signing in to {service.name} goes through a Meta app of your own. Set one up first, or choose "Use an access token" above.</div>
      )}
      {unavailable && option.app !== "meta" && (
        <div className="notice info">
          Signing in to {service.name} needs Ringkeeper Connect's own {vendor} sign-in, which isn't in this version yet.{" "}
          {ownAppsVendor ? `You can sign in through your own ${vendor} app instead.` : "It's coming in an update."}
        </div>
      )}

      {ownAppsVendor && (
        <button type="button" className="link small left" onClick={() => props.onOwnApps(ownAppsVendor)}>
          {unavailable ? `Set up your own ${vendor} app` : `Use your own ${vendor} app…`}
        </button>
      )}

      {usesSignIn && !unavailable && option.app === "meta" && (
        <ol className="steps sign-in-steps">
          <li>
            Click Continue. Facebook opens in your browser: sign in with the profile that manages <strong>{client.name}'s</strong> ad accounts.
          </li>
          <li>Allow access, then come back here.</li>
        </ol>
      )}

      {usesSignIn && !unavailable && option.app && option.app !== "meta" && (
        <ol className="steps sign-in-steps">
          <li>
            Click Continue. {vendor} opens in your browser: choose <strong>{client.name}'s</strong> account there, or add it.
          </li>
          <li>Allow what you ticked, then come back here.</li>
        </ol>
      )}

      {usesSignIn && !unavailable && !option.app && (
        <ol className="steps sign-in-steps">
          <li>
            In your browser, sign in to {service.name} with <strong>{client.name}'s</strong> account.
          </li>
          <li>Come back here and click Continue. {service.name} opens in your browser and asks you to allow access.</li>
        </ol>
      )}

      <div className="modal-actions">
        <button type="button" onClick={props.onBack}>
          Back
        </button>
        <button type="submit" className="primary" disabled={busy || !name.trim() || unavailable || nothingTicked}>
          {usesSignIn ? "Continue" : "Add tool"}
        </button>
      </div>
    </form>
  );
}

/** Waits while the user signs in in their browser. */
export function SignIn(props: { client: ClientView; connectionId: string; name: string; run: Run; onClose: () => void }) {
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Why sign-in failed, shown here (not as a banner behind this window).
  const [failed, setFailed] = useState<string | null>(null);
  const canRetry = !failed?.includes(NOT_APPROVED);

  async function start() {
    setFailed(null);
    const r = await api().signIn(props.client.id, props.connectionId);
    if (r.ok) props.onClose();
    else setFailed(r.error);
  }

  useEffect(() => {
    const off = api().onSignInLink(setLink);
    void start();
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Overlay
      onClose={() => {
        void api().cancelSignIn();
        props.onClose();
      }}
    >
      <h2>
        Sign in to {props.name} for {props.client.name}
      </h2>
      {failed ? (
        <>
          <p>{failed}</p>
          {canRetry && (
            <p className="muted small">
              If the sign-in page showed an error: sign in to {props.name} in your browser with {props.client.name}'s account first, then try
              again. You can also do it later with "Sign in" next to the connection.
            </p>
          )}
        </>
      ) : (
        <>
          <p>Your browser opened {props.name}. Allow access there, then come back here.</p>
          <p className="muted small">
            If the page shows an error, or you weren't signed in yet: sign in to {props.name} with{" "}
            <strong>{props.client.name}'s</strong> account, then paste this link into the browser's address bar. Signed in to a
            different account? Sign out there first, or paste the link into a private window.
          </p>
          {link && (
            <div className="copy-row">
              <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          )}
          <p className="muted small waiting">Waiting for you to finish signing in…</p>
        </>
      )}
      <div className="modal-actions">
        <button
          onClick={() => {
            void api().cancelSignIn();
            props.onClose();
          }}
        >
          {failed ? "Close" : "Cancel"}
        </button>
        {failed && canRetry && (
          <button className="primary" onClick={() => void start()}>
            Try again
          </button>
        )}
      </div>
    </Overlay>
  );
}

function Overlay(props: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true">
        {props.children}
      </div>
    </div>
  );
}

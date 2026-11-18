import { useEffect, useMemo, useState } from "react";
import type { CatalogService, ClientView, Result } from "../shared/api";
import { matchesWords } from "./search";

type Run = <T>(p: Promise<Result<T>>) => Promise<{ value: T } | null>;
const api = () => window.ringkeeper;

/** Add a known service to a client: pick it, answer its few questions, sign in if it uses sign-in. */
export function AddFromCatalog(props: { client: ClientView; run: Run; onAdvanced: () => void; onClose: () => void; initialToolId?: string }) {
  const [services, setServices] = useState<CatalogService[] | null>(null);
  const [service, setService] = useState<CatalogService | null>(null);
  const [signing, setSigning] = useState<{ connectionId: string; name: string } | null>(null);

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
  const usesSignIn = option.kind === "remote" && option.auth === "oauth";

  async function submit() {
    setBusy(true);
    const r = await api().addFromCatalog(client.id, service.id, option.id, answers, name);
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

      {error && (
        <div className="notice bad" role="alert">
          {error}
        </div>
      )}

      {usesSignIn && (
        <p className="muted small">
          Next, your browser opens {service.name}. Sign in with {client.name}'s account and allow access.
        </p>
      )}

      <div className="modal-actions">
        <button type="button" onClick={props.onBack}>
          Back
        </button>
        <button type="submit" className="primary" disabled={busy || !name.trim()}>
          {usesSignIn ? "Add and sign in" : "Add tool"}
        </button>
      </div>
    </form>
  );
}

/** Waits while the user signs in in their browser. */
export function SignIn(props: { client: ClientView; connectionId: string; name: string; run: Run; onClose: () => void }) {
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function start() {
    setFailed(false);
    const r = await props.run(api().signIn(props.client.id, props.connectionId));
    if (r) props.onClose();
    else setFailed(true);
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
        <p>Sign-in didn't finish. You can try again now, or later with "Sign in" next to the connection.</p>
      ) : (
        <>
          <p>Your browser opened the sign-in page. Finish there, then come back here.</p>
          <p className="muted small">
            Use <strong>{props.client.name}'s</strong> account. If your browser is already signed in to a different account, sign out
            there first, or paste this link into a private window:
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
        {failed && (
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

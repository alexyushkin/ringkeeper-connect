// Moving to another computer: save every client, with its tools, keys and sign-ins, to one
// file locked with a password, and bring it in on the new computer. Plain words only.
import { useEffect, useState } from "react";
import type { CopyPreview, CopyResult, Result } from "../shared/api";
import { copyResultText } from "./copy-text";

const api = window.ringkeeper;
type Run = <T>(p: Promise<Result<T>>) => Promise<{ value: T } | null>;

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

/** The two ways: save a copy here, or bring one in. */
export function MoveComputerDialog(props: { start?: "save" | "bring-in"; hasClients: boolean; onClose: () => void; run: Run; onHint: (t: string) => void }) {
  const [step, setStep] = useState<"choose" | "save" | "bring-in">(props.start ?? (props.hasClients ? "choose" : "bring-in"));
  if (step === "save") return <SaveCopy onClose={props.onClose} onHint={props.onHint} />;
  if (step === "bring-in") return <BringIn onClose={props.onClose} run={props.run} onHint={props.onHint} />;
  return (
    <Modal title="Move to another computer" onClose={props.onClose}>
      <p>
        Save a copy of your clients here, with their tools, keys and sign-ins, then bring it in with Ringkeeper Connect on the other computer.
        The copy is one file, locked with a password you choose.
      </p>
      <div className="choice-buttons">
        <button className="primary" onClick={() => setStep("save")}>
          Save a copy of my clients
        </button>
        <button onClick={() => setStep("bring-in")}>Bring in clients from a copy</button>
      </div>
      <p className="muted small">Your AI apps are connected on each computer separately: on the new one, use "Connect" next to each app.</p>
      <div className="modal-actions">
        <button onClick={props.onClose}>Close</button>
      </div>
    </Modal>
  );
}

/** Send everything to the full Ringkeeper app on this computer: no file, no password. */
export function SendToRingkeeperDialog(props: { clients: number; onClose: () => void; onHint: (t: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    const r = await api.sendToRingkeeper();
    setBusy(false);
    if (!r.ok) return setError(r.error);
    props.onHint(
      `Sent ${r.value.clients === 1 ? "1 client" : `${r.value.clients} clients`} to Ringkeeper. Open Ringkeeper: it shows them on Home, with "Bring them in". Your clients stay here too.`,
    );
    props.onClose();
  }

  return (
    <Modal title="Send to Ringkeeper" onClose={props.onClose}>
      <p className="small">
        Ringkeeper is the full app: tasks, approvals before changes, undo and more. This hands it every client here ({props.clients}), with their
        tools, keys and the tools for every client. It's locked so only the Ringkeeper on this computer can open it, and Ringkeeper asks before
        bringing anything in. Nothing here changes.
      </p>
      <p className="muted small">Sign-ins made here (Google, Microsoft and others) don&apos;t move: you sign in to those again in Ringkeeper.</p>
      {error && (
        <div className="notice bad" role="alert">
          {error}
        </div>
      )}
      <div className="modal-actions">
        <button type="button" onClick={props.onClose}>
          Cancel
        </button>
        <button className="primary" disabled={busy} onClick={() => void send()}>
          {busy ? "Sending…" : "Send to Ringkeeper"}
        </button>
      </div>
    </Modal>
  );
}

function SaveCopy(props: { onClose: () => void; onHint: (t: string) => void }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const r = await api.saveCopy(password, repeat);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    if (!r.value) return; // cancelled in the save window: stay here
    props.onHint(
      `Saved "${r.value.file}". It holds your clients' keys, locked with your password: keep it somewhere safe, and delete it once it's brought in on the other computer.`,
    );
    props.onClose();
  }

  return (
    <Modal title="Save a copy of your clients" onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="small">
          Every client, its tools, keys and sign-ins, the tools for every client and your own apps go into one file. Choose a password to lock
          it: you'll type it on the other computer.
        </p>
        <label className="field">
          <span>Password (at least 8 characters)</span>
          <input type="password" autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="field">
          <span>The same password again</span>
          <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </label>
        <div className="notice warn small">If you forget this password, the copy can't be opened. Nobody can recover it, Ringkeeper Connect included.</div>
        {error && (
          <div className="notice bad" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || password.length < 8 || !repeat}>
            {busy ? "Saving…" : "Choose where to save it…"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function BringIn(props: { onClose: () => void; run: Run; onHint: (t: string) => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<CopyPreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [every, setEvery] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    void api.cancelCopy();
    props.onClose();
  };

  async function choose() {
    setError(null);
    const r = await api.chooseCopy();
    if (!r.ok) return setError(r.error);
    if (r.value) {
      setFile(r.value.file);
      setPreview(null);
      setPassword("");
    }
  }

  async function open() {
    setBusy(true);
    setError(null);
    const r = await api.previewCopy(password);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setPreview(r.value);
    // Clients already here (by name) aren't ticked: bringing one in would add a second.
    setPicked(new Set(r.value.clients.filter((c) => !c.exists).map((c) => c.name)));
  }

  async function bringIn() {
    setBusy(true);
    const done = await props.run(api.importCopy({ clients: [...picked], everyClient: every }));
    setBusy(false);
    if (done) {
      props.onHint(copyResultText(done.value as CopyResult));
      props.onClose();
    }
  }

  const toggle = (name: string, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  const newEvery = preview?.everyClient.filter((t) => !t.exists) ?? [];

  return (
    <Modal title="Bring in clients from a copy" onClose={close} wide={!!preview}>
      {!preview ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void open();
          }}
        >
          <p className="small">Pick the copy you saved on the other computer (it ends in .ringkeeper), then type the password you chose for it.</p>
          <div className="field">
            <span>Copy</span>
            <div className="file-pick">
              <button type="button" onClick={() => void choose()}>
                {file ? "Pick another…" : "Pick the copy…"}
              </button>
              {file && <span className="muted small">{file}</span>}
            </div>
          </div>
          {file && (
            <label className="field">
              <span>Its password</span>
              <input type="password" autoFocus autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          )}
          {error && (
            <div className="notice bad" role="alert">
              {error}
            </div>
          )}
          <div className="modal-actions">
            <button type="button" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!file || !password || busy}>
              {busy ? "Opening…" : "Open it"}
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="small">Choose what to bring in. Nothing already on this computer is changed.</p>
          <fieldset className="choice copy-list">
            <legend>Clients</legend>
            {preview.clients.length === 0 && <p className="muted small">The copy has no clients.</p>}
            {preview.clients.map((c) => (
              <label key={c.name}>
                <input type="checkbox" checked={picked.has(c.name)} onChange={(e) => toggle(c.name, e.target.checked)} /> {c.name}
                <span className="hint">
                  {" "}
                  {c.tools === 1 ? "1 tool" : `${c.tools} tools`}
                  {c.archived ? ", archived" : ""}
                  {c.exists ? `. There's already a client called ${c.name} here; ticking it adds a second one.` : ""}
                </span>
              </label>
            ))}
          </fieldset>
          {preview.everyClient.length > 0 && (
            <fieldset className="choice copy-list">
              <legend>For every client</legend>
              <label>
                <input type="checkbox" checked={every && newEvery.length > 0} disabled={newEvery.length === 0} onChange={(e) => setEvery(e.target.checked)} />{" "}
                {newEvery.length ? newEvery.map((t) => t.name).join(", ") : "Already here"}
                {newEvery.length < preview.everyClient.length && newEvery.length > 0 && (
                  <span className="hint"> Ones already here by name are left as they are.</span>
                )}
              </label>
            </fieldset>
          )}
          {preview.ownApps.some((a) => !a.exists) && (
            <p className="muted small">
              Your own apps come too, so sign-ins through them keep working: {preview.ownApps.filter((a) => !a.exists).map((a) => a.name).join(", ")}.
            </p>
          )}
          <div className="modal-actions">
            <button type="button" onClick={close}>
              Cancel
            </button>
            <button className="primary" disabled={busy || (picked.size === 0 && !(every && newEvery.length))} onClick={() => void bringIn()}>
              Bring them in
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

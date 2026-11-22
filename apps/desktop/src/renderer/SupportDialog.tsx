// "Details for support" on a tool: shows exactly what would be shared (no keys, no client name),
// then copies it or opens an email the person chooses to send.
import { useEffect, useState } from "react";
import type { ClientView, ConnectionView } from "../shared/api";

const api = window.ringkeeper;

export function SupportDialog(props: { client: ClientView; conn: ConnectionView; onClose: () => void }) {
  const { client, conn } = props;
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void api.supportDetails(client.id, conn.id).then((r) => (r.ok ? setText(r.value) : setError(r.error)));
  }, [client.id, conn.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label={`Details for support: ${conn.name}`}>
        <h2>Details for support: {conn.name}</h2>
        <p className="muted small">
          This is everything that would be shared: the version, how {conn.name} connects, its status and its last log lines. Keys, sign-ins and
          your client's name are taken out. Read it first; change or remove anything you like after pasting.
        </p>
        {error && (
          <div className="notice bad" role="alert">
            {error}
          </div>
        )}
        {text === null && !error && <p className="muted small">Collecting…</p>}
        {text !== null && <textarea className="support-text" readOnly rows={14} value={text} onFocus={(e) => e.currentTarget.select()} />}
        <div className="modal-actions">
          <button onClick={props.onClose}>Close</button>
          <button disabled={text === null} onClick={() => void api.emailSupport(client.id, conn.id)}>
            Email it to the developer…
          </button>
          <button
            className="primary"
            disabled={text === null}
            onClick={() => {
              if (text === null) return;
              void api.copyText(text).then((r) => setCopied(r.ok));
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="muted small">"Email it" opens an email in your email app, for you to read and send. Nothing is sent by itself.</p>
      </div>
    </div>
  );
}

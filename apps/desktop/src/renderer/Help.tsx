// "How it works": what Ringkeeper Connect does, what it changes on this
// computer, and what Restore and uninstalling do. Plain words only.
import { useEffect } from "react";
import type { HostView } from "../shared/api";
import { RESTORE_POINTS, appsToRestore, listOf } from "./restore-text";

export function Help(props: { hosts: HostView[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  const changed = appsToRestore(props.hosts);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal wide help" role="dialog" aria-modal="true" aria-label="How Ringkeeper Connect works">
        <h2>How Ringkeeper Connect works</h2>

        <details open>
          <summary>What it does</summary>
          <p>
            Your AI apps (Claude Desktop, Cursor, Claude Code and others) connect to Ringkeeper Connect once. Ringkeeper Connect holds each client's
            tools, like their n8n, Airtable or Notion, and gives the AI apps the tools of one client at a time: the active client. Switch client and
            every AI app works with that client's accounts, so one client's data never ends up in another's.
          </p>
        </details>

        <details>
          <summary>Clients and the active client</summary>
          <ul>
            <li>Each client has its own tools and its own keys or sign-ins.</li>
            <li>The active client is the one every AI app is working with right now, in every chat. Switch in Ringkeeper Connect, or ask the AI to switch.</li>
            <li>
              "Ask AI apps to name the client on every action" (recommended) makes the AI say which client each action is for. If it names a different
              client than the active one, nothing is run.
            </li>
            <li>"Copy to…" puts a tool into another client too. Keys aren't copied: each client uses its own.</li>
          </ul>
        </details>

        <details>
          <summary>Adding tools</summary>
          <ul>
            <li>
              <strong>Add a tool</strong> on a client's page: pick the service, then sign in or paste a key. Sign-in is offered wherever the service
              allows it, so there's no key to make.
            </li>
            <li>
              <strong>Bring in connections from apps</strong> moves tools already set up in your AI apps into a client, keys included. Tools other AI
              apps use (Windsurf, Gemini CLI and others) are copied; those apps aren't changed. An AI app's own helpers, like the one Codex adds
              for its browser and screen control, are left where they are: they aren't a client's tool and only work inside that app.
            </li>
            <li>
              Connectors added in your Claude or ChatGPT account online, and Claude Desktop extensions, keep their sign-ins to themselves. Add those
              again in Ringkeeper Connect (for your own connectors, paste their address in the setup). It's once: after that, every AI app uses the
              same connection, and a key or sign-in is changed in one place.
            </li>
          </ul>
        </details>

        <details>
          <summary>What it changes on this computer</summary>
          <ul>
            <li>
              <strong>Each AI app you connect:</strong> one entry, "ringkeeper-connect", is added to the app's own settings, and the tools you chose to
              bring in are moved out of them. Nothing else in those settings is touched. A backup is kept before every change.
              {changed.length > 0 && <> Changed so far: {listOf(changed)}.</>}
            </li>
            <li>
              <strong>Its own folder:</strong> your clients and their tools. Keys and sign-ins are stored encrypted with your computer account's own
              protection, never as plain text.
            </li>
            <li>
              <strong>A small helper program</strong> the AI apps start to reach Ringkeeper Connect. It's kept outside the install folder, so updates
              don't interrupt them.
            </li>
            <li>
              <strong>Starting with your computer</strong> (if "Start when I log in" is on), in the background, so AI apps can always reach your clients.
            </li>
          </ul>
        </details>

        <details>
          <summary>If an AI app drops Ringkeeper Connect</summary>
          <p>
            An AI app that was open while Ringkeeper Connect set it up may save its old settings later, without the Ringkeeper Connect entry. It's put
            back straight away. If that keeps happening, you'll be asked to quit the app completely and open it again; the entry is put back as soon as
            the app is closed.
          </p>
        </details>

        <details>
          <summary>Restore original settings</summary>
          <ul>
            {RESTORE_POINTS.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="muted small">Restart the AI apps afterwards. You can connect them again later with "Connect" next to each app.</p>
        </details>

        <details>
          <summary>Updates and uninstalling</summary>
          <ul>
            <li>Updates download by themselves and install the next time Ringkeeper Connect restarts. Your AI apps keep working through them.</li>
            <li>
              Uninstalling runs Restore first, so your AI apps go back to how they were. Your clients and keys stay on this computer, so reinstalling
              brings them back.
            </li>
          </ul>
        </details>

        <details>
          <summary>Something not working?</summary>
          <ul>
            <li>
              Ask your AI app. It can read this guide and see what's set up here (your clients, their tools and whether each works, never your
              keys), so "Why isn't Acme's n8n working?" or "How do I add Globex's Airtable?" gets a real answer.
            </li>
            <li>A tool marked "Not working" says why and how to fix it, right under its name.</li>
            <li>"Show me how to check" next to an AI app walks you through checking that it uses Ringkeeper Connect.</li>
            <li>Missing a service? Use "Request a tool" at the bottom of "Add a tool".</li>
          </ul>
        </details>

        <div className="modal-actions">
          <button className="primary" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

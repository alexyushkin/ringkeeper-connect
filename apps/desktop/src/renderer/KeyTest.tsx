// "Test connection" for a pasted key (Meta Ads): asks the vendor and says what it found,
// in plain words, right under the key.
import { useEffect, useState } from "react";
import type { Result } from "../shared/api";
export { keyExpiryWarning } from "../shared/key-expiry";

type Found = { ok: boolean; message: string };

export function KeyTest(props: {
  test: () => Promise<Result<Found>>;
  /** A new value here clears the last result (the key was changed). */
  resetOn: string;
  disabled?: boolean;
}) {
  const [found, setFound] = useState<Found | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setFound(null), [props.resetOn]);

  async function test() {
    setBusy(true);
    setFound(null);
    const r = await props.test();
    setBusy(false);
    setFound(r.ok ? r.value : { ok: false, message: r.error });
  }

  return (
    <>
      <div className="key-test">
        <button type="button" disabled={busy || props.disabled} onClick={() => void test()}>
          {busy ? "Testing…" : "Test connection"}
        </button>
      </div>
      {found && (
        <div className={`notice ${found.ok ? "good" : "bad"} small`} role="status">
          {found.message}
        </div>
      )}
    </>
  );
}

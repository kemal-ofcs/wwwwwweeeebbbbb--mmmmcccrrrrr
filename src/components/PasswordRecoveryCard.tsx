"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { issueRecoveryCodes } from "@/lib/gateways/two-factor";

/**
 * Kode pemulihan password untuk akun yang sedang login.
 *
 * Jalan masuk terakhir ketika password terlupa dan tidak ada siapa pun yang
 * bisa menyetujui pemulihan — keadaan yang pasti dialami Superadmin, karena
 * tidak ada akun di atasnya. Pada pemasangan tanpa internet, tidak ada email
 * yang bisa dikirim, sehingga inilah satu-satunya jaring pengaman yang tersisa.
 *
 * SENGAJA hanya untuk akun sendiri: mencetak kode bagi akun orang lain berarti
 * membuat kunci cadangan ke akun itu tanpa pemiliknya pernah tahu.
 */
export function PasswordRecoveryCard() {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      setCodes(await issueRecoveryCodes());
      setConfirming(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Recovery codes could not be issued.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="app-panel p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-container-low text-on-surface-variant">
          <Icon name="lock" className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-headline-md text-on-surface">
            Password recovery codes
          </h2>
          <p className="mt-1 max-w-2xl text-body-md text-on-surface-variant">
            Use one to sign back in if you forget this account's password and
            nobody can approve a recovery. Works without internet, and only for
            your own account.
          </p>
        </div>
      </div>

      {codes ? (
        <div className="mt-4 space-y-3">
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {codes.map((code) => (
              <li
                key={code}
                className="select-all rounded-md border border-outline-variant bg-surface-container-low px-2 py-2.5 text-center font-mono text-code-md font-bold text-on-surface"
              >
                {code}
              </li>
            ))}
          </ul>
          <p className="rounded-md border border-error/30 bg-error-container p-3 text-body-md font-semibold text-on-error-container">
            Print or copy them now. These codes are not stored in readable form
            and cannot be shown again. All previous codes no longer work, so
            throw away the old sheet.
          </p>
          <button
            type="button"
            onClick={() => setCodes(null)}
            className="app-btn app-btn-secondary w-full"
          >
            I have saved them
          </button>
        </div>
      ) : confirming ? (
        <div className="mt-4 space-y-3">
          <p className="rounded-md border border-tertiary-fixed-dim bg-tertiary-fixed p-3 text-body-md text-on-tertiary-fixed">
            Issuing new codes invalidates every old code, including printed
            ones. Continue only if the old sheet is lost, used up, or has been
            seen by someone else.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void issue()}
              disabled={busy}
              className="app-btn app-btn-primary"
            >
              {busy ? "Issuing..." : "Yes, issue new codes"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="app-btn app-btn-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="app-btn app-btn-secondary mt-4"
        >
          Issue new recovery codes
        </button>
      )}

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-error/30 bg-error-container p-3 text-body-md text-on-error-container"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}

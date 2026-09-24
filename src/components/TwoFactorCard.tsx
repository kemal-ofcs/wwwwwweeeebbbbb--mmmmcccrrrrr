"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  beginTwoFactorSetup,
  confirmTwoFactorSetup,
  disableTwoFactor,
  getTwoFactorStatus,
  type TwoFactorSetup,
  type TwoFactorStatus,
} from "@/lib/gateways/two-factor";

/**
 * Pengaturan verifikasi dua langkah untuk akun yang sedang login.
 *
 * Dipilih menggantikan penyedia identitas pihak ketiga karena TOTP tidak
 * memerlukan jaringan sama sekali — kode dihitung dari rahasia bersama dan
 * waktu, sehingga operator tetap bisa masuk di lokasi tanpa sinyal.
 */
type Mode = "idle" | "setup" | "recovery" | "disable";

export function TwoFactorCard() {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getTwoFactorStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fail = (error: unknown, fallback: string) =>
    setFeedback({
      tone: "error",
      text: error instanceof Error ? error.message : fallback,
    });

  const startSetup = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      setSetup(await beginTwoFactorSetup());
      setCode("");
      setMode("setup");
    } catch (error) {
      fail(error, "Two-step verification setup could not start.");
    } finally {
      setBusy(false);
    }
  };

  const confirmSetup = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await confirmTwoFactorSetup(code);
      setRecoveryCodes(result.recoveryCodes);
      setCode("");
      setMode("recovery");
      await refresh();
    } catch (error) {
      fail(error, "The code could not be verified.");
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      await disableTwoFactor(code);
      setCode("");
      setMode("idle");
      setFeedback({
        tone: "success",
        text: "Two-step verification is turned off.",
      });
      await refresh();
    } catch (error) {
      fail(error, "Two-step verification could not be turned off.");
    } finally {
      setBusy(false);
    }
  };

  const feedbackClass =
    feedback?.tone === "success"
      ? "border-success/30 bg-success-container text-on-success-container"
      : "border-error/30 bg-error-container text-on-error-container";

  return (
    <section className="app-panel p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-container-low text-on-surface-variant">
            <Icon name="lock" className="size-5" />
          </span>
          <div>
            <h2 className="text-headline-md text-on-surface">
              Two-step verification (2FA)
            </h2>
            <p className="mt-1 max-w-2xl text-body-md text-on-surface-variant">
              A 6-digit code from an authenticator app, asked at every sign-in
              after the password. The code is computed from time, not the
              network, so it works where there is no signal.
            </p>
          </div>
        </div>
        <StatusBadge tone={status?.enabled ? "success" : "warning"}>
          {status === null ? "Loading" : status.enabled ? "On" : "Off"}
        </StatusBadge>
      </div>

      {status?.requiredByRole && !status.enabled ? (
        <p className="mt-4 rounded-md border border-tertiary-fixed-dim bg-tertiary-fixed p-3 text-body-md text-on-tertiary-fixed">
          Your role requires two-step verification. Turn it on now: without it
          you will not be able to sign in again after signing out.
        </p>
      ) : null}

      {feedback ? (
        <p
          role={feedback.tone === "error" ? "alert" : "status"}
          className={`mt-4 rounded-md border p-3 text-body-md ${feedbackClass}`}
        >
          {feedback.text}
        </p>
      ) : null}

      {mode === "idle" ? (
        <div className="mt-4 space-y-3">
          {status?.enabled ? (
            <>
              <p className="text-body-md text-on-surface-variant">
                Backup codes left: {status.recoveryRemaining} of 8.
              </p>
              <button
                type="button"
                onClick={() => {
                  setCode("");
                  setFeedback(null);
                  setMode("disable");
                }}
                className="app-btn app-btn-secondary text-error"
              >
                Turn off 2FA
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void startSetup()}
              disabled={busy}
              className="app-btn app-btn-primary"
            >
              {busy ? "Preparing..." : "Turn on 2FA"}
            </button>
          )}
        </div>
      ) : null}

      {mode === "setup" && setup ? (
        <div className="mt-4 space-y-4">
          <ol className="list-decimal space-y-1 pl-5 text-body-md text-on-surface">
            <li>
              Open Google Authenticator, Authy, or another authenticator app.
            </li>
            <li>Choose to add an account, then enter the key below.</li>
            <li>Type the 6-digit code it shows to confirm.</li>
          </ol>

          {/* Kunci ditampilkan sebagai teks, bukan QR: menggambar QR butuh
              pustaka tambahan, sementara semua aplikasi autentikator menerima
              entri manual. Dikelompokkan empat-empat supaya mudah disalin. */}
          <div className="rounded-md border border-surface-container bg-surface-container-low p-3">
            <p className="font-mono text-label-caps uppercase text-on-surface-variant">
              Account key (manual entry)
            </p>
            <p className="mt-1 select-all break-all font-mono text-headline-md tracking-widest text-on-surface">
              {(setup.secret.match(/.{1,4}/g) ?? []).join(" ")}
            </p>
          </div>

          <label className="app-label grid gap-1.5">
            6-digit code from the authenticator app
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="123456"
              className="app-input font-mono text-headline-md font-normal tracking-[0.4em]"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void confirmSetup()}
              disabled={busy}
              className="app-btn app-btn-primary"
            >
              {busy ? "Checking..." : "Turn on now"}
            </button>
            <button
              type="button"
              onClick={() => setMode("idle")}
              className="app-btn app-btn-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {mode === "recovery" ? (
        <div className="mt-4 space-y-4">
          <output className="block rounded-md border border-success/30 bg-success-container p-3 text-body-md text-on-success-container">
            2FA is on. Save the backup codes below right now.
          </output>
          {/* Ditampilkan sekali seumur pendaftaran: yang tersimpan di database
              hanya hash-nya, jadi tidak ada cara menampilkannya lagi nanti. */}
          <div className="grid grid-cols-2 gap-2 rounded-md border border-surface-container bg-surface-container-low p-3 font-mono text-code-lg text-on-surface sm:grid-cols-4">
            {recoveryCodes.map((item) => (
              <span key={item} className="select-all">
                {item}
              </span>
            ))}
          </div>
          <p className="text-body-md text-on-surface-variant">
            Each code works once, in place of the authenticator code if your
            phone is lost. Keep them somewhere safe: this page will not show
            them again.
          </p>
          <button
            type="button"
            onClick={() => {
              setRecoveryCodes([]);
              setMode("idle");
            }}
            className="app-btn app-btn-primary"
          >
            I have saved them
          </button>
        </div>
      ) : null}

      {mode === "disable" ? (
        <div className="mt-4 space-y-4">
          <p className="text-body-md text-on-surface">
            Enter a code from the authenticator app, or one of your backup
            codes, to turn off 2FA.
          </p>
          <label className="app-label grid gap-1.5">
            Verification code
            <input
              autoComplete="one-time-code"
              maxLength={16}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="123456 or ABCD-EFGH"
              className="app-input font-mono font-normal"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void turnOff()}
              disabled={busy}
              className="app-btn app-btn-danger"
            >
              {busy ? "Processing..." : "Turn off 2FA"}
            </button>
            <button
              type="button"
              onClick={() => setMode("idle")}
              className="app-btn app-btn-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

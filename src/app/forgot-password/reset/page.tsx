"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { FormEvent } from "react";
import { Suspense, useCallback, useEffect, useState } from "react";
import { validatePasswordStrength } from "@/lib/auth/password";
import {
  completePasswordReset,
  inspectResetToken,
  type ResetTokenPreview,
} from "@/lib/gateways/password-reset";
import { useHydrated } from "@/lib/hooks/useHydrated";

/**
 * Halaman pembuatan password baru.
 *
 * Token dibaca dari query string (`?token=`) ketika pengguna mengklik tautan
 * email, dan bisa ditempel manual pada pemasangan Desktop yang emailnya hanya
 * memuat kode — di sana tidak ada URL aplikasi Web untuk dituju.
 *
 * Identik di Web-Desktop dan Mobile; salin berkas ini apa adanya.
 */
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<PageShell>Loading...</PageShell>}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const isHydrated = useHydrated();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<ResetTokenPreview | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const verifyToken = useCallback(async (value: string) => {
    const clean = value.trim();
    if (!clean) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await inspectResetToken(clean));
      setNotice(null);
    } catch (cause) {
      setPreview(null);
      setError(
        cause instanceof Error
          ? cause.message
          : "The token could not be checked.",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const fromLink = searchParams.get("token")?.trim();
    if (!fromLink) return;
    setToken(fromLink);
    void verifyToken(fromLink);
  }, [searchParams, verifyToken]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmation) {
      setError("The password confirmation does not match.");
      return;
    }
    const strength = validatePasswordStrength(password);
    if (strength) {
      setError(strength);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await completePasswordReset(token.trim(), password);
      setDone(true);
      setPassword("");
      setConfirmation("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The new password could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!isHydrated) return <PageShell>Loading...</PageShell>;

  if (done) {
    return (
      <PageShell>
        <div className="space-y-4 text-center">
          <h1 className="text-headline-xl text-on-surface">Password changed</h1>
          <p className="text-body-md text-on-surface-variant">
            Your old password has been replaced. All old sessions on this
            account were also signed out for security.
          </p>
          <button
            type="button"
            onClick={() => router.replace("/login")}
            className="app-btn app-btn-primary w-full"
          >
            Sign in with the new password
          </button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <header className="space-y-1">
        <p className="text-body-sm font-semibold text-on-surface-variant">
          App Template
        </p>
        <h1 className="text-headline-xl text-on-surface">
          Create a new password
        </h1>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-error/30 bg-error-container p-3 text-body-md text-on-error-container"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <output className="block rounded-md border border-secondary/20 bg-secondary-fixed p-3 text-body-md text-on-secondary-fixed-variant">
          {notice}
        </output>
      ) : null}

      <div className="space-y-2">
        <label className="app-label grid gap-1.5">
          Reset code or token
          <input
            required
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              setPreview(null);
            }}
            placeholder="Paste the code from the email"
            className="app-input font-mono text-code-md font-normal"
          />
        </label>
        {!preview ? (
          <button
            type="button"
            disabled={busy || token.trim().length === 0}
            onClick={() => void verifyToken(token)}
            className="app-btn app-btn-secondary w-full"
          >
            {busy ? "Checking code..." : "Check code"}
          </button>
        ) : null}
      </div>

      {preview ? (
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1 rounded-md border border-surface-container bg-surface-container-low p-3 text-body-md">
            <p className="text-headline-md text-on-surface">
              {preview.operatorName}
            </p>
            <p className="text-on-surface-variant">@{preview.username}</p>
            <p className="text-on-surface-variant">{preview.maskedEmail}</p>
          </div>
          <label className="app-label grid gap-1.5">
            New password
            <input
              required
              type="password"
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="app-input font-normal"
            />
            <span className="font-normal text-on-surface-variant">
              At least 12 characters with uppercase, lowercase, and a number.
            </span>
          </label>
          <label className="app-label grid gap-1.5">
            Repeat new password
            <input
              required
              type="password"
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              className="app-input font-normal"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="app-btn app-btn-primary w-full"
          >
            {busy ? "Saving..." : "Save new password"}
          </button>
        </form>
      ) : null}

      <footer className="border-t border-surface-container pt-4 text-center">
        <Link
          href="/login"
          className="inline-flex min-h-11 items-center text-body-md font-semibold text-secondary hover:underline"
        >
          Back to sign in
        </Link>
      </footer>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background p-4 sm:p-6">
      <section className="app-panel w-full max-w-lg space-y-5 p-5 shadow-[0_8px_32px_rgb(11_28_48/0.08)] sm:p-6">
        {children}
      </section>
    </main>
  );
}

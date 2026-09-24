"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useCallback, useState } from "react";
import {
  LivenessCapture,
  type LivenessCaptureResult,
} from "@/components/LivenessCapture";
import {
  confirmResetAccount,
  lookupResetAccount,
  type ResetAccountPreview,
  type ResetChallenge,
  recoverWithCode,
  swapResetChallenge,
  verifyResetLiveness,
} from "@/lib/gateways/password-reset";
import { useHydrated } from "@/lib/hooks/useHydrated";

/**
 * Alur pemulihan password. Halaman ini identik di Web-Desktop dan Mobile
 * (`src/app` tidak disalin skrip; salin berkas ini apa adanya).
 *
 * Jalur peninjauan: `cari` -> `konfirmasi` (apakah ini akun Anda?) ->
 * `ulangi` (ketik ulang identitas) -> `foto` (verifikasi wajah) ->
 * `terkirim`.
 *
 * Jalur kode cetak: `kode-pemulihan` -> `pulih`. Jalur ini ADA supaya
 * pemasangan tanpa jaringan tidak bisa terkunci selamanya: di sana tidak ada
 * email yang bisa dikirim, dan Superadmin pertama tidak punya siapa pun di
 * atasnya yang bisa menyetujui permintaannya.
 *
 * Langkah "ulangi" sengaja dipertahankan meskipun terasa berulang: identitas
 * tersamar baru saja ditampilkan di layar, jadi mengetik ulang adalah satu-
 * satunya titik di alur ini yang memaksa pemohon menyatakan kembali akun mana
 * yang ia klaim setelah melihat petunjuknya.
 */
type Step =
  | "cari"
  | "konfirmasi"
  | "ulangi"
  | "foto"
  | "terkirim"
  | "kode-pemulihan"
  | "pulih";

export default function ForgotPasswordPage() {
  const isHydrated = useHydrated();
  const router = useRouter();

  const [step, setStep] = useState<Step>("cari");
  const [identifier, setIdentifier] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [account, setAccount] = useState<ResetAccountPreview | null>(null);
  const [challenge, setChallenge] = useState<ResetChallenge | null>(null);
  const [deliveryMessage, setDeliveryMessage] = useState("");
  /**
   * Jalur penyerahan token yang dipakai permintaan ini.
   *
   * Pada pemasangan tanpa konfigurasi email — termasuk seluruh Mode Database
   * Lokal — tidak ada email yang dikirim, sehingga layar terakhir tidak boleh
   * menyuruh pengguna membuka kotak masuknya.
   */
  const [deliveryMode, setDeliveryMode] = useState<"email" | "in_app">("email");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryConfirm, setRecoveryConfirm] = useState("");
  const [sisaKode, setSisaKode] = useState(0);

  const fail = useCallback((cause: unknown) => {
    setError(
      cause instanceof Error
        ? cause.message
        : "The request could not be processed.",
    );
  }, []);

  const submitRecovery = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (recoveryPassword !== recoveryConfirm) {
      setError("The new password confirmation does not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const hasil = await recoverWithCode({
        identifier,
        code: recoveryCode,
        newPassword: recoveryPassword,
      });
      setSisaKode(hasil.sisaKode);
      setRecoveryCode("");
      setRecoveryPassword("");
      setRecoveryConfirm("");
      setStep("pulih");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const submitLookup = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setAccount(await lookupResetAccount(identifier.trim()));
      setStep("konfirmasi");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const submitConfirmation = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setChallenge(
        await confirmResetAccount(identifier.trim(), confirmation.trim()),
      );
      setStep("foto");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const submitLiveness = useCallback(
    async (result: LivenessCaptureResult) => {
      if (!challenge) return;
      setBusy(true);
      setError(null);
      try {
        const delivery = await verifyResetLiveness({
          requestId: challenge.requestId,
          challengeToken: challenge.challengeToken,
          frames: result.frames,
          photoBase64: result.photoBase64,
          photoMime: result.photoMime,
          challenges: challenge.challenges,
        });
        setDeliveryMessage(delivery.message);
        setDeliveryMode(delivery.mode);
        setStep("terkirim");
      } catch (cause) {
        fail(cause);
        // Tantangan lama sudah dipakai; pemohon harus mengulang dari langkah
        // konfirmasi supaya server menerbitkan urutan tantangan yang baru.
        setStep("ulangi");
        setChallenge(null);
      } finally {
        setBusy(false);
      }
    },
    [challenge, fail],
  );

  // Tantangan pengganti diterbitkan server, lalu urutan di layar ikut
  // diperbarui supaya langkah yang sudah lolos tidak perlu diulang.
  const swapChallenge = useCallback(
    async (stepIndex: number) => {
      if (!challenge) return;
      const next = await swapResetChallenge(
        challenge.requestId,
        challenge.challengeToken,
        stepIndex,
      );
      setChallenge({ ...challenge, challenges: next });
    },
    [challenge],
  );

  const restart = () => {
    setStep("cari");
    setIdentifier("");
    setConfirmation("");
    setAccount(null);
    setChallenge(null);
    setError(null);
    setDeliveryMessage("");
  };

  if (!isHydrated) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background">
        <output className="block text-body-md text-on-surface-variant">
          Loading...
        </output>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background p-4 sm:p-6">
      <section className="app-panel w-full max-w-lg space-y-5 p-5 shadow-[0_8px_32px_rgb(11_28_48/0.08)] sm:p-6">
        <header className="space-y-1">
          <p className="text-body-sm font-semibold text-on-surface-variant">
            App Template
          </p>
          <h1 className="text-headline-xl text-on-surface">Forgot password</h1>
          <p className="text-body-md text-on-surface-variant">
            {step === "terkirim"
              ? "Your request has been verified."
              : "We verify your face before sending a recovery link."}
          </p>
        </header>

        <StepIndicator step={step} />

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-error/30 bg-error-container p-3 text-body-md text-on-error-container"
          >
            {error}
          </p>
        ) : null}

        {step === "cari" ? (
          <form className="space-y-4" onSubmit={submitLookup}>
            <label className="app-label grid gap-1.5">
              Username or email
              <input
                required
                minLength={3}
                maxLength={120}
                autoComplete="username"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                placeholder="operator01 or operator@company.co.id"
                className="app-input font-normal"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="app-btn app-btn-primary w-full"
            >
              {busy ? "Looking up account..." : "Find account"}
            </button>

            {/* Jalur kedua, untuk akun yang tidak bisa menunggu peninjau —
                terutama Superadmin, yang tidak punya siapa pun di atasnya. */}
            <button
              type="button"
              onClick={() => {
                setError(null);
                setStep("kode-pemulihan");
              }}
              className="app-btn app-btn-secondary w-full"
            >
              I have a printed recovery code
            </button>
          </form>
        ) : null}

        {step === "kode-pemulihan" ? (
          <form className="space-y-4" onSubmit={submitRecovery}>
            <p className="rounded-md border border-tertiary-fixed-dim bg-tertiary-fixed p-3 text-body-md text-on-tertiary-fixed">
              Enter one of the codes printed when the app was first installed.
              Each code works once, and this works without internet.
            </p>
            <label className="app-label grid gap-1.5">
              Username or operator code
              <input
                required
                autoComplete="username"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                className="app-input font-normal"
              />
            </label>
            <label className="app-label grid gap-1.5">
              Recovery code
              <input
                required
                value={recoveryCode}
                onChange={(event) => setRecoveryCode(event.target.value)}
                placeholder="XXXX-XXXX"
                autoComplete="off"
                className="app-input font-mono font-normal uppercase tracking-wider"
              />
            </label>
            <label className="app-label grid gap-1.5">
              New password
              <input
                required
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={recoveryPassword}
                onChange={(event) => setRecoveryPassword(event.target.value)}
                className="app-input font-normal"
              />
            </label>
            <label className="app-label grid gap-1.5">
              Repeat new password
              <input
                required
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={recoveryConfirm}
                onChange={(event) => setRecoveryConfirm(event.target.value)}
                className="app-input font-normal"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="app-btn app-btn-primary w-full"
            >
              {busy ? "Recovering..." : "Recover access"}
            </button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setStep("cari");
              }}
              className="app-btn app-btn-secondary w-full"
            >
              Back
            </button>
          </form>
        ) : null}

        {step === "pulih" ? (
          <div className="space-y-4">
            <output className="block rounded-md border border-success/30 bg-success-container p-3 text-body-md text-on-success-container">
              Your password was changed and all old sessions were revoked. Sign
              in with your new password.
            </output>
            <p className="text-body-md text-on-surface-variant">
              Recovery codes left: <strong>{sisaKode}</strong>. Issue a new set
              from Settings when you are running low.
            </p>
            <button
              type="button"
              onClick={() => router.replace("/login")}
              className="app-btn app-btn-primary w-full"
            >
              Go to sign in
            </button>
          </div>
        ) : null}

        {step === "konfirmasi" && account ? (
          <div className="space-y-4">
            <div className="space-y-1 rounded-md border border-surface-container bg-surface-container-low p-3 text-body-md">
              <p className="text-headline-md text-on-surface">{account.name}</p>
              <p className="font-mono text-code-md text-on-surface-variant">
                {account.kodeOperator} · @{account.username}
              </p>
              <p className="text-on-surface-variant">
                Email: {account.maskedEmail}
              </p>
              <p className="text-on-surface-variant">
                Phone: {account.maskedPhone || "not set"}
              </p>
            </div>
            <p className="text-body-md text-on-surface">
              Is this your account?
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirmation("");
                  setStep("ulangi");
                }}
                className="app-btn app-btn-primary flex-1"
              >
                Yes, it is mine
              </button>
              <button
                type="button"
                onClick={restart}
                className="app-btn app-btn-secondary"
              >
                No, search again
              </button>
            </div>
          </div>
        ) : null}

        {step === "ulangi" && account ? (
          <form className="space-y-4" onSubmit={submitConfirmation}>
            <p className="text-body-md text-on-surface">
              To confirm, type the username or email of{" "}
              <strong>{account.name}</strong> again.
            </p>
            <label className="app-label grid gap-1.5">
              Username or email again
              <input
                required
                minLength={3}
                maxLength={120}
                autoComplete="off"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                className="app-input font-normal"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={busy}
                className="app-btn app-btn-primary flex-1"
              >
                {busy ? "Checking..." : "Continue to face verification"}
              </button>
              <button
                type="button"
                onClick={restart}
                className="app-btn app-btn-secondary"
              >
                Start over
              </button>
            </div>
          </form>
        ) : null}

        {step === "foto" && challenge ? (
          <div className="space-y-4">
            <p className="text-body-md text-on-surface">
              Follow the {challenge.challenges.length} instructions below. The
              recording confirms a real person is present, not a photo, and is
              kept as audit evidence.
            </p>
            <LivenessCapture
              challenges={challenge.challenges}
              busy={busy}
              onComplete={(result) => void submitLiveness(result)}
              onSwapChallenge={swapChallenge}
              onCancel={restart}
            />
          </div>
        ) : null}

        {step === "terkirim" ? (
          <div className="space-y-4">
            <output className="block rounded-md border border-success/30 bg-success-container p-3 text-body-md text-on-success-container">
              {deliveryMessage}
            </output>
            {deliveryMode === "in_app" ? (
              <p className="text-body-md text-on-surface">
                No email was sent: this install does not use email delivery. Ask
                the Superadmin to review your photo on the Password resets page,
                then ask for the recovery code shown on their screen. Enter that
                code on the next page.
              </p>
            ) : (
              <p className="text-body-md text-on-surface">
                Open that email and click the link to create a new password. If
                the email only contains a code, enter it on the next page.
              </p>
            )}
            <button
              type="button"
              onClick={() => router.push("/forgot-password/reset")}
              className="app-btn app-btn-primary w-full"
            >
              I have a reset code
            </button>
          </div>
        ) : null}

        <footer className="border-t border-surface-container pt-4 text-center">
          <Link
            href="/login"
            className="inline-flex min-h-11 items-center text-body-md font-semibold text-secondary hover:underline"
          >
            Back to sign in
          </Link>
        </footer>
      </section>
    </main>
  );
}

const STEP_LABELS: { key: Step; label: string }[] = [
  { key: "cari", label: "Find" },
  { key: "konfirmasi", label: "Confirm" },
  { key: "ulangi", label: "Repeat" },
  { key: "foto", label: "Face" },
  { key: "terkirim", label: "Send" },
];

function StepIndicator({ step }: { step: Step }) {
  const activeIndex = STEP_LABELS.findIndex((item) => item.key === step);
  return (
    <ol className="flex items-center gap-1.5">
      {STEP_LABELS.map((item, index) => (
        <li key={item.key} className="flex flex-1 flex-col gap-1">
          <span
            aria-hidden="true"
            className={`h-1 rounded-full ${
              index <= activeIndex ? "bg-secondary" : "bg-surface-container"
            }`}
          />
          <span
            aria-current={index === activeIndex ? "step" : undefined}
            className={`font-mono text-label-caps uppercase ${
              index <= activeIndex
                ? "text-secondary"
                : "text-on-surface-variant"
            }`}
          >
            {item.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

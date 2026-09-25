"use client";

import Link from "next/link";
import { redirect, useRouter } from "next/navigation";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { BootstrapPanel } from "@/components/BootstrapPanel";
import { LicenseActivationPanel } from "@/components/license/LicenseActivationPanel";
import { useAuth } from "@/lib/context/AuthContext";
import {
  type BootstrapStatus,
  getBootstrapStatus,
} from "@/lib/gateways/bootstrap";
import { isLicenseBlocking } from "@/lib/gateways/license";
import {
  describeSessionEnd,
  readEndedSessionReason,
} from "@/lib/gateways/sessions";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { useLicenseStatus } from "@/lib/hooks/useLicenseStatus";
import { useOnlineStatus } from "@/lib/hooks/useOnlineStatus";

export default function LoginPage() {
  const isHydrated = useHydrated();
  const isOnline = useOnlineStatus();
  const { user, login, isAuthenticated, isLoading: authLoading } = useAuth();
  const router = useRouter();

  const [username, setUsername] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Web: sesi cookie ini diakhiri dari luar (login di perangkat lain, atau
  // diakhiri admin). Desktop/Mobile menjelaskannya lewat modal AutoSyncRunner.
  const [endedNotice, setEndedNotice] = useState<string | null>(null);
  useEffect(() => {
    void readEndedSessionReason().then((reason) => {
      if (reason)
        setEndedNotice(
          `${describeSessionEnd(reason)} Sign in again to continue.`,
        );
    });
  }, []);
  // Kolom kode baru muncul setelah server menyatakan password sudah benar dan
  // tinggal kode 2FA-nya. Menampilkannya lebih awal akan membocorkan akun mana
  // yang memakai verifikasi dua langkah.
  const [totpCode, setTotpCode] = useState<string>("");
  const [needsTotp, setNeedsTotp] = useState<boolean>(false);
  const [bootstrapStatus, setBootstrapStatus] =
    useState<BootstrapStatus | null>(null);
  // Dibuka manual ketika kredensial database tersimpan tetapi database cloud-nya
  // tidak menjawab — misalnya database Turso lama sudah dihapus. Tanpa pintu
  // ini, layar provisioning tidak pernah muncul lagi dan tidak ada tempat untuk
  // memasukkan URL database baru.
  const [showDatabaseSetup, setShowDatabaseSetup] = useState(false);

  const refreshBootstrapStatus = useCallback(() => {
    void getBootstrapStatus()
      .then((status) => {
        setBootstrapStatus(status);
        if (status?.reachable) setShowDatabaseSetup(false);
      })
      .catch(() => setBootstrapStatus(null));
  }, []);

  useEffect(() => {
    refreshBootstrapStatus();
  }, [refreshBootstrapStatus]);

  // Desktop/Mobile saja (Web selalu `null`). Dibaca ulang setiap status
  // database berubah: perangkat yang baru bergabung ke database berlisensi
  // menemukan lisensinya di sana.
  const {
    status: licenseStatus,
    refresh: refreshLicense,
    setStatus: setLicenseStatus,
  } = useLicenseStatus(false);
  useEffect(() => {
    if (bootstrapStatus) void refreshLicense();
  }, [bootstrapStatus, refreshLicense]);
  // Pemasangan baru meminta lisensi SEBELUM provisioning. Perangkat kedua dan
  // seterusnya milik lembaga yang sama melewatinya: lisensinya sudah ada di
  // database yang akan mereka sambungkan.
  const [joiningLicensedDatabase, setJoiningLicensedDatabase] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setErrorMsg("Enter your username or operator code and your password.");
      return;
    }

    setErrorMsg(null);
    setIsSubmitting(true);

    try {
      const res = await login(
        username.trim(),
        password,
        needsTotp ? totpCode : undefined,
      );
      if (res.sukses) {
        router.replace("/");
      } else {
        if (res.requiresTotp) setNeedsTotp(true);
        setErrorMsg(res.pesan);
        void refreshLicense();
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Sign-in could not be verified.";
      setErrorMsg(msg);
      // Login bisa ditolak karena lisensinya; membaca ulang status memunculkan
      // layar aktivasi alih-alih membiarkan form login buntu.
      void refreshLicense();
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isHydrated || authLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <output className="block text-body-md text-on-surface-variant">
          Loading sign-in...
        </output>
      </div>
    );
  }

  if (isAuthenticated && user) redirect("/");
  if (
    bootstrapStatus?.required &&
    !joiningLicensedDatabase &&
    licenseStatus &&
    isLicenseBlocking(licenseStatus)
  ) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background p-4 sm:p-6">
        <div className="app-panel w-full max-w-md p-5 shadow-[0_8px_32px_rgb(11_28_48/0.08)] sm:p-6">
          <p className="mb-3 font-mono text-label-caps uppercase text-on-surface-variant">
            Step 1 of 2 · database setup follows
          </p>
          <LicenseActivationPanel
            status={licenseStatus}
            onInstalled={setLicenseStatus}
          />
          <button
            type="button"
            onClick={() => setJoiningLicensedDatabase(true)}
            className="app-btn app-btn-secondary mt-3 w-full"
          >
            This device is joining an already licensed database
          </button>
        </div>
      </main>
    );
  }
  if (bootstrapStatus?.required) {
    return (
      <BootstrapPanel
        status={bootstrapStatus}
        onCompleted={refreshBootstrapStatus}
      />
    );
  }
  if (bootstrapStatus && showDatabaseSetup) {
    return (
      <BootstrapPanel
        status={bootstrapStatus}
        onCompleted={refreshBootstrapStatus}
        onCancel={() => setShowDatabaseSetup(false)}
      />
    );
  }
  if (licenseStatus && isLicenseBlocking(licenseStatus)) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background p-4 sm:p-6">
        <div className="app-panel w-full max-w-md p-5 shadow-[0_8px_32px_rgb(11_28_48/0.08)] sm:p-6">
          <LicenseActivationPanel
            status={licenseStatus}
            onInstalled={(next) => {
              setLicenseStatus(next);
              setErrorMsg(null);
            }}
          />
          {/* Perangkat yang menunjuk database salah tidak pernah menemukan
              lisensinya; tanpa pintu ini ia terjebak di layar aktivasi. */}
          <button
            type="button"
            onClick={() => setShowDatabaseSetup(true)}
            className="app-btn app-btn-secondary mt-3 w-full"
          >
            Reconfigure database
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background p-4 sm:p-6">
      <div className="app-panel w-full max-w-md space-y-5 p-5 shadow-[0_8px_32px_rgb(11_28_48/0.08)] sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-headline-xl text-on-surface">App Template</h1>
            <p className="mt-1 text-body-md text-on-surface-variant">
              Sign in to continue.
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-surface-container bg-surface-container-low px-2 py-0.5 font-mono text-code-sm text-on-surface-variant">
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${isOnline ? "bg-success" : "bg-on-tertiary-container"}`}
            />
            {isOnline ? "Online" : "Offline"}
          </span>
        </div>

        {/* Database cloud tersimpan tetapi tidak menjawab: tawarkan konfigurasi
            ulang, jangan biarkan pengguna menebak-nebak di form login. */}
        {bootstrapStatus?.configured && !bootstrapStatus.reachable ? (
          <div className="space-y-1.5 rounded-md border border-tertiary-fixed-dim bg-tertiary-fixed p-3 text-body-md text-on-tertiary-fixed">
            <p className="font-semibold">
              The cloud database cannot be reached
            </p>
            <p>
              {bootstrapStatus.message ??
                "This app still points at the old database."}
            </p>
            <p>
              If the network is up and the database was replaced or deleted,
              point the app at the new one. Offline sign-in still works if this
              device has signed in online before.
            </p>
            <button
              type="button"
              onClick={() => setShowDatabaseSetup(true)}
              className="app-btn app-btn-secondary mt-1 w-full"
            >
              Reconfigure database
            </button>
          </div>
        ) : null}

        {endedNotice && !errorMsg ? (
          <output className="block rounded-md border border-tertiary-fixed-dim bg-tertiary-fixed p-3 text-body-md text-on-tertiary-fixed">
            {endedNotice}
          </output>
        ) : null}

        {errorMsg && (
          <div
            role="alert"
            className="rounded-md border border-error/30 bg-error-container p-3 text-body-md text-on-error-container"
          >
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="username-input" className="app-label">
              Username or operator code
            </label>
            <input
              id="username-input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="app-input"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password-input" className="app-label">
              Password
            </label>
            <div className="relative">
              <input
                id="password-input"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="app-input pr-20"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-pressed={showPassword}
                className="absolute right-1 top-1/2 min-h-9 -translate-y-1/2 rounded-md px-3 text-body-sm font-semibold text-on-surface-variant hover:bg-surface-container-low"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {needsTotp ? (
            <div className="space-y-1.5">
              <label htmlFor="totp-input" className="app-label">
                Two-step verification code
              </label>
              <input
                id="totp-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={16}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="123456 or a backup code"
                className="app-input font-mono tracking-[0.3em]"
              />
              <p className="text-body-sm text-on-surface-variant">
                Open your authenticator app, or enter one of your backup codes.
              </p>
            </div>
          ) : null}

          <button
            type="submit"
            disabled={isSubmitting}
            className="app-btn app-btn-primary w-full"
          >
            {isSubmitting ? "Signing in..." : "Sign in"}
          </button>

          <div className="text-center">
            <Link
              href="/forgot-password"
              className="inline-flex min-h-11 items-center text-body-md font-semibold text-secondary hover:underline"
            >
              Forgot password?
            </Link>
          </div>
        </form>

        <div className="space-y-0.5 text-center font-mono text-code-sm text-on-surface-variant">
          {licenseStatus?.license ? (
            <p>Licensed to {licenseStatus.license.holder}</p>
          ) : null}
          <p>Kemal Office Studio v0.1.0</p>
        </div>
      </div>
    </main>
  );
}

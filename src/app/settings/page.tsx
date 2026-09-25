"use client";

import { redirect } from "next/navigation";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppShell } from "@/components/AppShell";
import { BusinessSettingsCard } from "@/components/BusinessSettingsCard";
import { CompanyProfileCard } from "@/components/CompanyProfileCard";
import { ClientCodeCard } from "@/components/clients/ClientCodeCard";
import { MasterDataCard } from "@/components/clients/MasterDataCard";
import { DatabaseBackupCard } from "@/components/DatabaseBackupCard";
import { LicenseCard } from "@/components/license/LicenseCard";
import { MailSettingsCard } from "@/components/MailSettingsCard";
import { PasswordRecoveryCard } from "@/components/PasswordRecoveryCard";
import { TwoFactorCard } from "@/components/TwoFactorCard";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { PageHeader } from "@/components/ui/PageHeader";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  getSyncStatus,
  type SyncStatus,
  syncNow,
} from "@/lib/gateways/sync-status";
import {
  clearTursoConfig,
  type DatabaseConfigView,
  getDatabaseConfig,
  saveTursoConfig,
  type TursoConnectionStatus,
  testTursoConnection,
} from "@/lib/gateways/turso-config";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import {
  DATABASE_PROVIDER_OPTIONS,
  type DatabaseProvider,
  describeProvider,
  providerNeedsEndpoint,
  reviewDatabaseEndpoint,
} from "@/lib/validations/database-endpoint";

type Feedback = { type: "success" | "error"; message: string } | null;

export default function SettingsPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const canManage = hasPermission(user, "settings.manage");
  const isDesktop = isDesktopRuntime();
  // Ref, bukan state: dua klik dalam satu tick sama-sama membaca state lama.
  const isSubmittingRef = useRef(false);

  const [provider, setProvider] = useState<DatabaseProvider>("turso");
  const [allowInsecure, setAllowInsecure] = useState(false);
  const [databaseUrl, setDatabaseUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [tokenSaved, setTokenSaved] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connection, setConnection] = useState<TursoConnectionStatus | null>(
    null,
  );
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const providerInfo = describeProvider(provider);
  // Cermin sisi klien dari `normalize_database_url` di Rust. Backend tetap
  // penjaga sebenarnya; ini hanya supaya formulir menjelaskan lebih awal.
  const endpoint = reviewDatabaseEndpoint(databaseUrl, provider, allowInsecure);

  const loadConfig = useCallback(async () => {
    const config: DatabaseConfigView = await getDatabaseConfig();
    if (!config.configured) return;
    setDatabaseUrl(config.databaseUrl);
    setProvider(config.provider);
    setAllowInsecure(config.allowInsecureTransport);
    setTokenSaved(config.authTokenSaved);
  }, []);

  useEffect(() => {
    if (!isDesktop) return;
    void loadConfig().catch(() => undefined);
    void getSyncStatus()
      .then(setSync)
      .catch(() => undefined);
  }, [isDesktop, loadConfig]);

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    const needsEndpoint = providerNeedsEndpoint(provider);
    if (needsEndpoint && !endpoint.valid) {
      setFeedback({
        type: "error",
        message: endpoint.issue?.message ?? "This database URL cannot be used.",
      });
      return;
    }
    if (
      needsEndpoint &&
      endpoint.tokenRequired &&
      !authToken.trim() &&
      !tokenSaved
    ) {
      setFeedback({
        type: "error",
        message: "An Auth Token is required for this database address.",
      });
      return;
    }
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    try {
      await saveTursoConfig(
        needsEndpoint ? databaseUrl.trim() : "",
        needsEndpoint ? authToken.trim() : "",
        {
          provider,
          allowInsecureTransport: allowInsecure,
        },
      );
      if (authToken.trim()) setTokenSaved(true);
      setAuthToken("");
      setFeedback({
        type: "success",
        message: `${providerInfo.label} connection saved in the encrypted vault.`,
      });
      setConnection(
        await testTursoConnection(databaseUrl.trim(), "", {
          provider,
          allowInsecureTransport: allowInsecure,
        }),
      );
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "The database connection could not be saved.",
      });
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const status = await testTursoConnection(
        databaseUrl.trim() || undefined,
        authToken.trim() || undefined,
        { provider, allowInsecureTransport: allowInsecure },
      );
      setConnection(status);
      setFeedback({
        type: status.connected ? "success" : "error",
        message: status.connected
          ? `Connected. Latency ${status.latency_ms ?? 0} ms.`
          : `Connection failed: ${status.error_message ?? "could not connect"}`,
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "The connection test could not be run.",
      });
    } finally {
      setTesting(false);
    }
  };

  const handleReset = async () => {
    if (isSubmittingRef.current) return;
    if (!confirm("Remove the database connection from this device?")) return;
    isSubmittingRef.current = true;
    setBusy(true);
    try {
      await clearTursoConfig();
      setDatabaseUrl("");
      setAuthToken("");
      setProvider("turso");
      setAllowInsecure(false);
      setTokenSaved(false);
      setConnection(null);
      setFeedback({
        type: "success",
        message: "Database connection reset.",
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "The reset failed.",
      });
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      setSync(await syncNow());
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error ? error.message : "Sync could not be run.",
      });
    } finally {
      setSyncing(false);
    }
  };

  if (!isHydrated || authLoading)
    return <div className="min-h-dvh bg-background" />;
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "settings")) redirect("/forbidden");

  return (
    <AppShell>
      <PageHeader
        title="Settings"
        description="Database connection, account security, and sync status for this device."
      />

      {feedback ? (
        <FeedbackBanner
          tone={feedback.type}
          onDismiss={() => setFeedback(null)}
        >
          {feedback.message}
        </FeedbackBanner>
      ) : null}

      {!isDesktop ? (
        <section className="app-panel p-4 sm:p-5">
          <h2 className="text-headline-md text-on-surface">Database</h2>
          <p className="mt-1 text-body-md text-on-surface-variant">
            In the Web build, the database is set through server environment
            variables (
            <code className="text-on-surface">APP_DATABASE_PROVIDER</code>,{" "}
            <code className="text-on-surface">TURSO_DATABASE_URL</code>,{" "}
            <code className="text-on-surface">TURSO_AUTH_TOKEN</code>), not on
            this screen. The credential vault only exists in the Desktop and
            Mobile apps.
          </p>
        </section>
      ) : null}

      {isDesktop && canManage ? (
        <section className="app-panel p-4 sm:p-5">
          <h2 className="text-headline-md text-on-surface">
            Database connection (LibSQL)
          </h2>
          <p className="mt-1 max-w-2xl text-body-md text-on-surface-variant">
            The app talks directly to a LibSQL database over the HTTP pipeline:
            Turso Cloud or your own libSQL server at the office, at home, or on
            a VPS. Credentials are stored in an AES-256-GCM encrypted vault on
            this device.
          </p>

          <form onSubmit={handleSave} className="mt-4 space-y-4">
            <fieldset className="space-y-2">
              <legend className="app-label mb-2">Database type</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {DATABASE_PROVIDER_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className={`grid min-w-0 cursor-pointer gap-1 rounded-md border p-3 text-body-sm transition-colors ${
                      provider === option.value
                        ? "border-secondary bg-secondary-fixed text-on-secondary-fixed-variant"
                        : "border-outline-variant bg-surface-container-lowest text-on-surface-variant hover:border-outline"
                    }`}
                  >
                    <span className="flex items-center gap-2 text-body-md font-semibold">
                      <input
                        type="radio"
                        name="database-provider"
                        value={option.value}
                        checked={provider === option.value}
                        onChange={() => {
                          setProvider(option.value);
                          setAllowInsecure(false);
                          setConnection(null);
                        }}
                        className="size-4 shrink-0 accent-secondary"
                      />
                      <span className="min-w-0 truncate">{option.label}</span>
                    </span>
                    <span>{option.description}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {providerNeedsEndpoint(provider) ? (
              <>
                <label className="app-label grid gap-1.5">
                  {provider === "turso"
                    ? "Turso database URL"
                    : "Your database server address"}
                  <input
                    type="text"
                    inputMode="url"
                    value={databaseUrl}
                    onChange={(event) => {
                      setDatabaseUrl(event.target.value);
                      setConnection(null);
                    }}
                    placeholder={providerInfo.urlPlaceholder}
                    className="app-input font-mono text-code-md font-normal"
                  />
                  {databaseUrl.trim().length > 0 && endpoint.issue ? (
                    <span className="font-normal text-error">
                      {endpoint.issue.message}
                    </span>
                  ) : null}
                </label>

                <label className="app-label grid gap-1.5">
                  {endpoint.tokenRequired
                    ? "Auth Token"
                    : "Auth Token (optional for servers without authentication)"}
                  <div className="relative">
                    <input
                      type={showToken ? "text" : "password"}
                      value={authToken}
                      onChange={(event) => setAuthToken(event.target.value)}
                      placeholder={
                        tokenSaved
                          ? "•••••••••••••••• (saved in the vault)"
                          : providerInfo.tokenPlaceholder
                      }
                      autoComplete="off"
                      className="app-input pr-20 font-mono text-code-md font-normal"
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken((value) => !value)}
                      aria-pressed={showToken}
                      className="absolute right-1 top-1/2 min-h-9 -translate-y-1/2 rounded-md px-3 text-body-sm font-semibold text-on-surface-variant hover:bg-surface-container-low"
                    >
                      {showToken ? "Hide" : "Show"}
                    </button>
                  </div>
                  <span className="font-normal text-on-surface-variant">
                    A saved token is never shown again. Leave this empty to keep
                    it.
                  </span>
                </label>
              </>
            ) : (
              <p className="rounded-md border border-secondary/20 bg-secondary-fixed p-3 text-body-md text-on-secondary-fixed-variant">
                All data is stored in a SQLite file on this device. No server
                address or Auth Token is needed, and the app runs fully without
                internet.
              </p>
            )}

            {provider === "self_hosted" &&
            (endpoint.issue?.code === "INSECURE_PUBLIC" || allowInsecure) ? (
              <label className="flex items-start gap-2 rounded-md border border-error/30 bg-error-container p-3 text-body-md font-semibold text-on-error-container">
                <input
                  type="checkbox"
                  checked={allowInsecure}
                  onChange={(event) => {
                    setAllowInsecure(event.target.checked);
                    setConnection(null);
                  }}
                  className="mt-0.5 size-4 shrink-0 accent-error"
                />
                <span>
                  Allow an unencrypted connection to a public address. The Auth
                  Token and all data will be sent as plain text that anyone on
                  the network path can read. The safe options are HTTPS on the
                  server or a LAN/VPN address.
                </span>
              </label>
            ) : null}

            {connection ? (
              <div
                role={connection.connected ? "status" : "alert"}
                className={`rounded-md border p-3 text-body-md font-semibold ${
                  connection.connected
                    ? "border-success/30 bg-success-container text-on-success-container"
                    : "border-error/30 bg-error-container text-on-error-container"
                }`}
              >
                {connection.connected
                  ? `Connected to ${providerInfo.label} (latency ${connection.latency_ms ?? 0} ms)`
                  : `Connection failed: ${connection.error_message ?? "check the URL and token"}`}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="submit"
                disabled={busy || testing}
                className="app-btn app-btn-primary"
              >
                {busy ? "Saving..." : "Save connection"}
              </button>
              <button
                type="button"
                onClick={() => void handleTest()}
                disabled={busy || testing}
                className="app-btn app-btn-secondary"
              >
                {testing ? "Testing..." : "Test connection"}
              </button>
              {databaseUrl ? (
                <button
                  type="button"
                  onClick={() => void handleReset()}
                  disabled={busy || testing}
                  className="app-btn app-btn-secondary text-error"
                >
                  Reset connection
                </button>
              ) : null}
            </div>
          </form>
        </section>
      ) : null}

      {/* Keamanan akun sendiri: tidak dijaga izin apa pun, karena setiap
          operator berhak mengamankan akunnya — termasuk role paling terbatas. */}
      <LicenseCard />
      <TwoFactorCard />
      <PasswordRecoveryCard />
      <DatabaseBackupCard provider={provider} />

      {/* Identitas perusahaan dibaca siapa pun yang punya sesi — nilainya
          muncul di kop dokumen — tetapi hanya pemegang settings.manage yang
          boleh menyuntingnya, dan itulah gerbang di sini. */}
      {hasPermission(user, "settings.manage") ? <CompanyProfileCard /> : null}

      {hasPermission(user, "settings.manage") ? <MailSettingsCard /> : null}

      {/* Domain MaklonOS: pilihan form intake dan bentuk kode klien. */}
      <BusinessSettingsCard
        canManage={hasPermission(user, "settings.manage")}
      />
      {hasPermission(user, "master_data.manage") ? <MasterDataCard /> : null}
      {hasPermission(user, "settings.manage") ? <ClientCodeCard /> : null}

      {isDesktop ? (
        <section className="app-panel p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-headline-md text-on-surface">Sync</h2>
              <p className="mt-1 text-body-md text-on-surface-variant">
                The local queue is sent to the cloud, then cloud changes are
                pulled to this device.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleSyncNow()}
              disabled={syncing}
              className="app-btn app-btn-secondary"
            >
              {syncing ? "Syncing..." : "Sync now"}
            </button>
          </div>
          {sync ? (
            <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-surface-container pt-4 sm:grid-cols-4">
              {[
                { label: "Pending", value: sync.pending },
                { label: "Sent", value: sync.synced },
                { label: "Failed", value: sync.failed },
                { label: "Conflicts", value: sync.conflict },
              ].map((entry) => (
                <div key={entry.label}>
                  <dt className="font-mono text-label-caps uppercase text-on-surface-variant">
                    {entry.label}
                  </dt>
                  <dd className="font-mono text-headline-lg tabular-nums text-on-surface">
                    {String(entry.value)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {sync?.pushError ? (
            <p className="mt-3 rounded-md border border-tertiary-fixed-dim bg-tertiary-fixed p-3 text-body-md text-on-tertiary-fixed">
              The last push failed: {sync.pushError}. Cloud data is still
              pulled, and the local queue is retried automatically.
            </p>
          ) : null}
        </section>
      ) : null}
    </AppShell>
  );
}

"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { LicenseBootstrapField } from "@/components/license/LicenseBootstrapField";
import {
  type BootstrapStatus,
  bootstrapSuperadmin,
  checkBootstrapDatabase,
  type DatabaseCheckResult,
  type DatabaseCredentials,
  linkBootstrapDatabase,
} from "@/lib/gateways/bootstrap";
import {
  type DatabaseCheckTone,
  summarizeDatabaseCheck,
} from "@/lib/utils/bootstrap-check";
import {
  DATABASE_PROVIDER_OPTIONS,
  type DatabaseProvider,
  describeProvider,
  providerNeedsEndpoint,
  reviewDatabaseEndpoint,
} from "@/lib/validations/database-endpoint";

type BootstrapPanelProps = {
  status: BootstrapStatus;
  onCompleted: () => void;
  /**
   * Diisi hanya ketika panel dibuka manual dari layar login (kredensial sudah
   * ada tetapi database cloud-nya tidak menjawab). Tanpa jalan kembali,
   * pengguna yang sekadar sedang offline akan terjebak di panel ini.
   */
  onCancel?: () => void;
};

const TONE_CARD: Record<DatabaseCheckTone, string> = {
  success: "border-success/30 bg-success-container text-on-success-container",
  warning: "border-tertiary-fixed-dim bg-tertiary-fixed text-on-tertiary-fixed",
  danger: "border-error/30 bg-error-container text-on-error-container",
};

const TONE_BADGE: Record<DatabaseCheckTone, string> = {
  success: "bg-success text-on-secondary",
  warning: "bg-tertiary-container text-on-tertiary",
  danger: "bg-error text-on-error",
};

const TONE_LABEL: Record<DatabaseCheckTone, string> = {
  success: "Safe",
  warning: "Caution",
  danger: "Danger",
};

export function BootstrapPanel({
  status,
  onCompleted,
  onCancel,
}: BootstrapPanelProps) {
  const [provider, setProvider] = useState<DatabaseProvider>("turso");
  const [allowInsecure, setAllowInsecure] = useState(false);
  const [databaseUrl, setDatabaseUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [license, setLicense] = useState("");
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [linking, setLinking] = useState(false);
  const [check, setCheck] = useState<DatabaseCheckResult | null>(null);
  const [editingDatabase, setEditingDatabase] = useState(false);
  const [forceProceed, setForceProceed] = useState(false);
  /**
   * Kode pemulihan Superadmin, ditahan di layar sampai pengguna mengakui.
   *
   * `null` berarti bootstrap belum berjalan; array kosong berarti akun sudah
   * ada sebelumnya sehingga tidak ada kode baru yang diterbitkan.
   */
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const needsCredentials = !status.configured || editingDatabase;
  const summary = check ? summarizeDatabaseCheck(check) : null;
  const provisioningUnlocked = Boolean(
    summary?.canCreateSuperadmin &&
      (!summary.requiresConfirmation || forceProceed),
  );

  const providerInfo = describeProvider(provider);

  // Cermin sisi klien dari aturan Rust: memberi tahu sebelum tombol ditekan,
  // bukan setelah IPC gagal. Backend tetap penjaga yang sebenarnya.
  const endpoint = useMemo(
    () => reviewDatabaseEndpoint(databaseUrl, provider, allowInsecure),
    [databaseUrl, provider, allowInsecure],
  );

  const needsEndpoint = providerNeedsEndpoint(provider);

  // Mode lokal tidak punya endpoint, dan validatornya memang MENOLAKNYA secara
  // sengaja — kalau diloloskan, alamat remote yang dipasangkan dengan mode
  // lokal akan melewati seluruh aturan transport.
  const credentialsReady =
    !needsCredentials ||
    !needsEndpoint ||
    (endpoint.valid &&
      (!endpoint.tokenRequired || authToken.trim().length > 0));

  const resetCheck = useCallback(() => {
    setCheck(null);
    setForceProceed(false);
  }, []);

  const credentials = useCallback((): DatabaseCredentials => {
    if (!needsCredentials) return {};
    // Backend yang menentukan lokasi berkas hub, sehingga UI tidak perlu tahu
    // direktori data aplikasi.
    if (!needsEndpoint) return { provider };
    return {
      databaseUrl,
      authToken,
      provider,
      allowInsecureTransport: allowInsecure,
    };
  }, [
    needsCredentials,
    needsEndpoint,
    databaseUrl,
    authToken,
    provider,
    allowInsecure,
  ]);

  const runCheck = useCallback(async (payload: DatabaseCredentials) => {
    setChecking(true);
    setFeedback("");
    try {
      setCheck(await checkBootstrapDatabase(payload));
      setForceProceed(false);
    } catch (error: unknown) {
      setCheck(null);
      setFeedback(
        error instanceof Error
          ? error.message
          : "The database check could not be run.",
      );
    } finally {
      setChecking(false);
    }
  }, []);

  // Kredensial sudah tersimpan di vault: periksa otomatis tanpa input ulang.
  useEffect(() => {
    if (status.configured && !editingDatabase) {
      void runCheck({});
    }
  }, [status.configured, editingDatabase, runCheck]);

  const handleCheck = () => {
    void runCheck(credentials());
  };

  const handleUseExisting = async () => {
    setLinking(true);
    setFeedback("");
    try {
      await linkBootstrapDatabase(credentials());
      onCompleted();
    } catch (error: unknown) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "This database cannot be used.",
      );
    } finally {
      setLinking(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!provisioningUnlocked) {
      setFeedback("Check the database before creating the Superadmin.");
      return;
    }
    if (password !== confirmation) {
      setFeedback("The password confirmation does not match.");
      return;
    }
    setSubmitting(true);
    setFeedback("");
    try {
      const codes = await bootstrapSuperadmin({
        kodeOperator: "SPD001",
        namaOperator: name,
        username,
        password,
        databaseUrl: needsCredentials ? databaseUrl : undefined,
        authToken: needsCredentials ? authToken : undefined,
        provider: needsCredentials ? provider : undefined,
        allowInsecureTransport: needsCredentials ? allowInsecure : undefined,
        license,
      });
      setPassword("");
      setConfirmation("");
      setAuthToken("");
      // Bila ada kode, layar pemulihan yang memanggil `onCompleted` — pengguna
      // harus melewatinya lebih dulu.
      if (codes.length > 0) {
        setRecoveryCodes(codes);
        return;
      }
      onCompleted();
    } catch (error: unknown) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "The Superadmin could not be created.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  // Layar kode pemulihan MENGGANTIKAN formulir, bukan menumpang di atasnya.
  // Ini satu-satunya kesempatan membaca kodenya, jadi tidak boleh ada tombol
  // lain yang menggoda pengguna melewatinya.
  if (recoveryCodes) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background p-4 sm:p-6">
        <section className="app-panel w-full max-w-lg p-5 shadow-[0_8px_32px_rgb(11_28_48/0.08)] sm:p-6">
          <h1 className="text-headline-xl text-on-surface">
            Save your recovery codes
          </h1>
          <p className="mt-2 text-body-md text-on-surface-variant">
            The Superadmin is the only account with nobody above it to approve a
            recovery. These codes are the last way in if its password is
            forgotten, especially on installs without internet, which cannot
            send any email.
          </p>

          <ul className="mt-4 grid grid-cols-2 gap-2">
            {recoveryCodes.map((code) => (
              <li
                key={code}
                className="select-all rounded-md border border-outline-variant bg-surface-container-low px-3 py-2.5 text-center font-mono text-code-lg font-bold text-on-surface"
              >
                {code}
              </li>
            ))}
          </ul>

          <p className="mt-4 rounded-md border border-error/30 bg-error-container p-3 text-body-md font-semibold text-on-error-container">
            These codes are not stored in readable form and cannot be shown
            again. Each code works once. Keep them somewhere other than this
            device, such as a safe or a locked archive cabinet.
          </p>

          <button
            type="button"
            onClick={onCompleted}
            className="app-btn app-btn-primary mt-4 w-full"
          >
            I have saved them, continue
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-4 sm:p-6">
      <section className="app-panel w-full max-w-lg p-5 shadow-[0_8px_32px_rgb(11_28_48/0.08)] sm:p-6">
        <h1 className="text-headline-xl text-on-surface">
          Check the database, then create the Superadmin
        </h1>
        <p className="mt-2 text-body-md text-on-surface-variant">
          This is done once. The database is checked first so a mistyped URL is
          caught, and so you can see whether a Superadmin already exists there.
        </p>
        {status.configured && !status.reachable ? (
          <div className="mt-4 rounded-md border border-tertiary-fixed-dim bg-tertiary-fixed p-3 text-body-md text-on-tertiary-fixed">
            <span className="font-semibold">
              The saved cloud database cannot be reached.
            </span>{" "}
            {status.message ??
              "This device still points at the old database. If that database was deleted or replaced, press “Change database” and enter the new URL and Auth Token."}
          </div>
        ) : null}
        {status.configured ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 truncate rounded-md border border-surface-container bg-surface-container-low px-3 py-2 font-mono text-code-md text-on-surface">
              {status.serverOrigin}
            </p>
            <button
              type="button"
              onClick={() => {
                setEditingDatabase((value) => !value);
                resetCheck();
              }}
              className="app-btn app-btn-secondary"
            >
              {editingDatabase ? "Cancel change" : "Change database"}
            </button>
          </div>
        ) : null}
        {feedback ? (
          <div
            role="alert"
            className="mt-4 rounded-md border border-error/30 bg-error-container p-3 text-body-md text-on-error-container"
          >
            {feedback}
          </div>
        ) : null}

        <div className="mt-4 grid gap-4">
          {needsCredentials ? (
            <>
              <fieldset className="grid gap-2">
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
                            resetCheck();
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
              {needsEndpoint ? (
                <>
                  <label className="app-label grid gap-1.5">
                    {provider === "turso"
                      ? "Turso database URL"
                      : "Database server address"}
                    <input
                      type="text"
                      inputMode="url"
                      value={databaseUrl}
                      onChange={(event) => {
                        setDatabaseUrl(event.target.value);
                        resetCheck();
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
                      : "Auth Token (optional)"}
                    <input
                      type="password"
                      value={authToken}
                      onChange={(event) => {
                        setAuthToken(event.target.value);
                        resetCheck();
                      }}
                      placeholder={providerInfo.tokenPlaceholder}
                      autoComplete="off"
                      className="app-input font-mono text-code-md font-normal"
                    />
                  </label>
                </>
              ) : (
                <p className="rounded-md border border-secondary/20 bg-secondary-fixed p-3 text-body-md text-on-secondary-fixed-variant">
                  Data is stored in a SQLite file on this device. No server
                  address or Auth Token is needed, and the app runs fully
                  without internet.
                </p>
              )}
              {provider === "self_hosted" &&
              endpoint.issue?.code === "INSECURE_PUBLIC" ? (
                <label className="flex items-start gap-2 rounded-md border border-error/30 bg-error-container p-3 text-body-md font-semibold text-on-error-container">
                  <input
                    type="checkbox"
                    checked={allowInsecure}
                    onChange={(event) => {
                      setAllowInsecure(event.target.checked);
                      resetCheck();
                    }}
                    className="mt-0.5 size-4 shrink-0 accent-error"
                  />
                  Allow an unencrypted connection. The Auth Token and
                  operational data will be sent as plain text. Only use this on
                  a network you fully trust.
                </label>
              ) : null}
            </>
          ) : null}
          <button
            type="button"
            onClick={handleCheck}
            disabled={checking || linking || submitting || !credentialsReady}
            className="app-btn app-btn-secondary"
          >
            {checking ? "Checking database..." : "Check database"}
          </button>
        </div>

        {summary ? (
          <div
            className={`mt-4 rounded-md border p-3 text-body-md ${TONE_CARD[summary.tone]}`}
          >
            <div className="flex items-start gap-2">
              <span
                className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 font-mono text-label-caps uppercase ${TONE_BADGE[summary.tone]}`}
              >
                {TONE_LABEL[summary.tone]}
              </span>
              <p className="font-semibold">{summary.title}</p>
            </div>
            <p className="mt-2">{summary.detail}</p>
            {summary.facts.length > 0 ? (
              <dl className="mt-3 grid gap-1.5 border-t border-current/15 pt-3 sm:grid-cols-2">
                {summary.facts.map((fact) => (
                  <div
                    key={fact.label}
                    className="flex items-baseline justify-between gap-2 sm:block"
                  >
                    <dt className="text-body-sm opacity-80">{fact.label}</dt>
                    <dd className="truncate font-mono text-code-md">
                      {fact.value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {summary.canUseExisting ? (
              <button
                type="button"
                onClick={() => void handleUseExisting()}
                disabled={linking}
                className="app-btn app-btn-primary mt-4 w-full"
              >
                {linking
                  ? "Saving settings..."
                  : "Use this database and sign in"}
              </button>
            ) : null}
            {summary.requiresConfirmation ? (
              <label className="mt-4 flex items-start gap-2 rounded-md border border-current/20 bg-surface-container-lowest/60 p-3 font-semibold">
                <input
                  type="checkbox"
                  checked={forceProceed}
                  onChange={(event) => setForceProceed(event.target.checked)}
                  className="mt-0.5 size-4 accent-error"
                />
                I have made sure this is the right database and still want to
                create the Superadmin.
              </label>
            ) : null}
          </div>
        ) : null}

        {provisioningUnlocked ? (
          <form onSubmit={submit} className="mt-4 grid gap-4">
            <div className="grid gap-4 sm:grid-cols-[7rem_1fr]">
              <label className="app-label grid gap-1.5">
                Code
                <input
                  value="SPD001"
                  readOnly
                  className="app-input font-mono font-normal"
                  disabled
                />
              </label>
              <label className="app-label grid min-w-0 gap-1.5">
                Full name
                <input
                  required
                  minLength={3}
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  className="app-input min-w-0 font-normal"
                />
              </label>
            </div>
            <label className="app-label grid gap-1.5">
              Username
              <input
                required
                minLength={3}
                maxLength={64}
                pattern="[A-Za-z0-9._-]+"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                className="app-input font-normal"
              />
            </label>
            <LicenseBootstrapField value={license} onChange={setLicense} />
            <label className="app-label grid gap-1.5">
              Strong password
              <input
                required
                minLength={12}
                maxLength={128}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                className="app-input font-normal"
              />
              <span className="font-normal text-on-surface-variant">
                At least 12 characters with uppercase, lowercase, a number, and
                a symbol, and it must not contain the username.
              </span>
            </label>
            <label className="app-label grid gap-1.5">
              Repeat password
              <input
                required
                minLength={12}
                maxLength={128}
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="new-password"
                className="app-input font-normal"
              />
            </label>
            <button
              type="submit"
              disabled={submitting}
              className="app-btn app-btn-primary"
            >
              {submitting ? "Securing the database..." : "Create Superadmin"}
            </button>
          </form>
        ) : (
          <p className="mt-4 rounded-md border border-surface-container bg-surface-container-low p-3 text-body-md text-on-surface-variant">
            The Superadmin form opens after the database has been checked and
            reported ready.
          </p>
        )}
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="app-btn app-btn-secondary mt-4 w-full"
          >
            Back to sign in
          </button>
        ) : null}
      </section>
    </main>
  );
}

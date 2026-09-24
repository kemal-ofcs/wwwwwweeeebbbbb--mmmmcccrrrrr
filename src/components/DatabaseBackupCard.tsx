"use client";

import { useEffect, useRef, useState } from "react";
import {
  type DataFolderInfo,
  type DeviceExportReport,
  type ExportReport,
  exportDatabase,
  exportDatabaseToDevice,
  getDataFolder,
  type ImportReport,
  importDatabaseFile,
} from "@/lib/gateways/database-portability";
import { isMobileRuntime } from "@/lib/runtime/app-runtime";
import type { DatabaseProvider } from "@/lib/validations/database-endpoint";

/** Kata yang harus diketik ulang sebelum pemulihan dijalankan. */
const RESTORE_CONFIRMATION = "RESTORE";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Android SELALU memakai dialog "Simpan ke…" (SAF, aturan 28), sehingga bentuk
 * laporannya berbeda: `savedToDevice` alih-alih `publicPath`.
 */
type ExportResult =
  | { kind: "desktop"; report: ExportReport }
  | { kind: "device"; report: DeviceExportReport };

const panelNote =
  "rounded-md border p-3 text-body-md border-tertiary-fixed-dim bg-tertiary-fixed text-on-tertiary-fixed";
const panelDanger =
  "rounded-md border p-3 text-body-md font-semibold border-error/30 bg-error-container text-on-error-container";
const panelSuccess =
  "rounded-md border p-3 text-body-md border-success/30 bg-success-container text-on-success-container";

/**
 * Layar Cadangan Database, dipakai Desktop dan Mobile.
 *
 * Tanpa cloud tidak ada cadangan otomatis di mana pun, jadi inilah satu-satunya
 * cara customer memindahkan datanya sendiri: ganti laptop, pulihkan setelah
 * kerusakan, atau mengirimkannya saat meminta bantuan.
 *
 * Dua hal yang sengaja tampil menonjol: peringatan bahwa berkas tanpa frasa
 * sandi memuat hash password dan seluruh data operasional, dan konfirmasi
 * ketik-ulang sebelum memulihkan — memulihkan berarti MENIMPA seluruh data,
 * bukan menggabungkannya.
 */
export function DatabaseBackupCard({
  provider,
}: {
  provider: DatabaseProvider;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<"export" | "restore" | null>(null);
  const [exported, setExported] = useState<ExportResult | null>(null);
  const [restored, setRestored] = useState<ImportReport | null>(null);
  const [folder, setFolder] = useState<DataFolderInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const isLocalMode = provider === "local_file";

  useEffect(() => {
    if (!isLocalMode) return;
    getDataFolder()
      .then(setFolder)
      .catch(() => setFolder(null));
  }, [isLocalMode]);

  if (!isLocalMode) {
    return (
      <section className="app-panel p-4 sm:p-5">
        <h2 className="text-headline-md text-on-surface">Database backup</h2>
        <p className="mt-1 max-w-2xl text-body-md text-on-surface-variant">
          This device uses a server database, so the master data is not stored
          here. Back it up from your database provider. This menu is available
          in Local Database Mode.
        </p>
      </section>
    );
  }

  const handleExport = async () => {
    setBusy("export");
    setError(null);
    setExported(null);
    try {
      if (isMobileRuntime()) {
        const report = await exportDatabaseToDevice(passphrase);
        setExported({ kind: "device", report });
        if (report.savedToDevice) setPassphrase("");
      } else {
        setExported({
          kind: "desktop",
          report: await exportDatabase(passphrase),
        });
        setPassphrase("");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a backup file first.");
      return;
    }
    setBusy("restore");
    setError(null);
    setRestored(null);
    try {
      const report = await importDatabaseFile(file, restorePassphrase);
      setRestored(report);
      setRestorePassphrase("");
      setConfirmation("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Restore failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="app-panel p-4 sm:p-5">
      <h2 className="text-headline-md text-on-surface">Database backup</h2>
      <p className="mt-1 max-w-2xl text-body-md text-on-surface-variant">
        All company data is stored on this device. Back it up regularly: there
        is no other copy anywhere.
      </p>

      {folder ? (
        <p className="mt-3 break-all rounded-md border border-surface-container bg-surface-container-low px-3 py-2 font-mono text-code-sm text-on-surface-variant">
          {folder.hubPath}
        </p>
      ) : null}

      <div className="mt-4 space-y-3 border-t border-surface-container pt-4">
        <h3 className="text-headline-md text-on-surface">Create a backup</h3>
        <label className="app-label grid gap-1.5">
          Passphrase (recommended)
          <input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            placeholder="Leave empty for an unencrypted file"
            autoComplete="new-password"
            className="app-input font-mono font-normal"
          />
        </label>

        {passphrase.trim().length === 0 ? (
          <p className={panelNote}>
            Without a passphrase, anyone who has the file can open it, including
            password hashes, two-step verification secrets, and all operational
            data. Set a passphrase unless you are preparing it for diagnostics.
          </p>
        ) : null}

        <button
          type="button"
          onClick={handleExport}
          disabled={busy !== null}
          className="app-btn app-btn-primary"
        >
          {busy === "export"
            ? "Preparing..."
            : isMobileRuntime()
              ? "Create and save backup"
              : "Create backup file"}
        </button>

        {exported ? (
          <div className={panelSuccess}>
            <p className="font-semibold">
              {exported.report.fileName} ·{" "}
              {formatSize(exported.report.sizeBytes)} ·{" "}
              {exported.report.encrypted ? "encrypted" : "NOT encrypted"}
            </p>
            {exported.kind === "device" ? (
              <p className="mt-1">
                {exported.report.savedToDevice
                  ? "Saved to the location you chose."
                  : "The backup file was created, but you closed the location picker, so there is no copy in your storage yet. Press the button above again to choose where to save it."}
              </p>
            ) : exported.report.publicPath ? (
              <p className="mt-1 break-all font-mono text-code-sm">
                Saved to: {exported.report.publicPath}
              </p>
            ) : (
              <p className="mt-1">
                The file was created, but this device does not allow writing to
                the Downloads folder, so you cannot open it from a file manager
                yet. Copy it manually from the location below.
              </p>
            )}
            <p className="mt-1 break-all font-mono text-code-sm opacity-80">
              {exported.report.path}
            </p>
          </div>
        ) : null}
      </div>

      <div className="mt-4 space-y-3 border-t border-surface-container pt-4">
        <h3 className="text-headline-md text-on-surface">
          Restore from a backup
        </h3>
        <p className={panelDanger}>
          Restoring REPLACES all data on this device (operational data,
          operators, and their permissions) instead of merging it. The current
          database is kept alongside first, so picking the wrong file can still
          be undone manually.
        </p>

        <input
          ref={fileRef}
          type="file"
          aria-label="Choose a backup file"
          accept=".db,.appbak"
          className="block w-full text-body-sm text-on-surface-variant file:mr-3 file:min-h-9 file:rounded-md file:border file:border-outline-variant file:bg-surface-container-lowest file:px-3 file:text-body-sm file:font-semibold file:text-on-surface"
        />

        <label className="app-label grid gap-1.5">
          File passphrase (if encrypted)
          <input
            type="password"
            value={restorePassphrase}
            onChange={(event) => setRestorePassphrase(event.target.value)}
            autoComplete="off"
            className="app-input font-mono font-normal"
          />
        </label>

        <label className="app-label grid gap-1.5">
          Type {RESTORE_CONFIRMATION} to confirm
          <input
            type="text"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            className="app-input font-mono font-normal"
          />
        </label>

        <button
          type="button"
          onClick={handleRestore}
          disabled={
            busy !== null || confirmation.trim() !== RESTORE_CONFIRMATION
          }
          className="app-btn app-btn-danger"
        >
          {busy === "restore" ? "Restoring..." : "Restore database"}
        </button>

        {restored ? (
          <div className={panelSuccess}>
            <p className="font-semibold">
              Restored from {restored.restoredFrom} · schema v
              {restored.schemaVersion} · {restored.tableCount} tables
            </p>
            <p className="mt-1">
              Close and reopen the app so every screen reads the new data.
            </p>
            {restored.previousBackup ? (
              <p className="mt-1 break-all font-mono text-code-sm opacity-80">
                Previous database: {restored.previousBackup}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className={`mt-4 ${panelDanger}`}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

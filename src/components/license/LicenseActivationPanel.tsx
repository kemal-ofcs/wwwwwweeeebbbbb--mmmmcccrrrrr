"use client";

import {
  type ChangeEvent,
  type FormEvent,
  useId,
  useRef,
  useState,
} from "react";
import {
  installLicense,
  LICENSE_ISSUER,
  LICENSE_KIND_LABEL,
  type LicenseState,
  type LicenseStatus,
} from "@/lib/gateways/license";

const TITLES: Record<LicenseState, string> = {
  missing: "Activate the app license",
  invalid: "Invalid license",
  device_not_listed: "This device is not registered",
  read_only: "Activate a new license",
  active: "Replace license",
};

/** Batas berkas yang wajar untuk satu lisensi (200 kode perangkat ≈ 7 KB). */
const MAX_LICENSE_FILE_BYTES = 20_000;

type Props = {
  status: LicenseStatus;
  onInstalled: (status: LicenseStatus) => void;
  /** Tombol sekunder, mis. "Continue in read-only mode". */
  onDismiss?: () => void;
  dismissLabel?: string;
};

/**
 * Formulir aktivasi lisensi: kode perangkat untuk diminta ke penyedia, lalu
 * tempel teks `LIS1.…` atau pilih berkas `.lic`. Dipakai layar login,
 * pemberitahuan mode baca-saja, dan kartu Lisensi di Pengaturan — identik di
 * Web-Desktop dan Mobile (`filesToCopy` di `sync-frontend-lib.ts`).
 */
export function LicenseActivationPanel({
  status,
  onInstalled,
  onDismiss,
  dismissLabel,
}: Props) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const textId = useId();
  const fileId = useId();

  const copyDeviceCode = async () => {
    try {
      await navigator.clipboard.writeText(status.deviceCode);
      setCopied(true);
    } catch {
      setError(
        "The code could not be copied automatically. Press and hold it, then copy it manually.",
      );
    }
  };

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_LICENSE_FILE_BYTES) {
      setError("That file is too large to be a license.");
      return;
    }
    setText((await file.text()).trim());
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    if (!text.trim()) {
      setError("Paste the license text or choose a .lic file first.");
      return;
    }
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setError(null);
    try {
      const next = await installLicense(text);
      setText("");
      onInstalled(next);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "The license could not be installed.",
      );
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const license = status.license;
  const tone =
    status.state === "read_only" || status.state === "missing"
      ? "border-tertiary-fixed-dim bg-tertiary-fixed text-on-tertiary-fixed"
      : "border-error/30 bg-error-container text-on-error-container";

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-headline-md text-on-surface">
          {TITLES[status.state]}
        </h2>
        {license ? (
          <p className="text-body-md text-on-surface-variant">
            {LICENSE_KIND_LABEL[license.kind]} license for{" "}
            <span className="font-semibold text-on-surface">
              {license.holder}
            </span>
          </p>
        ) : null}
      </div>

      {status.message ? (
        <p className={`rounded-md border p-3 text-body-md ${tone}`}>
          {status.message}
        </p>
      ) : null}

      <div className="space-y-1.5">
        <p className="app-label">This device code</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 select-all rounded-md border border-outline-variant bg-surface-container-low px-3 py-2.5 text-center text-code-lg font-bold text-on-surface">
            {status.deviceCode}
          </code>
          <button
            type="button"
            onClick={copyDeviceCode}
            className="app-btn app-btn-secondary"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="text-body-sm text-on-surface-variant">
          Send this code to {LICENSE_ISSUER} when requesting or renewing a
          license.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor={textId} className="app-label">
          License text
        </label>
        <textarea
          id={textId}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          placeholder="LIS1.…"
          className="app-input resize-y break-all py-2 font-mono text-code-sm"
        />
        <label
          htmlFor={fileId}
          className="app-btn app-btn-secondary cursor-pointer"
        >
          Choose a .lic file
        </label>
        <input
          id={fileId}
          type="file"
          accept=".lic,.txt,text/plain"
          onChange={readFile}
          className="sr-only"
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-error/30 bg-error-container p-3 text-body-md text-on-error-container"
        >
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <button
          type="submit"
          disabled={isSubmitting}
          className="app-btn app-btn-primary flex-1"
        >
          {isSubmitting ? "Checking license…" : "Activate license"}
        </button>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="app-btn app-btn-secondary flex-1"
          >
            {dismissLabel ?? "Not now"}
          </button>
        ) : null}
      </div>

      <p className="text-center font-mono text-code-sm text-on-surface-variant">
        Build {status.buildDate}
      </p>
    </form>
  );
}

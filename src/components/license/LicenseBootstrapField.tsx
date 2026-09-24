"use client";

import { useId } from "react";
import { LICENSE_ISSUER } from "@/lib/gateways/license";
import { useLicenseStatus } from "@/lib/hooks/useLicenseStatus";

type Props = {
  value: string;
  onChange: (value: string) => void;
};

/**
 * Kolom lisensi pada provisioning Superadmin pertama (Desktop/Mobile).
 * Database baru tidak bisa diprovisioning tanpa lisensi, jadi kode perangkat
 * ditampilkan di sini juga — lisensi yang dikunci ke perangkat harus diminta
 * sebelum formulir ini bisa diselesaikan. Tidak merender apa pun di Web.
 *
 * Pemasangan baru biasanya sudah mengaktifkan lisensi di layar pertama
 * (sebelum provisioning); bootstrap memakai lisensi itu bila kolom ini kosong,
 * jadi yang ditampilkan cukup konfirmasinya.
 */
export function LicenseBootstrapField({ value, onChange }: Props) {
  const { status } = useLicenseStatus();
  const textId = useId();
  if (!status) return null;
  if (status.state === "active" && status.license) {
    return (
      <p className="rounded-md border border-surface-container bg-surface-container-low p-3 text-body-md text-on-surface-variant">
        An active license for{" "}
        <span className="font-semibold text-on-surface">
          {status.license.holder}
        </span>{" "}
        is installed on this device.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={textId} className="app-label">
        License text
      </label>
      <textarea
        id={textId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        spellCheck={false}
        autoComplete="off"
        placeholder="LIS1.…"
        className="app-input resize-y break-all py-2 font-mono text-code-sm"
      />
      <p className="text-body-sm text-on-surface-variant">
        This device code:{" "}
        <code className="select-all font-bold text-on-surface">
          {status.deviceCode}
        </code>
        . Send it to {LICENSE_ISSUER} to get a license.
      </p>
    </div>
  );
}

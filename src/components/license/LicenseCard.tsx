"use client";

import { useState } from "react";
import { useAuth } from "@/lib/context/AuthContext";
import { LICENSE_KIND_LABEL } from "@/lib/gateways/license";
import { useLicenseStatus } from "@/lib/hooks/useLicenseStatus";
import { LicenseActivationPanel } from "./LicenseActivationPanel";

function describeDaysLeft(days: number) {
  if (days <= 0) return "Rental has ended";
  if (days === 1) return "Last day of rental";
  return `${days} days`;
}

const STATE_LABEL = {
  active: "Active",
  read_only: "Read-only mode",
  missing: "No license yet",
  invalid: "Invalid",
  device_not_listed: "Device not registered",
} as const;

/**
 * Kartu Lisensi di Pengaturan (Desktop dan Mobile), KHUSUS Superadmin: sisa
 * sewa dan daftar perangkat adalah urusan pemilik lembaga, bukan operator.
 * Operator tetap melihat dialog "Activate license" saat sewa habis
 * (`LicenseNotice`). Tidak merender apa pun di Web.
 */
export function LicenseCard() {
  const { user } = useAuth();
  const { status, setStatus } = useLicenseStatus();
  const [replacing, setReplacing] = useState(false);
  if (!status || !user?.isSuperadmin) return null;

  const license = status.license;
  const rows: [string, string][] = license
    ? [
        ["Holder", license.holder],
        ["License number", license.id],
        ["Type", LICENSE_KIND_LABEL[license.kind]],
        ["Issued", license.issued],
        ["Updates until", license.updatesUntil],
        ["Valid until", license.validUntil ?? "Perpetual"],
        ...(status.daysLeft === null
          ? []
          : ([["Rental left", describeDaysLeft(status.daysLeft)]] as [
              string,
              string,
            ][])),
        [
          "Devices",
          license.devices.length
            ? `${license.devices.length} registered${status.deviceBound ? "" : " (this device does not need to be listed)"}`
            : "Not locked to devices",
        ],
      ]
    : [];

  return (
    <section className="app-panel space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-headline-md text-on-surface">License</h2>
          <p className="text-body-md text-on-surface-variant">
            Status: {STATE_LABEL[status.state]}
          </p>
        </div>
        {!replacing ? (
          <button
            type="button"
            onClick={() => setReplacing(true)}
            className="app-btn app-btn-secondary"
          >
            {status.state === "active" ? "Replace license" : "Activate license"}
          </button>
        ) : null}
      </div>

      {rows.length ? (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-body-md sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-body-sm text-on-surface-variant">{label}</dt>
              <dd className="wrap-break-word font-semibold text-on-surface">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <p className="text-body-md text-on-surface-variant">
        This device code:{" "}
        <code className="select-all font-bold text-on-surface">
          {status.deviceCode}
        </code>
      </p>

      {replacing ? (
        <div className="border-t border-surface-container pt-4">
          <LicenseActivationPanel
            status={status}
            onInstalled={(next) => {
              setStatus(next);
              setReplacing(false);
            }}
            onDismiss={() => setReplacing(false)}
            dismissLabel="Cancel"
          />
        </div>
      ) : null}
    </section>
  );
}

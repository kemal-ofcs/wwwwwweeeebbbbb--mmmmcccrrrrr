"use client";

import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

/**
 * Lisensi offline Ed25519 — hanya ditegakkan di build Desktop dan Mobile
 * (`license.rs`). Web di-host pemilik aplikasi sendiri, jadi di sana setiap
 * fungsi di sini mengembalikan `null` dan UI lisensi tidak pernah tampil.
 *
 * Bentuknya persis `LicenseStatus` / `LicensePayload` di `license.rs`
 * (serde camelCase; enum snake_case).
 */
export type LicenseState =
  | "active"
  | "read_only"
  | "missing"
  | "invalid"
  | "device_not_listed";

export type LicenseReadOnlyReason = "expired" | "version_not_covered";

export type LicenseKind = "beli_putus" | "sewa";

export type LicensePayload = {
  id: string;
  holder: string;
  kind: LicenseKind;
  issued: string;
  updatesUntil: string;
  validUntil: string | null;
  devices: string[];
  lockMobile: boolean;
};

export type LicenseStatus = {
  state: LicenseState;
  readOnlyReason: LicenseReadOnlyReason | null;
  message: string | null;
  license: LicensePayload | null;
  /** Sisa hari sewa, hari ini ikut dihitung (hari terakhir = 1). `null` untuk beli putus. */
  daysLeft: number | null;
  deviceCode: string;
  deviceBound: boolean;
  buildDate: string;
};

/** Penerbit lisensi, disebut di layar aktivasi. Padanan `LICENSE_ISSUER` di `license.rs`. */
export const LICENSE_ISSUER = "Kemal Office Studio";

export const LICENSE_KIND_LABEL: Record<LicenseKind, string> = {
  beli_putus: "Perpetual",
  sewa: "Rental",
};

/** Status yang tidak mengizinkan login sama sekali. */
export function isLicenseBlocking(status: LicenseStatus | null): boolean {
  return (
    status !== null && status.state !== "active" && status.state !== "read_only"
  );
}

export async function getLicenseStatus(): Promise<LicenseStatus | null> {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<LicenseStatus>("desktop_get_license_status");
}

/**
 * Pasang lisensi dari teks `LIS1.…`. Tanpa sesi hanya bila lisensi saat ini
 * tidak aktif penuh; mengganti lisensi yang masih aktif menuntut Superadmin.
 */
export async function installLicense(license: string): Promise<LicenseStatus> {
  if (!isDesktopRuntime()) {
    throw new Error("Licenses are only installed in the Desktop/Mobile app.");
  }
  return invokeDesktop<LicenseStatus>("desktop_install_license", {
    license: license.trim(),
  });
}

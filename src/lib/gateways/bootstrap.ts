"use client";

import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { DatabaseProvider } from "@/lib/validations/database-endpoint";

export type BootstrapStatus = {
  configured: boolean;
  required: boolean;
  serverOrigin: string;
  /**
   * Apakah database cloud tersimpan benar-benar menjawab.
   *
   * `configured` hanya berarti perangkat menyimpan kredensial. Kredensial yang
   * menunjuk database Turso yang sudah dihapus tetap `configured: true` dengan
   * `reachable: false` — layar login memakai selisih itu untuk menawarkan
   * konfigurasi ulang database alih-alih membuntu di form login.
   */
  reachable: boolean;
  /** Alasan `reachable: false`, langsung dari klien Turso. */
  message: string | null;
};

export type BootstrapDraft = {
  kodeOperator: string;
  namaOperator: string;
  username: string;
  password: string;
  databaseUrl?: string;
  authToken?: string;
  provider?: DatabaseProvider;
  allowInsecureTransport?: boolean;
  /**
   * Teks lisensi `LIS1.…`. Kosong = pakai lisensi yang sudah dipasang di layar
   * aktivasi sebelum provisioning. Rust menolak membuat Superadmin sebelum
   * lisensinya terbukti sah untuk perangkat ini.
   */
  license: string;
};

export async function getBootstrapStatus(): Promise<BootstrapStatus | null> {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<BootstrapStatus>("desktop_get_bootstrap_status");
}

/**
 * Buat Superadmin pertama, lalu terima kode pemulihannya.
 *
 * Kodenya hanya bisa dibaca SEKALI: database memegang hash-nya saja. Layar
 * pemanggil WAJIB menampilkannya sampai pengguna menyatakan sudah menyimpan —
 * membuangnya diam-diam berarti pemasangan tanpa jaringan kehilangan satu-
 * satunya jalan pulih bila password Superadmin terlupa.
 */
export async function bootstrapSuperadmin(
  draft: BootstrapDraft,
): Promise<string[]> {
  if (!isDesktopRuntime()) {
    throw new Error("Bootstrap is only available in the desktop/mobile app.");
  }
  const response = await invokeDesktop<{ recoveryCodes?: unknown }>(
    "desktop_bootstrap_superadmin",
    {
      draft: {
        kode_operator: draft.kodeOperator,
        nama_operator: draft.namaOperator,
        username: draft.username,
        password: draft.password,
      },
      databaseUrl: draft.databaseUrl?.trim() || null,
      authToken: draft.authToken?.trim() || null,
      provider: draft.provider ?? null,
      allowInsecureTransport: draft.allowInsecureTransport ?? null,
      license: draft.license.trim() || null,
    },
  );
  return Array.isArray(response.recoveryCodes)
    ? response.recoveryCodes.map((code) => String(code))
    : [];
}

export type DatabaseCheckResult = {
  reachable: boolean;
  serverOrigin: string;
  latencyMs: number | null;
  emptyDatabase: boolean;
  schemaReady: boolean;
  missingTables: string[];
  tableCount: number;
  bootstrapClaimed: boolean;
  superadminExists: boolean;
  superadminCount: number;
  superadminUsername: string | null;
  operatorCount: number;
  karyawanCount: number;
  attendanceCount: number;
  companyName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type DatabaseCredentials = {
  databaseUrl?: string;
  authToken?: string;
  /**
   * Provider yang dipilih di formulir. Dikirim eksplisit supaya alamat LAN
   * ber-HTTP tidak divalidasi memakai aturan Turso — yang akan menolaknya.
   */
  provider?: DatabaseProvider;
  allowInsecureTransport?: boolean;
};

function credentialArgs(credentials: DatabaseCredentials) {
  return {
    databaseUrl: credentials.databaseUrl?.trim() || null,
    authToken: credentials.authToken?.trim() || null,
    provider: credentials.provider ?? null,
    allowInsecureTransport: credentials.allowInsecureTransport ?? null,
  };
}

/**
 * Pemeriksaan read-only database cloud sebelum Superadmin dibuat.
 * Tidak menulis apa pun sehingga salah input URL tidak mencemari database lain.
 */
export async function checkBootstrapDatabase(
  credentials: DatabaseCredentials = {},
): Promise<DatabaseCheckResult> {
  if (!isDesktopRuntime()) {
    throw new Error(
      "The database check is only available in the desktop/mobile app.",
    );
  }
  return invokeDesktop<DatabaseCheckResult>(
    "desktop_check_bootstrap_database",
    credentialArgs(credentials),
  );
}

/** Memakai database yang sudah punya Superadmin aktif tanpa membuat akun baru. */
export async function linkBootstrapDatabase(
  credentials: DatabaseCredentials = {},
): Promise<DatabaseCheckResult> {
  if (!isDesktopRuntime()) {
    throw new Error(
      "Database settings are only available in the desktop/mobile app.",
    );
  }
  return invokeDesktop<DatabaseCheckResult>(
    "desktop_link_bootstrap_database",
    credentialArgs(credentials),
  );
}

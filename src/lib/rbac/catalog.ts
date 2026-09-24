/**
 * Katalog permission aplikasi.
 *
 * Daftar ini adalah kontrak RBAC dan WAJIB identik dengan dua tempat lain:
 *
 * - seed `app_permission` di `src-tauri/src/desktop/turso.rs`
 * - seed `app_permission` di `src/lib/db-schema.ts`
 *
 * Menambah permission berarti menambahnya di ketiga tempat sekaligus. Katalog
 * yang lebih longgar daripada seed database membuat UI menawarkan hak akses yang
 * tidak pernah bisa diberikan; yang lebih ketat membuat hak akses yang sudah ada
 * di database tidak pernah bisa dicabut lewat UI.
 */
export const PERMISSION_CATALOG = [
  { key: "home.view", name: "Home and navigation access", group: "Navigation" },
  { key: "dashboard.view", name: "Dashboard access", group: "Dashboard" },
  { key: "items.view", name: "View items", group: "Master data" },
  { key: "items.manage", name: "Manage items", group: "Master data" },
  { key: "activity.view", name: "View activity log", group: "Operations" },
  { key: "activity.record", name: "Record activity", group: "Operations" },
  // MENGAJUKAN reset password dan MENGAKTIFKAN 2FA untuk akun sendiri tidak
  // butuh izin apa pun: yang pertama memang terbuka tanpa sesi, yang kedua hak
  // setiap operator atas akunnya. Yang di-RBAC adalah membaca/menghapus jejak
  // pemulihan dan mematikan 2FA milik orang lain.
  {
    key: "password_reset.view",
    name: "View password reset history",
    group: "Operators",
  },
  {
    key: "password_reset.delete",
    name: "Delete password reset history",
    group: "Operators",
  },
  {
    key: "two_factor.reset",
    name: "Reset another operator's 2FA",
    group: "Operators",
  },
  // Menyetujui pemulihan berarti menyerahkan kendali sebuah akun kepada
  // orang yang sedang berdiri di depan layar, setelah peninjau melihat foto
  // wajahnya. Harus diberikan sadar, bukan ikut paket bawaan.
  {
    key: "password_reset.approve",
    name: "Approve password recovery",
    group: "System",
  },
  {
    key: "database_backup.export",
    name: "Export database backup",
    group: "System",
  },
  {
    key: "database_backup.restore",
    name: "Restore database from backup",
    group: "System",
  },
  { key: "operators.view", name: "View operators", group: "Operators" },
  { key: "operators.manage", name: "Manage operators", group: "Operators" },
  { key: "roles.manage", name: "Manage roles and access", group: "Roles" },
  {
    key: "settings.view",
    name: "View system settings",
    group: "Settings",
  },
  {
    key: "settings.manage",
    name: "Manage system settings",
    group: "Settings",
  },
  {
    key: "sync.view",
    name: "View sync status",
    group: "Sync",
  },
  {
    key: "sync.retry",
    name: "Retry sync and resolve conflicts",
    group: "Sync",
  },
  {
    key: "diagnostics.view",
    name: "View system diagnostics",
    group: "Diagnostics",
  },
] as const;

export type PermissionKey = (typeof PERMISSION_CATALOG)[number]["key"];

/**
 * Permission yang hanya boleh dipegang Superadmin.
 *
 * Ini pagar terakhir terhadap eskalasi hak akses: tanpa daftar ini, seorang
 * Admin yang punya `roles.manage` dapat memberikan dirinya sendiri hak apa pun.
 */
export const SUPERADMIN_ONLY_PERMISSIONS = new Set<PermissionKey>([
  "operators.view",
  "operators.manage",
  "roles.manage",
]);

/** Mutasi yang menghapus atau mengubah data historis. */
export const SENSITIVE_MUTATION_PERMISSIONS = new Set<PermissionKey>([
  // Menghapus riwayat reset menghilangkan satu-satunya jejak siapa yang pernah
  // mengajukan pemulihan beserta foto wajahnya. Mematikan 2FA orang lain
  // melucuti lapisan kedua akunnya. Keduanya berguna, tetapi harus diberikan
  // sadar lewat Role & Akses.
  "password_reset.delete",
  "two_factor.reset",
  // Memulihkan cadangan MENIMPA seluruh data perangkat dalam satu langkah.
  // Tidak ada operasi lain di aplikasi ini yang bisa menghapus sebanyak itu.
  "database_backup.restore",
  // Menyetujui pemulihan berarti menyerahkan kendali sebuah akun kepada orang
  // yang sedang berdiri di depan layar. Peninjaunya WAJIB sadar memikul itu.
  "password_reset.approve",
  "items.manage",
  "settings.manage",
]);

export const SYSTEM_ROLE_KEYS = ["superadmin", "admin", "operator"] as const;

export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export const DEFAULT_ROLE_PERMISSIONS: Record<
  Exclude<SystemRoleKey, "superadmin">,
  readonly PermissionKey[]
> = {
  // Mutasi sensitif TIDAK ikut paket bawaan: Admin tetap bisa mendapatkannya,
  // tetapi lewat keputusan sadar di layar Role & Akses. Daftar pengecualian ini
  // WAJIB sama dengan seed SQL di `db-schema.ts` dan `turso.rs`.
  admin: PERMISSION_CATALOG.filter(
    ({ key }) =>
      !SUPERADMIN_ONLY_PERMISSIONS.has(key) &&
      key !== "diagnostics.view" &&
      !SENSITIVE_MUTATION_PERMISSIONS.has(key),
  ).map(({ key }) => key),
  operator: [
    "home.view",
    "dashboard.view",
    "items.view",
    "activity.view",
    "activity.record",
    "sync.view",
  ],
};

export function normalizeRoleKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_CATALOG.some(({ key }) => key === value);
}

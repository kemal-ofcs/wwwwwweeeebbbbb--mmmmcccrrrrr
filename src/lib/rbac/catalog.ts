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
  { key: "clients.view", name: "View clients", group: "Clients" },
  { key: "clients.manage", name: "Manage clients", group: "Clients" },
  {
    key: "master_data.manage",
    name: "Manage master data",
    group: "Master data",
  },
  // Lihat semua lead; catat interaksi hanya di lead sendiri. Memindahkan PIC
  // sekaligus mencatat di lead siapa pun adalah `leads.reassign` (PRD OQ-34).
  { key: "leads.view", name: "View leads", group: "Leads" },
  { key: "leads.manage", name: "Manage own leads", group: "Leads" },
  { key: "leads.reassign", name: "Reassign leads", group: "Leads" },
  // Tiket sampel (PRD F-06). Di MVP pemegang `samples.manage` juga mencatat
  // langkah RnD dan Finance atas nama divisi itu (D-23).
  { key: "samples.view", name: "View sample requests", group: "Samples" },
  { key: "samples.manage", name: "Manage sample requests", group: "Samples" },
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
  {
    key: "sessions.manage",
    name: "Manage active sessions",
    group: "Operators",
  },
  { key: "audit.view", name: "View audit log", group: "Operators" },
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
  "settings.manage",
  // Izin domain yang bisa MENGHAPUS data bisnis (mis. `clients.delete` saat
  // ditambahkan) wajib didaftarkan di sini, bukan ikut paket Admin diam-diam.
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
  // Operator bawaan bekerja sebagai CS sampai role divisi dibuat (PRD F-02).
  // WAJIB sama dengan seed role 3 di `db-schema.ts` dan `turso.rs`.
  operator: [
    "home.view",
    "dashboard.view",
    "clients.view",
    "clients.manage",
    "leads.view",
    "leads.manage",
    "samples.view",
    "samples.manage",
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

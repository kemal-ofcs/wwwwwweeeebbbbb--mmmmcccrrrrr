import type { Client } from "@libsql/client";
import { runDatabaseMigrations } from "./db-migrations";

/**
 * Skema database cloud versi jalur Web.
 *
 * Database yang sama dapat dibuat oleh dua jalur: `turso.rs::ensure_schema`
 * (bootstrap dari Desktop/Mobile) dan berkas ini (aplikasi Web). Keduanya WAJIB
 * menghasilkan tabel dan kolom yang identik. `CREATE TABLE IF NOT EXISTS` tidak
 * pernah memperbaiki tabel yang sudah ada, sehingga satu perbedaan akan merusak
 * jalur yang tidak membuat tabel itu — secara permanen.
 *
 * Kolom yang hanya diketahui satu sisi harus masuk daftar `ensure_column` di
 * Rust DAN migrasi `ALTER TABLE` di `db-migrations.ts`, supaya klien mana pun
 * bisa menyembuhkan database buatan klien lain.
 */
export const CURRENT_SCHEMA_VERSION = 2;

/** Tabel yang wajib ada sebelum database dianggap siap dipakai. */
export const REQUIRED_TABLES = [
  // Infrastruktur autentikasi & RBAC
  "app_role",
  "app_permission",
  "role_permission",
  "role_permission_audit",
  "master_operator",
  "app_bootstrap_state",
  "app_session",
  "auth_login_rate_limit",
  // Pemulihan password lewat email + verifikasi wajah, dan konfigurasi
  // pengirimnya. Keduanya cloud-only: tidak pernah direplikasi ke SQLite
  // perangkat, karena berisi bukti foto, hash token, dan kunci API.
  "password_reset_request",
  "app_mail_config",
  // Infrastruktur sinkronisasi
  "schema_migration",
  "sync_changelog",
  "sync_change_log",
  "sync_operation_receipt",
  "setting_gex_system",
  // Identitas perusahaan pemakai aplikasi. Bagian platform, bukan domain
  // contoh: hampir setiap aplikasi bisnis membutuhkannya untuk kop dokumen,
  // cetakan, dan ekspor.
  "company_profile",
  // Domain contoh — ganti dengan tabel aplikasi Anda
  "master_item",
  "log_aktivitas",
] as const;

export const REQUIRED_TABLE_COUNT = REQUIRED_TABLES.length;

export async function isDatabaseSchemaReady(client: Client) {
  try {
    const names = REQUIRED_TABLES.map((name) => `'${name}'`).join(", ");
    const result = await client.execute(`
      SELECT
        COALESCE((SELECT MAX(version) FROM schema_migration), 0) AS version,
        (
          SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'table' AND name IN (${names})
        ) AS table_count;
    `);
    return (
      Number(result.rows[0]?.version ?? 0) >= CURRENT_SCHEMA_VERSION &&
      Number(result.rows[0]?.table_count ?? 0) === REQUIRED_TABLE_COUNT
    );
  } catch {
    return false;
  }
}

/**
 * Database pra-rilis yang dibuat sebelum nilai tersimpan diganti ke bahasa
 * Inggris masih membawa CHECK lama (`'Aktif'`, `'Menunggu Verifikasi'`). SQLite
 * tidak bisa mengubah CHECK di tempat, jadi database itu ditolak dengan pesan
 * yang jelas alih-alih gagal di tengah login. WAJIB identik dengan
 * `LEGACY_STORED_VALUES_SQL` di `turso.rs`.
 */
export const LEGACY_STORED_VALUES_SQL =
  "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name IN ('app_role', 'password_reset_request') AND (sql LIKE '%''Aktif''%' OR sql LIKE '%''Menunggu Verifikasi''%');";

export const LEGACY_STORED_VALUES_MESSAGE =
  "This database was created by a pre-release build that stored values in Indonesian. It cannot be upgraded in place. Create a new database (or a new Local Database Mode file) and connect this device to it.";

async function rejectLegacyStoredValues(client: Client) {
  const result = await client.execute(LEGACY_STORED_VALUES_SQL);
  if (Number(result.rows[0]?.total ?? 0) > 0) {
    throw new Error(LEGACY_STORED_VALUES_MESSAGE);
  }
}

export async function initDatabaseSchema(client: Client) {
  await rejectLegacyStoredValues(client);
  if (await isDatabaseSchemaReady(client)) return;

  const statements = [
    `CREATE TABLE IF NOT EXISTS schema_migration (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
      );`,
    `CREATE TABLE IF NOT EXISTS app_role (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_key TEXT UNIQUE NOT NULL,
      nama_role TEXT UNIQUE NOT NULL,
      deskripsi TEXT,
      is_system INTEGER NOT NULL DEFAULT 0 CHECK(is_system IN (0, 1)),
      is_superadmin INTEGER NOT NULL DEFAULT 0 CHECK(is_superadmin IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active', 'Inactive')),
      require_totp INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT
      );`,
    `CREATE TABLE IF NOT EXISTS app_permission (
      permission_key TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      grup TEXT NOT NULL,
      deskripsi TEXT,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0
      );`,
    `CREATE TABLE IF NOT EXISTS role_permission (
      role_id INTEGER NOT NULL,
      permission_key TEXT NOT NULL,
      is_allowed INTEGER NOT NULL DEFAULT 0 CHECK(is_allowed IN (0, 1)),
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      PRIMARY KEY (role_id, permission_key),
      FOREIGN KEY (role_id) REFERENCES app_role(id) ON DELETE CASCADE,
      FOREIGN KEY (permission_key) REFERENCES app_permission(permission_key) ON DELETE CASCADE
      );`,
    `CREATE TABLE IF NOT EXISTS role_permission_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id INTEGER NOT NULL,
      permission_key TEXT NOT NULL,
      before_allowed INTEGER NOT NULL,
      after_allowed INTEGER NOT NULL,
      changed_at TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      revision INTEGER NOT NULL
      );`,
    `CREATE TABLE IF NOT EXISTS master_operator (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kode_operator TEXT UNIQUE NOT NULL,
      nama_operator TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Operator' CHECK(role IN ('Admin', 'Operator', 'Scanner')),
      role_id INTEGER REFERENCES app_role(id),
      email TEXT,
      no_hp TEXT,
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      totp_confirmed_at TEXT,
      totp_recovery_codes TEXT,
      status TEXT DEFAULT 'Active',
      created_at TEXT,
      updated_at TEXT
      );`,
    `CREATE TABLE IF NOT EXISTS app_bootstrap_state (
      bootstrap_key TEXT PRIMARY KEY,
      claimed_at TEXT NOT NULL
      );`,
    `CREATE TABLE IF NOT EXISTS app_session (
      session_id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      operator_id INTEGER NOT NULL,
      permission_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_reason TEXT,
      user_agent_hash TEXT,
      FOREIGN KEY (operator_id) REFERENCES master_operator(id) ON DELETE CASCADE
      );`,
    `CREATE TABLE IF NOT EXISTS auth_login_rate_limit (
      rate_key TEXT PRIMARY KEY,
      attempt_count INTEGER NOT NULL,
      window_started_at TEXT NOT NULL,
      blocked_until TEXT,
      updated_at TEXT NOT NULL
      );`,
    `CREATE TABLE IF NOT EXISTS password_reset_request (
      id TEXT PRIMARY KEY,
      operator_id INTEGER NOT NULL,
      identifier_used TEXT NOT NULL,
      contact_channel TEXT NOT NULL DEFAULT 'email',
      contact_target TEXT NOT NULL,
      challenge_hash TEXT NOT NULL,
      challenge_sequence TEXT NOT NULL,
      token_hash TEXT,
      status TEXT NOT NULL DEFAULT 'Pending Verification'
        CHECK(status IN (
          'Pending Verification', 'Sent', 'Used', 'Expired', 'Cancelled'
        )),
      liveness_score REAL,
      liveness_report TEXT,
      photo_mime TEXT,
      photo_base64 TEXT,
      delivery_status TEXT,
      delivery_error TEXT,
      requested_at TEXT NOT NULL,
      verified_at TEXT,
      sent_at TEXT,
      used_at TEXT,
      expires_at TEXT NOT NULL,
      request_ip_hash TEXT,
      user_agent_hash TEXT,
      FOREIGN KEY (operator_id) REFERENCES master_operator(id) ON DELETE CASCADE
      );`,
    `CREATE TABLE IF NOT EXISTS app_mail_config (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'resend'
        CHECK(provider IN ('resend', 'brevo')),
      api_key TEXT,
      sender_email TEXT,
      sender_name TEXT,
      reset_base_url TEXT,
      is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0, 1)),
      updated_at TEXT NOT NULL,
      updated_by TEXT
      );`,
    `CREATE TABLE IF NOT EXISTS sync_changelog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      domain TEXT NOT NULL,
      operation TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
      );`,
    `CREATE TABLE IF NOT EXISTS sync_change_log (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      actor_operator_id INTEGER NOT NULL
      );`,
    `CREATE TABLE IF NOT EXISTS sync_operation_receipt (
      event_id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      operation TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('applied', 'rejected', 'conflict')),
      result_json TEXT NOT NULL,
      base_revision INTEGER,
      server_revision INTEGER,
      actor_operator_id INTEGER NOT NULL,
      receipt_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      processed_at TEXT NOT NULL
      );`,
    `CREATE TABLE IF NOT EXISTS setting_gex_system (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
      );`,
    // Satu baris, selamanya: kuncinya konstanta 'default_company'. Definisinya
    // WAJIB sama persis dengan `turso.rs` dan `storage.rs` —
    // `CREATE TABLE IF NOT EXISTS` tidak pernah memperbaiki tabel yang sudah
    // ada, jadi satu perbedaan merusak jalur yang tidak membuat tabel itu,
    // secara permanen.
    `CREATE TABLE IF NOT EXISTS company_profile (
      id TEXT PRIMARY KEY DEFAULT 'default_company',
      company_name TEXT NOT NULL DEFAULT 'Company Name',
      branch_name TEXT,
      logo_url TEXT,
      signature_url TEXT,
      address TEXT,
      phone TEXT,
      email TEXT,
      website TEXT,
      leader_name TEXT,
      leader_title TEXT,
      timezone TEXT DEFAULT 'Asia/Jakarta',
      updated_at TEXT NOT NULL
      );`,

    // ============ DOMAIN CONTOH — GANTI DENGAN MILIK ANDA ============
    // DDL ini disalin dari `turso.rs` agar kedua jalur provisioning —
    // bootstrap dari perangkat dan inisialisasi dari Web — menghasilkan
    // tabel yang persis sama. `CREATE TABLE IF NOT EXISTS` tidak pernah
    // memperbaiki tabel yang sudah ada, jadi satu perbedaan akan merusak
    // jalur yang tidak membuat tabel itu, secara permanen.
    `CREATE TABLE IF NOT EXISTS master_item (
      id_item INTEGER PRIMARY KEY AUTOINCREMENT,
      kode_item TEXT NOT NULL UNIQUE,
      nama TEXT NOT NULL,
      kategori TEXT,
      harga INTEGER NOT NULL DEFAULT 0 CHECK (harga >= 0),
      satuan TEXT,
      catatan TEXT,
      status_aktif TEXT NOT NULL DEFAULT 'Active'
      CHECK (status_aktif IN ('Active', 'Inactive')),
      update_terakhir TEXT NOT NULL
      );`,
    `CREATE TABLE IF NOT EXISTS log_aktivitas (
      id_log INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      kode_item TEXT NOT NULL,
      jenis TEXT NOT NULL,
      jumlah INTEGER NOT NULL DEFAULT 0,
      keterangan TEXT,
      kode_operator TEXT,
      waktu TEXT NOT NULL
      );`,
    // =================================================================

    `CREATE INDEX IF NOT EXISTS idx_operator_username ON master_operator(username);`,
    `CREATE INDEX IF NOT EXISTS idx_item_status ON master_item(status_aktif);`,
    `CREATE INDEX IF NOT EXISTS idx_aktivitas_item_waktu ON log_aktivitas(kode_item, waktu);`,

    // Seed role bawaan. TIDAK ADA akun bawaan: operator pertama hanya lahir
    // lewat provisioning sekali-pakai, sehingga tidak ada kredensial default
    // yang seragam di semua instalasi.
    `INSERT OR IGNORE INTO app_role (id, role_key, nama_role, deskripsi, is_system, is_superadmin, status, created_at, updated_at) VALUES
      (1, 'superadmin', 'Superadmin', 'Full access owner who manages the app roles.', 1, 1, 'Active', datetime('now'), datetime('now')),
      (2, 'admin', 'Admin', 'Operations administrator, per the permission matrix.', 1, 0, 'Active', datetime('now'), datetime('now')),
      (3, 'operator', 'Operator', 'Daily operator, per the permission matrix.', 1, 0, 'Active', datetime('now'), datetime('now'));`,

    // Katalog permission. WAJIB identik dengan seed di `turso.rs` dan daftar di
    // `src/lib/rbac/catalog.ts`.
    `INSERT OR IGNORE INTO app_permission (permission_key, nama, grup, deskripsi, is_active, sort_order) VALUES
      ('home.view', 'Home and navigation access', 'Navigation', 'View home and the app menu.', 1, 10),
      ('dashboard.view', 'Dashboard access', 'Dashboard', 'View summaries and statistics.', 1, 20),
      ('items.view', 'View items', 'Master data', 'View the item list.', 1, 30),
      ('items.manage', 'Manage items', 'Master data', 'Add, edit, and deactivate items.', 1, 40),
      ('activity.view', 'View activity log', 'Operations', 'View activity history.', 1, 50),
      ('activity.record', 'Record activity', 'Operations', 'Record new activity.', 1, 60),
      ('password_reset.view', 'View password reset history', 'Operators', 'Review who requested a password recovery, with their verification photo.', 1, 62),
      ('password_reset.delete', 'Delete password reset history', 'Operators', 'Delete password recovery records and their photos.', 1, 64),
      ('two_factor.reset', 'Reset another operator''s 2FA', 'Operators', 'Turn off two-step verification for another operator who lost their phone.', 1, 66),
      ('password_reset.approve', 'Approve password recovery', 'System', 'Review the requester''s photo, then hand over a password recovery code.', 1, 65),
      ('database_backup.export', 'Export database backup', 'System', 'Export the entire database into one backup file.', 1, 66),
      ('database_backup.restore', 'Restore database from backup', 'System', 'Replace all device data with the contents of a backup file.', 1, 67),
      ('operators.view', 'View operators', 'Operators', 'View operator and user account data.', 1, 70),
      ('operators.manage', 'Manage operators', 'Operators', 'Add and edit app operators.', 1, 80),
      ('roles.manage', 'Manage roles and access', 'Roles', 'Set the permission matrix of each role.', 1, 90),
      ('settings.view', 'View system settings', 'Settings', 'View app and database settings.', 1, 100),
      ('settings.manage', 'Manage system settings', 'Settings', 'Change app and database settings.', 1, 110),
      ('sync.view', 'View sync status', 'Sync', 'View the sync indicator and queue.', 1, 120),
      ('sync.retry', 'Retry sync and resolve conflicts', 'Sync', 'Trigger a manual sync and resolve conflicts.', 1, 130),
      ('diagnostics.view', 'View system diagnostics', 'Diagnostics', 'View runtime information and database health.', 1, 140);`,

    `INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by)
      SELECT 1, permission_key, 1, datetime('now'), 'system' FROM app_permission;`,
    `INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by)
      SELECT 2, permission_key, 1, datetime('now'), 'system' FROM app_permission
      WHERE permission_key NOT IN (
        'roles.manage', 'operators.manage', 'operators.view', 'diagnostics.view',
        'password_reset.delete', 'two_factor.reset', 'password_reset.approve',
        'database_backup.restore', 'items.manage', 'settings.manage'
      );`,

    // `rbac_revision` WAJIB ada: nilainya yang dipakai Web dan perangkat untuk
    // mendeteksi pencabutan hak akses tanpa menunggu login ulang.
    `INSERT OR IGNORE INTO setting_gex_system (key, value) VALUES
      ('app_name', 'App Template'),
      ('rbac_revision', '1');`,

    // Angka 1 di sini disengaja dan TIDAK boleh diikatkan ke
    // `CURRENT_SCHEMA_VERSION`: baris ini menandai fondasi versi 1, sedangkan
    // versi berikutnya dicatat masing-masing oleh `runDatabaseMigrations`.
    // Mengikatkannya ke konstanta akan membuat riwayat migrasi melompat dan
    // database lama tampak sudah berada di versi terbaru padahal belum.
    `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
      VALUES (1, 'template-foundation-v1', datetime('now'));`,
  ];

  for (const sql of statements) {
    await client.execute(sql);
  }

  await runDatabaseMigrations(client);
}

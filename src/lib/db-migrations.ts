import type { Client } from "@libsql/client";

/**
 * Penyembuhan skema untuk database yang sudah terlanjur dibuat versi lama.
 *
 * `CREATE TABLE IF NOT EXISTS` di `db-schema.ts` tidak pernah memperbaiki tabel
 * yang sudah ada. Setiap kolom baru karena itu WAJIB punya dua tempat:
 *
 * 1. `CREATE TABLE` di `db-schema.ts` dan `turso.rs` — untuk database baru.
 * 2. `ALTER TABLE` di berkas ini dan daftar `ensure_column` di `turso.rs` —
 *    untuk database yang sudah ada.
 *
 * Tanpa pasangan itu, database yang lahir dari jalur Web akan kehilangan kolom
 * yang hanya dibuat jalur Rust (dan sebaliknya), dan klien yang tidak
 * membuatnya akan gagal permanen pada tabel tersebut.
 *
 * SQLite menolak `ADD COLUMN` dengan default non-konstan seperti
 * `datetime('now')`, jadi kolom tambahan wajib nullable atau berdefault konstan.
 */
interface ColumnMigration {
  readonly table: string;
  readonly column: string;
  readonly sql: string;
}

const COLUMN_MIGRATIONS: readonly ColumnMigration[] = [
  // Kontak operator: wajib diisi lewat validasi aplikasi, tetapi NULL-able di
  // DDL supaya baris operator lama tidak rusak saat migrasi berjalan. Email
  // adalah satu-satunya jalur pengiriman link "Lupa Password".
  {
    table: "master_operator",
    column: "email",
    sql: "ALTER TABLE master_operator ADD COLUMN email TEXT;",
  },
  {
    table: "master_operator",
    column: "no_hp",
    sql: "ALTER TABLE master_operator ADD COLUMN no_hp TEXT;",
  },
  // Verifikasi dua langkah. `totp_enabled` sengaja tanpa CHECK: SQLite
  // membatasi bentuk constraint pada ALTER TABLE ADD COLUMN, dan menaruh CHECK
  // hanya di CREATE TABLE akan membuat database hasil migrasi berbeda dari
  // database baru.
  {
    table: "master_operator",
    column: "totp_secret",
    sql: "ALTER TABLE master_operator ADD COLUMN totp_secret TEXT;",
  },
  {
    table: "master_operator",
    column: "totp_enabled",
    sql: "ALTER TABLE master_operator ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;",
  },
  {
    table: "master_operator",
    column: "totp_confirmed_at",
    sql: "ALTER TABLE master_operator ADD COLUMN totp_confirmed_at TEXT;",
  },
  {
    table: "master_operator",
    column: "totp_recovery_codes",
    sql: "ALTER TABLE master_operator ADD COLUMN totp_recovery_codes TEXT;",
  },
  // Kode pemulihan password Superadmin. Dieja di sini DAN di daftar
  // ensure_column milik `turso.rs`, supaya klien mana pun bisa menyembuhkan
  // database yang dibuat jalur lainnya.
  {
    table: "master_operator",
    column: "password_recovery_codes",
    sql: "ALTER TABLE master_operator ADD COLUMN password_recovery_codes TEXT;",
  },
  {
    table: "master_operator",
    column: "password_recovery_created_at",
    sql: "ALTER TABLE master_operator ADD COLUMN password_recovery_created_at TEXT;",
  },
  {
    table: "app_role",
    column: "require_totp",
    sql: "ALTER TABLE app_role ADD COLUMN require_totp INTEGER NOT NULL DEFAULT 0;",
  },
  {
    table: "master_operator",
    column: "role_id",
    sql: "ALTER TABLE master_operator ADD COLUMN role_id INTEGER REFERENCES app_role(id);",
  },
  {
    table: "master_operator",
    column: "created_at",
    sql: "ALTER TABLE master_operator ADD COLUMN created_at TEXT;",
  },
  {
    table: "master_operator",
    column: "updated_at",
    sql: "ALTER TABLE master_operator ADD COLUMN updated_at TEXT;",
  },
  {
    table: "sync_operation_receipt",
    column: "payload_hash",
    sql: "ALTER TABLE sync_operation_receipt ADD COLUMN payload_hash TEXT;",
  },
  {
    table: "sync_operation_receipt",
    column: "result_json",
    sql: "ALTER TABLE sync_operation_receipt ADD COLUMN result_json TEXT;",
  },
  {
    table: "sync_operation_receipt",
    column: "base_revision",
    sql: "ALTER TABLE sync_operation_receipt ADD COLUMN base_revision INTEGER;",
  },
  {
    table: "sync_operation_receipt",
    column: "actor_operator_id",
    sql: "ALTER TABLE sync_operation_receipt ADD COLUMN actor_operator_id INTEGER;",
  },
  {
    table: "sync_operation_receipt",
    column: "processed_at",
    sql: "ALTER TABLE sync_operation_receipt ADD COLUMN processed_at TEXT;",
  },
];

async function tableExists(client: Client, table: string) {
  const result = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1;",
    args: [table],
  });
  return result.rows.length > 0;
}

async function columnExists(client: Client, table: string, column: string) {
  try {
    const result = await client.execute(`PRAGMA table_info(${table});`);
    return result.rows.some((row) => String(row.name) === column);
  } catch {
    return false;
  }
}

/**
 * Indeks yang memakai kolom hasil migrasi, dibuat SETELAH kolomnya dipastikan
 * ada.
 *
 * Menaruhnya di dalam DDL awal akan gagal pada database yang sudah berjalan —
 * kolomnya belum ada di sana — dan satu statement yang gagal membatalkan
 * seluruh pipeline, sehingga migrasi kolomnya sendiri tidak pernah sempat
 * berjalan dan database lama terkunci selamanya.
 */
const INDEX_MIGRATIONS: readonly string[] = [
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_master_operator_email ON master_operator(LOWER(email)) WHERE email IS NOT NULL AND TRIM(email) <> '';",
  "CREATE INDEX IF NOT EXISTS idx_password_reset_operator ON password_reset_request(operator_id, status, requested_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_request(token_hash);",
  "CREATE INDEX IF NOT EXISTS idx_password_reset_challenge ON password_reset_request(challenge_hash);",
];

export async function runDatabaseMigrations(client: Client) {
  for (const migration of COLUMN_MIGRATIONS) {
    if (!(await tableExists(client, migration.table))) continue;
    if (await columnExists(client, migration.table, migration.column)) continue;
    try {
      await client.execute(migration.sql);
    } catch {
      // Kolom bisa saja ditambahkan klien lain di antara pemeriksaan dan
      // eksekusi. Itu bukan kegagalan: tujuan migrasi sudah tercapai.
    }
  }

  for (const sql of INDEX_MIGRATIONS) {
    try {
      await client.execute(sql);
    } catch {
      // Tabelnya mungkin belum ada pada database yang sangat lama; DDL awal
      // akan membuatnya lengkap dengan indeksnya.
    }
  }

  // Baris konfigurasi email bawaan.
  //
  // Jalur Rust menyeednya di `turso.rs::ensure_schema`; tanpa baris yang sama di
  // sini, database yang di-provisioning dari Web tidak punya baris itu sama
  // sekali — dua jalur provisioning menghasilkan isi yang berbeda, persis kelas
  // kesalahan yang dijaga `audit:contract`. `is_active = 0` disengaja: email
  // baru menyala setelah Superadmin mengisinya, dan sampai saat itu pemulihan
  // password memakai jalur persetujuan di aplikasi.
  await client.execute({
    sql: `INSERT OR IGNORE INTO app_mail_config (
            id, provider, api_key, sender_email, sender_name,
            reset_base_url, is_active, updated_at, updated_by
          ) VALUES ('default', 'resend', NULL, NULL, NULL, NULL, 0, ?, 'migration');`,
    args: [new Date().toISOString()],
  });

  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (2, 'password-reset-and-two-factor', ?);`,
    args: [new Date().toISOString()],
  });
}

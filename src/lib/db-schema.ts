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
export const CURRENT_SCHEMA_VERSION = 16;

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
  // Domain MaklonOS: klien, lead, dan daftar pilihan Master Data (ikut
  // sinkronisasi), serta registri tag perangkat untuk kode klien (cloud-only).
  "clients",
  "leads",
  "master_option",
  "device_tag_registry",
  // Catatan follow up dan respons klien per lead (PRD FR-05), ikut sinkronisasi.
  "lead_interactions",
  // Log audit domain (PRD F-10): ditulis perangkat dan Web, hanya-tambah.
  "domain_audit_log",
  // Tiket sampel (PRD F-06): tiket, keputusan klien per iterasi, dan riwayat
  // langkahnya. Ketiganya ikut sinkronisasi.
  "sample_requests",
  "sample_feedbacks",
  "sample_status_log",
  // Formula per sampel yang selesai dibuat RnD (v2.1, PRD F-14), ikut sinkronisasi.
  "sample_formulas",
  // Harga Finance per iterasi tiket (v2.2, PRD F-16), ikut sinkronisasi.
  "pricing_formulas",
  // Tagihan, uang masuk, alokasi, dan daftar pajak/diskon (v2.3a, PRD F-17).
  // Keempatnya ikut sinkronisasi.
  "finance_options",
  "invoices",
  "incoming_funds",
  "fund_allocations",
  // Tiket desain: mockup dan dummy (v2.4, PRD F-19), ikut sinkronisasi.
  "design_tickets",
  // MoU produksi (v2.5a, PRD F-20), ikut sinkronisasi.
  "production_mou",
  // Dokumen legal per MoU (v2.6, PRD F-21), ikut sinkronisasi.
  "legal_documents",
  // Arsip impor Database Formulasi/Desain (v2.7, PRD F-22), ikut sinkronisasi.
  "imported_records",
  // Foto (PRD F-07). Isi gambar tidak pernah ikut snapshot perangkat.
  "media_asset",
  // Notifikasi divisi (PRD FR-08). Ketiganya cloud-only.
  "notification_outbox",
  "telegram_config",
  "notification_seen",
  // Tautan persetujuan klien (v2.5b, PRD F-18), cloud-only: hanya hash token.
  "approval_tokens",
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

/**
 * Seed role divisi. WAJIB identik (per karakter) dengan seed yang sama di
 * `turso.rs`; `division-roles.test.ts` membandingkan keduanya. Urutannya
 * penting: penanda ditulis terakhir.
 */
export const DIVISION_ROLE_SEED_SQL = [
  "INSERT OR IGNORE INTO app_role (role_key, nama_role, deskripsi, is_system, is_superadmin, status, created_at, updated_at) SELECT column1, column2, column3, 0, 0, 'Active', datetime('now'), datetime('now') FROM (VALUES ('cs', 'CS', 'Customer service: registers leads and follows them up.'), ('crm', 'CRM', 'Client relationship after the first order.'), ('rnd', 'R&D', 'Formulation and samples.'), ('finance', 'Finance', 'Invoices and payments.'), ('design', 'Design', 'Mockups and dummies.'), ('legal', 'Legal', 'BPOM, halal, and trademark filings.'), ('ppic', 'PPIC', 'Production planning and materials.'), ('production_spv', 'Production SPV', 'Production floor supervision.'), ('qc', 'QC', 'Quality control and claims.'), ('logistics', 'Logistics', 'Shipping and delivery.')) WHERE NOT EXISTS (SELECT 1 FROM setting_gex_system WHERE key = 'division_roles_seeded');",
  "INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by) SELECT r.id, p.permission_key, 1, datetime('now'), 'system' FROM app_role r JOIN app_permission p ON p.permission_key IN ('home.view', 'dashboard.view', 'sync.view') OR (r.role_key IN ('cs', 'crm') AND p.permission_key IN ('clients.view', 'leads.view')) OR (r.role_key = 'cs' AND p.permission_key IN ('clients.manage', 'leads.manage')) WHERE r.role_key IN ('cs', 'crm', 'rnd', 'finance', 'design', 'legal', 'ppic', 'production_spv', 'qc', 'logistics') AND NOT EXISTS (SELECT 1 FROM setting_gex_system WHERE key = 'division_roles_seeded');",
  "INSERT OR IGNORE INTO setting_gex_system (key, value) VALUES ('division_roles_seeded', '1');",
];

/**
 * WAJIB identik dengan seed yang sama di `turso.rs` (dites per karakter).
 * Dijaga penanda `sample_permissions_seeded`: izin yang dicabut Admin dari
 * role CS/CRM tidak kembali saat skema naik versi.
 */
export const SAMPLE_PERMISSION_SEED_SQL = [
  "INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by) SELECT r.id, p.permission_key, 1, datetime('now'), 'system' FROM app_role r JOIN app_permission p ON (r.role_key IN ('cs', 'crm') AND p.permission_key = 'samples.view') OR (r.role_key = 'cs' AND p.permission_key = 'samples.manage') WHERE r.role_key IN ('cs', 'crm') AND NOT EXISTS (SELECT 1 FROM setting_gex_system WHERE key = 'sample_permissions_seeded');",
  "INSERT OR IGNORE INTO setting_gex_system (key, value) VALUES ('sample_permissions_seeded', '1');",
];

/**
 * Izin lonceng per divisi (PRD FR-08) untuk role divisi CS/RnD/Finance, sekali
 * saja. WAJIB identik dengan seed yang sama di `turso.rs` (dites per karakter).
 */
export const NOTIFICATION_PERMISSION_SEED_SQL = [
  "INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by) SELECT r.id, p.permission_key, 1, datetime('now'), 'system' FROM app_role r JOIN app_permission p ON (r.role_key = 'cs' AND p.permission_key = 'notifications_cs.view') OR (r.role_key = 'rnd' AND p.permission_key = 'notifications_rnd.view') OR (r.role_key = 'finance' AND p.permission_key = 'notifications_finance.view') WHERE r.role_key IN ('cs', 'rnd', 'finance') AND NOT EXISTS (SELECT 1 FROM setting_gex_system WHERE key = 'notification_permissions_seeded');",
  "INSERT OR IGNORE INTO setting_gex_system (key, value) VALUES ('notification_permissions_seeded', '1');",
];

/**
 * Izin RnD (v2.1, PRD F-14) untuk role divisi RnD, sekali saja. WAJIB identik
 * dengan seed yang sama di `turso.rs` (dites per karakter).
 */
export const RND_PERMISSION_SEED_SQL = [
  "INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by) SELECT r.id, p.permission_key, 1, datetime('now'), 'system' FROM app_role r JOIN app_permission p ON p.permission_key IN ('rnd.manage', 'samples.view', 'clients.view') WHERE r.role_key = 'rnd' AND NOT EXISTS (SELECT 1 FROM setting_gex_system WHERE key = 'rnd_permissions_seeded');",
  "INSERT OR IGNORE INTO setting_gex_system (key, value) VALUES ('rnd_permissions_seeded', '1');",
];

/**
 * Izin Finance (v2.2, PRD F-15/F-16) untuk role divisi Finance, sekali saja.
 * WAJIB identik dengan seed yang sama di `turso.rs` (dites per karakter).
 */
export const FINANCE_PERMISSION_SEED_SQL = [
  "INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by) SELECT r.id, p.permission_key, 1, datetime('now'), 'system' FROM app_role r JOIN app_permission p ON p.permission_key IN ('finance.manage', 'pricing.view', 'samples.view', 'clients.view') WHERE r.role_key = 'finance' AND NOT EXISTS (SELECT 1 FROM setting_gex_system WHERE key = 'finance_permissions_seeded');",
  "INSERT OR IGNORE INTO setting_gex_system (key, value) VALUES ('finance_permissions_seeded', '1');",
];

/**
 * Izin melihat tagihan (v2.3a, PRD F-17) untuk role divisi CS dan Finance,
 * sekali saja. WAJIB identik dengan seed yang sama di `turso.rs`.
 */
export const INVOICE_PERMISSION_SEED_SQL = [
  "INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by) SELECT r.id, p.permission_key, 1, datetime('now'), 'system' FROM app_role r JOIN app_permission p ON p.permission_key = 'invoices.view' WHERE r.role_key IN ('cs', 'finance') AND NOT EXISTS (SELECT 1 FROM setting_gex_system WHERE key = 'invoice_permissions_seeded');",
  "INSERT OR IGNORE INTO setting_gex_system (key, value) VALUES ('invoice_permissions_seeded', '1');",
];

/**
 * Izin Desain (v2.4, PRD F-19) untuk role divisi Design, sekali saja. WAJIB
 * identik dengan seed yang sama di `turso.rs` (dites per karakter).
 */
export const DESIGN_PERMISSION_SEED_SQL = [
  "INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by) SELECT r.id, p.permission_key, 1, datetime('now'), 'system' FROM app_role r JOIN app_permission p ON p.permission_key IN ('design.manage', 'samples.view', 'clients.view', 'notifications_design.view') WHERE r.role_key = 'design' AND NOT EXISTS (SELECT 1 FROM setting_gex_system WHERE key = 'design_permissions_seeded');",
  "INSERT OR IGNORE INTO setting_gex_system (key, value) VALUES ('design_permissions_seeded', '1');",
];

/**
 * Izin MoU (v2.5a, PRD F-20) untuk role divisi CS, sekali saja. WAJIB
 * identik dengan seed yang sama di `turso.rs` (dites per karakter).
 */
export const MOU_PERMISSION_SEED_SQL = [
  "INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by) SELECT r.id, p.permission_key, 1, datetime('now'), 'system' FROM app_role r JOIN app_permission p ON p.permission_key = 'mou.manage' WHERE r.role_key = 'cs' AND NOT EXISTS (SELECT 1 FROM setting_gex_system WHERE key = 'mou_permissions_seeded');",
  "INSERT OR IGNORE INTO setting_gex_system (key, value) VALUES ('mou_permissions_seeded', '1');",
];

/**
 * Izin dokumen legal (v2.6, PRD F-21) untuk role divisi Legal, sekali saja.
 * WAJIB identik dengan seed yang sama di `turso.rs` (dites per karakter).
 */
export const LEGAL_PERMISSION_SEED_SQL = [
  "INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by) SELECT r.id, p.permission_key, 1, datetime('now'), 'system' FROM app_role r JOIN app_permission p ON p.permission_key IN ('legal.manage', 'samples.view', 'clients.view') WHERE r.role_key = 'legal' AND NOT EXISTS (SELECT 1 FROM setting_gex_system WHERE key = 'legal_permissions_seeded');",
  "INSERT OR IGNORE INTO setting_gex_system (key, value) VALUES ('legal_permissions_seeded', '1');",
];

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
      client_kind TEXT NOT NULL DEFAULT 'web',
      device_label TEXT NOT NULL DEFAULT '',
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

    // ============ DOMAIN MAKLONOS ============
    // DDL ini WAJIB identik dengan `turso.rs` (cloud) dan, untuk tabel yang ikut
    // sinkronisasi, dengan `storage.rs` (lokal). `CREATE TABLE IF NOT EXISTS`
    // tidak pernah memperbaiki tabel yang sudah ada, jadi satu perbedaan
    // merusak jalur yang tidak membuat tabel itu, secara permanen.
    //
    // Tanpa CHECK dan tanpa FOREIGN KEY, sengaja: nilai divalidasi aplikasi
    // (`src/lib/validations/client.ts` dan `clients.rs`). CHECK di tabel yang
    // ikut sinkron membuat perangkat versi lama menolak nilai baru dari cloud,
    // dan FK bisa menolak snapshot yang tiba dengan urutan tabel berbeda.
    // Keunikan nomor WhatsApp dan kode klien juga dijaga aplikasi, bukan
    // UNIQUE: dua perangkat offline yang bertabrakan akan membuat push macet.
    `CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      client_code TEXT NOT NULL,
      name TEXT NOT NULL,
      phone_normalized TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      province TEXT NOT NULL DEFAULT '',
      lifecycle_status TEXT NOT NULL DEFAULT 'LEAD',
      free_revision_limit INTEGER NOT NULL DEFAULT 1,
      is_white_label INTEGER NOT NULL DEFAULT 0,
      assigned_crm_id INTEGER,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
      );`,
    `CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      pic_cs_id INTEGER,
      channel_option_id TEXT NOT NULL,
      product_category_option_id TEXT NOT NULL,
      needs_notes TEXT NOT NULL DEFAULT '',
      last_followup_at TEXT NOT NULL DEFAULT '',
      last_client_response_at TEXT NOT NULL DEFAULT '',
      total_followups INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
      );`,
    `CREATE TABLE IF NOT EXISTS master_option (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      code TEXT NOT NULL,
      label TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
      );`,
    // Satu baris per follow up CS (`OUTBOUND`) atau respons klien (`INBOUND`).
    // Ringkasan di `leads` diperbarui bersamaan, dengan aturan yang aman
    // diulang, supaya dua perangkat offline yang mencatat di lead yang sama
    // tidak saling menimpa (PRD FR-05.1, E-05).
    `CREATE TABLE IF NOT EXISTS lead_interactions (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      operator_id INTEGER,
      direction TEXT NOT NULL,
      kind TEXT NOT NULL,
      notes TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
      );`,
    // Log audit domain (PRD FR-10). Hanya-tambah: rute sync `audit/record`
    // hanya menyisipkan, dan tidak ada jalur aplikasi yang mengubah atau
    // menghapusnya. Perangkat menulisnya dalam transaksi yang sama dengan
    // mutasinya lalu mendorongnya lewat outbox; tabel ini tidak ditarik ulang.
    `CREATE TABLE IF NOT EXISTS domain_audit_log (
      id TEXT PRIMARY KEY,
      actor_operator_id INTEGER,
      on_behalf_of_division TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL
      );`,
    // Tiket sampel (PRD FR-06). `status` dan `revision_index` hanya berubah
    // lewat rute `sample/transition` yang diperiksa terhadap status cloud
    // (konflik bila perangkat lain sudah memindahkannya lebih dulu).
    // `status_changed_at` untuk lencana "sudah berapa lama di status ini".
    `CREATE TABLE IF NOT EXISTS sample_requests (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      lead_id TEXT NOT NULL DEFAULT '',
      sample_kind_option_id TEXT NOT NULL DEFAULT '',
      formulation_type_option_id TEXT NOT NULL DEFAULT '',
      registration_category_option_id TEXT NOT NULL DEFAULT '',
      rnd_product_class TEXT NOT NULL DEFAULT '',
      product_category_option_id TEXT NOT NULL,
      pic_crm_id INTEGER,
      sample_qty INTEGER NOT NULL,
      brand_name TEXT NOT NULL,
      bpom_product_name TEXT NOT NULL DEFAULT '',
      claims TEXT NOT NULL DEFAULT '',
      packaging TEXT NOT NULL,
      reference_notes TEXT NOT NULL DEFAULT '',
      client_budget_idr INTEGER,
      special_requests_json TEXT NOT NULL DEFAULT '{}',
      deadline_at TEXT NOT NULL,
      ship_to_address TEXT NOT NULL,
      is_dummy_required INTEGER NOT NULL DEFAULT 0,
      is_paid_sample INTEGER NOT NULL DEFAULT 0,
      revision_index INTEGER NOT NULL DEFAULT 0,
      is_billable INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      rnd_lead_time_days INTEGER,
      sent_at TEXT NOT NULL DEFAULT '',
      status_changed_at TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      rnd_reject_reason_option_id TEXT NOT NULL DEFAULT '',
      revision_fee_idr INTEGER,
      is_test_requested INTEGER NOT NULL DEFAULT 0
      );`,
    // Satu baris per keputusan klien atas satu iterasi sampel (ACC/REVISE/REJECT).
    `CREATE TABLE IF NOT EXISTS sample_feedbacks (
      id TEXT PRIMARY KEY,
      sample_request_id TEXT NOT NULL,
      iteration_number INTEGER NOT NULL,
      client_decision TEXT NOT NULL,
      client_notes TEXT NOT NULL DEFAULT '',
      recorded_by INTEGER,
      recorded_at TEXT NOT NULL
      );`,
    // Riwayat langkah tiket (linimasa SCR-03), hanya-tambah. Ikut snapshot
    // supaya linimasa tetap terbaca saat offline, berbeda dari log audit.
    `CREATE TABLE IF NOT EXISTS sample_status_log (
      id TEXT PRIMARY KEY,
      sample_request_id TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      action TEXT NOT NULL,
      notes TEXT NOT NULL,
      on_behalf_of_division TEXT NOT NULL DEFAULT '',
      recorded_by INTEGER,
      recorded_at TEXT NOT NULL
      );`,
    // Formula per sampel yang selesai dibuat RnD (v2.1, PRD F-14), hanya-tambah.
    // Satu baris per iterasi; `formula_code` sengaja tidak unik (produk
    // Existing memakai ulang formula). `rnd_notes` = catatan langkahnya.
    `CREATE TABLE IF NOT EXISTS sample_formulas (
      id TEXT PRIMARY KEY,
      sample_request_id TEXT NOT NULL,
      iteration_number INTEGER NOT NULL,
      formula_code TEXT NOT NULL,
      product_knowledge TEXT NOT NULL DEFAULT '',
      rnd_notes TEXT NOT NULL DEFAULT '',
      recorded_by INTEGER,
      recorded_at TEXT NOT NULL
      );`,
    // Harga Finance per iterasi tiket (v2.2, PRD F-16), hanya-tambah; baris
    // terbaru per iterasi yang berlaku. Rincian biaya hanya dibaca pemegang
    // `pricing.view`; yang lain menerima harga jualnya saja.
    `CREATE TABLE IF NOT EXISTS pricing_formulas (
      id TEXT PRIMARY KEY,
      sample_request_id TEXT NOT NULL,
      iteration_number INTEGER NOT NULL,
      raw_material_cost_idr INTEGER NOT NULL,
      packaging_cost_idr INTEGER NOT NULL,
      operational_cost_idr INTEGER NOT NULL,
      regulatory_cost_idr INTEGER NOT NULL DEFAULT 0,
      hpp_unit_idr INTEGER NOT NULL,
      margin_bp INTEGER NOT NULL,
      final_unit_price_idr INTEGER NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      recorded_by INTEGER,
      recorded_at TEXT NOT NULL
      );`,
    // Tagihan dan uang masuk (v2.3a, PRD F-17). `finance_options` = daftar
    // pajak dan diskon (D-28); tarifnya DISALIN ke tagihan saat dibuat. Lunas
    // dihitung dari `fund_allocations`, tidak disimpan. Tanpa UNIQUE: nomor
    // tagihan memakai kode perangkat seperti kode klien.
    `CREATE TABLE IF NOT EXISTS finance_options (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        rate_bp INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        installment_count INTEGER
      );`,
    `CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        invoice_number TEXT NOT NULL,
        client_id TEXT NOT NULL,
        sample_request_id TEXT NOT NULL DEFAULT '',
        ref_type TEXT NOT NULL,
        revision_index INTEGER NOT NULL DEFAULT 0,
        description TEXT NOT NULL DEFAULT '',
        subtotal_idr INTEGER NOT NULL,
        discount_label TEXT NOT NULL DEFAULT '',
        discount_bp INTEGER NOT NULL DEFAULT 0,
        discount_idr INTEGER NOT NULL DEFAULT 0,
        taxes_json TEXT NOT NULL DEFAULT '[]',
        tax_idr INTEGER NOT NULL DEFAULT 0,
        total_idr INTEGER NOT NULL,
        issued_on TEXT NOT NULL,
        due_on TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN',
        cancel_reason TEXT NOT NULL DEFAULT '',
        created_by INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        parent_invoice_id TEXT NOT NULL DEFAULT '',
        installment_no INTEGER NOT NULL DEFAULT 0
      );`,
    `CREATE TABLE IF NOT EXISTS incoming_funds (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL DEFAULT '',
        received_on TEXT NOT NULL,
        amount_idr INTEGER NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        proof_media_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        void_reason TEXT NOT NULL DEFAULT '',
        recorded_by INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deposit_confirmed_by INTEGER,
        deposit_confirmed_at TEXT NOT NULL DEFAULT ''
      );`,
    `CREATE TABLE IF NOT EXISTS fund_allocations (
        id TEXT PRIMARY KEY,
        fund_id TEXT NOT NULL,
        invoice_id TEXT NOT NULL,
        amount_idr INTEGER NOT NULL,
        recorded_by INTEGER,
        recorded_at TEXT NOT NULL
      );`,
    // Tiket desain (v2.4, PRD F-19): satu per tiket sampel, tanpa UNIQUE
    // (keunikan dijaga `DESIGN_ACTIVE_SQL`). `status` dan
    // `dummy_rejection_count` hanya berubah lewat rute `design/transition`.
    `CREATE TABLE IF NOT EXISTS design_tickets (
      id TEXT PRIMARY KEY,
      sample_request_id TEXT NOT NULL,
      brief TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'MOCKUP',
      dummy_rejection_count INTEGER NOT NULL DEFAULT 0,
      dummy_tracking_no TEXT NOT NULL DEFAULT '',
      revision_notes TEXT NOT NULL DEFAULT '',
      status_changed_at TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
      );`,
    // MoU produksi (v2.5a, PRD F-20): satu MoU aktif per tiket sampel, tanpa
    // UNIQUE (`MOU_ACTIVE_SQL`). Total dan DP dihitung `validateMouTerms`;
    // status hanya berubah lewat rute `mou/transition`, isi hanya saat draf.
    `CREATE TABLE IF NOT EXISTS production_mou (
      id TEXT PRIMARY KEY,
      mou_number TEXT NOT NULL,
      sample_request_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      total_units INTEGER NOT NULL,
      unit_price_idr INTEGER NOT NULL,
      total_production_cost_idr INTEGER NOT NULL,
      production_lead_time_days INTEGER NOT NULL,
      regulatory_path TEXT NOT NULL,
      dp_bp INTEGER NOT NULL,
      dp_amount_required_idr INTEGER NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'DRAFT',
      revision_notes TEXT NOT NULL DEFAULT '',
      status_changed_at TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
      );`,
    // Dokumen legal (v2.6, PRD F-21): satu baris per dokumen per MoU, tanpa
    // UNIQUE (`LEGAL_EXISTING_SQL`); suntingan dijaga `updated_at`.
    `CREATE TABLE IF NOT EXISTS legal_documents (
      id TEXT PRIMARY KEY,
      mou_id TEXT NOT NULL,
      sample_request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      reference_no TEXT NOT NULL DEFAULT '',
      certificate_no TEXT NOT NULL DEFAULT '',
      bpom_type TEXT NOT NULL DEFAULT '',
      submitted_on TEXT NOT NULL DEFAULT '',
      issued_on TEXT NOT NULL DEFAULT '',
      expires_on TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      updated_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
      );`,
    // Arsip impor (v2.7, PRD F-22): Database Formulasi dan Database Desain
    // lama, hanya-tambah dan hanya-baca, terikat ke klien.
    `CREATE TABLE IF NOT EXISTS imported_records (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      client_id TEXT NOT NULL,
      record_date TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      amount_idr INTEGER,
      notes TEXT NOT NULL DEFAULT '',
      source_file TEXT NOT NULL DEFAULT '',
      imported_by INTEGER,
      created_at TEXT NOT NULL
      );`,
    // Foto terkompresi (PRD FR-07), terpisah dari baris pemiliknya supaya query
    // daftar tidak membawa biner. Hanya-tambah (D-13). Perangkat menarik kolom
    // selain `data_base64`; isinya diambil satu per satu saat dibuka, lalu
    // disimpan di perangkat. `''` di perangkat = belum pernah diambil.
    `CREATE TABLE IF NOT EXISTS media_asset (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      mime TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      data_base64 TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL
      );`,
    // Cloud-only: tag dua karakter yang diterbitkan untuk setiap perangkat,
    // bagian `<KP>` dari kode klien. Tidak ikut sinkronisasi, jadi UNIQUE
    // di sini aman.
    `CREATE TABLE IF NOT EXISTS device_tag_registry (
      tag TEXT PRIMARY KEY,
      client_id TEXT NOT NULL UNIQUE,
      registered_at TEXT NOT NULL
      );`,
    // Notifikasi divisi (PRD FR-08), cloud-only. `id` sekaligus kunci dedupe;
    // `status` adalah status pengiriman Telegram, sedangkan lonceng membaca
    // semua baris. `telegram_config` memegang token bot (tidak pernah dikirim ke
    // frontend), `notification_seen` kapan operator terakhir membuka lonceng.
    `CREATE TABLE IF NOT EXISTS notification_outbox (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      target_division TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT,
      next_attempt_at TEXT NOT NULL,
      sent_at TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
      );`,
    `CREATE TABLE IF NOT EXISTS telegram_config (
      id TEXT PRIMARY KEY,
      bot_token TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_by TEXT
      );`,
    `CREATE TABLE IF NOT EXISTS notification_seen (
      operator_id INTEGER PRIMARY KEY,
      seen_at TEXT NOT NULL
      );`,
    // Tautan persetujuan klien (v2.5b, PRD F-18), cloud-only: tidak ada di
    // `storage.rs` maupun snapshot. Hanya hash token yang disimpan; UNIQUE
    // aman karena tabel ini tidak pernah didorong dari perangkat lewat outbox.
    `CREATE TABLE IF NOT EXISTS approval_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      sample_request_id TEXT NOT NULL,
      base_status TEXT NOT NULL,
      base_revision INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      revoked_at TEXT,
      response_json TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL
      );`,
    // =========================================

    `CREATE INDEX IF NOT EXISTS idx_operator_username ON master_operator(username);`,
    `CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone_normalized);`,
    `CREATE INDEX IF NOT EXISTS idx_clients_code ON clients(client_code);`,
    `CREATE INDEX IF NOT EXISTS idx_leads_client ON leads(client_id);`,
    `CREATE INDEX IF NOT EXISTS idx_master_option_kind ON master_option(kind, sort_order);`,
    `CREATE INDEX IF NOT EXISTS idx_lead_interactions_lead ON lead_interactions(lead_id, occurred_at);`,
    `CREATE INDEX IF NOT EXISTS idx_domain_audit_occurred ON domain_audit_log(occurred_at);`,
    `CREATE INDEX IF NOT EXISTS idx_domain_audit_entity ON domain_audit_log(entity_type, entity_id);`,
    `CREATE INDEX IF NOT EXISTS idx_sample_requests_client ON sample_requests(client_id);`,
    `CREATE INDEX IF NOT EXISTS idx_sample_feedbacks_request ON sample_feedbacks(sample_request_id, iteration_number);`,
    `CREATE INDEX IF NOT EXISTS idx_sample_status_log_request ON sample_status_log(sample_request_id, recorded_at);`,
    `CREATE INDEX IF NOT EXISTS idx_sample_formulas_request ON sample_formulas(sample_request_id, iteration_number);`,
    `CREATE INDEX IF NOT EXISTS idx_pricing_formulas_request ON pricing_formulas(sample_request_id, iteration_number);`,
    `CREATE INDEX IF NOT EXISTS idx_invoices_sample ON invoices(sample_request_id);`,
    `CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);`,
    `CREATE INDEX IF NOT EXISTS idx_fund_allocations_invoice ON fund_allocations(invoice_id);`,
    `CREATE INDEX IF NOT EXISTS idx_fund_allocations_fund ON fund_allocations(fund_id);`,
    `CREATE INDEX IF NOT EXISTS idx_design_tickets_sample ON design_tickets(sample_request_id);`,
    `CREATE INDEX IF NOT EXISTS idx_production_mou_sample ON production_mou(sample_request_id);`,
    `CREATE INDEX IF NOT EXISTS idx_legal_documents_mou ON legal_documents(mou_id, kind);`,
    `CREATE INDEX IF NOT EXISTS idx_imported_records_client ON imported_records(client_id);`,
    `CREATE INDEX IF NOT EXISTS idx_approval_tokens_entity ON approval_tokens(entity_type, entity_id);`,
    `CREATE INDEX IF NOT EXISTS idx_media_asset_owner ON media_asset(owner_type, owner_id);`,
    `CREATE INDEX IF NOT EXISTS idx_notification_outbox_due ON notification_outbox(status, next_attempt_at);`,
    `CREATE INDEX IF NOT EXISTS idx_notification_outbox_created ON notification_outbox(created_at);`,

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
      ('clients.view', 'View clients', 'Clients', 'View clients and their leads.', 1, 30),
      ('clients.manage', 'Manage clients', 'Clients', 'Register new leads and edit client details.', 1, 40),
      ('master_data.manage', 'Manage master data', 'Master data', 'Maintain lead channels and product categories.', 1, 50),
      ('leads.view', 'View leads', 'Leads', 'View leads, their interactions, and the Cold queue.', 1, 52),
      ('leads.manage', 'Manage own leads', 'Leads', 'Record follow ups and client responses on your own leads.', 1, 54),
      ('leads.reassign', 'Reassign leads', 'Leads', 'Move a lead to another CS and record on any lead.', 1, 56),
      ('samples.view', 'View sample requests', 'Samples', 'View sample requests and their history.', 1, 58),
      ('samples.manage', 'Manage sample requests', 'Samples', 'Create sample requests and record the CS steps of each request.', 1, 59),
      ('rnd.manage', 'Record RnD decisions', 'Samples', 'Accept or reject sample requests, and record each finished sample with its formula.', 1, 60),
      ('finance.manage', 'Record Finance decisions', 'Finance', 'Price finished samples, set revision fees, and record payments as received.', 1, 61),
      ('pricing.view', 'View cost and margin', 'Finance', 'See the cost breakdown and margin behind each sample price.', 1, 61),
      ('invoices.view', 'View invoices', 'Finance', 'See invoices, incoming payments, and which invoices are paid.', 1, 62),
      ('finance_options.manage', 'Manage taxes and discounts', 'Finance', 'Add and change the taxes and discounts used on new invoices.', 1, 63),
      ('payments.approve_exception', 'Approve payment exceptions', 'Finance', 'Accept a partial payment into installments, or keep an overpayment as a client deposit.', 1, 64),
      ('design.manage', 'Do design work', 'Design', 'Upload mockups, print dummies, and record dummies as sent.', 1, 65),
      ('mou.manage', 'Manage MoUs', 'Samples', 'Draft MoUs for approved samples, send them, and record the client''s answer.', 1, 60),
      ('legal.manage', 'Record legal documents', 'Legal', 'Record BPOM, halal, and trademark (HKI) filings and certificates.', 1, 67),
      ('design.override_dummy_limit', 'Override the dummy rejection limit', 'Design', 'Print a dummy again after the client has rejected it as many times as the limit allows.', 1, 66),
      ('password_reset.view', 'View password reset history', 'Operators', 'Review who requested a password recovery, with their verification photo.', 1, 62),
      ('password_reset.delete', 'Delete password reset history', 'Operators', 'Delete password recovery records and their photos.', 1, 64),
      ('two_factor.reset', 'Reset another operator''s 2FA', 'Operators', 'Turn off two-step verification for another operator who lost their phone.', 1, 66),
      ('password_reset.approve', 'Approve password recovery', 'System', 'Review the requester''s photo, then hand over a password recovery code.', 1, 65),
      ('database_backup.export', 'Export database backup', 'System', 'Export the entire database into one backup file.', 1, 66),
      ('database_backup.restore', 'Restore database from backup', 'System', 'Replace all device data with the contents of a backup file.', 1, 67),
      ('operators.view', 'View operators', 'Operators', 'View operator and user account data.', 1, 70),
      ('sessions.manage', 'Manage active sessions', 'Operators', 'View every operator''s active sessions and end them.', 1, 72),
      ('audit.view', 'View audit log', 'Operators', 'View who changed clients, leads, and master data, and when.', 1, 74),
      ('operators.manage', 'Manage operators', 'Operators', 'Add and edit app operators.', 1, 80),
      ('roles.manage', 'Manage roles and access', 'Roles', 'Set the permission matrix of each role.', 1, 90),
      ('settings.view', 'View system settings', 'Settings', 'View app and database settings.', 1, 100),
      ('settings.manage', 'Manage system settings', 'Settings', 'Change app and database settings.', 1, 110),
      ('notifications_cs.view', 'CS notifications', 'Notifications', 'See new leads and leads that went Cold in the notification bell.', 1, 112),
      ('notifications_rnd.view', 'RnD notifications', 'Notifications', 'See sample requests waiting for RnD review in the notification bell.', 1, 114),
      ('notifications_finance.view', 'Finance notifications', 'Notifications', 'See sample fees and revision fees waiting for Finance in the notification bell.', 1, 116),
      ('notifications_design.view', 'Design notifications', 'Notifications', 'See new design briefs and dummy revisions in the notification bell.', 1, 118),
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
        'database_backup.restore', 'settings.manage', 'finance_options.manage',
        'payments.approve_exception'
      );`,
    // Operator bawaan bekerja sebagai CS sampai role divisi dibuat (PRD F-02).
    // WAJIB sama dengan `DEFAULT_ROLE_PERMISSIONS.operator` di `catalog.ts` dan
    // seed yang sama di `turso.rs`.
    `INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by)
      SELECT 3, permission_key, 1, datetime('now'), 'system' FROM app_permission
      WHERE permission_key IN (
        'home.view', 'dashboard.view', 'clients.view', 'clients.manage',
        'leads.view', 'leads.manage', 'samples.view', 'samples.manage',
        'notifications_cs.view', 'sync.view', 'mou.manage'
      );`,

    // `rbac_revision` WAJIB ada: nilainya yang dipakai Web dan perangkat untuk
    // mendeteksi pencabutan hak akses tanpa menunggu login ulang.
    `INSERT OR IGNORE INTO setting_gex_system (key, value) VALUES
      ('app_name', 'Company OS'),
      ('rbac_revision', '1');`,

    // Role divisi (PRD FR-02), sekali saja: dijaga penanda supaya role yang
    // dihapus atau izin yang dicabut Admin tidak kembali saat skema naik versi.
    ...DIVISION_ROLE_SEED_SQL,
    // Izin tiket sampel (PRD F-06) untuk role divisi CS dan CRM, sekali saja
    // seperti `DIVISION_ROLE_SEED_SQL`.
    ...SAMPLE_PERMISSION_SEED_SQL,
    // Izin lonceng per divisi (PRD FR-08), sekali saja.
    ...NOTIFICATION_PERMISSION_SEED_SQL,
    // Izin RnD (v2.1), sekali saja.
    ...RND_PERMISSION_SEED_SQL,
    // Izin Finance (v2.2), sekali saja.
    ...FINANCE_PERMISSION_SEED_SQL,
    // Izin melihat tagihan (v2.3a), sekali saja.
    ...INVOICE_PERMISSION_SEED_SQL,
    // Izin Desain (v2.4), sekali saja.
    ...DESIGN_PERMISSION_SEED_SQL,
    // Izin MoU (v2.5a), sekali saja.
    ...MOU_PERMISSION_SEED_SQL,
    // Izin dokumen legal (v2.6), sekali saja.
    ...LEGAL_PERMISSION_SEED_SQL,

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

use std::{path::Path, time::SystemTime};

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use super::models::{CommandError, OfflineCredential};

const DATABASE_NAME: &str = "desktop-security.db";

pub(crate) fn database(path: &Path) -> Result<Connection, CommandError> {
    let connection =
        Connection::open(path.join(DATABASE_NAME)).map_err(|_| CommandError::internal())?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -64000;",
        )
        .map_err(|_| CommandError::internal())?;
    Ok(connection)
}

pub fn now_epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

pub fn normalize_identifier(value: &str) -> String {
    value.trim().to_lowercase()
}

pub fn get_or_create_device_id(path: &Path) -> Result<String, CommandError> {
    let connection = database(path)?;
    if let Some(existing) = connection
        .query_row(
            "SELECT device_id FROM desktop_device_identity WHERE singleton_id = 1;",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())?
    {
        let valid = existing.len() == 71
            && existing.starts_with("device-")
            && existing[7..].bytes().all(|byte| byte.is_ascii_hexdigit());
        if valid {
            return Ok(existing);
        }
    }
    let mut random = [0_u8; 32];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut random);
    let generated = format!("device-{}", hex::encode(random));
    random.zeroize();
    connection
        .execute(
            "INSERT INTO desktop_device_identity (singleton_id, device_id, created_at) VALUES (1, ?, ?) ON CONFLICT(singleton_id) DO UPDATE SET device_id = excluded.device_id, created_at = excluded.created_at;",
            params![generated, now_epoch_seconds()],
        )
        .map_err(|_| CommandError::internal())?;
    Ok(generated)
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    alter_sql: &str,
) -> Result<(), String> {
    let exists = connection
        .query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?);"),
            [column],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|_| format!("The schema of table {table} could not be checked."))?;
    if !exists {
        connection
            .execute(alter_sql, [])
            .map_err(|_| format!("Column {table}.{column} could not be migrated."))?;
    }
    Ok(())
}

/// Buat seluruh skema SQLite lokal.
///
/// Dua kelompok tabel:
///
/// 1. **Infrastruktur** (`desktop_*`, `setting_gex_system`) — mesin sinkronisasi,
///    vault kredensial, audit, dan rate limit login. JANGAN dihapus; seluruh
///    aplikasi bergantung padanya, dan nama kolomnya dipakai langsung oleh
///    fungsi-fungsi di berkas ini.
/// 2. **Domain MaklonOS** (`clients`, `leads`, `master_option`,
///    `lead_interactions`, direktori `master_operator`) — cache lokal
///    tabel cloud yang ikut sinkronisasi. Keempat lapisan (`storage.rs`,
///    `turso.rs`, `SNAPSHOT_TABLES` di `sync.rs`, `db-schema.ts`) WAJIB memakai
///    nama tabel dan kolom yang identik.
pub fn initialize(path: &Path) -> Result<(), String> {
    let connection = database(path).map_err(|error| error.message)?;
    connection
        .execute_batch(
            r#"
      CREATE TABLE IF NOT EXISTS desktop_schema_migration (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_credential_index (
        identity_key TEXT PRIMARY KEY,
        operator_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        kode_operator TEXT NOT NULL,
        role_key TEXT NOT NULL,
        permission_revision INTEGER NOT NULL,
        provisioned_at INTEGER NOT NULL,
        offline_valid_until INTEGER NOT NULL,
        server_origin TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_credential_alias (
        alias TEXT NOT NULL,
        server_origin TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        PRIMARY KEY (alias, server_origin),
        FOREIGN KEY (identity_key) REFERENCES desktop_credential_index(identity_key)
          ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS desktop_security_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operator_id INTEGER,
        event_type TEXT NOT NULL,
        event_at INTEGER NOT NULL,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS desktop_login_rate_limit (
        identifier_hash TEXT PRIMARY KEY,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER,
        last_attempt_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_device_identity (
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
        device_id TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS setting_gex_system (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      -- Salinan lokal identitas perusahaan. Definisinya WAJIB sama persis
      -- dengan `turso.rs` dan `db-schema.ts`; satu kolom yang berbeda ejaan
      -- membuat barisnya tersimpan mulus di perangkat lalu ditolak cloud dan
      -- dicoba ulang selamanya.
      CREATE TABLE IF NOT EXISTS company_profile (
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
      );
      -- `device_tag`: bagian `<KP>` kode klien, diterbitkan database yang
      -- ditunjuk `server_origin`. Disimpan di sini (bukan setting device-local)
      -- supaya perangkat yang pindah database otomatis tidak membawa tag lama.
      CREATE TABLE IF NOT EXISTS desktop_client_identity (
        server_origin TEXT PRIMARY KEY,
        client_id TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL,
        device_tag TEXT
      );
      CREATE TABLE IF NOT EXISTS desktop_sync_outbox (
        event_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        operation TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        base_revision INTEGER,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'synced', 'failed', 'conflict')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        last_error TEXT,
        server_revision INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- Waktu cloud (bentuk `datetime('now')` dari database) saat perangkat
      -- terakhir memastikan sesi operator ini masih berlaku. Sesi offline yang
      -- tersambung lagi dibandingkan dengan sesi cloud yang lahir SETELAHNYA.
      CREATE TABLE IF NOT EXISTS desktop_session_contact (
        operator_id INTEGER PRIMARY KEY,
        last_online_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_sync_cursor (
        domain TEXT PRIMARY KEY,
        last_revision INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_sync_table_cursor (
        table_name TEXT PRIMARY KEY,
        remote_revision INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_sync_conflict (
        event_id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        local_payload_json TEXT NOT NULL,
        server_payload_json TEXT,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY (event_id) REFERENCES desktop_sync_outbox(event_id)
      );
      CREATE TABLE IF NOT EXISTS desktop_entity_revision (
        domain TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        server_revision INTEGER NOT NULL,
        payload_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (domain, entity_key)
      );

      -- ================= DOMAIN MAKLONOS =================
      -- Cache lokal tabel cloud yang ikut sinkronisasi. Kolom WAJIB identik
      -- dengan `turso.rs` dan `db-schema.ts`. Tanpa CHECK/FK/UNIQUE (keputusan
      -- G): perangkat versi lama tidak boleh menolak nilai baru dari cloud.
      CREATE TABLE IF NOT EXISTS clients (
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
      );
      CREATE TABLE IF NOT EXISTS leads (
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
      );
      CREATE TABLE IF NOT EXISTS master_option (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        code TEXT NOT NULL,
        label TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lead_interactions (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL,
        operator_id INTEGER,
        direction TEXT NOT NULL,
        kind TEXT NOT NULL,
        notes TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      -- Tiket sampel (PRD FR-06), cache milik cloud. WAJIB identik dengan
      -- `turso.rs` dan `db-schema.ts`.
      CREATE TABLE IF NOT EXISTS sample_requests (
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
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sample_feedbacks (
        id TEXT PRIMARY KEY,
        sample_request_id TEXT NOT NULL,
        iteration_number INTEGER NOT NULL,
        client_decision TEXT NOT NULL,
        client_notes TEXT NOT NULL DEFAULT '',
        recorded_by INTEGER,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sample_status_log (
        id TEXT PRIMARY KEY,
        sample_request_id TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        action TEXT NOT NULL,
        notes TEXT NOT NULL,
        on_behalf_of_division TEXT NOT NULL DEFAULT '',
        recorded_by INTEGER,
        recorded_at TEXT NOT NULL
      );
      -- Foto: data ringkas ditarik dari cloud; `data_base64` terisi untuk foto
      -- buatan perangkat ini dan foto yang pernah dibuka ('' = belum diambil).
      CREATE TABLE IF NOT EXISTS media_asset (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        mime TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        data_base64 TEXT NOT NULL DEFAULT '',
        created_by INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_media_asset_owner
        ON media_asset(owner_type, owner_id);
      CREATE INDEX IF NOT EXISTS idx_local_sample_requests_client
        ON sample_requests(client_id);
      CREATE INDEX IF NOT EXISTS idx_local_sample_status_log_request
        ON sample_status_log(sample_request_id, recorded_at);
      -- Log audit domain: ditulis di transaksi yang sama dengan mutasinya,
      -- didorong lewat rute `audit/record`, tidak ditarik ulang dari cloud.
      CREATE TABLE IF NOT EXISTS domain_audit_log (
        id TEXT PRIMARY KEY,
        actor_operator_id INTEGER,
        on_behalf_of_division TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        summary_json TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL
      );
      -- Direktori operator hanya-baca (nama PIC, pilihan pindah PIC saat
      -- offline). Kolomnya sama dengan `master_operator` cloud supaya DDL
      -- lokal dan cloud tetap bisa hidup di satu berkas (Mode Database Lokal,
      -- `audit:sql`), tetapi SEMUA boleh kosong: snapshot hanya mengisi id,
      -- kode, nama, dan status. Hash password, kontak, dan rahasia 2FA tidak
      -- pernah disalin ke perangkat (lihat `SNAPSHOT_SOURCES` di turso.rs).
      CREATE TABLE IF NOT EXISTS master_operator (
        id INTEGER PRIMARY KEY,
        kode_operator TEXT,
        nama_operator TEXT,
        username TEXT,
        password_hash TEXT,
        role TEXT,
        role_id INTEGER,
        email TEXT,
        no_hp TEXT,
        totp_secret TEXT,
        totp_enabled INTEGER,
        totp_confirmed_at TEXT,
        totp_recovery_codes TEXT,
        password_recovery_codes TEXT,
        password_recovery_created_at TEXT,
        status TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      -- ====================================================

      CREATE INDEX IF NOT EXISTS idx_local_outbox_status_retry
        ON desktop_sync_outbox(status, next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_local_outbox_domain_entity
        ON desktop_sync_outbox(domain, entity_key);
      CREATE INDEX IF NOT EXISTS idx_local_clients_phone
        ON clients(phone_normalized);
      CREATE INDEX IF NOT EXISTS idx_local_clients_code
        ON clients(client_code);
      CREATE INDEX IF NOT EXISTS idx_local_leads_client
        ON leads(client_id);
      CREATE INDEX IF NOT EXISTS idx_local_master_option_kind
        ON master_option(kind, sort_order);
      CREATE INDEX IF NOT EXISTS idx_local_lead_interactions_lead
        ON lead_interactions(lead_id, occurred_at);

      INSERT OR IGNORE INTO desktop_schema_migration (version, name, applied_at)
      VALUES (1, 'desktop-security-foundation', unixepoch());
      INSERT OR IGNORE INTO desktop_schema_migration (version, name, applied_at)
      VALUES (2, 'desktop-sync-foundation', unixepoch());
      "#,
        )
        .map_err(|_| "The desktop security schema could not be initialized.".to_owned())?;

    // Database perangkat yang dibuat sebelum kode klien ada.
    ensure_column(
        &connection,
        "desktop_client_identity",
        "device_tag",
        "ALTER TABLE desktop_client_identity ADD COLUMN device_tag TEXT;",
    )?;
    // Sesi tunggal (PRD F-03): setiap entri outbox mencatat sesi dan operator
    // pembuatnya, dan entri yang tersusul dikarantina (`quarantined_at`),
    // tidak didorong dan tidak dihapus sampai pemiliknya memutuskan.
    for (column, sql) in [
        ("session_id", "ALTER TABLE desktop_sync_outbox ADD COLUMN session_id TEXT;"),
        ("operator_id", "ALTER TABLE desktop_sync_outbox ADD COLUMN operator_id INTEGER;"),
        ("quarantined_at", "ALTER TABLE desktop_sync_outbox ADD COLUMN quarantined_at INTEGER;"),
    ] {
        ensure_column(&connection, "desktop_sync_outbox", column, sql)?;
    }

    Ok(())
}

/// Tabel lokal yang seluruh isinya adalah cache milik database cloud.
///
/// Daftarkan setiap tabel domain yang ikut sinkronisasi di sini. Tabel yang
/// terlewat akan menyimpan data milik database lama setelah perangkat dipindahkan
/// ke database baru — data itu tetap tampil di layar dan outbox lamanya justru
/// terdorong masuk ke database yang baru.
const CLOUD_MIRRORED_TABLES: &[&str] = &[
    "clients",
    "leads",
    "master_option",
    "lead_interactions",
    "master_operator",
    "domain_audit_log",
    "sample_requests",
    "sample_feedbacks",
    "sample_status_log",
    "media_asset",
];

/// Membuang seluruh jejak database cloud lama ketika perangkat dipindahkan ke
/// database Turso yang berbeda.
///
/// Tanpa ini, memindah aplikasi ke database baru hanya mengganti kredensial:
/// karyawan, operasional, log scan, dan payroll dari database lama tetap tersimpan
/// di SQLite lokal, tetap tampil di layar, dan outbox lama tetap terdorong ke
/// database baru. Snapshot pull tidak bisa membereskannya karena `delete_missing`
/// sengaja dimatikan untuk hampir semua tabel — cloud kosong memang tidak boleh
/// menghapus data lokal yang belum pernah dilacak server. Jadi pembersihan wajib
/// dilakukan tepat di titik perpindahan database.
///
/// Yang sengaja DIPERTAHANKAN: `desktop_schema_migration`, `desktop_device_identity`,
/// dan `desktop_client_identity` (identitas perangkat dipakai untuk membuka vault
/// kredensial yang baru saja ditulis), serta setting koneksi milik perangkat ini
/// (`device_local_setting_keys`) yang justru menentukan database tujuan baru.
pub fn reset_cloud_linked_data(
    path: &Path,
    device_local_setting_keys: &[&str],
) -> Result<(), CommandError> {
    let mut connection = database(path)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    // Foreign key antar tabel cache tidak relevan saat seluruh cache dibuang.
    transaction
        .execute_batch("PRAGMA defer_foreign_keys = ON;")
        .map_err(|_| CommandError::internal())?;

    for table in CLOUD_MIRRORED_TABLES {
        transaction
            .execute(&format!("DELETE FROM {table};"), [])
            .map_err(|_| {
                CommandError::new(
                    "LOCAL_RESET_FAILED",
                    "Local data from the old database could not be cleared.",
                )
            })?;
    }

    // Setting operasional ikut dibuang, kecuali kunci koneksi perangkat ini.
    let placeholders = vec!["?"; device_local_setting_keys.len()].join(", ");
    transaction
        .execute(
            &format!("DELETE FROM setting_gex_system WHERE key NOT IN ({placeholders});"),
            rusqlite::params_from_iter(device_local_setting_keys.iter()),
        )
        .map_err(|_| {
            CommandError::new(
                "LOCAL_RESET_FAILED",
                "Local settings from the old database could not be cleared.",
            )
        })?;

    // Seluruh state sinkronisasi milik database lama: outbox yang belum terkirim
    // ke database lama TIDAK boleh dikirim ke database baru.
    transaction
        .execute_batch(
            r#"
            DELETE FROM desktop_sync_outbox;
            DELETE FROM desktop_sync_conflict;
            DELETE FROM desktop_entity_revision;
            DELETE FROM desktop_sync_cursor;
            DELETE FROM desktop_sync_table_cursor;
            DELETE FROM desktop_credential_alias;
            DELETE FROM desktop_credential_index;
            DELETE FROM desktop_login_rate_limit;
            "#,
        )
        .map_err(|_| {
            CommandError::new(
                "LOCAL_RESET_FAILED",
                "Sync status from the old database could not be cleared.",
            )
        })?;

    // Kait untuk menanam ulang seed bawaan aplikasi setelah cache cloud
    // dibuang. Tabel seed (mis. tarif, kategori bawaan) bukan data cloud, jadi
    // tempatnya di sini — di dalam transaksi yang sama dengan pembersihan.

    transaction.commit().map_err(|_| CommandError::internal())?;

    // Snapshot login offline terikat ke origin database lama, jadi sudah tidak
    // pernah bisa dipakai lagi. Buang berkasnya supaya kredensial operator
    // database lama tidak tertinggal di perangkat. Vault koneksi Turso
    // (`turso_config.*`) justru baru saja ditulis untuk database baru — jangan
    // disentuh.
    let credentials_dir = path.join("credentials");
    if let Ok(entries) = std::fs::read_dir(&credentials_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("turso_config.") {
                continue;
            }
            let _ = std::fs::remove_file(entry.path());
        }
    }

    Ok(())
}

pub fn save_credential_index(
    path: &Path,
    credential: &OfflineCredential,
) -> Result<(), CommandError> {
    let mut connection = database(path)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    transaction
        .execute(
            r#"
      INSERT INTO desktop_credential_index (
        identity_key, operator_id, username, kode_operator, role_key,
        permission_revision, provisioned_at, offline_valid_until, server_origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_key) DO UPDATE SET
        operator_id = excluded.operator_id,
        username = excluded.username,
        kode_operator = excluded.kode_operator,
        role_key = excluded.role_key,
        permission_revision = excluded.permission_revision,
        provisioned_at = excluded.provisioned_at,
        offline_valid_until = excluded.offline_valid_until,
        server_origin = excluded.server_origin;
      "#,
            params![
                credential.identity_key,
                credential.operator.id,
                credential.operator.username,
                credential.operator.kode_operator,
                credential.operator.role_key,
                credential.operator.permission_revision,
                credential.provisioned_at,
                credential.offline_valid_until,
                credential.server_origin,
            ],
        )
        .map_err(|_| CommandError::internal())?;

    transaction
        .execute(
            "DELETE FROM desktop_credential_alias WHERE identity_key = ?;",
            params![credential.identity_key],
        )
        .map_err(|_| CommandError::internal())?;

    for alias in [
        normalize_identifier(&credential.operator.username),
        normalize_identifier(&credential.operator.kode_operator),
    ] {
        transaction
            .execute(
                r#"
        INSERT INTO desktop_credential_alias (alias, server_origin, identity_key)
        VALUES (?, ?, ?)
        ON CONFLICT(alias, server_origin) DO UPDATE SET
          identity_key = excluded.identity_key;
        "#,
                params![alias, credential.server_origin, credential.identity_key],
            )
            .map_err(|_| CommandError::internal())?;
    }
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(())
}

pub fn find_identity_key(
    path: &Path,
    server_origin: &str,
    identifier: &str,
) -> Result<Option<String>, CommandError> {
    database(path)?
        .query_row(
            r#"
      SELECT identity_key FROM desktop_credential_alias
      WHERE alias = ? AND server_origin = ? LIMIT 1;
      "#,
            params![normalize_identifier(identifier), server_origin],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())
}

pub fn audit(path: &Path, operator_id: Option<i64>, event_type: &str, detail: Option<&str>) {
    if let Ok(connection) = database(path) {
        let _ = connection.execute(
            r#"
      INSERT INTO desktop_security_audit (operator_id, event_type, event_at, detail)
      VALUES (?, ?, ?, ?);
      "#,
            params![operator_id, event_type, now_epoch_seconds(), detail],
        );
    }
}

pub fn get_system_setting(path: &Path, key: &str) -> Result<Option<String>, CommandError> {
    database(path)?
        .query_row(
            "SELECT value FROM setting_gex_system WHERE key = ? LIMIT 1;",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())
}

pub fn set_system_setting(path: &Path, key: &str, value: &str) -> Result<(), CommandError> {
    database(path)?
        .execute(
            "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            params![key, value],
        )
        .map_err(|_| CommandError::internal())?;
    Ok(())
}

fn login_identifier_hash(identifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalize_identifier(identifier).as_bytes());
    hex::encode(hasher.finalize())
}

pub fn login_lock_remaining(path: &Path, identifier: &str) -> Result<Option<i64>, CommandError> {
    let connection = database(path)?;
    let identifier_hash = login_identifier_hash(identifier);
    let now = now_epoch_seconds();
    let locked_until: Option<i64> = connection
        .query_row(
            "SELECT locked_until FROM desktop_login_rate_limit WHERE identifier_hash = ?;",
            [&identifier_hash],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())?
        .flatten();
    if let Some(until) = locked_until.filter(|until| *until > now) {
        return Ok(Some(until.saturating_sub(now)));
    }
    if locked_until.is_some() {
        connection
            .execute(
                "DELETE FROM desktop_login_rate_limit WHERE identifier_hash = ?;",
                [&identifier_hash],
            )
            .map_err(|_| CommandError::internal())?;
    }
    Ok(None)
}

pub fn record_failed_login(path: &Path, identifier: &str) -> Result<Option<i64>, CommandError> {
    let connection = database(path)?;
    let identifier_hash = login_identifier_hash(identifier);
    let now = now_epoch_seconds();
    connection
        .execute(
            r#"INSERT INTO desktop_login_rate_limit (
                identifier_hash, failed_attempts, locked_until, last_attempt_at
            ) VALUES (?, 1, NULL, ?)
            ON CONFLICT(identifier_hash) DO UPDATE SET
                failed_attempts = desktop_login_rate_limit.failed_attempts + 1,
                locked_until = CASE
                    WHEN desktop_login_rate_limit.failed_attempts + 1 >= 5 THEN ? + 120
                    ELSE desktop_login_rate_limit.locked_until
                END,
                last_attempt_at = excluded.last_attempt_at;"#,
            params![identifier_hash, now, now],
        )
        .map_err(|_| CommandError::internal())?;
    login_lock_remaining(path, identifier)
}

pub fn clear_login_failures(path: &Path, identifier: &str) -> Result<(), CommandError> {
    database(path)?
        .execute(
            "DELETE FROM desktop_login_rate_limit WHERE identifier_hash = ?;",
            [login_identifier_hash(identifier)],
        )
        .map_err(|_| CommandError::internal())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{
        clear_login_failures, database, get_or_create_device_id, initialize,
        login_lock_remaining, record_failed_login, reset_cloud_linked_data, set_system_setting,
    };

    #[test]
    fn initializes_schema_idempotently() {
        let directory = tempdir().expect("temporary directory");
        initialize(directory.path()).expect("first initialization");
        initialize(directory.path()).expect("second initialization");

        let connection = database(directory.path()).expect("database connection");
        for table in [
            "clients",
            "leads",
            "master_option",
            "lead_interactions",
            "master_operator",
            "domain_audit_log",
            "sample_requests",
            "sample_feedbacks",
            "sample_status_log",
            "media_asset",
            "setting_gex_system",
            "desktop_sync_outbox",
            "desktop_sync_cursor",
            "desktop_sync_table_cursor",
            "desktop_sync_conflict",
            "desktop_entity_revision",
            "desktop_login_rate_limit",
            "desktop_device_identity",
            "desktop_client_identity",
        ] {
            let total: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?;",
                    [table],
                    |row| row.get(0),
                )
                .expect("schema query");
            assert_eq!(total, 1, "tabel hilang: {table}");
        }
    }

    /// Pindah database cloud harus membuang seluruh cache database lama, tetapi
    /// TIDAK boleh menyentuh identitas perangkat atau kunci koneksi perangkat —
    /// justru kunci itulah yang menentukan database tujuan baru.
    #[test]
    fn switching_cloud_database_purges_old_local_data() {
        let directory = tempdir().expect("temporary directory");
        initialize(directory.path()).expect("initialize schema");
        let device_id = get_or_create_device_id(directory.path()).expect("device id");

        let connection = database(directory.path()).expect("database connection");
        connection
            .execute(
                "INSERT INTO clients (id, client_code, name, phone_normalized, created_at, updated_at) VALUES ('C1', 'KLN-20260925-0101', 'Klien Lama', '6281234567890', '0', '0');",
                [],
            )
            .expect("seed client");
        connection
            .execute(
                "INSERT INTO desktop_sync_outbox (event_id, client_id, domain, operation, entity_key, payload_json, status, created_at, updated_at) VALUES ('EV1', 'C1', 'client', 'update', 'C1', '{}', 'pending', 0, 0);",
                [],
            )
            .expect("seed outbox");
        drop(connection);

        set_system_setting(directory.path(), "app_name", "Lama").expect("seed setting");
        set_system_setting(
            directory.path(),
            "turso_database_url",
            "libsql://lama.turso.io",
        )
        .expect("seed device-local setting");

        reset_cloud_linked_data(directory.path(), &["turso_database_url", "turso_auth_token"])
            .expect("reset local workspace");

        let connection = database(directory.path()).expect("database connection");
        for table in ["clients", "desktop_sync_outbox", "desktop_entity_revision"] {
            let total: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table};"), [], |row| {
                    row.get(0)
                })
                .expect("count rows");
            assert_eq!(total, 0, "{table} masih menyimpan data database lama");
        }

        // Setting biasa ikut dibuang...
        let leftover: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM setting_gex_system WHERE key = 'app_name';",
                [],
                |row| row.get(0),
            )
            .expect("count settings");
        assert_eq!(leftover, 0);

        // ...tetapi kunci koneksi perangkat ini harus bertahan.
        let kept: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM setting_gex_system WHERE key = 'turso_database_url';",
                [],
                |row| row.get(0),
            )
            .expect("count device-local settings");
        assert_eq!(kept, 1, "kunci koneksi perangkat ikut terhapus");
        drop(connection);

        // Identitas perangkat dipakai membuka vault kredensial; ia harus stabil.
        assert_eq!(
            get_or_create_device_id(directory.path()).expect("device id"),
            device_id
        );
    }

    #[test]
    fn login_is_temporarily_locked_after_five_failures() {
        let directory = tempdir().expect("temporary directory");
        initialize(directory.path()).expect("initialize schema");

        for _ in 0..4 {
            assert!(record_failed_login(directory.path(), "operator")
                .expect("record failure")
                .is_none());
        }
        let locked = record_failed_login(directory.path(), "operator")
            .expect("record failure")
            .expect("percobaan kelima harus mengunci akun");
        assert!(locked > 0);
        assert!(login_lock_remaining(directory.path(), "operator")
            .expect("lock remaining")
            .is_some());

        clear_login_failures(directory.path(), "operator").expect("clear failures");
        assert!(login_lock_remaining(directory.path(), "operator")
            .expect("lock remaining")
            .is_none());
    }

    #[test]
    fn device_identity_is_local_and_stable() {
        let directory = tempdir().expect("temporary directory");
        initialize(directory.path()).expect("initialize schema");
        let first = get_or_create_device_id(directory.path()).expect("device id");
        let second = get_or_create_device_id(directory.path()).expect("device id");
        assert_eq!(first, second);
        assert!(!first.is_empty());
    }

    /// SQL ringkasan interaksi lead (`clients::LEAD_SUMMARY_UPDATE_SQL`) bekerja
    /// di skema lokal yang sebenarnya: kiriman ulang tidak menghitung ganda dan
    /// interaksi yang dicatat mundur tidak memundurkan tanggal. Padanan TS:
    /// `src/lib/server/leads.test.ts`.
    #[test]
    fn ringkasan_interaksi_lead_aman_diulang() {
        use super::super::clients::{LEAD_INTERACTION_INSERT_SQL, LEAD_SUMMARY_UPDATE_SQL};
        let directory = tempdir().expect("temporary directory");
        initialize(directory.path()).expect("schema");
        let connection = database(directory.path()).expect("database connection");
        connection
            .execute(
                "INSERT INTO leads (id, client_id, pic_cs_id, channel_option_id, product_category_option_id, last_client_response_at, created_at, updated_at) VALUES ('lead-1', 'client-1', 7, 'ch', 'cat', '2026-09-20 00:00:00', '2026-09-20 00:00:00', '2026-09-20 00:00:00');",
                [],
            )
            .expect("lead");
        let record = |id: &str, direction: &str, at: &str| {
            connection
                .execute(LEAD_SUMMARY_UPDATE_SQL, rusqlite::params![direction, at, "lead-1", id])
                .expect("summary");
            connection
                .execute(
                    LEAD_INTERACTION_INSERT_SQL,
                    rusqlite::params![id, "lead-1", 7, direction, "CALL", "catatan", at, at],
                )
                .expect("insert");
        };
        record("a", "OUTBOUND", "2026-09-24 10:00:00");
        record("a", "OUTBOUND", "2026-09-24 10:00:00");
        record("b", "OUTBOUND", "2026-09-22 10:00:00");
        record("c", "INBOUND", "2026-09-23 08:00:00");
        let (followup, response, total): (String, String, i64) = connection
            .query_row(
                "SELECT last_followup_at, last_client_response_at, total_followups FROM leads WHERE id = 'lead-1';",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("lead row");
        assert_eq!(followup, "2026-09-24 10:00:00");
        assert_eq!(response, "2026-09-23 08:00:00");
        assert_eq!(total, 2);
    }

    /// Log audit lokal hanya-tambah: kiriman ulang dengan id yang sama tidak
    /// menimpa baris yang sudah ada (PRD FR-10.2), dan daftar filter berjalan
    /// di skema lokal. Padanan TS: `src/lib/server/audit.test.ts`.
    #[test]
    fn log_audit_lokal_hanya_tambah() {
        use super::super::clients::{DOMAIN_AUDIT_INSERT_SQL, DOMAIN_AUDIT_LIST_SQL};
        let directory = tempdir().expect("temporary directory");
        initialize(directory.path()).expect("schema");
        let connection = database(directory.path()).expect("database connection");
        for label in ["asli", "tiruan"] {
            connection
                .execute(
                    DOMAIN_AUDIT_INSERT_SQL,
                    rusqlite::params![
                        "audit-1", 7, "CS", "client.update", "client", "client-1",
                        format!("{{\"name\":\"{label}\"}}"), "2026-09-25 01:00:00"
                    ],
                )
                .expect("insert");
        }
        let summary: String = connection
            .query_row("SELECT summary_json FROM domain_audit_log WHERE id = 'audit-1';", [], |row| row.get(0))
            .expect("row");
        assert_eq!(summary, "{\"name\":\"asli\"}");
        let count = |entity: &str, actor: i64| -> usize {
            let mut statement = connection.prepare(DOMAIN_AUDIT_LIST_SQL).expect("prepare");
            statement
                .query_map(rusqlite::params![entity, actor, "", ""], |_| Ok(()))
                .expect("query")
                .count()
        };
        assert_eq!(count("", 0), 1);
        assert_eq!(count("client", 7), 1);
        assert_eq!(count("lead", 0), 0);
        assert_eq!(count("", 8), 0);
    }
}

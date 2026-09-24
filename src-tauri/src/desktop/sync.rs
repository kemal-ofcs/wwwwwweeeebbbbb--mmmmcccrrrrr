use std::{
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicBool, Ordering},
    time::SystemTime,
};

use rusqlite::{params, types::Value as SqlValue, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    config::DesktopState,
    models::{CommandError, DesktopSyncStatus},
    storage,
    turso::TursoClient,
};

/// Versi skema yang dipahami build ini. WAJIB dinaikkan bersama
/// `CURRENT_SCHEMA_VERSION` di `web-desktop/src/lib/db-schema.ts` setiap kali
/// migrasi baru ditambahkan, karena keduanya membaca tabel `schema_migration`
/// yang sama di Turso.
pub const CLIENT_SCHEMA_VERSION: i64 = 2;

/// Hanya `cloud > client` yang berbahaya; `cloud <= client` adalah kondisi normal.
fn is_client_schema_outdated(cloud_version: i64) -> bool {
    cloud_version > CLIENT_SCHEMA_VERSION
}

fn schema_outdated_error(cloud_version: i64) -> CommandError {
    CommandError::new(
        "SCHEMA_VERSION_OUTDATED",
        format!(
            "Aplikasi perlu diperbarui. Skema database cloud sudah versi {cloud_version}, \
             sedangkan aplikasi ini hanya mendukung versi {CLIENT_SCHEMA_VERSION}. \
             Pengiriman data dihentikan agar kolom versi baru tidak tertimpa data lama."
        ),
    )
}

/// Menolak push dari build yang skemanya lebih tua daripada cloud.
///
/// Arah sebaliknya (client lebih baru daripada cloud) sengaja dibiarkan lewat:
/// itu jalur normal, karena `TursoClient::ensure_schema` pada client barulah yang
/// memigrasi cloud. Yang berbahaya hanya client lama menimpa baris yang skemanya
/// sudah lebih baru, sebab kolom yang belum dikenal tidak ikut di-`SNAPSHOT_TABLES`
/// dan akan hilang saat ditulis ulang.
async fn assert_cloud_schema_compatible(turso: &TursoClient) -> Result<(), CommandError> {
    let cloud_version = turso
        .query_one(
            "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration;",
            vec![],
        )
        .await?
        .to_objects()
        .into_iter()
        .next()
        .and_then(|row| row.get("version").cloned())
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        })
        .unwrap_or(0);
    if is_client_schema_outdated(cloud_version) {
        return Err(schema_outdated_error(cloud_version));
    }
    Ok(())
}

struct SnapshotTable {
    payload_key: &'static str,
    domain: &'static str,
    table: &'static str,
    columns: &'static [&'static str],
    conflict_column: &'static str,
    entity_column: &'static str,
    delete_missing: bool,
}

/// Tabel yang ikut ditarik dari cloud ke SQLite lokal.
///
/// Ini satu dari empat lapisan yang WAJIB memakai nama tabel dan kolom identik:
/// registri ini, DDL lokal di `storage.rs`, DDL cloud di `turso.rs`, dan skema
/// server di `db-schema.ts`. Satu kolom yang berbeda ejaan membuat baris tabel
/// itu gagal ditulis dan sinkronisasi berhenti pada tabel tersebut.
///
/// - `payload_key` harus sama dengan `SNAPSHOT_SOURCES` di `turso.rs`.
/// - `conflict_column` adalah kunci upsert lokal; pilih kolom yang stabil lintas
///   perangkat (kode bisnis), bukan rowid yang berbeda di tiap instalasi.
/// - `entity_column` adalah identitas baris untuk `desktop_entity_revision`.
/// - `delete_missing` hanya untuk tabel yang cloud-nya benar-benar otoritatif.
///   Untuk log transaksional biarkan `false`: baris lokal yang belum pernah
///   terkirim tidak boleh dihapus hanya karena cloud belum memilikinya.
const SNAPSHOT_TABLES: &[SnapshotTable] = &[
    SnapshotTable {
        payload_key: "items",
        domain: "item",
        table: "master_item",
        columns: &[
            "kode_item",
            "nama",
            "kategori",
            "harga",
            "satuan",
            "catatan",
            "status_aktif",
            "update_terakhir",
        ],
        conflict_column: "kode_item",
        entity_column: "kode_item",
        delete_missing: true,
    },
    SnapshotTable {
        payload_key: "activities",
        domain: "activity",
        table: "log_aktivitas",
        columns: &[
            "event_key",
            "kode_item",
            "jenis",
            "jumlah",
            "keterangan",
            "kode_operator",
            "waktu",
        ],
        conflict_column: "event_key",
        entity_column: "event_key",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "settings",
        domain: "setting",
        table: "setting_gex_system",
        columns: &["key", "value"],
        conflict_column: "key",
        entity_column: "key",
        delete_missing: false,
    },
    // `delete_missing: false` seperti seluruh tabel lain di sini, dan untuk
    // tabel baris-tunggal alasannya lebih tajam: cloud yang untuk sesaat tidak
    // memuat baris ini — misalnya database baru yang belum pernah disunting —
    // tidak boleh menghapus identitas perusahaan yang sudah diisi di perangkat.
    SnapshotTable {
        payload_key: "companyProfiles",
        domain: "company-profile",
        table: "company_profile",
        columns: &[
            "id",
            "company_name",
            "branch_name",
            "logo_url",
            "signature_url",
            "address",
            "phone",
            "email",
            "website",
            "leader_name",
            "leader_title",
            "timezone",
            "updated_at",
        ],
        conflict_column: "id",
        entity_column: "id",
        delete_missing: false,
    },
];

/// Pasangan (domain, operation) yang boleh diproduksi outbox.
///
/// Daftar ini WAJIB sama persis dengan `canonical_sync_route` di `turso.rs`.
/// Producer yang menulis pasangan di luar daftar akan ditolak batas cloud
/// sebagai konflik dan macet permanen di antrean.
const CANONICAL_SYNC_ROUTES: &[(&str, &str)] = &[
    ("item", "create"),
    ("item", "update"),
    ("item", "delete"),
    ("activity", "record"),
    ("setting", "update"),
    ("setting", "upsert"),
    ("company-profile", "update"),
];

/// Apakah pasangan (domain, operation) boleh diproduksi outbox.
///
/// Gerbang tunggal sisi produsen. Pasangan yang tidak terdaftar ditolak di sini,
/// sebelum sempat masuk antrean — bukan setelah ditolak cloud dan macet
/// permanen sebagai konflik.
fn is_canonical_sync_route(domain: &str, operation: &str) -> bool {
    CANONICAL_SYNC_ROUTES
        .iter()
        .any(|(route_domain, route_operation)| {
            *route_domain == domain && *route_operation == operation
        })
}

pub const DEVICE_LOCAL_SETTING_KEYS: &[&str] = &[
    "turso_database_url",
    "turso_auth_token",
    "server_api_base_url",
    // Provider dan izin transport adalah bagian tak terpisahkan dari alamat
    // database perangkat ini. Kalau ikut tersinkronisasi, perangkat lain akan
    // menarik "self_hosted" beserta URL LAN milik kantor dan mencoba
    // menghubungi 192.168.x.x dari jaringan yang sama sekali berbeda.
    "turso_database_provider",
    "turso_allow_insecure_transport",
];

pub fn is_device_local_setting(key: &str) -> bool {
    DEVICE_LOCAL_SETTING_KEYS.contains(&key)
}

fn sql_value(value: Option<&Value>) -> SqlValue {
    match value {
        None | Some(Value::Null) => SqlValue::Null,
        Some(Value::Bool(value)) => SqlValue::Integer(i64::from(*value)),
        Some(Value::Number(value)) => value
            .as_i64()
            .map(SqlValue::Integer)
            .or_else(|| value.as_f64().map(SqlValue::Real))
            .unwrap_or(SqlValue::Null),
        Some(Value::String(value)) => SqlValue::Text(value.clone()),
        Some(value) => SqlValue::Text(value.to_string()),
    }
}

fn entity_key(row: &Value, column: &str) -> String {
    match row.get(column) {
        Some(Value::String(value)) => value.clone(),
        Some(value) => value.to_string().trim_matches('"').to_owned(),
        None => String::new(),
    }
}

/// Snapshot in-memory dari seluruh entri outbox yang belum tuntas.
///
/// Dibangun sekali di awal `apply_snapshot`, lalu dipakai untuk memeriksa setiap
/// baris snapshot. Versi lama menembakkan 1-4 query per baris — dua di antaranya
/// `json_extract` tanpa indeks yang memindai seluruh outbox — sehingga biaya
/// penerapan snapshot adalah O(baris x outbox). Sekarang O(baris + outbox).
#[derive(Default)]
struct PendingGuard {
    /// Kunci gabungan `domain \u{1} entity_key`; satu alokasi per pencarian.
    by_domain_key: HashSet<String>,
    attendance_sessions: HashSet<String>,
    scan_logs: HashSet<(String, String, String, String)>,
}

fn guard_key(domain: &str, key: &str) -> String {
    format!("{domain}\u{1}{key}")
}

impl PendingGuard {
    fn load(transaction: &Transaction<'_>) -> Result<Self, CommandError> {
        let mut guard = Self::default();
        let mut statement = transaction
            .prepare(
                r#"
      SELECT domain, entity_key,
             COALESCE(json_extract(payload_json, '$.attendance.id_sesi'), '') AS sesi,
             COALESCE(json_extract(payload_json, '$.log.timestamp_scan'), '') AS log_ts,
             COALESCE(json_extract(payload_json, '$.log.id_karyawan'), '') AS log_emp,
             COALESCE(json_extract(payload_json, '$.log.jenis_scan'), '') AS log_kind,
             COALESCE(json_extract(payload_json, '$.log.id_referensi'), '') AS log_ref
      FROM desktop_sync_outbox
      WHERE status IN ('pending', 'failed', 'conflict');
      "#,
            )
            .map_err(|_| CommandError::internal())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2).unwrap_or_default(),
                    row.get::<_, String>(3).unwrap_or_default(),
                    row.get::<_, String>(4).unwrap_or_default(),
                    row.get::<_, String>(5).unwrap_or_default(),
                    row.get::<_, String>(6).unwrap_or_default(),
                ))
            })
            .map_err(|_| CommandError::internal())?;
        for row in rows {
            let (domain, key, sesi, log_ts, log_emp, log_kind, log_ref) =
                row.map_err(|_| CommandError::internal())?;
            guard.by_domain_key.insert(guard_key(&domain, &key));
            if !sesi.is_empty() {
                guard.attendance_sessions.insert(sesi);
            }
            if !(log_ts.is_empty() && log_emp.is_empty()) {
                guard.scan_logs.insert((log_ts, log_emp, log_kind, log_ref));
            }
        }
        Ok(guard)
    }

    fn has(&self, domain: &str, key: &str) -> bool {
        self.by_domain_key.contains(&guard_key(domain, key))
    }

    fn row_has_unsynced_change(&self, definition: &SnapshotTable, row: &Value, key: &str) -> bool {
        if self.has(definition.domain, key) {
            return true;
        }
        match definition.domain {
            "shift" => {
                let code = entity_key(row, "kode_shift");
                if !code.is_empty()
                    && (self.has("shift", &format!("kode:{code}")) || self.has("shift", &code))
                {
                    return true;
                }
                let shift_id = entity_key(row, "id_shift");
                !shift_id.is_empty() && self.has("shift", &shift_id)
            }
            "attendance" => self.attendance_sessions.contains(key),
            "log-scan" => self.scan_logs.contains(&(
                entity_key(row, "timestamp_scan"),
                entity_key(row, "id_karyawan"),
                entity_key(row, "jenis_scan"),
                entity_key(row, "id_referensi"),
            )),
            _ => false,
        }
    }
}

fn sync_table_error(table: &str, err: impl std::fmt::Display) -> CommandError {
    CommandError::new(
        "DESKTOP_SYNC_APPLY_FAILED",
        format!("The snapshot of table {table} could not be applied to the local database: {err}"),
    )
}

const REVISION_UPSERT_SQL: &str = r#"
INSERT INTO desktop_entity_revision (
  domain, entity_key, server_revision, payload_hash, updated_at
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(domain, entity_key) DO UPDATE SET
  server_revision = excluded.server_revision,
  payload_hash = excluded.payload_hash,
  updated_at = excluded.updated_at;
"#;

/// Sidik jari satu baris snapshot. Nama tabel ikut di-hash supaya dua tabel yang
/// berbagi `domain` (mis. `payroll_runs`, `payroll_items`, `payroll_audit_logs`)
/// tidak pernah saling mengaku identik lewat `desktop_entity_revision` yang
/// berkunci `(domain, entity_key)`.
fn row_payload_hash(table: &str, row: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(table.as_bytes());
    hasher.update([0u8]);
    hasher.update(row.to_string().as_bytes());
    hex::encode(hasher.finalize())
}

fn apply_table(
    transaction: &Transaction<'_>,
    guard: &PendingGuard,
    hashes: &mut HashMap<String, String>,
    snapshot: &Value,
    definition: &SnapshotTable,
    revision: i64,
) -> Result<usize, CommandError> {
    // Kunci payload yang tidak dikirim server berarti "tabel ini tidak berubah"
    // pada pull inkremental — bukan "tabel ini kosong". Berhenti lebih awal agar
    // blok delete_missing tidak pernah menyentuhnya.
    let Some(rows) = snapshot
        .get(definition.payload_key)
        .and_then(Value::as_array)
    else {
        return Ok(0);
    };
    let placeholders = vec!["?"; definition.columns.len()].join(", ");
    let conflict_cols = definition
        .conflict_column
        .split(',')
        .map(str::trim)
        .collect::<Vec<_>>();
    let updates = definition
        .columns
        .iter()
        .filter(|column| !conflict_cols.contains(column))
        .map(|column| format!("{column} = excluded.{column}"))
        .collect::<Vec<_>>()
        .join(", ");
    let statement = format!(
        "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT({}) DO UPDATE SET {};",
        definition.table,
        definition.columns.join(", "),
        placeholders,
        definition.conflict_column,
        updates,
    );

    let snapshot_keys = rows
        .iter()
        .map(|row| entity_key(row, definition.entity_column))
        .filter(|key| !key.is_empty())
        .collect::<HashSet<_>>();

    // Kalau tabel lokal benar-benar kosong sementara server mengirim baris, cache
    // hash tidak boleh dipercaya (mis. tabel sempat dikosongkan di luar aplikasi).
    // Tulis ulang semuanya sekali supaya drift seperti itu sembuh sendiri.
    let distrust_hash_cache = !rows.is_empty()
        && transaction
            .query_row(
                &format!(
                    "SELECT NOT EXISTS(SELECT 1 FROM {} LIMIT 1);",
                    definition.table
                ),
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap_or(false);

    let mut written = 0usize;
    {
        let mut upsert_row = transaction
            .prepare_cached(&statement)
            .map_err(|err| sync_table_error(definition.table, err))?;
        let mut upsert_revision = transaction
            .prepare_cached(REVISION_UPSERT_SQL)
            .map_err(|_| CommandError::internal())?;

        for row in rows {
            let key = entity_key(row, definition.entity_column);
            if key.is_empty() || guard.row_has_unsynced_change(definition, row, &key) {
                continue;
            }
            // Konfigurasi koneksi milik perangkat lain tidak boleh menimpa milik kita.
            if definition.domain == "setting" && is_device_local_setting(&key) {
                continue;
            }

            // Lewati baris yang isinya persis sama dengan yang sudah tersimpan.
            // Inilah yang memangkas mayoritas tulisan: snapshot penuh biasanya
            // hanya berbeda di segelintir baris, sisanya identik.
            let payload_hash = row_payload_hash(definition.table, row);
            let cache_key = guard_key(definition.domain, &key);
            if !distrust_hash_cache
                && hashes
                    .get(&cache_key)
                    .is_some_and(|previous| previous == &payload_hash)
            {
                continue;
            }

            let values = definition
                .columns
                .iter()
                .map(|column| sql_value(row.get(*column)))
                .collect::<Vec<_>>();
            upsert_row
                .execute(rusqlite::params_from_iter(values))
                .map_err(|err| sync_table_error(definition.table, err))?;
            upsert_revision
                .execute(params![
                    definition.domain,
                    key,
                    revision,
                    payload_hash,
                    storage::now_epoch_seconds(),
                ])
                .map_err(|_| CommandError::internal())?;
            hashes.insert(cache_key, payload_hash);
            written += 1;
        }
    }
    if definition.delete_missing {
        let select = format!(
            "SELECT CAST({} AS TEXT) FROM {};",
            definition.entity_column, definition.table
        );
        let mut statement = transaction
            .prepare(&select)
            .map_err(|_| CommandError::internal())?;
        let local_keys = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| CommandError::internal())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?;
        drop(statement);
        let delete = format!(
            "DELETE FROM {} WHERE CAST({} AS TEXT) = ?;",
            definition.table, definition.entity_column
        );
        for key in local_keys {
            if snapshot_keys.contains(&key) || guard.has(definition.domain, &key) {
                continue;
            }
            let cache_key = guard_key(definition.domain, &key);
            // Jejak `desktop_entity_revision` sudah dimuat di awal apply_snapshot,
            // jadi asal-usul baris diperiksa dari memori, bukan query per baris.
            let came_from_server = hashes.contains_key(&cache_key);
            if !came_from_server {
                // Baris lokal murni yang tidak pernah datang dari server: jangan dihapus.
                continue;
            }
            transaction
                .execute(&delete, [&key])
                .map_err(|_| CommandError::internal())?;
            transaction
                .execute(
                    "DELETE FROM desktop_entity_revision WHERE domain = ? AND entity_key = ?;",
                    params![definition.domain, key],
                )
                .map_err(|_| CommandError::internal())?;
            hashes.remove(&cache_key);
            written += 1;
        }
    }
    Ok(written)
}

pub fn ensure_client_id(state: &DesktopState) -> Result<String, CommandError> {
    let server_origin = state.server_origin();
    let connection = storage::database(&state.data_dir)?;
    if let Ok(client_id) = connection.query_row(
        "SELECT client_id FROM desktop_client_identity WHERE server_origin = ?;",
        [&server_origin],
        |row| row.get(0),
    ) {
        return Ok(client_id);
    }
    let created_at = storage::now_epoch_seconds();
    let mut hasher = Sha256::new();
    hasher.update(server_origin.as_bytes());
    hasher.update(state.data_dir.to_string_lossy().as_bytes());
    hasher.update(created_at.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    let client_id = format!("desktop-{}", hex::encode(hasher.finalize()));
    connection
        .execute(
            r#"
      INSERT OR IGNORE INTO desktop_client_identity (server_origin, client_id, created_at)
      VALUES (?, ?, ?);
      "#,
            params![server_origin, client_id, created_at],
        )
        .map_err(|_| CommandError::internal())?;
    connection
        .query_row(
            "SELECT client_id FROM desktop_client_identity WHERE server_origin = ?;",
            [&server_origin],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())
}

pub fn new_event_id(client_id: &str, domain: &str, operation: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(client_id.as_bytes());
    hasher.update(domain.as_bytes());
    hasher.update(operation.as_bytes());
    hasher.update(nanos.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    format!("evt-{}", hex::encode(hasher.finalize()))
}

pub fn new_local_id() -> i64 {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(1);
    const MAX_SAFE_JSON_INTEGER: u128 = 9_007_199_254_740_991;
    -((nanos % (MAX_SAFE_JSON_INTEGER - 1)) as i64 + 1)
}

pub fn enqueue(
    transaction: &Transaction<'_>,
    client_id: &str,
    domain: &str,
    operation: &str,
    entity_key: &str,
    payload: &Value,
    base_revision: Option<i64>,
) -> Result<String, CommandError> {
    let payload_json = payload.to_string();
    if !is_canonical_sync_route(domain, operation)
        || entity_key.trim().is_empty()
        || entity_key.len() > 160
        || !payload.is_object()
        || payload_json.len() > 25_165_824
    {
        return Err(CommandError::new(
            "DESKTOP_SYNC_EVENT_INVALID",
            format!("Invalid sync event: {domain}/{operation}."),
        ));
    }
    // Penjagaan terakhir: konfigurasi koneksi perangkat tidak boleh masuk outbox.
    if domain == "setting" && is_device_local_setting(entity_key) {
        return Err(CommandError::new(
            "DESKTOP_SYNC_EVENT_INVALID",
            format!("Setting '{entity_key}' is device-local and is not synced."),
        ));
    }
    let event_id = new_event_id(client_id, domain, operation);
    let now = storage::now_epoch_seconds();
    transaction
        .execute(
            r#"
      INSERT INTO desktop_sync_outbox (
        event_id, client_id, domain, operation, entity_key,
        payload_json, base_revision, status, attempt_count,
        next_retry_at, last_error, server_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?);
      "#,
            params![
                event_id,
                client_id,
                domain,
                operation,
                entity_key,
                payload_json,
                base_revision,
                now,
                now,
            ],
        )
        .map_err(|_| CommandError::internal())?;
    Ok(event_id)
}

/// Nilai `sync_pulse` cloud yang terakhir berhasil diterapkan, per tabel.
fn load_table_cursors(state: &DesktopState) -> Result<HashMap<String, i64>, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare("SELECT table_name, remote_revision FROM desktop_sync_table_cursor;")
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|_| CommandError::internal())?;
    let mut cursors = HashMap::new();
    for row in rows {
        let (table, revision) = row.map_err(|_| CommandError::internal())?;
        cursors.insert(table, revision);
    }
    Ok(cursors)
}

/// Membaca sidik jari baris yang terakhir diterapkan dari server, sekali saja
/// untuk seluruh snapshot. Dipakai `apply_table` untuk melewatkan baris yang
/// tidak berubah tanpa satu pun query tambahan per baris.
fn load_revision_hashes(
    transaction: &Transaction<'_>,
) -> Result<HashMap<String, String>, CommandError> {
    let mut statement = transaction
        .prepare("SELECT domain, entity_key, payload_hash FROM desktop_entity_revision;")
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|_| CommandError::internal())?;
    let mut hashes = HashMap::new();
    for row in rows {
        let (domain, key, hash) = row.map_err(|_| CommandError::internal())?;
        hashes.insert(guard_key(&domain, &key), hash);
    }
    Ok(hashes)
}

pub fn apply_snapshot_with_pulse(
    state: &DesktopState,
    payload: &Value,
    pulse: Option<&HashMap<String, i64>>,
) -> Result<usize, CommandError> {
    // Pastikan skema lokal sudah memuat seluruh tabel snapshot terbaru (mis. id_card_template,
    // company_profile) sebelum menerapkan data server. Tanpa ini, client dengan skema lokal yang
    // tertinggal (belum sempat relaunch sejak tabel baru ditambahkan) akan gagal total di tengah
    // transaksi apply_table dan me-rollback SELURUH snapshot, bukan hanya tabel yang hilang.
    storage::initialize(&state.data_dir).map_err(|_| {
        CommandError::new(
            "DESKTOP_SCHEMA_MIGRATION_FAILED",
            "The local database schema could not be prepared before applying the sync snapshot.",
        )
    })?;
    let snapshot = payload.get("snapshot").unwrap_or(payload);
    let revision = snapshot
        .get("revision")
        .and_then(Value::as_i64)
        .filter(|revision| *revision >= 0)
        .ok_or_else(CommandError::internal)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    // Snapshot yang revisinya lebih tua daripada cursor lokal adalah data basi —
    // misalnya replika cloud yang tertinggal. Menerapkannya akan memundurkan
    // cursor dan menimpa baris lokal dengan versi lama.
    let local_revision: i64 = transaction
        .query_row(
            "SELECT last_revision FROM desktop_sync_cursor WHERE domain = 'operational';",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if revision < local_revision {
        return Err(CommandError::new(
            "DESKTOP_SYNC_SNAPSHOT_STALE",
            format!(
                "Cloud snapshot revision {revision} is older than local data revision {local_revision}. The snapshot was ignored so newer data is not overwritten."
            ),
        ));
    }

    let guard = PendingGuard::load(&transaction)?;
    let mut hashes = load_revision_hashes(&transaction)?;
    // Kait rekonsiliasi foreign key sebelum snapshot diterapkan. Aplikasi asal
    // memakainya untuk menukar id shift lokal sementara dengan id dari server
    // dan meng-cascade-nya ke tabel anak sebelum tabel induknya ditulis ulang.
    // Template ini memakai kunci bisnis sehingga tidak memerlukannya.
    let mut written = 0usize;
    for definition in SNAPSHOT_TABLES {
        written += apply_table(
            &transaction,
            &guard,
            &mut hashes,
            snapshot,
            definition,
            revision,
        )?;
    }

    // Catat pulse cloud per tabel. Pemanggil hanya mengirim entri untuk tabel
    // yang benar-benar ikut ditarik; tabel lain tetap memakai cursor lamanya
    // sehingga pull berikutnya masih menganggapnya basi.
    if let Some(pulse) = pulse {
        for (table, remote_revision) in pulse {
            transaction
                .execute(
                    r#"
          INSERT INTO desktop_sync_table_cursor (table_name, remote_revision, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(table_name) DO UPDATE SET
            remote_revision = excluded.remote_revision,
            updated_at = excluded.updated_at;
          "#,
                    params![table, remote_revision, storage::now_epoch_seconds()],
                )
                .map_err(|_| CommandError::internal())?;
        }
    }

    transaction
        .execute(
            r#"
      INSERT INTO desktop_sync_cursor (domain, last_revision, updated_at)
      VALUES ('operational', ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        last_revision = excluded.last_revision,
        updated_at = excluded.updated_at;
      "#,
            params![revision, storage::now_epoch_seconds()],
        )
        .map_err(|_| CommandError::internal())?;
    transaction
        .commit()
        .map_err(|_| CommandError::internal())
        .map(|()| written)
}

pub async fn pull_snapshot(state: &DesktopState) -> Result<DesktopSyncStatus, CommandError> {
    if let Ok(turso) = state.get_turso_client() {
        let (last_rev, _) = {
            let connection = storage::database(&state.data_dir)?;
            connection
                .query_row(
                    "SELECT last_revision, updated_at FROM desktop_sync_cursor WHERE domain = 'operational';",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
                )
                .unwrap_or((0, None))
        };

        // Probe murah sebelum menarik apa pun: satu query kecil ke `sync_pulse`
        // memberi tahu tabel mana saja yang berubah sejak pull terakhir. Trigger
        // pulse di cloud ikut naik untuk penulisan dari perangkat lain MAUPUN
        // dari route handler Web yang menulis langsung ke Turso, jadi probe ini
        // tidak bisa melewatkan perubahan. Bila tidak ada yang berubah, siklus
        // sync selesai tanpa menarik satu baris pun.
        let pulse = turso.fetch_sync_pulse().await?;
        let wanted = match pulse.as_ref() {
            Some(pulse) => {
                let local = load_table_cursors(state)?;
                let stale = pulse
                    .iter()
                    .filter(|(table, remote)| local.get(table.as_str()) != Some(remote))
                    .map(|(table, _)| table.clone())
                    .collect::<HashSet<String>>();
                if stale.is_empty() {
                    return status(state);
                }
                Some(stale)
            }
            // Database cloud lama tanpa tabel pulse: jatuh ke pull penuh.
            None => None,
        };

        let payload = turso.pull_snapshot_tables(last_rev, wanted.as_ref()).await?;
        let applied_pulse = pulse.as_ref().map(|pulse| {
            pulse
                .iter()
                .filter(|(table, _)| match wanted.as_ref() {
                    None => true,
                    Some(stale) => stale.contains(table.as_str()),
                })
                .map(|(table, revision)| (table.clone(), *revision))
                .collect::<HashMap<String, i64>>()
        });
        let written = apply_snapshot_with_pulse(state, &payload, applied_pulse.as_ref())?;
        let mut result = status(state)?;
        result.changed_rows = i64::try_from(written).unwrap_or(i64::MAX);
        return Ok(result);
    }

    // Database belum dikonfigurasi: tidak ada yang bisa ditarik. Ini bukan
    // error — perangkat baru memang berada di keadaan ini sampai provisioning
    // selesai, dan siklus sync tetap harus melaporkan status apa adanya.
    status(state)
}

fn mark_batch_failed(state: &DesktopState, event_ids: &[String], message: &str) {
    if event_ids.is_empty() {
        return;
    }
    if let Ok(mut connection) = storage::database(&state.data_dir) {
        if let Ok(transaction) = connection.transaction() {
            for event_id in event_ids {
                let attempt: i64 = transaction
                    .query_row(
                        "SELECT attempt_count FROM desktop_sync_outbox WHERE event_id = ?;",
                        [event_id],
                        |row| row.get(0),
                    )
                    .unwrap_or_default();
                let exponent = u32::try_from(attempt.clamp(0, 8)).unwrap_or_default();
                let delay = 5_i64.saturating_mul(2_i64.saturating_pow(exponent));
                let _ = transaction.execute(
                    r#"
          UPDATE desktop_sync_outbox SET status = 'failed',
            attempt_count = attempt_count + 1, next_retry_at = ?,
            last_error = ?, updated_at = ? WHERE event_id = ?;
          "#,
                    params![
                        storage::now_epoch_seconds() + delay,
                        message,
                        storage::now_epoch_seconds(),
                        event_id,
                    ],
                );
            }
            let _ = transaction.commit();
        }
    }
}

fn pending_events(state: &DesktopState) -> Result<(String, Vec<Value>), CommandError> {
    let client_id = ensure_client_id(state)?;
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            r#"
      SELECT event_id, client_id, domain, operation, entity_key, payload_json,
             base_revision, created_at
      FROM desktop_sync_outbox
      WHERE status = 'pending'
         OR (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ?)
         -- Konflik UNIQUE pada shift/karyawan memang layak dicoba ulang: baris
         -- kembarannya biasanya sudah direkonsiliasi oleh pull berikutnya.
         -- Tetapi retry-nya WAJIB ikut backoff. Tanpa `next_retry_at`, konflik
         -- yang tidak pernah bisa selesai (mis. kode_shift yang memang benar-benar
         -- dobel) akan didorong ulang ke cloud setiap siklus 30 detik selamanya,
         -- menghabiskan kuota dan baterai perangkat lapangan.
         OR (status = 'conflict' AND operation = 'create'
             AND (next_retry_at IS NULL OR next_retry_at <= ?)
             AND (
              (domain = 'shift' AND last_error LIKE '%UNIQUE constraint failed: tbl_shift.kode_shift%')
              OR (domain = 'employee' AND last_error LIKE '%UNIQUE constraint failed: master_data.id_unik%')
            ))
      ORDER BY
        CASE WHEN domain = 'shift' AND operation = 'create' THEN 0 ELSE 1 END,
        created_at ASC
      LIMIT 50;
      "#,
        )
        .map_err(|_| CommandError::internal())?;
    let now = storage::now_epoch_seconds();
    let rows = statement
        .query_map([now, now], |row| {
            let payload: String = row.get(5)?;
            Ok(json!({
                "eventId": row.get::<_, String>(0)?,
                "clientId": row.get::<_, String>(1)?,
                "domain": row.get::<_, String>(2)?,
                "operation": row.get::<_, String>(3)?,
                "entityKey": row.get::<_, String>(4)?,
                "payload": serde_json::from_str::<Value>(&payload).unwrap_or(Value::Null),
                "baseRevision": row.get::<_, Option<i64>>(6)?,
                "createdAt": row.get::<_, i64>(7)?,
            }))
        })
        .map_err(|_| CommandError::internal())?;
    Ok((
        client_id,
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?,
    ))
}

fn validate_push_results(
    expected_event_ids: &[String],
    results: &[Value],
) -> Result<(), CommandError> {
    if results.len() != expected_event_ids.len() {
        return Err(CommandError::internal());
    }
    let expected = expected_event_ids.iter().collect::<HashSet<_>>();
    let mut received = HashSet::with_capacity(results.len());
    for result in results {
        let event_id = result
            .get("eventId")
            .and_then(Value::as_str)
            .filter(|event_id| !event_id.is_empty())
            .ok_or_else(CommandError::internal)?;
        if !expected.contains(&event_id.to_owned()) || !received.insert(event_id) {
            return Err(CommandError::internal());
        }
        let status = result
            .get("status")
            .and_then(Value::as_str)
            .ok_or_else(CommandError::internal)?;
        if !matches!(status, "applied" | "rejected" | "conflict") {
            return Err(CommandError::internal());
        }
        if result
            .get("message")
            .and_then(Value::as_str)
            .filter(|message| !message.is_empty())
            .is_none()
        {
            return Err(CommandError::internal());
        }
        if status == "applied"
            && result
                .get("serverRevision")
                .and_then(Value::as_i64)
                .filter(|revision| *revision > 0)
                .is_none()
        {
            return Err(CommandError::internal());
        }
    }
    Ok(())
}

fn apply_push_results(
    state: &DesktopState,
    expected_event_ids: &[String],
    results: &[Value],
) -> Result<(), CommandError> {
    validate_push_results(expected_event_ids, results)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    for result in results {
        let event_id = result
            .get("eventId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let sync_status = result
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("rejected");
        let message = result
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Invalid sync response.");
        let server_revision = result.get("serverRevision").and_then(Value::as_i64);
        let source = transaction
            .query_row(
                r#"
        SELECT domain, entity_key, payload_json FROM desktop_sync_outbox
        WHERE event_id = ?;
        "#,
                [event_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| CommandError::internal())?;
        let Some((domain, entity_key, local_payload)) = source else {
            continue;
        };
        if sync_status == "applied" {
            transaction
                .execute(
                    r#"
          UPDATE desktop_sync_outbox SET status = 'synced', server_revision = ?,
            next_retry_at = NULL, last_error = NULL, updated_at = ?
          WHERE event_id = ?;
          "#,
                    params![server_revision, storage::now_epoch_seconds(), event_id],
                )
                .map_err(|_| CommandError::internal())?;
            transaction
                .execute(
                    "UPDATE desktop_sync_conflict SET resolved_at = ? WHERE event_id = ? AND resolved_at IS NULL;",
                    params![storage::now_epoch_seconds(), event_id],
                )
                .map_err(|_| CommandError::internal())?;
            if let Some(revision) = server_revision {
                let mut hasher = Sha256::new();
                hasher.update(local_payload.as_bytes());
                transaction
                    .execute(
                        r#"
            INSERT INTO desktop_entity_revision (
              domain, entity_key, server_revision, payload_hash, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(domain, entity_key) DO UPDATE SET
              server_revision = excluded.server_revision,
              payload_hash = excluded.payload_hash,
              updated_at = excluded.updated_at;
            "#,
                        params![
                            domain,
                            entity_key,
                            revision,
                            hex::encode(hasher.finalize()),
                            storage::now_epoch_seconds(),
                        ],
                    )
                    .map_err(|_| CommandError::internal())?;
            }

            // Titik pasang rekonsiliasi ID. Aplikasi asal memakai blok di sini
            // untuk menukar id lokal sementara (bernilai negatif, dibuat
            // `new_local_id`) dengan id yang baru diberikan server, lalu
            // meng-cascade-nya ke tabel anak dan ke payload outbox yang masih
            // mengantre. Template ini memakai kunci bisnis (`kode_item`,
            // `event_key`) sehingga tidak memerlukannya. Kalau domain Anda
            // memakai id numerik dari server, tambahkan penukaran itu di sini —
            // sebelum baris ini, outbox yang mengantre masih memuat id lama.
        } else if sync_status == "conflict" {
            // Konflik ikut menaikkan `attempt_count` dan menjadwalkan
            // `next_retry_at` dengan backoff eksponensial yang sama seperti
            // kegagalan biasa. Hanya konflik UNIQUE shift/karyawan yang benar-benar
            // diambil ulang oleh `pending_events`, tetapi tanpa jadwal ini konflik
            // itu didorong ulang setiap siklus 30 detik tanpa henti — termasuk
            // konflik yang memang tidak akan pernah selesai.
            let attempt: i64 = transaction
                .query_row(
                    "SELECT attempt_count FROM desktop_sync_outbox WHERE event_id = ?;",
                    [event_id],
                    |row| row.get(0),
                )
                .unwrap_or_default();
            let exponent = u32::try_from(attempt.clamp(0, 8)).unwrap_or_default();
            let delay = 5_i64.saturating_mul(2_i64.saturating_pow(exponent));
            transaction
                .execute(
                    r#"
          UPDATE desktop_sync_outbox SET status = 'conflict', last_error = ?,
            server_revision = ?, attempt_count = attempt_count + 1,
            next_retry_at = ?, updated_at = ? WHERE event_id = ?;
          "#,
                    params![
                        message,
                        server_revision,
                        storage::now_epoch_seconds() + delay,
                        storage::now_epoch_seconds(),
                        event_id,
                    ],
                )
                .map_err(|_| CommandError::internal())?;
            transaction
                .execute(
                    r#"
          INSERT OR REPLACE INTO desktop_sync_conflict (
            event_id, domain, entity_key, local_payload_json,
            server_payload_json, reason, created_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL);
          "#,
                    params![
                        event_id,
                        domain,
                        entity_key,
                        local_payload,
                        result.get("serverPayload").map(Value::to_string),
                        message,
                        storage::now_epoch_seconds(),
                    ],
                )
                .map_err(|_| CommandError::internal())?;
        } else {
            transaction
                .execute(
                    r#"
          UPDATE desktop_sync_outbox SET status = 'failed',
            attempt_count = attempt_count + 1, next_retry_at = NULL,
            last_error = ?, updated_at = ? WHERE event_id = ?;
          "#,
                    params![message, storage::now_epoch_seconds(), event_id],
                )
                .map_err(|_| CommandError::internal())?;
        }
    }
    transaction.commit().map_err(|_| CommandError::internal())
}

/// Kesempatan mendaftarkan ulang data lokal yang belum pernah masuk outbox.
///
/// Aplikasi asal memakai kait ini untuk menyelamatkan data yang dibuat oleh
/// versi lama sebelum tabelnya ikut disinkronkan. Biarkan kosong sampai Anda
/// benar-benar membutuhkannya; dipanggil sekali di awal setiap siklus push.
fn ensure_unsynced_local_data_enqueued(_state: &DesktopState) -> Result<(), CommandError> {
    Ok(())
}

/// Batas jumlah batch yang boleh dikirim dalam satu siklus push.
///
/// Loop push berhenti ketika satu batch berisi kurang dari 50 event. Kalau
/// seluruh 50 event dalam batch berakhir sebagai `conflict` yang layak dicoba
/// ulang, `pending_events` bisa mengembalikan 50 baris yang sama persis pada
/// putaran berikutnya dan loop tidak pernah berhenti. Batas ini memastikan
/// siklus selalu selesai; sisa antrean ikut siklus berikutnya.
const MAX_PUSH_BATCHES_PER_CYCLE: usize = 40;

pub async fn push_outbox(state: &DesktopState) -> Result<(), CommandError> {
    let _ = ensure_unsynced_local_data_enqueued(state);
    if let Ok(turso) = state.get_turso_client() {
        // Diperiksa sekali per siklus push, dan hanya bila benar-benar ada yang
        // dikirim, supaya sync idle tidak menambah round-trip ke Turso.
        let mut schema_checked = false;
        for _ in 0..MAX_PUSH_BATCHES_PER_CYCLE {
            let (_client_id, events) = pending_events(state)?;
            if events.is_empty() {
                return Ok(());
            }
            if !schema_checked {
                // Sengaja sebelum mark_batch_failed mana pun: event tetap
                // `pending` dan akan terkirim lagi setelah aplikasi diperbarui.
                assert_cloud_schema_compatible(&turso).await?;
                schema_checked = true;
            }
            let event_ids = events
                .iter()
                .filter_map(|event| event.get("eventId").and_then(Value::as_str))
                .map(str::to_owned)
                .collect::<Vec<_>>();

            let results = match turso.push_events(&events).await {
                Ok(res) => res,
                Err(error) => {
                    mark_batch_failed(state, &event_ids, &error.message);
                    return Err(error);
                }
            };

            if let Err(error) = apply_push_results(state, &event_ids, &results) {
                mark_batch_failed(
                    state,
                    &event_ids,
                    "The Turso database response is incomplete or invalid.",
                );
                return Err(error);
            }
            if event_ids.len() < 50 {
                return Ok(());
            }
        }
        return Ok(());
    }

    Ok(())
}

/// Satu siklus sinkronisasi penuh: kirim antrean lokal, lalu tarik perubahan cloud.
///
/// Push yang gagal sengaja TIDAK menghentikan pull. Sebelumnya `push_outbox(...)?`
/// langsung mengembalikan error, sehingga satu event outbox yang bermasalah
/// (atau satu gangguan jaringan sesaat) mematikan pull selamanya — perangkat
/// berhenti menerima data cloud sama sekali. Sekarang kegagalan push tetap
/// tercatat di outbox dengan backoff, dan dilaporkan lewat `push_error`.
/// Penjaga agar hanya satu siklus sinkronisasi berjalan pada satu waktu.
///
/// Auto-sync berkala, tombol sync manual, dan push setelah scan bisa datang
/// hampir bersamaan. Menjalankannya paralel tidak mempercepat apa pun — keduanya
/// hanya berebut kunci tulis SQLite lokal dan berisiko "database is locked".
static SYNC_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct SyncInFlightGuard;

impl Drop for SyncInFlightGuard {
    fn drop(&mut self) {
        SYNC_IN_FLIGHT.store(false, Ordering::Release);
    }
}

pub async fn synchronize(state: &DesktopState) -> Result<DesktopSyncStatus, CommandError> {
    if SYNC_IN_FLIGHT
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        // Siklus lain sedang berjalan; laporkan status terkini saja.
        return status(state);
    }
    let _in_flight = SyncInFlightGuard;

    let push_error = push_outbox(state).await.err();
    let pulled = pull_snapshot(state).await;

    // Penegakan RBAC dinamis untuk jalur 2-tier. Sesi Desktop/Mobile hidup di
    // memori sampai aplikasi ditutup, jadi tanpa langkah ini operator yang baru
    // saja dinonaktifkan atau dicabut permission-nya tetap memegang akses penuh
    // di perangkatnya. Sisi web sudah memeriksa `rbac_revision` pada setiap
    // request; perangkat memeriksanya sekali per siklus sinkronisasi.
    enforce_rbac_revision(state).await;

    match pulled {
        Ok(mut status) => {
            status.push_error = push_error.map(|error| error.message);
            Ok(status)
        }
        Err(pull_error) => Err(push_error.unwrap_or(pull_error)),
    }
}

/// Cabut atau segarkan sesi aktif bila katalog RBAC cloud sudah berubah.
///
/// Sengaja tidak mengembalikan error: ini pekerjaan latar di akhir siklus sync,
/// dan kegagalan jaringan TIDAK boleh menjatuhkan sinkronisasi yang sudah
/// berhasil — apalagi mencabut sesi. Sesi hanya dicabut ketika cloud menjawab
/// dengan pasti bahwa operatornya sudah tidak aktif.
async fn enforce_rbac_revision(state: &DesktopState) {
    let Some((operator_id, known_revision)) = ({
        let Ok(guard) = state.session.lock() else {
            return;
        };
        guard
            .as_ref()
            .map(|session| (session.operator.id, session.operator.permission_revision))
    }) else {
        return;
    };

    // `rbac_revision` ikut tersinkronisasi lewat `setting_gex_system`, jadi
    // perbandingannya dibaca dari SQLite lokal — nol round-trip tambahan pada
    // kasus normal ketika tidak ada perubahan role sama sekali.
    let Ok(connection) = storage::database(&state.data_dir) else {
        return;
    };
    let local_revision: Option<i64> = connection
        .query_row(
            "SELECT value FROM setting_gex_system WHERE key = 'rbac_revision' LIMIT 1;",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok());
    drop(connection);

    let Some(local_revision) = local_revision else {
        return;
    };
    if local_revision == known_revision {
        return;
    }

    let Ok(turso) = state.get_turso_client() else {
        return;
    };
    match turso.reload_operator(operator_id).await {
        Ok(Some(refreshed)) => {
            if let Ok(mut guard) = state.session.lock() {
                if let Some(session) = guard.as_mut() {
                    // Hanya perbarui bila sesi masih milik operator yang sama:
                    // pengguna bisa saja logout lalu login sebagai orang lain
                    // selama query di atas berjalan.
                    if session.operator.id == operator_id {
                        session.operator = refreshed;
                    }
                }
            }
        }
        Ok(None) => {
            if let Ok(mut guard) = state.session.lock() {
                if guard
                    .as_ref()
                    .is_some_and(|session| session.operator.id == operator_id)
                {
                    *guard = None;
                }
            }
            storage::audit(
                &state.data_dir,
                Some(operator_id),
                "session-revoked-rbac-change",
                None,
            );
        }
        // Cloud tidak menjawab: biarkan sesi apa adanya dan coba lagi siklus
        // berikutnya. Mencabut sesi di sini akan mengeluarkan operator lapangan
        // setiap kali sinyal terputus sesaat.
        Err(_) => {}
    }
}

pub fn status(state: &DesktopState) -> Result<DesktopSyncStatus, CommandError> {
    let client_id = ensure_client_id(state)?;
    let connection = storage::database(&state.data_dir)?;
    let count = |status: &str| -> Result<i64, CommandError> {
        connection
            .query_row(
                "SELECT COUNT(*) FROM desktop_sync_outbox WHERE status = ?;",
                [status],
                |row| row.get(0),
            )
            .map_err(|_| CommandError::internal())
    };
    let (last_revision, last_sync_at) = connection
        .query_row(
            r#"
      SELECT last_revision, updated_at FROM desktop_sync_cursor
      WHERE domain = 'operational';
      "#,
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or((0, None));
    let table_count = |table: &str| -> i64 {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table};"), [], |row| {
                row.get(0)
            })
            .unwrap_or_default()
    };
    Ok(DesktopSyncStatus {
        client_id,
        pending: count("pending")?,
        synced: count("synced")?,
        failed: count("failed")?,
        conflict: count("conflict")?,
        last_revision,
        last_sync_at,
        table_counts: json!({
            "items": table_count("master_item"),
            "activities": table_count("log_aktivitas"),
        }),
        push_error: None,
        changed_rows: 0,
        local_mode: state
            .turso_config()
            .is_some_and(|config| config.provider.is_local_file()),
    })
}

pub fn conflicts(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            r#"
      SELECT event_id, domain, entity_key, local_payload_json,
             server_payload_json, reason, created_at
      FROM desktop_sync_conflict WHERE resolved_at IS NULL
      ORDER BY created_at DESC LIMIT 100;
      "#,
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "eventId": row.get::<_, String>(0)?,
                "domain": row.get::<_, String>(1)?,
                "entityKey": row.get::<_, String>(2)?,
                "localPayload": serde_json::from_str::<Value>(&row.get::<_, String>(3)?).unwrap_or(Value::Null),
                "serverPayload": row.get::<_, Option<String>>(4)?.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                "reason": row.get::<_, String>(5)?,
                "createdAt": row.get::<_, i64>(6)?,
            }))
        })
        .map_err(|_| CommandError::internal())?;
    Ok(Value::Array(
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?,
    ))
}

pub fn retry_failed(state: &DesktopState, event_id: Option<&str>) -> Result<(), CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let changed = if let Some(event_id) = event_id {
        connection.execute(
            "UPDATE desktop_sync_outbox SET status = 'pending', next_retry_at = NULL, last_error = NULL, updated_at = ? WHERE event_id = ? AND status IN ('failed', 'conflict');",
            params![storage::now_epoch_seconds(), event_id],
        )
    } else {
        connection.execute(
            "UPDATE desktop_sync_outbox SET status = 'pending', next_retry_at = NULL, last_error = NULL, updated_at = ? WHERE status IN ('failed', 'conflict');",
            [storage::now_epoch_seconds()],
        )
    }.map_err(|_| CommandError::internal())?;
    if event_id.is_some() && changed == 0 {
        return Err(CommandError::new(
            "OPERATIONAL_NOT_FOUND",
            "Failed or conflicting event not found.",
        ));
    }
    Ok(())
}

pub fn resolve_conflicts(state: &DesktopState, event_id: Option<&str>) -> Result<(), CommandError> {
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let now = storage::now_epoch_seconds();
    if let Some(event_id) = event_id {
        transaction
            .execute(
                "UPDATE desktop_sync_conflict SET resolved_at = ? WHERE event_id = ? AND resolved_at IS NULL;",
                params![now, event_id],
            )
            .map_err(|_| CommandError::internal())?;
        transaction
            .execute(
                "UPDATE desktop_sync_outbox SET status = 'synced', next_retry_at = NULL, updated_at = ? WHERE event_id = ? AND status = 'conflict';",
                params![now, event_id],
            )
            .map_err(|_| CommandError::internal())?;
    } else {
        transaction
            .execute(
                "UPDATE desktop_sync_conflict SET resolved_at = ? WHERE resolved_at IS NULL;",
                [now],
            )
            .map_err(|_| CommandError::internal())?;
        transaction
            .execute(
                "UPDATE desktop_sync_outbox SET status = 'synced', next_retry_at = NULL, updated_at = ? WHERE status = 'conflict';",
                [now],
            )
            .map_err(|_| CommandError::internal())?;
    }
    transaction.commit().map_err(|_| CommandError::internal())
}

pub fn resolve_conflicts_local(
    state: &DesktopState,
    event_id: Option<&str>,
) -> Result<(), CommandError> {
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let now = storage::now_epoch_seconds();
    if let Some(event_id) = event_id {
        transaction
            .execute(
                "DELETE FROM desktop_sync_conflict WHERE event_id = ?;",
                params![event_id],
            )
            .map_err(|_| CommandError::internal())?;
        transaction
            .execute(
                "UPDATE desktop_sync_outbox SET status = 'pending', base_revision = NULL, attempt_count = 0, last_error = NULL, updated_at = ? WHERE event_id = ? AND status = 'conflict';",
                params![now, event_id],
            )
            .map_err(|_| CommandError::internal())?;
    } else {
        transaction
            .execute(
                "DELETE FROM desktop_sync_conflict;",
                [],
            )
            .map_err(|_| CommandError::internal())?;
        transaction
            .execute(
                "UPDATE desktop_sync_outbox SET status = 'pending', base_revision = NULL, attempt_count = 0, last_error = NULL, updated_at = ? WHERE status = 'conflict';",
                [now],
            )
            .map_err(|_| CommandError::internal())?;
    }
    transaction.commit().map_err(|_| CommandError::internal())
}

pub fn clear_failed(state: &DesktopState, event_id: Option<&str>) -> Result<(), CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let now = storage::now_epoch_seconds();
    if let Some(event_id) = event_id {
        connection
            .execute(
                "UPDATE desktop_sync_outbox SET status = 'synced', next_retry_at = NULL, updated_at = ? WHERE event_id = ? AND status = 'failed';",
                params![now, event_id],
            )
            .map_err(|_| CommandError::internal())?;
    } else {
        connection
            .execute(
                "UPDATE desktop_sync_outbox SET status = 'synced', next_retry_at = NULL, updated_at = ? WHERE status = 'failed';",
                [now],
            )
            .map_err(|_| CommandError::internal())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, RwLock};

    use reqwest::Client;
    use tempfile::tempdir;

    use super::{storage, DesktopState, CANONICAL_SYNC_ROUTES, SNAPSHOT_TABLES};

    /// `AutoSyncRunner` memakai bendera ini untuk memutuskan apakah
    /// `navigator.onLine === false` boleh dipakai sebagai alasan melewatkan
    /// siklus. Salah di sini berarti perangkat Mode Database Lokal yang
    /// benar-benar terputus berhenti menguras outbox, berkas hub tertinggal,
    /// lalu ekspor cadangan dan promosi ke cloud kehilangan data tanpa satu pun
    /// pesan error.
    #[test]
    fn status_menandai_mode_lokal_hanya_untuk_provider_local_file() {
        let directory = tempdir().expect("direktori sementara");
        storage::initialize(directory.path()).expect("skema lokal");
        let state = DesktopState {
            server_origin: RwLock::new(
                crate::desktop::app_identity::DEFAULT_SERVER_ORIGIN.to_owned(),
            ),
            offline_max_age_hours: 24,
            data_dir: directory.path().to_path_buf(),
            http: Client::new(),
            turso_config: RwLock::new(None),
            session: Mutex::new(None),
            vault_lock: Mutex::new(()),
        };

        // Belum dikonfigurasi: bukan mode lokal.
        assert!(!super::status(&state).expect("status").local_mode);

        for (provider, harapan) in [
            (crate::desktop::turso::DatabaseProvider::Turso, false),
            (crate::desktop::turso::DatabaseProvider::SelfHosted, false),
            (crate::desktop::turso::DatabaseProvider::LocalFile, true),
        ] {
            *state.turso_config.write().expect("kunci config") =
                Some(crate::desktop::turso::TursoConfig::new(
                    if provider.is_local_file() {
                        "C:/data/app-hub.db".to_string()
                    } else {
                        "https://contoh.turso.io".to_string()
                    },
                    "token".to_string(),
                    provider,
                    false,
                ));
            assert_eq!(
                super::status(&state).expect("status").local_mode,
                harapan,
                "provider {provider:?} salah ditandai"
            );
        }
    }

    #[test]
    fn setiap_domain_snapshot_punya_route_kanonik() {
        // Tabel snapshot tanpa route kanonik berarti perangkat bisa menarik
        // baris dari cloud tetapi tidak akan pernah bisa mendorong perubahannya
        // balik — sinkronisasi menjadi satu arah tanpa ada yang menyadarinya.
        for table in SNAPSHOT_TABLES {
            assert!(
                CANONICAL_SYNC_ROUTES
                    .iter()
                    .any(|(domain, _)| *domain == table.domain),
                "domain '{}' tidak punya route kanonik",
                table.domain
            );
        }
    }

    #[test]
    fn kunci_upsert_snapshot_ikut_terdaftar_sebagai_kolom() {
        // `conflict_column` yang tidak ada di daftar kolom membuat statement
        // upsert gagal saat runtime, bukan saat kompilasi.
        for table in SNAPSHOT_TABLES {
            for key in table.conflict_column.split(',') {
                let key = key.trim();
                assert!(
                    table.columns.contains(&key),
                    "kolom konflik '{key}' tidak ada di tabel '{}'",
                    table.table
                );
            }
        }
    }
}

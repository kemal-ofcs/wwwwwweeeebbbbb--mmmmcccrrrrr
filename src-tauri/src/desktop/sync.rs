use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::SystemTime,
};

use rusqlite::{params, types::Value as SqlValue, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    clients,
    config::DesktopState,
    models::{CommandError, DesktopSyncStatus, SessionMode},
    storage,
    turso::TursoClient,
};

/// Versi skema yang dipahami build ini. WAJIB dinaikkan bersama
/// `CURRENT_SCHEMA_VERSION` di `web-desktop/src/lib/db-schema.ts` setiap kali
/// migrasi baru ditambahkan, karena keduanya membaca tabel `schema_migration`
/// yang sama di Turso.
pub const CLIENT_SCHEMA_VERSION: i64 = 8;

/// Hanya `cloud > client` yang berbahaya; `cloud <= client` adalah kondisi normal.
fn is_client_schema_outdated(cloud_version: i64) -> bool {
    cloud_version > CLIENT_SCHEMA_VERSION
}

fn schema_outdated_error(cloud_version: i64) -> CommandError {
    CommandError::new(
        "SCHEMA_VERSION_OUTDATED",
        format!(
            "The app needs an update. The cloud database schema is already version {cloud_version}, \
             but this app only supports version {CLIENT_SCHEMA_VERSION}. \
             Sending data was stopped so columns from the newer version are not overwritten with old data."
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
    /// Tabel yang hanya ditarik, tidak pernah didorong (direktori operator).
    /// Wajib TIDAK punya rute kanonik; tabel lain wajib punya.
    read_only: bool,
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
/// - `read_only` menandai tabel yang sengaja satu arah (cloud → perangkat).
/// - `delete_missing` hanya untuk tabel yang cloud-nya benar-benar otoritatif.
///   Untuk log transaksional biarkan `false`: baris lokal yang belum pernah
///   terkirim tidak boleh dihapus hanya karena cloud belum memilikinya.
const SNAPSHOT_TABLES: &[SnapshotTable] = &[
    // Domain MaklonOS. Kolom WAJIB identik dengan `storage.rs`, `turso.rs`,
    // dan `db-schema.ts`. `delete_missing: true` karena cloud otoritatif untuk
    // ketiganya; aturan 7 tetap menjaga baris yang belum pernah dilacak server.
    SnapshotTable {
        payload_key: "clients",
        domain: "client",
        table: "clients",
        columns: &[
            "id",
            "client_code",
            "name",
            "phone_normalized",
            "address",
            "city",
            "province",
            "lifecycle_status",
            "free_revision_limit",
            "is_white_label",
            "assigned_crm_id",
            "created_by",
            "created_at",
            "updated_at",
        ],
        conflict_column: "id",
        entity_column: "id",
        delete_missing: true,
        read_only: false,
    },
    // Lead ikut rute `client`: satu event `client/register` membawa kedua baris.
    SnapshotTable {
        payload_key: "leads",
        domain: "client",
        table: "leads",
        columns: &[
            "id",
            "client_id",
            "pic_cs_id",
            "channel_option_id",
            "product_category_option_id",
            "needs_notes",
            "last_followup_at",
            "last_client_response_at",
            "total_followups",
            "created_at",
            "updated_at",
        ],
        conflict_column: "id",
        entity_column: "id",
        delete_missing: true,
        read_only: false,
    },
    // Log interaksi: `delete_missing: false` seperti log transaksional lain.
    // Baris lokal yang belum terkirim tidak boleh hilang hanya karena cloud
    // belum memilikinya.
    SnapshotTable {
        payload_key: "leadInteractions",
        domain: "lead-interaction",
        table: "lead_interactions",
        columns: &[
            "id",
            "lead_id",
            "operator_id",
            "direction",
            "kind",
            "notes",
            "occurred_at",
            "created_at",
        ],
        conflict_column: "id",
        entity_column: "id",
        delete_missing: false,
        read_only: false,
    },
    // Tiket sampel (PRD FR-06). Satu rute `sample` untuk ketiga tabel: event
    // `sample/transition` membawa tiket, riwayat langkah, dan keputusan klien
    // sekaligus. Tiket `delete_missing: true` (cloud otoritatif, aturan 7 tetap
    // menjaga baris yang belum terkirim); dua tabel riwayat `false` seperti log
    // transaksional lain.
    SnapshotTable {
        payload_key: "sampleRequests",
        domain: "sample",
        table: "sample_requests",
        columns: &[
            "id",
            "client_id",
            "lead_id",
            "sample_kind_option_id",
            "formulation_type_option_id",
            "registration_category_option_id",
            "rnd_product_class",
            "product_category_option_id",
            "pic_crm_id",
            "sample_qty",
            "brand_name",
            "bpom_product_name",
            "claims",
            "packaging",
            "reference_notes",
            "client_budget_idr",
            "special_requests_json",
            "deadline_at",
            "ship_to_address",
            "is_dummy_required",
            "is_paid_sample",
            "revision_index",
            "is_billable",
            "status",
            "rnd_lead_time_days",
            "sent_at",
            "status_changed_at",
            "created_by",
            "created_at",
            "updated_at",
        ],
        conflict_column: "id",
        entity_column: "id",
        delete_missing: true,
        read_only: false,
    },
    SnapshotTable {
        payload_key: "sampleFeedbacks",
        domain: "sample",
        table: "sample_feedbacks",
        columns: &[
            "id",
            "sample_request_id",
            "iteration_number",
            "client_decision",
            "client_notes",
            "recorded_by",
            "recorded_at",
        ],
        conflict_column: "id",
        entity_column: "id",
        delete_missing: false,
        read_only: false,
    },
    // Foto (PRD FR-07): hanya data ringkas. `data_base64` SENGAJA tidak ada di
    // daftar kolom, jadi pull tidak pernah menimpa isi foto yang sudah tersimpan
    // di perangkat. Hanya-tambah, `delete_missing: false`.
    SnapshotTable {
        payload_key: "mediaAssets",
        domain: "media",
        table: "media_asset",
        columns: &[
            "id",
            "owner_type",
            "owner_id",
            "purpose",
            "mime",
            "byte_size",
            "created_by",
            "created_at",
        ],
        conflict_column: "id",
        entity_column: "id",
        delete_missing: false,
        read_only: false,
    },
    SnapshotTable {
        payload_key: "sampleStatusLog",
        domain: "sample",
        table: "sample_status_log",
        columns: &[
            "id",
            "sample_request_id",
            "from_status",
            "to_status",
            "action",
            "notes",
            "on_behalf_of_division",
            "recorded_by",
            "recorded_at",
        ],
        conflict_column: "id",
        entity_column: "id",
        delete_missing: false,
        read_only: false,
    },
    // Direktori operator hanya-baca: tidak punya rute outbox, cloud
    // otoritatif penuh. Hanya empat kolom (lihat `SNAPSHOT_SOURCES`).
    SnapshotTable {
        payload_key: "operatorDirectory",
        domain: "operator",
        table: "master_operator",
        columns: &["id", "kode_operator", "nama_operator", "status", "role"],
        conflict_column: "id",
        entity_column: "id",
        delete_missing: true,
        read_only: true,
    },
    SnapshotTable {
        payload_key: "masterOptions",
        domain: "master-option",
        table: "master_option",
        columns: &[
            "id",
            "kind",
            "code",
            "label",
            "is_active",
            "sort_order",
            "updated_at",
        ],
        conflict_column: "id",
        entity_column: "id",
        delete_missing: true,
        read_only: false,
    },
    SnapshotTable {
        payload_key: "settings",
        domain: "setting",
        table: "setting_gex_system",
        columns: &["key", "value"],
        conflict_column: "key",
        entity_column: "key",
        delete_missing: false,
        read_only: false,
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
        read_only: false,
    },
];

/// Pasangan (domain, operation) yang boleh diproduksi outbox.
///
/// Daftar ini WAJIB sama persis dengan `canonical_sync_route` di `turso.rs`.
/// Producer yang menulis pasangan di luar daftar akan ditolak batas cloud
/// sebagai konflik dan macet permanen di antrean.
const CANONICAL_SYNC_ROUTES: &[(&str, &str)] = &[
    ("client", "register"),
    ("client", "update"),
    ("master-option", "upsert"),
    ("lead-interaction", "record"),
    ("lead", "reassign"),
    ("sample", "create"),
    ("sample", "update"),
    ("sample", "transition"),
    ("media", "upload"),
    // Log audit hanya-dorong: tidak ada di `SNAPSHOT_TABLES` karena tumbuh
    // tanpa batas dan hanya dibaca dari cloud (layar Audit).
    ("audit", "record"),
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
            // Tabel hanya-baca tidak pernah punya baris buatan perangkat, jadi
            // cloud menentukan isinya sepenuhnya.
            if !came_from_server && !definition.read_only {
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

/// Tag perangkat (bagian `<KP>` kode klien) untuk database yang sedang
/// ditunjuk, atau `None` bila perangkat ini belum pernah mendapatkannya.
pub fn local_device_tag(state: &DesktopState) -> Result<Option<String>, CommandError> {
    let client_id = ensure_client_id(state)?;
    let connection = storage::database(&state.data_dir)?;
    connection
        .query_row(
            "SELECT device_tag FROM desktop_client_identity WHERE client_id = ?;",
            [&client_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(Option::flatten)
        .map_err(|_| CommandError::internal())
}

/// Minta tag perangkat ke database bila belum punya. Best effort, dijalankan di
/// AKHIR siklus sync supaya setting `client_code_web_tag` dari cloud sudah
/// tertarik lebih dulu: tag Web tidak pernah boleh diberikan ke perangkat.
async fn ensure_device_tag(state: &DesktopState) {
    if local_device_tag(state).ok().flatten().is_some() {
        return;
    }
    let (Ok(turso), Ok(client_id)) = (state.get_turso_client(), ensure_client_id(state)) else {
        return;
    };
    let web_tag = storage::get_system_setting(&state.data_dir, clients::CLIENT_CODE_WEB_TAG_SETTING)
        .ok()
        .flatten()
        .and_then(|value| clients::normalize_device_tag(&value))
        .unwrap_or_else(|| clients::DEFAULT_CLIENT_CODE_WEB_TAG.to_owned());
    let Ok(tag) = turso.register_device_tag(&client_id, &web_tag).await else {
        return;
    };
    if let Ok(connection) = storage::database(&state.data_dir) {
        let _ = connection.execute(
            "UPDATE desktop_client_identity SET device_tag = ? WHERE client_id = ?;",
            params![tag, client_id],
        );
    }
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
    let (operator_id, session_id) = current_actor();
    transaction
        .execute(
            r#"
      INSERT INTO desktop_sync_outbox (
        event_id, client_id, domain, operation, entity_key,
        payload_json, base_revision, status, attempt_count,
        next_retry_at, last_error, server_revision, created_at, updated_at,
        operator_id, session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?, ?, ?);
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
                operator_id,
                session_id,
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

/// Batas ukuran satu batch push (PRD F-07, keputusan C 1.4b). Satu foto
/// terkirim sebagai ~400 KB base64; tanpa batas ini perangkat yang lama offline
/// mengirim 50 foto (~20 MB) dalam satu request yang rawan putus di jaringan HP.
const PUSH_BATCH_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Potong batch agar total payload ≤ `PUSH_BATCH_MAX_BYTES`, minimal satu
/// event (satu event tidak pernah melebihi batas outbox). `true` = ada event
/// yang ditinggal untuk batch berikutnya.
fn limit_batch_by_size(events: Vec<Value>) -> (Vec<Value>, bool) {
    let mut total = 0usize;
    let mut kept = Vec::with_capacity(events.len());
    let count = events.len();
    for event in events {
        let size = event.get("payload").map_or(0, |payload| payload.to_string().len());
        if !kept.is_empty() && total + size > PUSH_BATCH_MAX_BYTES {
            break;
        }
        total += size;
        kept.push(event);
    }
    let truncated = kept.len() < count;
    (kept, truncated)
}

/// Event siap kirim, paling banyak 50 dan paling besar `PUSH_BATCH_MAX_BYTES`.
/// `true` pada nilai ketiga = batch dipotong karena ukuran; masih ada sisa.
fn pending_events(state: &DesktopState) -> Result<(String, Vec<Value>, bool), CommandError> {
    let client_id = ensure_client_id(state)?;
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            r#"
      SELECT event_id, client_id, domain, operation, entity_key, payload_json,
             base_revision, created_at
      FROM desktop_sync_outbox
      -- Entri karantina (sesi tersusul, PRD FR-03) tidak pernah didorong
      -- sampai pemiliknya memilih Kirim.
      WHERE quarantined_at IS NULL AND (status = 'pending'
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
            )))
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
    let (events, truncated) = limit_batch_by_size(
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?,
    );
    Ok((client_id, events, truncated))
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
            // untuk menukar id lokal sementara (bernilai negatif) dengan id
            // yang baru diberikan server, lalu meng-cascade-nya ke tabel anak
            // dan ke payload outbox yang masih mengantre. Domain MaklonOS
            // memakai UUID buatan perangkat (`clients::new_uuid`) sehingga
            // tidak memerlukannya. Kalau domain Anda
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
            let (_client_id, events, truncated) = pending_events(state)?;
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
            if event_ids.len() < 50 && !truncated {
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

    // Sesi tunggal (PRD FR-03): pastikan sesi ini belum tersusul SEBELUM
    // mendorong apa pun. Pemeriksaan yang gagal (jaringan) melewatkan push
    // siklus ini, tetapi tidak pernah membatalkan pull (aturan 9).
    let push_error = match check_session(state).await {
        Ok(()) => push_outbox(state).await.err(),
        Err(error) => Some(error),
    };
    let pulled = pull_snapshot(state).await;

    // Penegakan RBAC dinamis untuk jalur 2-tier. Sesi Desktop/Mobile hidup di
    // memori sampai aplikasi ditutup, jadi tanpa langkah ini operator yang baru
    // saja dinonaktifkan atau dicabut permission-nya tetap memegang akses penuh
    // di perangkatnya. Sisi web sudah memeriksa `rbac_revision` pada setiap
    // request; perangkat memeriksanya sekali per siklus sinkronisasi.
    enforce_rbac_revision(state).await;
    ensure_device_tag(state).await;

    let superseded = push_error
        .as_ref()
        .is_some_and(|error| error.code == "SESSION_SUPERSEDED");
    match pulled {
        Ok(mut status) => {
            status.push_error = push_error.map(|error| error.message);
            Ok(status)
        }
        // Sesi baru saja tersusul: layar WAJIB menerima `session_superseded`
        // walau pull gagal, karena sesudah ini tidak ada sesi yang bisa
        // membaca status lagi.
        Err(_) if superseded => {
            let mut status = status(state)?;
            status.push_error = push_error.map(|error| error.message);
            Ok(status)
        }
        Err(pull_error) => Err(push_error.unwrap_or(pull_error)),
    }
}

/// Operator dan sesi cloud yang sedang login, untuk menandai entri outbox.
/// Proses aplikasi hanya punya satu sesi, jadi cukup satu nilai global —
/// `enqueue` dipanggil dengan transaksi saja, tanpa `DesktopState`.
static CURRENT_ACTOR: Mutex<Option<(i64, Option<String>)>> = Mutex::new(None);

/// Alasan sesi terakhir diakhiri dari luar, dilaporkan lewat
/// `DesktopSyncStatus.session_superseded` sampai login berikutnya.
static SESSION_ENDED: Mutex<Option<String>> = Mutex::new(None);

pub fn set_current_actor(operator_id: Option<i64>, session_id: Option<String>) {
    if let Ok(mut guard) = CURRENT_ACTOR.lock() {
        *guard = operator_id.map(|id| (id, session_id));
    }
}

fn current_actor() -> (Option<i64>, Option<String>) {
    CURRENT_ACTOR
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .map_or((None, None), |(id, session)| (Some(id), session))
}

fn session_ended_reason() -> Option<String> {
    SESSION_ENDED.lock().ok().and_then(|guard| guard.clone())
}

/// Dipanggil saat login: tanda "tersusul" milik sesi sebelumnya dihapus.
pub fn clear_session_ended() {
    if let Ok(mut guard) = SESSION_ENDED.lock() {
        *guard = None;
    }
}

/// Jenis klien dan label perangkat untuk baris `app_session`.
pub fn device_identity(state: &DesktopState) -> (&'static str, String) {
    let kind = if cfg!(any(target_os = "android", target_os = "ios")) {
        "mobile"
    } else {
        "desktop"
    };
    let client = ensure_client_id(state).unwrap_or_default();
    let short: String = client.chars().filter(char::is_ascii_alphanumeric).take(8).collect();
    (kind, format!("{} {}", std::env::consts::OS, short).trim().to_owned())
}

/// Catat waktu cloud saat sesi operator ini terakhir terbukti berlaku.
pub fn record_session_contact(state: &DesktopState, operator_id: i64, cloud_now: &str) {
    if cloud_now.is_empty() {
        return;
    }
    if let Ok(connection) = storage::database(&state.data_dir) {
        let _ = connection.execute(
            "INSERT INTO desktop_session_contact (operator_id, last_online_at) VALUES (?1, ?2) ON CONFLICT(operator_id) DO UPDATE SET last_online_at = excluded.last_online_at;",
            params![operator_id, cloud_now],
        );
    }
}

fn session_contact(state: &DesktopState, operator_id: i64) -> Option<String> {
    storage::database(&state.data_dir)
        .ok()?
        .query_row(
            "SELECT last_online_at FROM desktop_session_contact WHERE operator_id = ?;",
            [operator_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
}

/// Pemeriksaan sesi tunggal sebelum push (PRD FR-03 butir 2-4).
///
/// - Sesi online: dicabut atau hilang di cloud → tersusul.
/// - Sesi offline yang tersambung lagi: cloud punya sesi operator ini yang
///   lahir setelah kontak terakhir perangkat → tersusul; bila tidak, sesi ini
///   dipromosikan ke baris `app_session` TANPA mencabut sesi lain.
///
/// Mode Database Lokal dilewati: hub-nya berkas di perangkat yang sama, tidak
/// ada perangkat lain yang bisa login bersamaan.
async fn check_session(state: &DesktopState) -> Result<(), CommandError> {
    let Some((operator_id, session_id, mode)) = ({
        let guard = state.session.lock().map_err(|_| CommandError::internal())?;
        guard
            .as_ref()
            .map(|session| (session.operator.id, session.session_id.clone(), session.mode))
    }) else {
        return Ok(());
    };
    let Ok(turso) = state.get_turso_client() else {
        return Ok(());
    };
    if turso.is_local() {
        return Ok(());
    }

    if let Some(session_id) = session_id {
        return match turso.check_device_session(&session_id).await? {
            Ok(cloud_now) => {
                record_session_contact(state, operator_id, &cloud_now);
                Ok(())
            }
            Err(reason) => Err(supersede(state, operator_id, Some(&session_id), &reason)),
        };
    }

    // Sesi tanpa baris cloud: login offline (atau login online sebelum
    // pembaruan ini) yang baru tersambung.
    let contact = session_contact(state, operator_id);
    let (superseded, cloud_now) = turso
        .offline_session_superseded(operator_id, contact.as_deref())
        .await?;
    if superseded {
        return Err(supersede(state, operator_id, None, "SUPERSEDED"));
    }
    let operator = {
        let guard = state.session.lock().map_err(|_| CommandError::internal())?;
        match guard.as_ref() {
            Some(session) if session.operator.id == operator_id => session.operator.clone(),
            _ => return Ok(()),
        }
    };
    let (kind, label) = device_identity(state);
    let (new_session, created_at) = turso
        .open_device_session(&operator, kind, &label, false)
        .await?;
    {
        let mut guard = state.session.lock().map_err(|_| CommandError::internal())?;
        match guard.as_mut() {
            Some(session) if session.operator.id == operator_id => {
                session.session_id = Some(new_session.clone());
            }
            _ => return Ok(()),
        }
    }
    set_current_actor(Some(operator_id), Some(new_session));
    record_session_contact(state, operator_id, if created_at.is_empty() { &cloud_now } else { &created_at });
    if matches!(mode, SessionMode::Offline) {
        storage::audit(&state.data_dir, Some(operator_id), "session-offline-promoted", None);
    }
    Ok(())
}

/// Sesi ini tersusul: karantina outbox miliknya, lalu akhiri sesi lokal.
///
/// Entri yang belum terkirim (`pending`/`failed`/`conflict`) milik operator
/// ini — atau tanpa pemilik, dibuat sebelum sesi tunggal ada — ditandai
/// `quarantined_at`. Tidak didorong, tidak dihapus, dan tetap menjaga baris
/// lokalnya dari `delete_missing` (aturan 7) sampai pemiliknya memutuskan.
fn supersede(
    state: &DesktopState,
    operator_id: i64,
    session_id: Option<&str>,
    reason: &str,
) -> CommandError {
    if let Ok(connection) = storage::database(&state.data_dir) {
        let _ = connection.execute(
            r#"
      UPDATE desktop_sync_outbox
      SET quarantined_at = ?1, operator_id = COALESCE(operator_id, ?2),
          session_id = COALESCE(session_id, ?3), updated_at = ?1
      WHERE quarantined_at IS NULL
        AND status IN ('pending', 'failed', 'conflict')
        AND (operator_id = ?2 OR operator_id IS NULL);
      "#,
            params![storage::now_epoch_seconds(), operator_id, session_id],
        );
    }
    if let Ok(mut guard) = state.session.lock() {
        if guard
            .as_ref()
            .is_some_and(|session| session.operator.id == operator_id)
        {
            *guard = None;
        }
    }
    set_current_actor(None, None);
    if let Ok(mut guard) = SESSION_ENDED.lock() {
        *guard = Some(reason.to_owned());
    }
    storage::audit(&state.data_dir, Some(operator_id), "session-superseded", Some(reason));
    CommandError::new(
        "SESSION_SUPERSEDED",
        "Your account signed in on another device. Unsent data is kept and waits for your decision.",
    )
}

/// Entri karantina (PRD FR-03 butir 5). Pemegang `sync.retry` melihat semua
/// entri di perangkat ini; operator lain hanya miliknya sendiri.
pub fn quarantine_entries(
    state: &DesktopState,
    operator_id: i64,
    see_all: bool,
) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            r#"
      SELECT event_id, domain, operation, entity_key, operator_id, session_id,
             created_at, quarantined_at
      FROM desktop_sync_outbox
      WHERE quarantined_at IS NOT NULL AND (?1 = 1 OR operator_id = ?2)
      ORDER BY created_at ASC LIMIT 500;
      "#,
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map(params![i64::from(see_all), operator_id], |row| {
            Ok(json!({
                "eventId": row.get::<_, String>(0)?,
                "domain": row.get::<_, String>(1)?,
                "operation": row.get::<_, String>(2)?,
                "entityKey": row.get::<_, String>(3)?,
                "operatorId": row.get::<_, Option<i64>>(4)?,
                "sessionId": row.get::<_, Option<String>>(5)?,
                "createdAt": row.get::<_, i64>(6)?,
                "quarantinedAt": row.get::<_, i64>(7)?,
            }))
        })
        .map_err(|_| CommandError::internal())?;
    Ok(Value::Array(
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?,
    ))
}

/// Kirim: lepas tanda karantina, entrinya didorong seperti biasa di siklus
/// berikutnya (konflik tetap ditangani `base_revision`). Mengembalikan jumlah
/// entri yang dilepas.
pub fn release_quarantine(
    state: &DesktopState,
    event_ids: &[String],
    operator_id: i64,
    see_all: bool,
) -> Result<usize, CommandError> {
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let now = storage::now_epoch_seconds();
    let mut changed = 0;
    for event_id in event_ids {
        changed += transaction
            .execute(
                "UPDATE desktop_sync_outbox SET quarantined_at = NULL, status = CASE WHEN status = 'failed' THEN 'pending' ELSE status END, next_retry_at = NULL, updated_at = ?1 WHERE event_id = ?2 AND quarantined_at IS NOT NULL AND (?3 = 1 OR operator_id = ?4);",
                params![now, event_id, i64::from(see_all), operator_id],
            )
            .map_err(|_| CommandError::internal())?;
    }
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(changed)
}

/// Buang: hapus entri karantina dari outbox di transaksi yang sama dengan
/// catatan auditnya (`apply`). Data di tabel lokal TIDAK disentuh; pull
/// berikutnya menyamakannya dengan cloud. Mengembalikan entri yang dibuang.
pub fn discard_quarantine(
    transaction: &Transaction<'_>,
    event_ids: &[String],
    operator_id: i64,
    see_all: bool,
) -> Result<Vec<Value>, CommandError> {
    let mut discarded = Vec::new();
    for event_id in event_ids {
        let row = transaction
            .query_row(
                "SELECT domain, operation, entity_key FROM desktop_sync_outbox WHERE event_id = ?1 AND quarantined_at IS NOT NULL AND (?2 = 1 OR operator_id = ?3);",
                params![event_id, i64::from(see_all), operator_id],
                |row| {
                    Ok(json!({
                        "eventId": event_id,
                        "domain": row.get::<_, String>(0)?,
                        "operation": row.get::<_, String>(1)?,
                        "entityKey": row.get::<_, String>(2)?,
                    }))
                },
            )
            .optional()
            .map_err(|_| CommandError::internal())?;
        if let Some(row) = row {
            transaction
                .execute("DELETE FROM desktop_sync_outbox WHERE event_id = ?;", [event_id])
                .map_err(|_| CommandError::internal())?;
            discarded.push(row);
        }
    }
    Ok(discarded)
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
                    set_current_actor(None, None);
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
                "SELECT COUNT(*) FROM desktop_sync_outbox WHERE status = ? AND quarantined_at IS NULL;",
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
            "clients": table_count("clients"),
            "leads": table_count("leads"),
            "masterOptions": table_count("master_option"),
            "leadInteractions": table_count("lead_interactions"),
            "sampleRequests": table_count("sample_requests"),
        }),
        push_error: None,
        changed_rows: 0,
        local_mode: state
            .turso_config()
            .is_some_and(|config| config.provider.is_local_file()),
        quarantined: connection
            .query_row(
                "SELECT COUNT(*) FROM desktop_sync_outbox WHERE quarantined_at IS NOT NULL;",
                [],
                |row| row.get(0),
            )
            .map_err(|_| CommandError::internal())?,
        session_superseded: session_ended_reason(),
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
    /// Foto yang sudah pernah diunduh ke perangkat tidak terhapus oleh pull
    /// berikutnya (permintaan pemilik produk, 1.4b): snapshot hanya membawa
    /// data ringkas, dan upsert-nya tidak menyentuh `data_base64`.
    #[test]
    fn pull_foto_tidak_menghapus_isi_yang_sudah_diunduh() {
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
        let meta = |id: &str| {
            serde_json::json!({
                "id": id, "owner_type": "sample", "owner_id": "s1", "purpose": "REFERENCE",
                "mime": "image/webp", "byte_size": 16, "created_by": 7,
                "created_at": "2026-09-25 01:00:00",
            })
        };
        super::apply_snapshot_with_pulse(
            &state,
            &serde_json::json!({ "revision": 1, "mediaAssets": [meta("m1"), meta("m2")] }),
            None,
        )
        .expect("pull pertama");
        let connection = storage::database(&state.data_dir).expect("db");
        connection
            .execute("UPDATE media_asset SET data_base64 = 'UklGRgwAAABXRUJQVlA4TA==' WHERE id = 'm1';", [])
            .expect("simpan isi foto");
        drop(connection);
        super::apply_snapshot_with_pulse(
            &state,
            &serde_json::json!({ "revision": 2, "mediaAssets": [meta("m1"), meta("m2")] }),
            None,
        )
        .expect("pull kedua");
        let connection = storage::database(&state.data_dir).expect("db");
        let data: Vec<String> = connection
            .prepare("SELECT data_base64 FROM media_asset ORDER BY id;")
            .expect("query")
            .query_map([], |row| row.get(0))
            .expect("rows")
            .collect::<Result<_, _>>()
            .expect("data");
        assert_eq!(data, vec!["UklGRgwAAABXRUJQVlA4TA==".to_owned(), String::new()]);
    }

    /// Batch push dibatasi ukuran (keputusan C 1.4b): foto tidak pernah
    /// terkirim sebagai satu request raksasa, dan event pertama selalu lolos.
    #[test]
    fn batch_push_dibatasi_ukuran() {
        let photo = |id: u32| {
            serde_json::json!({ "eventId": id, "payload": { "data_base64": "A".repeat(400 * 1024) } })
        };
        let small = |id: u32| serde_json::json!({ "eventId": id, "payload": { "x": 1 } });
        let (kept, truncated) = super::limit_batch_by_size((0..12).map(photo).collect());
        assert_eq!(kept.len(), 10);
        assert!(truncated);
        let (kept, truncated) = super::limit_batch_by_size((0..50).map(small).collect());
        assert_eq!((kept.len(), truncated), (50, false));
        let huge = serde_json::json!({ "eventId": 1, "payload": { "data": "A".repeat(5 * 1024 * 1024) } });
        let (kept, truncated) = super::limit_batch_by_size(vec![huge, small(2)]);
        assert_eq!((kept.len(), truncated), (1, true));
    }

    /// Sesi tunggal (PRD FR-03): entri milik sesi yang tersusul dikarantina,
    /// tidak didorong, dan jumlah outbox tidak berkurang sampai pemiliknya
    /// memilih Kirim atau Buang. Entri operator lain tidak ikut.
    #[test]
    fn sesi_tersusul_mengkarantina_outbox_tanpa_menghapusnya() {
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
        let client_id = super::ensure_client_id(&state).expect("client id");
        let enqueue_as = |operator: Option<i64>, key: &str| {
            let mut connection = storage::database(&state.data_dir).expect("db");
            let transaction = connection.transaction().expect("tx");
            super::set_current_actor(operator, operator.map(|_| "sesi-lama".to_owned()));
            let id = super::enqueue(
                &transaction,
                &client_id,
                "audit",
                "record",
                key,
                &serde_json::json!({ "id": key }),
                None,
            )
            .expect("enqueue");
            transaction.commit().expect("commit");
            id
        };
        let milik_7a = enqueue_as(Some(7), "a");
        let milik_7b = enqueue_as(Some(7), "b");
        let tanpa_pemilik = enqueue_as(None, "c");
        let milik_9 = enqueue_as(Some(9), "d");
        super::set_current_actor(None, None);

        let _ = super::supersede(&state, 7, Some("sesi-lama"), "SUPERSEDED");

        let (_, siap_kirim, _) = super::pending_events(&state).expect("pending");
        let ids: Vec<&str> = siap_kirim
            .iter()
            .filter_map(|event| event["eventId"].as_str())
            .collect();
        assert_eq!(ids, vec![milik_9.as_str()]);
        let status = super::status(&state).expect("status");
        assert_eq!((status.pending, status.quarantined), (1, 3));
        assert_eq!(status.session_superseded.as_deref(), Some("SUPERSEDED"));

        // Entri tanpa pemilik diwarisi operator yang tersusul.
        let milik_sendiri = super::quarantine_entries(&state, 7, false).expect("daftar");
        assert_eq!(milik_sendiri.as_array().map(Vec::len), Some(3));
        assert_eq!(
            super::quarantine_entries(&state, 9, false).expect("daftar").as_array().map(Vec::len),
            Some(0)
        );

        // Kirim: kembali ke antrean biasa. Operator lain tidak bisa melepasnya.
        assert_eq!(
            super::release_quarantine(&state, &[milik_7a.clone()], 9, false).expect("lepas"),
            0
        );
        assert_eq!(
            super::release_quarantine(&state, &[milik_7a.clone()], 7, false).expect("lepas"),
            1
        );
        assert_eq!(super::pending_events(&state).expect("pending").1.len(), 2);

        // Buang: hanya entri karantina yang dihapus.
        let mut connection = storage::database(&state.data_dir).expect("db");
        let transaction = connection.transaction().expect("tx");
        let dibuang = super::discard_quarantine(
            &transaction,
            &[milik_7b, tanpa_pemilik, milik_7a],
            7,
            false,
        )
        .expect("buang");
        transaction.commit().expect("commit");
        assert_eq!(dibuang.len(), 2);
        let status = super::status(&state).expect("status");
        assert_eq!((status.pending, status.quarantined), (2, 0));
        super::clear_session_ended();
    }

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
        //
        // Kebalikannya juga dijaga: tabel yang sengaja hanya-baca (direktori
        // operator) TIDAK boleh punya route, supaya perangkat tidak pernah bisa
        // mendorong perubahan ke `master_operator`.
        for table in SNAPSHOT_TABLES {
            let has_route = CANONICAL_SYNC_ROUTES
                .iter()
                .any(|(domain, _)| *domain == table.domain);
            assert_eq!(
                has_route, !table.read_only,
                "domain '{}': read_only = {}, tetapi route kanonik {}",
                table.domain,
                table.read_only,
                if has_route { "ada" } else { "tidak ada" }
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

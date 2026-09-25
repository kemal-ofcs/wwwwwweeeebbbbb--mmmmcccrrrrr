use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::Mutex;

use argon2::PasswordVerifier;
use base64::prelude::*;
use pbkdf2::pbkdf2_hmac;
use reqwest::{header::HeaderMap, Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;
use zeroize::Zeroizing;

use super::clients;
use super::models::{CommandError, OperatorUser};
// Seam transport: dekoder sel Hrana dan jalur SQLite lokal. SQL-nya sama,
// yang berbeda hanya ke mana ia dikirim.
use super::sql_backend::{decode_hrana_cell, LocalTransport};

/// Provider database cloud yang dipakai perangkat.
///
/// `Turso` adalah layanan terkelola (`libsql://<db>.turso.io`): selalu TLS dan
/// selalu memerlukan Auth Token. `SelfHosted` adalah server libSQL milik
/// pengguna sendiri (`sqld` / `libsql-server`) yang berjalan di komputer kantor,
/// NAS, mesin LAN, atau VPS. Server seperti itu lazim dijalankan tanpa token dan
/// tanpa sertifikat TLS, sehingga aturan validasinya memang berbeda.
///
/// Provider disimpan eksplisit, BUKAN ditebak dari bentuk URL. Kalau ditebak,
/// satu salah ketik pada URL Turso (`http://` alih-alih `https://`) otomatis
/// melonggarkan aturan transport tanpa pengguna pernah memilihnya.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseProvider {
    #[default]
    Turso,
    #[serde(
        alias = "selfHosted",
        alias = "self-hosted",
        alias = "custom",
        alias = "local",
        alias = "libsql"
    )]
    SelfHosted,
    /// Berkas SQLite di perangkat ini, tanpa server sama sekali.
    ///
    /// Alias `"local"` SENGAJA TIDAK dipakai di sini: nilai itu sudah lebih
    /// dulu berarti `SelfHosted` pada instalasi yang ada, dan memakainya ulang
    /// akan mengubah arti data yang sudah tersimpan di perangkat pelanggan.
    #[serde(alias = "localFile", alias = "local-file", alias = "file")]
    LocalFile,
}

impl DatabaseProvider {
    pub fn is_self_hosted(self) -> bool {
        matches!(self, Self::SelfHosted)
    }

    /// Apakah seluruh SQL dijalankan ke berkas lokal, tanpa jaringan.
    pub fn is_local_file(self) -> bool {
        matches!(self, Self::LocalFile)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Turso => "turso",
            Self::SelfHosted => "self_hosted",
            Self::LocalFile => "local_file",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Turso => "Turso Cloud",
            Self::SelfHosted => "Your Own Database Server",
            Self::LocalFile => "Local Database (No Server)",
        }
    }
}

/// Alamat yang trafiknya tidak pernah meninggalkan perangkat atau LAN pengguna.
///
/// Dipakai untuk memutuskan apakah HTTP polos boleh dipakai. Daftar ini sengaja
/// konservatif: hanya loopback, rentang privat RFC1918/RFC4193, link-local,
/// nama domain LAN, dan dua alias host yang memang menunjuk mesin developer
/// (`10.0.2.2` untuk emulator Android, `host.docker.internal` untuk container).
pub fn is_private_network_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host.eq_ignore_ascii_case("host.docker.internal") {
        return true;
    }
    // Alamat khusus emulator Android yang menunjuk balik ke mesin developer.
    if host == "10.0.2.2" {
        return true;
    }
    let lowered = host.to_ascii_lowercase();
    if lowered.ends_with(".local") || lowered.ends_with(".lan") || lowered.ends_with(".internal") {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(|ip| match ip {
        IpAddr::V4(address) => {
            address.is_loopback() || address.is_private() || address.is_link_local()
        }
        IpAddr::V6(address) => address.is_loopback() || address.is_unique_local(),
    })
}

/// Validasi dan normalisasi URL endpoint database untuk provider tertentu.
///
/// Mengembalikan origin bersih tanpa path/query/fragment karena seluruh
/// pemanggil menambahkan `/v2/pipeline` sendiri. Kredensial di dalam URL
/// (`https://user:pass@host`) ditolak: token wajib lewat vault, bukan lewat URL
/// yang ikut tersimpan di tabel setting dan ikut tampil di UI.
/// Origin sintetis untuk mode Database Lokal.
///
/// Mode lokal tidak punya alamat jaringan, tetapi `server_origin` tetap
/// dibutuhkan: vault perangkat mengikat snapshot kredensial pada kombinasi
/// origin + username + device_id. Nilainya harus stabil (kalau berubah, seluruh
/// akses offline yang sudah tersimpan menjadi tidak sah) dan tidak boleh pernah
/// bisa di-resolve — `.invalid` dicadangkan RFC 2606 justru untuk itu, sehingga
/// tidak ada kemungkinan permintaan nyasar ke host milik orang lain.
pub const LOCAL_FILE_ORIGIN: &str = "https://local-file.app.invalid";

pub fn normalize_database_url(
    raw: &str,
    provider: DatabaseProvider,
    allow_insecure_transport: bool,
) -> Result<Url, CommandError> {
    // Mode lokal tidak pernah menyentuh jaringan, sehingga seluruh aturan
    // transport di bawah tidak berlaku — dan `raw` di sini adalah lokasi
    // berkas, bukan URL. Dikembalikan lebih dulu supaya lokasi berkas tidak
    // pernah salah diuji sebagai alamat host.
    if provider.is_local_file() {
        return Url::parse(LOCAL_FILE_ORIGIN).map_err(|_| CommandError::internal());
    }

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CommandError::new(
            "TURSO_URL_INVALID",
            "The database URL cannot be empty.",
        ));
    }

    // `libsql://` dan `ws(s)://` hanyalah ejaan lain dari endpoint HTTP yang
    // sama. Server libSQL self-hosted kerap dicetak dengan salah satu bentuk itu
    // di dokumentasinya, jadi keduanya diterima dan dipetakan ke http(s).
    let https_url_str = if let Some(stripped) = trimmed.strip_prefix("libsql://") {
        format!("https://{stripped}")
    } else if let Some(stripped) = trimmed.strip_prefix("wss://") {
        format!("https://{stripped}")
    } else if let Some(stripped) = trimmed.strip_prefix("ws://") {
        format!("http://{stripped}")
    } else {
        trimmed.to_owned()
    };

    let mut parsed = Url::parse(&https_url_str).map_err(|_| {
        CommandError::new(
            "TURSO_URL_INVALID",
            match provider {
                DatabaseProvider::Turso => "Invalid Turso database URL format (for example: libsql://db-name.turso.io or https://db-name.turso.io).",
                DatabaseProvider::SelfHosted => "Invalid database server URL format (for example: http://192.168.1.10:8080 or https://db.your-office.com).",
                // Tidak terjangkau: mode lokal sudah kembali di awal fungsi.
                DatabaseProvider::LocalFile => "Local Database Mode does not use a URL.",
            },
        )
    })?;

    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(CommandError::new(
            "TURSO_URL_INVALID",
            "The database URL must use the libsql://, https://, or http:// protocol.",
        ));
    }
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(CommandError::new(
            "TURSO_URL_INVALID",
            "The database URL must have a host and cannot contain credentials.",
        ));
    }

    if parsed.scheme() == "http" {
        let host = parsed.host_str().unwrap_or_default();
        let is_private = is_private_network_host(host);
        let allowed = match provider {
            // Turso terkelola tidak pernah melayani HTTP polos di internet;
            // satu-satunya HTTP yang masuk akal adalah `turso dev` lokal saat
            // pengembangan.
            DatabaseProvider::Turso => is_private && cfg!(debug_assertions),
            // Server sendiri di jaringan privat: paket tidak pernah keluar dari
            // LAN, jadi HTTP polos diizinkan pada build rilis sekalipun. Di luar
            // jaringan privat, pengguna harus menyatakan risikonya secara sadar.
            DatabaseProvider::SelfHosted => is_private || allow_insecure_transport,
            DatabaseProvider::LocalFile => true,
        };
        if !allowed {
            let message = match provider {
                DatabaseProvider::Turso => {
                    "The Turso database URL must use HTTPS. If this is your own database server, choose \"Your Own Database Server\" first."
                }
                DatabaseProvider::SelfHosted => {
                    "This server address is outside a private network, so plain HTTP would send the Auth Token and operational data unencrypted. Set up HTTPS on the server (for example with Caddy/Nginx), use a LAN/VPN address, or check \"Allow an unencrypted connection\" if you accept the risk."
                }
                DatabaseProvider::LocalFile => "Local Database Mode does not use a URL.",
            };
            return Err(CommandError::new("TURSO_URL_INSECURE", message));
        }
    }

    parsed.set_path("");
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TursoConfig {
    pub database_url: String,
    pub auth_token: String,
    /// Default `Turso` supaya vault lama — yang hanya menyimpan `database_url`
    /// dan `auth_token` — tetap terbaca apa adanya setelah aplikasi diperbarui.
    #[serde(default)]
    pub provider: DatabaseProvider,
    /// Hanya bermakna untuk [`DatabaseProvider::SelfHosted`]: izin eksplisit
    /// memakai HTTP polos ke host di luar jaringan privat.
    #[serde(default)]
    pub allow_insecure_transport: bool,
}

impl TursoConfig {
    pub fn new(
        database_url: String,
        auth_token: String,
        provider: DatabaseProvider,
        allow_insecure_transport: bool,
    ) -> Self {
        Self {
            database_url,
            auth_token,
            provider,
            // Flag ini tidak punya arti di luar mode server sendiri; memaksanya
            // `false` mencegah nilai basi ikut aktif kalau pengguna berpindah
            // balik ke Turso lalu kembali lagi ke server sendiri.
            allow_insecure_transport: provider.is_self_hosted() && allow_insecure_transport,
        }
    }

    /// Konfigurasi Turso terkelola (bentuk lama dua-field).
    pub fn turso(database_url: String, auth_token: String) -> Self {
        Self::new(database_url, auth_token, DatabaseProvider::Turso, false)
    }

    /// Origin endpoint yang sudah tervalidasi menurut provider konfigurasi ini.
    pub fn normalized_url(&self) -> Result<Url, CommandError> {
        normalize_database_url(
            &self.database_url,
            self.provider,
            self.allow_insecure_transport,
        )
    }

    /// Apakah `raw` menunjuk database yang sama dengan konfigurasi ini.
    ///
    /// Perbandingan wajib ternormalisasi: `libsql://x`, `https://x`, dan
    /// `https://x/` menunjuk database yang sama. Perbandingan string mentah
    /// pernah membuat token yang tersimpan di vault dianggap milik database lain
    /// hanya karena pengguna mengetik ejaan URL yang berbeda.
    pub fn matches_url(&self, raw: &str) -> bool {
        match (
            self.normalized_url(),
            normalize_database_url(raw, self.provider, self.allow_insecure_transport),
        ) {
            (Ok(current), Ok(candidate)) => current == candidate,
            _ => self.database_url.trim() == raw.trim(),
        }
    }

    /// Lokasi berkas hub untuk mode Database Lokal.
    ///
    /// `database_url` menyimpan lokasi berkas apa adanya pada mode ini — bukan
    /// URL — supaya yang tersimpan di tabel setting dan yang tampil di layar
    /// adalah sesuatu yang bisa dibuka pengguna di file explorer.
    pub fn local_file_path(&self) -> Result<std::path::PathBuf, CommandError> {
        let trimmed = self.database_url.trim();
        if trimmed.is_empty() {
            return Err(CommandError::new(
                "LOCAL_DB_PATH_MISSING",
                "The local database file location is not set.",
            ));
        }
        Ok(std::path::PathBuf::from(trimmed))
    }

    /// Auth Token wajib ada sebelum koneksi boleh dicoba.
    ///
    /// Turso terkelola selalu wajib. Server sendiri boleh tanpa token — `sqld`
    /// default berjalan tanpa autentikasi — kecuali endpoint-nya HTTPS publik,
    /// yang berarti server itu terekspos ke internet dan token adalah satu-
    /// satunya penghalang yang tersisa.
    pub fn requires_auth_token(&self) -> bool {
        match self.provider {
            DatabaseProvider::Turso => true,
            // Tidak ada jaringan, tidak ada pihak yang perlu diyakinkan.
            DatabaseProvider::LocalFile => false,
            DatabaseProvider::SelfHosted => self.normalized_url().ok().is_some_and(|url| {
                url.scheme() == "https"
                    && !is_private_network_host(url.host_str().unwrap_or_default())
            }),
        }
    }
}

/// Ringkasan konfigurasi database yang aman ditampilkan di UI.
///
/// Auth Token TIDAK PERNAH ikut. Frontend hanya perlu tahu bahwa token sudah
/// tersimpan supaya bisa menampilkan "Tersimpan di Vault" dan membiarkan field
/// isian kosong berarti "pertahankan token lama".
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseConfigView {
    pub configured: bool,
    pub database_url: String,
    pub provider: String,
    /// Nama provider yang siap ditampilkan, supaya UI tidak perlu menyimpan
    /// salinan tabel terjemahannya sendiri dan ikut basi saat provider bertambah.
    pub provider_label: String,
    pub allow_insecure_transport: bool,
    pub auth_token_saved: bool,
}

impl DatabaseConfigView {
    pub fn empty() -> Self {
        Self {
            configured: false,
            database_url: String::new(),
            provider: DatabaseProvider::Turso.as_str().to_owned(),
            provider_label: DatabaseProvider::Turso.label().to_owned(),
            allow_insecure_transport: false,
            auth_token_saved: false,
        }
    }

    pub fn from_config(config: &TursoConfig) -> Self {
        Self {
            configured: true,
            database_url: config.database_url.clone(),
            provider: config.provider.as_str().to_owned(),
            provider_label: config.provider.label().to_owned(),
            allow_insecure_transport: config.allow_insecure_transport,
            auth_token_saved: !config.auth_token.trim().is_empty(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TursoConnectionStatus {
    pub connected: bool,
    pub url: String,
    pub latency_ms: Option<u64>,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapStatus {
    pub configured: bool,
    pub required: bool,
    pub server_origin: String,
    /// Apakah database cloud yang tersimpan benar-benar berhasil dihubungi.
    ///
    /// `configured = true` hanya berarti perangkat menyimpan kredensial; tidak
    /// berarti kredensial itu masih menunjuk database yang hidup. Kalau database
    /// lama sudah dihapus di Turso, `configured` tetap true sementara `reachable`
    /// menjadi false — dan layar login harus memakai perbedaan itu untuk
    /// menawarkan konfigurasi ulang, bukan menyembunyikannya sebagai kegagalan.
    pub reachable: bool,
    /// Alasan `reachable = false`, apa adanya dari klien Turso.
    pub message: Option<String>,
}

impl BootstrapStatus {
    /// Kredensial tersimpan tetapi database cloud-nya tidak menjawab.
    pub fn unreachable(server_origin: String, error: &CommandError) -> Self {
        Self {
            configured: true,
            required: false,
            server_origin,
            reachable: false,
            message: Some(error.message.clone()),
        }
    }
}

/// Tabel lama yang CHECK-nya masih memakai nilai berbahasa Indonesia. Kata
/// kunci diletakkan di dalam tanda kutip SQL supaya kalimat biasa tidak ikut
/// cocok. WAJIB identik dengan `LEGACY_STORED_VALUES_SQL` di `db-schema.ts`.
const LEGACY_STORED_VALUES_SQL: &str = "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name IN ('app_role', 'password_reset_request') AND (sql LIKE '%''Aktif''%' OR sql LIKE '%''Menunggu Verifikasi''%');";

const LEGACY_STORED_VALUES_MESSAGE: &str = "This database was created by a pre-release build that stored values in Indonesian. It cannot be upgraded in place. Create a new database (or a new Local Database Mode file) and connect this device to it.";

/// Tabel inti yang wajib ada agar database dianggap benar-benar database App Template.
const DATABASE_CHECK_CORE_TABLES: [&str; 4] = [
    "app_role",
    "master_operator",
    "clients",
    "leads",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCheckResult {
    pub reachable: bool,
    pub server_origin: String,
    pub latency_ms: Option<u64>,
    pub empty_database: bool,
    pub schema_ready: bool,
    pub missing_tables: Vec<String>,
    pub table_count: i64,
    pub bootstrap_claimed: bool,
    pub superadmin_exists: bool,
    pub superadmin_count: i64,
    pub superadmin_username: Option<String>,
    pub operator_count: i64,
    pub client_count: i64,
    pub lead_count: i64,
    pub company_name: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

impl DatabaseCheckResult {
    pub fn unreachable(server_origin: String, error: &CommandError) -> Self {
        Self {
            reachable: false,
            server_origin,
            latency_ms: None,
            empty_database: false,
            schema_ready: false,
            missing_tables: Vec::new(),
            table_count: 0,
            bootstrap_claimed: false,
            superadmin_exists: false,
            superadmin_count: 0,
            superadmin_username: None,
            operator_count: 0,
            client_count: 0,
            lead_count: 0,
            company_name: None,
            error_code: Some(error.code.to_owned()),
            error_message: Some(error.message.clone()),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct BootstrapSuperadminDraft {
    pub kode_operator: String,
    pub nama_operator: String,
    pub username: String,
    pub password: String,
}

#[derive(Clone, Debug)]
pub struct Statement {
    pub sql: String,
    pub args: Vec<Value>,
}

impl Statement {
    pub fn new(sql: impl Into<String>, args: Vec<Value>) -> Self {
        Self {
            sql: sql.into(),
            args,
        }
    }

    fn to_libsql_v2_stmt(&self) -> Value {
        let args_val: Vec<Value> = self
            .args
            .iter()
            .map(|arg| match arg {
                Value::Null => json!({ "type": "null" }),
                Value::Bool(b) => json!({ "type": "integer", "value": if *b { 1 } else { 0 } }),
                Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        json!({ "type": "integer", "value": i.to_string() })
                    } else if let Some(f) = n.as_f64() {
                        json!({ "type": "float", "value": f })
                    } else {
                        json!({ "type": "null" })
                    }
                }
                Value::String(s) => json!({ "type": "text", "value": s }),
                _ => json!({ "type": "text", "value": arg.to_string() }),
            })
            .collect();

        json!({
            "sql": self.sql,
            "args": args_val
        })
    }
}

#[derive(Default)]
struct StatementCollector {
    statements: Mutex<Vec<Statement>>,
}

impl StatementCollector {
    async fn query_one(
        &self,
        sql: impl Into<String>,
        args: Vec<Value>,
    ) -> Result<QueryResult, CommandError> {
        self.statements
            .lock()
            .map_err(|_| CommandError::internal())?
            .push(Statement::new(sql, args));
        Ok(QueryResult::default())
    }

    fn finish(self) -> Result<Vec<Statement>, CommandError> {
        self.statements
            .into_inner()
            .map_err(|_| CommandError::internal())
    }
}

fn atomic_batch_steps(statements: &[Statement]) -> (Vec<Value>, usize) {
    let mut steps = Vec::with_capacity(statements.len() + 3);
    steps.push(json!({
        "stmt": Statement::new("BEGIN IMMEDIATE;", vec![]).to_libsql_v2_stmt()
    }));
    let mut previous_step = 0_usize;
    for statement in statements {
        steps.push(json!({
            "condition": { "type": "ok", "step": previous_step },
            "stmt": statement.to_libsql_v2_stmt()
        }));
        previous_step += 1;
    }
    let commit_step = steps.len();
    steps.push(json!({
        "condition": { "type": "ok", "step": previous_step },
        "stmt": Statement::new("COMMIT;", vec![]).to_libsql_v2_stmt()
    }));
    steps.push(json!({
        "condition": {
            "type": "not",
            "cond": { "type": "ok", "step": commit_step }
        },
        "stmt": Statement::new("ROLLBACK;", vec![]).to_libsql_v2_stmt()
    }));
    (steps, commit_step)
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    #[allow(dead_code)]
    pub rows_affected: u64,
    pub last_insert_rowid: Option<i64>,
}

impl QueryResult {
    pub fn to_objects(&self) -> Vec<HashMap<String, Value>> {
        self.rows
            .iter()
            .map(|row| {
                let mut map = HashMap::new();
                for (col_idx, col_name) in self.columns.iter().enumerate() {
                    let val = row.get(col_idx).cloned().unwrap_or(Value::Null);
                    map.insert(col_name.clone(), val);
                }
                map
            })
            .collect()
    }
}

/// Cache proses-wide berisi URL database yang skemanya sudah diverifikasi mutakhir.
///
/// `DesktopState::get_turso_client` membuat `TursoClient` baru setiap kali dipanggil,
/// jadi cache tidak boleh menempel di instance — kalau tidak, `ensure_schema_current`
/// menambah satu round-trip ke Turso di setiap push dan setiap pull.
static SCHEMA_VERIFIED: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();

fn schema_verified_cache() -> &'static Mutex<HashSet<String>> {
    SCHEMA_VERIFIED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Satu tabel operasional cloud yang ikut ditarik ke SQLite lokal.
///
/// Daftar ini adalah sumber tunggal untuk dua hal sekaligus: query pembacaan
/// snapshot dan daftar tabel yang dipasangi trigger `sync_pulse`. Menambah
/// tabel snapshot baru cukup di sini — jangan bikin daftar kedua.
struct SnapshotSource {
    payload_key: &'static str,
    table: &'static str,
    sql: &'static str,
}

/// Tabel cloud yang ikut ditarik ke perangkat, beserta kunci payload-nya.
///
/// Daftar ini sekaligus menentukan tabel mana yang dipasangi trigger
/// `sync_pulse`, sehingga menambah tabel snapshot baru cukup dilakukan di sini.
/// `payload_key` WAJIB sama persis dengan yang dipakai `SNAPSHOT_TABLES` di
/// `sync.rs`; ketidakcocokan membuat tabel itu tampak "tidak pernah berubah".
const SNAPSHOT_SOURCES: &[SnapshotSource] = &[
    SnapshotSource {
        payload_key: "clients",
        table: "clients",
        sql: "SELECT * FROM clients ORDER BY created_at, id;",
    },
    SnapshotSource {
        payload_key: "leads",
        table: "leads",
        sql: "SELECT * FROM leads ORDER BY created_at, id;",
    },
    SnapshotSource {
        payload_key: "leadInteractions",
        table: "lead_interactions",
        sql: "SELECT * FROM lead_interactions ORDER BY occurred_at, id;",
    },
    // Direktori operator hanya-baca untuk nama PIC dan pilihan pindah PIC saat
    // offline. SENGAJA hanya empat kolom: hash password, email, nomor HP, dan
    // rahasia 2FA tidak pernah meninggalkan cloud.
    SnapshotSource {
        payload_key: "operatorDirectory",
        table: "master_operator",
        sql: "SELECT id, kode_operator, nama_operator, status FROM master_operator ORDER BY id;",
    },
    SnapshotSource {
        payload_key: "masterOptions",
        table: "master_option",
        sql: "SELECT * FROM master_option ORDER BY kind, sort_order, label;",
    },
    SnapshotSource {
        payload_key: "settings",
        table: "setting_gex_system",
        sql: "SELECT * FROM setting_gex_system;",
    },
    SnapshotSource {
        payload_key: "companyProfiles",
        table: "company_profile",
        sql: "SELECT * FROM company_profile;",
    },
];

pub struct TursoClient {
    base_url: Url,
    auth_token: Zeroizing<String>,
    http: Client,
    /// Berkas SQLite lokal, bila perangkat ini berjalan tanpa server sama
    /// sekali. `None` berarti seluruh SQL dikirim lewat HTTP seperti biasa.
    local: Option<LocalTransport>,
}

impl TursoClient {
    pub fn new(base_url: Url, auth_token: String, http: Client) -> Self {
        Self {
            base_url,
            auth_token: Zeroizing::new(auth_token),
            http,
            local: None,
        }
    }

    /// Klien yang berbicara ke berkas SQLite lokal, tanpa jaringan sama sekali.
    ///
    /// SQL yang dijalankannya sama persis dengan jalur cloud — yang berbeda
    /// hanya tujuannya. Itulah yang membuat tabel lokal dan tabel cloud tidak
    /// bisa berbeda bentuk: keduanya lahir dari `ensure_schema` yang sama.
    ///
    /// `base_url` tetap diminta karena dipakai sebagai identitas asal
    /// (`server_origin`) yang mengikat snapshot kredensial di vault perangkat.
    pub fn local_file(
        base_url: Url,
        path: impl Into<std::path::PathBuf>,
        http: Client,
    ) -> Self {
        Self {
            base_url,
            auth_token: Zeroizing::new(String::new()),
            http,
            local: Some(LocalTransport::new(path)),
        }
    }

    /// Apakah klien ini berjalan sepenuhnya lokal.
    #[allow(dead_code)]
    pub fn is_local(&self) -> bool {
        self.local.is_some()
    }

    pub fn from_config(config: &TursoConfig, http: Client) -> Result<Self, CommandError> {
        // Validasi URL memakai provider yang benar-benar dipilih pengguna.
        // Memakai aturan Turso untuk server sendiri akan menolak alamat LAN
        // ber-HTTP yang justru menjadi tujuan mode itu.
        let base_url = config.normalized_url()?;

        // Mode lokal: SQL yang sama, tujuan yang berbeda. Tidak ada token yang
        // perlu diperiksa karena tidak ada yang dikirim ke mana pun.
        if config.provider.is_local_file() {
            return Ok(Self::local_file(base_url, config.local_file_path()?, http));
        }

        if config.auth_token.trim().is_empty() && config.requires_auth_token() {
            return Err(CommandError::new(
                "TURSO_TOKEN_REQUIRED",
                match config.provider {
                    DatabaseProvider::Turso => {
                        "A Turso database Auth Token is required for HTTPS connections."
                    }
                    DatabaseProvider::SelfHosted => {
                        "This database server is reachable from the internet, so an Auth Token is required."
                    }
                    // Tidak terjangkau: mode lokal sudah kembali di atas.
                    DatabaseProvider::LocalFile => "Local Database Mode does not use an Auth Token.",
                },
            ));
        }
        Ok(Self::new(base_url, config.auth_token.clone(), http))
    }

    pub fn base_url(&self) -> &Url {
        &self.base_url
    }

    #[allow(dead_code)]
    pub fn auth_token(&self) -> &str {
        &self.auth_token
    }

    /// Titik tunggal yang memilih transport.
    ///
    /// Seluruh `Statement` di berkas ini melewati sini, sehingga menukar
    /// tujuan tidak menuntut satu baris SQL pun ditulis ulang.
    pub async fn execute_pipeline(
        &self,
        statements: Vec<Statement>,
    ) -> Result<Vec<QueryResult>, CommandError> {
        match &self.local {
            Some(local) => local.execute_pipeline(statements),
            None => self.execute_pipeline_remote(statements).await,
        }
    }

    pub async fn execute_atomic(&self, statements: Vec<Statement>) -> Result<(), CommandError> {
        match &self.local {
            Some(local) => local.execute_atomic(statements),
            None => self.execute_atomic_remote(statements).await,
        }
    }

    async fn execute_pipeline_remote(
        &self,
        statements: Vec<Statement>,
    ) -> Result<Vec<QueryResult>, CommandError> {
        let mut endpoint = self.base_url.clone();
        endpoint.set_path("/v2/pipeline");

        let requests: Vec<Value> = statements
            .iter()
            .map(|stmt| {
                json!({
                    "type": "execute",
                    "stmt": stmt.to_libsql_v2_stmt()
                })
            })
            .chain(std::iter::once(json!({ "type": "close" })))
            .collect();

        let payload = json!({ "requests": requests });

        let mut headers = HeaderMap::new();
        if !self.auth_token.is_empty() {
            let auth_header_val = format!("Bearer {}", self.auth_token.as_str());
            headers.insert(
                reqwest::header::AUTHORIZATION,
                reqwest::header::HeaderValue::from_str(&auth_header_val)
                    .map_err(|_| CommandError::internal())?,
            );
        }

        let response = self
            .http
            .post(endpoint)
            .headers(headers)
            .json(&payload)
            .send()
            .await
            .map_err(|e| {
                CommandError::new(
                    "TURSO_NETWORK_ERROR",
                    format!("Could not reach the Turso database: {e}"),
                )
            })?;

        let status = response.status();
        if !status.is_success() {
            let error_body = response.text().await.unwrap_or_default();
            if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                return Err(CommandError::new(
                    "TURSO_AUTH_FAILED",
                    "The Turso database Auth Token is invalid or expired.",
                ));
            }
            return Err(CommandError::new(
                "TURSO_QUERY_FAILED",
                format!(
                    "Database Turso mengembalikan error ({status}): {}",
                    error_body.chars().take(500).collect::<String>()
                ),
            ));
        }

        let text = response.text().await.map_err(|e| {
            CommandError::new(
                "TURSO_RESPONSE_INVALID",
                format!("Could not read the Turso response: {e}"),
            )
        })?;

        let body: Value = serde_json::from_str(&text).map_err(|e| {
            let snippet = text.chars().take(250).collect::<String>();
            CommandError::new(
                "TURSO_RESPONSE_INVALID",
                format!("Invalid Turso JSON response: {e}. Raw data: {snippet}"),
            )
        })?;

        let results_arr = body
            .get("results")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                CommandError::new("TURSO_RESPONSE_INVALID", "The pipeline result is empty.")
            })?;

        let mut query_results = Vec::new();
        for (i, res) in results_arr.iter().enumerate() {
            if i >= statements.len() {
                break; // Abaikan close request
            }
            let res_type = res.get("type").and_then(Value::as_str).unwrap_or("");
            if res_type != "ok" {
                let err_msg = res
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("The SQL query failed to run on Turso.");
                return Err(CommandError::new("TURSO_SQL_ERROR", err_msg));
            }

            let exec_res = res
                .get("response")
                .and_then(|r| r.get("result"))
                .cloned()
                .unwrap_or(Value::Null);

            let columns: Vec<String> = exec_res
                .get("cols")
                .and_then(Value::as_array)
                .map(|cols| {
                    cols.iter()
                        .filter_map(|c| c.get("name").and_then(Value::as_str).map(|s| s.to_owned()))
                        .collect()
                })
                .unwrap_or_default();

            let rows_arr = exec_res.get("rows").and_then(Value::as_array);
            let mut parsed_rows = Vec::new();

            if let Some(rows) = rows_arr {
                for row_val in rows {
                    if let Some(cells) = row_val.as_array() {
                        let parsed_cells: Vec<Value> =
                            cells.iter().map(decode_hrana_cell).collect();
                        parsed_rows.push(parsed_cells);
                    }
                }
            }

            let rows_affected = exec_res
                .get("affected_row_count")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let last_insert_rowid = exec_res.get("last_insert_rowid").and_then(|v| {
                if let Some(s) = v.as_str() {
                    s.parse::<i64>().ok()
                } else {
                    v.as_i64()
                }
            });

            query_results.push(QueryResult {
                columns,
                rows: parsed_rows,
                rows_affected,
                last_insert_rowid,
            });
        }

        Ok(query_results)
    }

    async fn execute_atomic_remote(&self, statements: Vec<Statement>) -> Result<(), CommandError> {
        if statements.is_empty() {
            return Ok(());
        }
        let mut endpoint = self.base_url.clone();
        endpoint.set_path("/v2/pipeline");

        let (steps, commit_step) = atomic_batch_steps(&statements);

        let payload = json!({
            "requests": [
                { "type": "batch", "batch": { "steps": steps } },
                { "type": "close" }
            ]
        });
        let mut headers = HeaderMap::new();
        if !self.auth_token.is_empty() {
            let auth_header_val = format!("Bearer {}", self.auth_token.as_str());
            headers.insert(
                reqwest::header::AUTHORIZATION,
                reqwest::header::HeaderValue::from_str(&auth_header_val)
                    .map_err(|_| CommandError::internal())?,
            );
        }
        let response = self
            .http
            .post(endpoint)
            .headers(headers)
            .json(&payload)
            .send()
            .await
            .map_err(|error| {
                CommandError::new(
                    "TURSO_NETWORK_ERROR",
                    format!("Could not reach the Turso database: {error}"),
                )
            })?;
        let status = response.status();
        let text = response.text().await.map_err(|error| {
            CommandError::new(
                "TURSO_RESPONSE_INVALID",
                format!("Could not read the Turso response: {error}"),
            )
        })?;
        if !status.is_success() {
            if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                return Err(CommandError::new(
                    "TURSO_AUTH_FAILED",
                    "The Turso database Auth Token is invalid or expired.",
                ));
            }
            return Err(CommandError::new(
                "TURSO_QUERY_FAILED",
                format!(
                    "Database Turso mengembalikan error ({status}): {}",
                    text.chars().take(500).collect::<String>()
                ),
            ));
        }
        let body: Value = serde_json::from_str(&text).map_err(|error| {
            CommandError::new(
                "TURSO_RESPONSE_INVALID",
                format!(
                    "Invalid Turso JSON response: {error}. Raw data: {}",
                    text.chars().take(250).collect::<String>()
                ),
            )
        })?;
        let batch_result = body
            .get("results")
            .and_then(Value::as_array)
            .and_then(|results| results.first())
            .filter(|result| result.get("type").and_then(Value::as_str) == Some("ok"))
            .and_then(|result| result.get("response"))
            .filter(|response| response.get("type").and_then(Value::as_str) == Some("batch"))
            .and_then(|response| response.get("result"))
            .ok_or_else(|| {
                CommandError::new(
                    "TURSO_RESPONSE_INVALID",
                    "Invalid Turso batch transaction result.",
                )
            })?;
        let step_errors = batch_result
            .get("step_errors")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                CommandError::new(
                    "TURSO_RESPONSE_INVALID",
                    "The Turso batch transaction result list is not available.",
                )
            })?;
        if let Some(error) = step_errors
            .iter()
            .take(commit_step + 1)
            .find(|error| !error.is_null())
        {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("The Turso database transaction failed and was cancelled.");
            return Err(CommandError::new("TURSO_SQL_ERROR", message));
        }
        let commit_succeeded = batch_result
            .get("step_results")
            .and_then(Value::as_array)
            .and_then(|results| results.get(commit_step))
            .is_some_and(|result| !result.is_null());
        if !commit_succeeded {
            return Err(CommandError::new(
                "TURSO_TRANSACTION_ROLLED_BACK",
                "The Turso database transaction was cancelled so no partial data is left.",
            ));
        }
        Ok(())
    }

    pub async fn query_one(
        &self,
        sql: impl Into<String>,
        args: Vec<Value>,
    ) -> Result<QueryResult, CommandError> {
        let stmt = Statement::new(sql, args);
        let mut results = self.execute_pipeline(vec![stmt]).await?;
        results
            .pop()
            .ok_or_else(|| CommandError::new("TURSO_QUERY_EMPTY", "The query result is empty."))
    }

    pub async fn ping(&self) -> Result<u64, CommandError> {
        let start = std::time::Instant::now();
        self.query_one("SELECT 1 AS ping_val;", vec![]).await?;
        let elapsed = start.elapsed().as_millis() as u64;
        Ok(elapsed)
    }

    async fn ensure_column(
        &self,
        table: &str,
        column: &str,
        alter_sql: &str,
    ) -> Result<(), CommandError> {
        let result = self
            .query_one(format!("PRAGMA table_info({table});"), vec![])
            .await?;
        let exists = result.to_objects().iter().any(|row| {
            row.get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| name == column)
        });
        if !exists {
            self.query_one(alter_sql, vec![]).await?;
        }
        Ok(())
    }

    pub async fn ensure_schema(&self) -> Result<(), CommandError> {
        self.reject_legacy_stored_values().await?;
        let schema_stmts = vec![
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS schema_migration (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    applied_at TEXT NOT NULL
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS app_role (
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
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS app_permission (
                    permission_key TEXT PRIMARY KEY,
                    nama TEXT NOT NULL,
                    grup TEXT NOT NULL,
                    deskripsi TEXT,
                    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
                    sort_order INTEGER NOT NULL DEFAULT 0
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS role_permission (
                    role_id INTEGER NOT NULL,
                    permission_key TEXT NOT NULL,
                    is_allowed INTEGER NOT NULL DEFAULT 0 CHECK(is_allowed IN (0, 1)),
                    updated_at TEXT NOT NULL,
                    updated_by TEXT,
                    PRIMARY KEY (role_id, permission_key),
                    FOREIGN KEY (role_id) REFERENCES app_role(id) ON DELETE CASCADE,
                    FOREIGN KEY (permission_key) REFERENCES app_permission(permission_key) ON DELETE CASCADE
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS master_operator (
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
                    password_recovery_codes TEXT,
                    password_recovery_created_at TEXT,
                    status TEXT DEFAULT 'Active',
                    created_at TEXT,
                    updated_at TEXT
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS setting_gex_system (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );"#,
                vec![],
            ),
            // Identitas perusahaan pemakai aplikasi: satu baris, selamanya.
            //
            // Berbeda dari setiap tabel lain di template ini, tabel ini BUKAN
            // daftar — kuncinya konstanta 'default_company'. Pola itu sengaja
            // diperagakan: aplikasi bisnis hampir selalu punya satu-dua baris
            // konfigurasi berbentuk begini, dan menuliskannya sebagai daftar
            // ber-AUTOINCREMENT adalah kesalahan yang mahal untuk diperbaiki
            // setelah datanya tersebar di banyak perangkat.
            //
            // `logo_url` dan `signature_url` menampung data URI base64, bukan
            // path berkas. Aplikasi ini offline-first dan berjalan di tiga
            // target dengan sistem berkas yang berbeda-beda; path yang sah di
            // satu perangkat tidak berarti apa-apa di perangkat lain setelah
            // disinkronkan.
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS company_profile (
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
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS sync_changelog (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    client_id TEXT NOT NULL,
                    event_id TEXT NOT NULL UNIQUE,
                    domain TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    entity_key TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );"#,
                vec![],
            ),
            Statement::new(
                // Definisi WAJIB sama dengan `db-migrations.ts`: tabel ini ditulis
                // jalur Rust MAUPUN jalur Web. Versi lama menaruh `server_revision`
                // sebagai NOT NULL (padahal Web menulis NULL untuk event yang
                // rejected/conflict) dan `receipt_json` NOT NULL tanpa DEFAULT
                // (padahal INSERT Web tidak menyertakan kolom itu) — dua-duanya
                // membuat push dari Web gagal di database hasil provisioning
                // Desktop/Mobile.
                r#"CREATE TABLE IF NOT EXISTS sync_operation_receipt (
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
                );"#,
                vec![],
            ),
            Statement::new(
                // `app_session` dan `auth_login_rate_limit` DIMILIKI aplikasi Web
                // (`src/lib/auth/session-store.ts` dan `login-rate-limit.ts`);
                // Rust tidak pernah membacanya. Definisi di bawah WAJIB sama
                // persis dengan `db-migrations.ts`. Versi lama Rust memakai
                // kolom karangan sendiri (`last_activity_at`, `identifier_hash`),
                // sehingga database yang di-provisioning dari Desktop/Mobile
                // membuat login Web gagal total.
                r#"CREATE TABLE IF NOT EXISTS app_session (
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
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS auth_login_rate_limit (
                    rate_key TEXT PRIMARY KEY,
                    attempt_count INTEGER NOT NULL,
                    window_started_at TEXT NOT NULL,
                    blocked_until TEXT,
                    updated_at TEXT NOT NULL
                );"#,
                vec![],
            ),
            // Pemulihan password lewat email + verifikasi wajah. Definisi asli
            // ada di `src/lib/db-migrations.ts`; Rust ikut membuatnya supaya
            // database yang lahir dari Desktop/Mobile tetap bisa dipakai
            // aplikasi Web, dan sebaliknya. Cloud-only: TIDAK pernah masuk
            // SNAPSHOT_TABLES, karena berisi foto bukti dan hash token yang
            // tidak boleh direplikasi ke setiap perangkat.
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS password_reset_request (
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
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS app_mail_config (
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
                );"#,
                vec![],
            ),
            Statement::new(
                "INSERT OR IGNORE INTO app_mail_config (id, provider, is_active, updated_at, updated_by) VALUES ('default', 'resend', 0, datetime('now'), 'rust-bootstrap');",
                vec![],
            ),
            Statement::new(
                // Jejak audit RBAC, dipakai `src/lib/rbac/role-admin.ts`. Dulu
                // hanya dibuat jalur Web, jadi database hasil provisioning
                // Desktop/Mobile membuat manajemen role di Web gagal.
                r#"CREATE TABLE IF NOT EXISTS role_permission_audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    role_id INTEGER NOT NULL,
                    permission_key TEXT NOT NULL,
                    before_allowed INTEGER NOT NULL,
                    after_allowed INTEGER NOT NULL,
                    changed_at TEXT NOT NULL,
                    changed_by TEXT NOT NULL,
                    revision INTEGER NOT NULL
                );"#,
                vec![],
            ),
            Statement::new(
                // Changelog jalur Web (`src/lib/server/operational/*`). Berbeda
                // dari `sync_changelog` milik pipeline Desktop/Mobile, dan ikut
                // dihitung `isDatabaseSchemaReady` di sisi Web.
                r#"CREATE TABLE IF NOT EXISTS sync_change_log (
                    revision INTEGER PRIMARY KEY AUTOINCREMENT,
                    domain TEXT NOT NULL,
                    entity_key TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    changed_at TEXT NOT NULL,
                    actor_operator_id INTEGER NOT NULL
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS app_bootstrap_state (
                    bootstrap_key TEXT PRIMARY KEY,
                    claimed_at TEXT NOT NULL
                );"#,
                vec![],
            ),
            // Indeks
            Statement::new("CREATE INDEX IF NOT EXISTS idx_operator_username ON master_operator(username);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_password_reset_operator ON password_reset_request(operator_id, status, requested_at DESC);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_request(token_hash);", vec![]),
            Statement::new("CREATE INDEX IF NOT EXISTS idx_password_reset_challenge ON password_reset_request(challenge_hash);", vec![]),
            // Seed Roles
            // Seed Role bawaan
            Statement::new(
                r#"INSERT OR IGNORE INTO app_role (id, role_key, nama_role, deskripsi, is_system, is_superadmin, status, created_at, updated_at) VALUES
                (1, 'superadmin', 'Superadmin', 'Full access owner who manages the app roles.', 1, 1, 'Active', datetime('now'), datetime('now')),
                (2, 'admin', 'Admin', 'Operations administrator, per the permission matrix.', 1, 0, 'Active', datetime('now'), datetime('now')),
                (3, 'operator', 'Operator', 'Daily operator, per the permission matrix.', 1, 0, 'Active', datetime('now'), datetime('now'));"#,
                vec![],
            ),
            // Seed Permissions Catalog
            // Katalog permission template. WAJIB identik dengan
            // `src/lib/rbac/catalog.ts` — audit kontrak membandingkan keduanya.
            Statement::new(
                r#"INSERT OR IGNORE INTO app_permission (permission_key, nama, grup, deskripsi, is_active, sort_order) VALUES
                ('home.view', 'Home and navigation access', 'Navigation', 'View home and the app menu.', 1, 10),
                ('dashboard.view', 'Dashboard access', 'Dashboard', 'View summaries and statistics.', 1, 20),
                ('clients.view', 'View clients', 'Clients', 'View clients and their leads.', 1, 30),
                ('clients.manage', 'Manage clients', 'Clients', 'Register new leads and edit client details.', 1, 40),
                ('master_data.manage', 'Manage master data', 'Master data', 'Maintain lead channels and product categories.', 1, 50),
                ('leads.view', 'View leads', 'Leads', 'View leads, their interactions, and the Cold queue.', 1, 52),
                ('leads.manage', 'Manage own leads', 'Leads', 'Record follow ups and client responses on your own leads.', 1, 54),
                ('leads.reassign', 'Reassign leads', 'Leads', 'Move a lead to another CS and record on any lead.', 1, 56),
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
                ('diagnostics.view', 'View system diagnostics', 'Diagnostics', 'View runtime information and database health.', 1, 140);"#,
                vec![],
            ),
            // Seed Default Role Permissions untuk Role Superadmin (Role 1)
            Statement::new(
                r#"INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by)
                SELECT 1, permission_key, 1, datetime('now'), 'system' FROM app_permission;"#,
                vec![],
            ),
            // Seed Default Role Permissions untuk Role Admin (Role 2)
            Statement::new(
                r#"INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by)
                SELECT 2, permission_key, 1, datetime('now'), 'system' FROM app_permission
                WHERE permission_key NOT IN (
                    'roles.manage', 'operators.manage', 'operators.view', 'diagnostics.view',
                    'password_reset.delete', 'two_factor.reset', 'password_reset.approve',
                    'database_backup.restore', 'settings.manage'
                );"#,
                vec![],
            ),
            // Operator bawaan bekerja sebagai CS sampai role divisi dibuat
            // (PRD F-02). WAJIB sama dengan `DEFAULT_ROLE_PERMISSIONS.operator`
            // di `catalog.ts` dan seed role 3 di `db-schema.ts`.
            Statement::new(
                r#"INSERT OR IGNORE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by)
                SELECT 3, permission_key, 1, datetime('now'), 'system' FROM app_permission
                WHERE permission_key IN (
                    'home.view', 'dashboard.view', 'clients.view', 'clients.manage',
                    'leads.view', 'leads.manage', 'sync.view'
                );"#,
                vec![],
            ),
            // Seed Settings
            // Seed pengaturan aplikasi. `rbac_revision` WAJIB ada: nilainya
            // yang dipakai perangkat untuk mendeteksi pencabutan hak akses.
            Statement::new(
                r#"INSERT OR IGNORE INTO setting_gex_system (key, value) VALUES
                ('app_name', 'App Template'),
                ('rbac_revision', '1');"#,
                vec![],
            ),
            // Riwayat versi WAJIB lengkap, bukan hanya fondasinya.
            //
            // `isDatabaseSchemaReady` di `db-schema.ts` menuntut
            // `version >= CURRENT_SCHEMA_VERSION`. Jalur Web mencatat versi 2
            // lewat `runDatabaseMigrations`; kalau jalur Rust berhenti di versi
            // 1, database hasil provisioning dari Desktop/Mobile akan dianggap
            // SELAMANYA belum siap oleh aplikasi Web — padahal seluruh tabel
            // yang diwakili versi 2 (pemulihan password dan verifikasi dua
            // langkah) memang dibuat di berkas ini juga.
            //
            // Setiap migrasi baru di `db-migrations.ts` WAJIB ditambahkan di
            // sini dengan nomor dan nama yang sama persis.
            Statement::new(
                r#"INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES
                (1, 'template-foundation-v1', datetime('now')),
                (2, 'password-reset-and-two-factor', datetime('now')),
                (3, 'clients-leads-master-data', datetime('now')),
                (4, 'lead-interactions', datetime('now'));"#,
                vec![],
            ),
            // ============ DOMAIN MAKLONOS ============
            // Kolom di sini WAJIB identik dengan `db-schema.ts` dan, untuk tabel
            // yang ikut sinkronisasi, dengan DDL lokal di `storage.rs` serta
            // `SNAPSHOT_TABLES` di `sync.rs`. Satu kolom yang berbeda ejaan membuat
            // push tabel itu gagal permanen. Tanpa CHECK, FOREIGN KEY, dan UNIQUE
            // (keputusan G): nilai dan keunikan dijaga aplikasi (`clients.rs`).
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS clients (
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
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS leads (
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
                );"#,
                vec![],
            ),
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS master_option (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    code TEXT NOT NULL,
                    label TEXT NOT NULL,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );"#,
                vec![],
            ),
            // Satu baris per follow up CS atau respons klien (PRD FR-05.1).
            // Ringkasan di `leads` diperbarui handler push dengan aturan yang
            // aman diulang, bukan dengan menimpa baris lead.
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS lead_interactions (
                    id TEXT PRIMARY KEY,
                    lead_id TEXT NOT NULL,
                    operator_id INTEGER,
                    direction TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    notes TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );"#,
                vec![],
            ),
            // Cloud-only: tag dua karakter untuk setiap perangkat, bagian `<KP>`
            // dari kode klien. Tidak ikut sinkronisasi, jadi UNIQUE aman.
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS device_tag_registry (
                    tag TEXT PRIMARY KEY,
                    client_id TEXT NOT NULL UNIQUE,
                    registered_at TEXT NOT NULL
                );"#,
                vec![],
            ),
            Statement::new(
                "CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone_normalized);",
                vec![],
            ),
            Statement::new(
                "CREATE INDEX IF NOT EXISTS idx_clients_code ON clients(client_code);",
                vec![],
            ),
            Statement::new(
                "CREATE INDEX IF NOT EXISTS idx_leads_client ON leads(client_id);",
                vec![],
            ),
            Statement::new(
                "CREATE INDEX IF NOT EXISTS idx_master_option_kind ON master_option(kind, sort_order);",
                vec![],
            ),
            Statement::new(
                "CREATE INDEX IF NOT EXISTS idx_lead_interactions_lead ON lead_interactions(lead_id, occurred_at);",
                vec![],
            ),
            // =========================================

        ];

        self.execute_pipeline(schema_stmts).await?;

        // Pertahankan nilai dari alias seed lama tanpa terus memakai nama yang drift.
        self.query_one(
            r#"INSERT INTO setting_gex_system (key, value)
               SELECT 'lat_kantor', value FROM setting_gex_system WHERE key = 'office_lat'
               ON CONFLICT(key) DO UPDATE SET value = excluded.value
               WHERE setting_gex_system.value = '0';"#,
            vec![],
        )
        .await?;
        self.query_one(
            r#"INSERT INTO setting_gex_system (key, value)
               SELECT 'lng_kantor', value FROM setting_gex_system WHERE key = 'office_lng'
               ON CONFLICT(key) DO UPDATE SET value = excluded.value
               WHERE setting_gex_system.value = '0';"#,
            vec![],
        )
        .await?;
        self.query_one(
            r#"INSERT INTO setting_gex_system (key, value)
               SELECT 'radius_meter', value FROM setting_gex_system WHERE key = 'office_radius_meters'
               ON CONFLICT(key) DO UPDATE SET value = excluded.value
               WHERE setting_gex_system.value = '100';"#,
            vec![],
        )
        .await?;
        self.query_one(
            r#"INSERT INTO setting_gex_system (key, value)
               SELECT 'anti_double_scan_seconds', value FROM setting_gex_system WHERE key = 'cooldown_scan_seconds'
               ON CONFLICT(key) DO UPDATE SET value = excluded.value
               WHERE setting_gex_system.value = '60';"#,
            vec![],
        )
        .await?;
        self.query_one(
            r#"INSERT INTO setting_gex_system (key, value)
               SELECT 'batas_multi_scan_menit', value FROM setting_gex_system WHERE key = 'multi_scan_window_minutes'
               ON CONFLICT(key) DO UPDATE SET value = excluded.value
               WHERE setting_gex_system.value = '5';"#,
            vec![],
        )
        .await?;
        self.query_one(
            r#"INSERT INTO setting_gex_system (key, value)
               SELECT 'auto_alfa_aktif', value FROM setting_gex_system WHERE key = 'auto_alfa_enabled'
               ON CONFLICT(key) DO UPDATE SET value = excluded.value
               WHERE setting_gex_system.value = 'true';"#,
            vec![],
        )
        .await?;

        // Idempotent column migrations for legacy databases in Turso Cloud.
        for (table, column, sql) in [
            ("master_operator", "role_id", "ALTER TABLE master_operator ADD COLUMN role_id INTEGER REFERENCES app_role(id);"),
            ("master_operator", "role", "ALTER TABLE master_operator ADD COLUMN role TEXT NOT NULL DEFAULT 'Operator';"),
            ("master_operator", "status", "ALTER TABLE master_operator ADD COLUMN status TEXT DEFAULT 'Active';"),
            ("master_operator", "created_at", "ALTER TABLE master_operator ADD COLUMN created_at TEXT;"),
            ("master_operator", "updated_at", "ALTER TABLE master_operator ADD COLUMN updated_at TEXT;"),
            // Kontak operator. NULL-able supaya baris operator lama tidak rusak;
            // kewajiban mengisinya ditegakkan di lapisan validasi aplikasi.
            ("master_operator", "email", "ALTER TABLE master_operator ADD COLUMN email TEXT;"),
            ("master_operator", "no_hp", "ALTER TABLE master_operator ADD COLUMN no_hp TEXT;"),
            // Verifikasi dua langkah.
            ("master_operator", "totp_secret", "ALTER TABLE master_operator ADD COLUMN totp_secret TEXT;"),
            ("master_operator", "totp_enabled", "ALTER TABLE master_operator ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;"),
            ("master_operator", "totp_confirmed_at", "ALTER TABLE master_operator ADD COLUMN totp_confirmed_at TEXT;"),
            ("master_operator", "totp_recovery_codes", "ALTER TABLE master_operator ADD COLUMN totp_recovery_codes TEXT;"),
            // Kode pemulihan password: jalan masuk terakhir bagi Superadmin pada
            // pemasangan tanpa jaringan.
            ("master_operator", "password_recovery_codes", "ALTER TABLE master_operator ADD COLUMN password_recovery_codes TEXT;"),
            ("master_operator", "password_recovery_created_at", "ALTER TABLE master_operator ADD COLUMN password_recovery_created_at TEXT;"),
            ("app_role", "require_totp", "ALTER TABLE app_role ADD COLUMN require_totp INTEGER NOT NULL DEFAULT 0;"),
            ("sync_operation_receipt", "payload_hash", "ALTER TABLE sync_operation_receipt ADD COLUMN payload_hash TEXT;"),
            ("sync_operation_receipt", "result_json", "ALTER TABLE sync_operation_receipt ADD COLUMN result_json TEXT;"),
            ("sync_operation_receipt", "base_revision", "ALTER TABLE sync_operation_receipt ADD COLUMN base_revision INTEGER;"),
            ("sync_operation_receipt", "actor_operator_id", "ALTER TABLE sync_operation_receipt ADD COLUMN actor_operator_id INTEGER;"),
            ("sync_operation_receipt", "receipt_json", "ALTER TABLE sync_operation_receipt ADD COLUMN receipt_json TEXT NOT NULL DEFAULT '{}';"),
            ("sync_operation_receipt", "processed_at", "ALTER TABLE sync_operation_receipt ADD COLUMN processed_at TEXT;"),
        ] {
            self.ensure_column(table, column, sql).await?;
        }

        // Indeks ini WAJIB dibuat setelah loop di atas, bukan di dalam pipeline
        // DDL. Pada database cloud yang sudah ada, `master_operator` lahir tanpa
        // kolom `email`, sehingga CREATE INDEX di pipeline gagal dengan
        // "no such column: email" — dan karena satu statement gagal membatalkan
        // seluruh pipeline, `ensure_column` yang justru menambahkan kolom itu
        // tidak pernah sempat berjalan. Database lama akan terkunci selamanya.
        self.query_one(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_master_operator_email ON master_operator(LOWER(email)) WHERE email IS NOT NULL AND TRIM(email) <> '';",
            vec![],
        )
        .await?;

        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2001, 'two-tier-schema-stabilization-v1', datetime('now'));",
            vec![],
        )
        .await?;
        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2002, 'two-tier-security-atomic-sync-v2', datetime('now'));",
            vec![],
        )
        .await?;
        // Selaraskan ulang counter AUTOINCREMENT yang terlanjur melar. Sebelum perbaikan,
        // setiap "INSERT ... ON CONFLICT DO UPDATE" tetap menghabiskan satu nomor urut
        // meskipun tidak ada baris baru, sehingga id melompat (mis. 7 -> 69 -> 111).
        // Dijalankan sekali saja karena ensure_schema hanya dipanggil ketika penanda
        // migrasi -2004 belum ada.
        for (table, primary_key) in [("master_operator", "id")] {
            let realign = format!(
                "UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX({primary_key}), 0) FROM {table}) WHERE name = '{table}' AND seq > (SELECT COALESCE(MAX({primary_key}), 0) FROM {table});"
            );
            let _ = self.query_one(realign, vec![]).await;
        }

        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2004, 'autoincrement-sequence-realign-v1', datetime('now'));",
            vec![],
        )
        .await?;

        self.ensure_sync_pulse().await?;
        self.repair_web_owned_tables().await?;
        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2006, 'sync-pulse-rate-seed-and-cloud-schema-unification-v1', datetime('now'));",
            vec![],
        )
        .await?;
        // Sentinel terakhir menentukan kapan `ensure_schema` dilewati. Setiap
        // penambahan kolom atau tabel WAJIB menaikkan sentinel ini DAN angka
        // yang diperiksa `ensure_schema_current`; kalau tidak, database yang
        // sudah pernah di-provisioning tidak akan pernah menerima kolom baru.
        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2007, 'operator-contact-password-reset-two-factor-v1', datetime('now'));",
            vec![],
        )
        .await?;
        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2009, 'company-profile-v1', datetime('now'));",
            vec![],
        )
        .await?;
        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2010, 'english-stored-values-v1', datetime('now'));",
            vec![],
        )
        .await?;
        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2011, 'clients-leads-master-data-v1', datetime('now'));",
            vec![],
        )
        .await?;
        self.query_one(
            "INSERT OR IGNORE INTO schema_migration (version, name, applied_at) VALUES (-2012, 'lead-interactions-v1', datetime('now'));",
            vec![],
        )
        .await?;

        Ok(())
    }

    /// Menolak database pra-rilis yang dibuat sebelum nilai tersimpan diganti ke
    /// bahasa Inggris (`'Aktif'` -> `'Active'`, `'Menunggu Verifikasi'` ->
    /// `'Pending Verification'`, dst).
    ///
    /// SQLite tidak bisa mengubah CHECK constraint di tempat, jadi tabel lama
    /// akan menolak nilai baru di tengah jalan: login gagal, operator tidak bisa
    /// dibuat, dan pesan errornya menyesatkan. Lebih jujur berhenti di sini.
    /// Padanan TS: `rejectLegacyStoredValues` di `db-schema.ts`.
    async fn reject_legacy_stored_values(&self) -> Result<(), CommandError> {
        let legacy = self
            .count_scalar(LEGACY_STORED_VALUES_SQL)
            .await
            .unwrap_or(0);
        if legacy > 0 {
            return Err(CommandError::new(
                "DATABASE_LEGACY_VALUES",
                LEGACY_STORED_VALUES_MESSAGE,
            ));
        }
        Ok(())
    }

    /// Membangun ulang tabel milik Web yang terlanjur dibuat dengan skema karangan Rust.
    ///
    /// `CREATE TABLE IF NOT EXISTS` tidak memperbaiki tabel yang sudah ada, jadi
    /// database yang pernah di-provisioning dari Desktop/Mobile akan selamanya
    /// memakai kolom yang salah dan membuat login Web gagal. Kedua tabel ini
    /// hanya menyimpan data sementara — sesi login dan penghitung rate limit —
    /// sehingga membangunnya ulang aman: pengguna Web cukup login lagi.
    async fn repair_web_owned_tables(&self) -> Result<(), CommandError> {
        for (table, required_column, create_sql) in [
            (
                "app_session",
                "token_hash",
                r#"CREATE TABLE app_session (
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
                );"#,
            ),
            (
                "auth_login_rate_limit",
                "rate_key",
                r#"CREATE TABLE auth_login_rate_limit (
                    rate_key TEXT PRIMARY KEY,
                    attempt_count INTEGER NOT NULL,
                    window_started_at TEXT NOT NULL,
                    blocked_until TEXT,
                    updated_at TEXT NOT NULL
                );"#,
            ),
        ] {
            let Ok(info) = self
                .query_one(format!("PRAGMA table_info({table});"), vec![])
                .await
            else {
                continue;
            };
            let rows = info.to_objects();
            // Tabel belum ada: `ensure_schema` di atas sudah membuatnya benar.
            if rows.is_empty() {
                continue;
            }
            let correct = rows.iter().any(|row| {
                row.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name == required_column)
            });
            if correct {
                continue;
            }
            let _ = self
                .query_one(format!("DROP TABLE IF EXISTS {table};"), vec![])
                .await;
            self.query_one(create_sql, vec![]).await?;
        }
        Ok(())
    }

    /// Menghapus baris tarif hasil seed lokal versi lama yang sempat terdorong ke cloud.
    ///
    /// Seed lokal dulu memakai id bertanda hubung (`tax-p17-1`, `bpjs-jkk`) sedangkan
    /// cloud memakai garis bawah, sehingga backfill outbox menambahkan bracket
    /// PASAL_17 kedua di cloud dan seluruh perangkat menarik tarif dobel itu.
    /// Daftar id sengaja eksplisit supaya tarif buatan admin tidak pernah tersentuh.
    async fn ensure_sync_pulse(&self) -> Result<(), CommandError> {
        let mut statements = vec![
            Statement::new(
                r#"CREATE TABLE IF NOT EXISTS sync_pulse (
                    table_name TEXT PRIMARY KEY,
                    revision INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );"#,
                vec![],
            ),
        ];
        for source in SNAPSHOT_SOURCES {
            let table = source.table;
            // Diseed pada revisi 1 supaya client yang sudah sinkron penuh punya
            // angka pembanding, bukan 0 yang ambigu dengan "cursor lokal kosong".
            statements.push(Statement::new(
                format!(
                    "INSERT OR IGNORE INTO sync_pulse (table_name, revision, updated_at) VALUES ('{table}', 1, datetime('now'));"
                ),
                vec![],
            ));
            for (suffix, event) in [("ins", "INSERT"), ("upd", "UPDATE"), ("del", "DELETE")] {
                statements.push(Statement::new(
                    format!(
                        r#"CREATE TRIGGER IF NOT EXISTS trg_sync_pulse_{table}_{suffix}
                        AFTER {event} ON {table}
                        BEGIN
                          INSERT INTO sync_pulse (table_name, revision, updated_at)
                          VALUES ('{table}', 1, datetime('now'))
                          ON CONFLICT(table_name) DO UPDATE SET
                            revision = revision + 1,
                            updated_at = datetime('now');
                        END;"#
                    ),
                    vec![],
                ));
            }
        }
        // Dikirim per rombongan supaya pemasangan ~80 statement DDL ini tidak
        // menjadi 80 round-trip berurutan saat login pertama setelah pembaruan.
        // Tabel bisa saja belum ada di database lama, jadi kegagalan satu
        // rombongan diulang satu per satu dan tetap tidak menggagalkan
        // `ensure_schema` secara keseluruhan.
        for chunk in statements.chunks(24) {
            if self.execute_pipeline(chunk.to_vec()).await.is_ok() {
                continue;
            }
            for statement in chunk {
                let _ = self
                    .query_one(statement.sql.clone(), statement.args.clone())
                    .await;
            }
        }
        Ok(())
    }

    async fn ensure_schema_current(&self) -> Result<(), CommandError> {
        let cache_key = self.base_url.as_str().to_owned();
        if schema_verified_cache()
            .lock()
            .map(|verified| verified.contains(&cache_key))
            .unwrap_or(false)
        {
            return Ok(());
        }
        let current = self
            .query_one(
                // Sentinel WAJIB dinaikkan setiap kali ensure_schema menambah
                // tabel atau kolom — nilainya di sini dan pada INSERT harus sama.
                "SELECT COUNT(*) AS total FROM schema_migration WHERE version = -2012;",
                vec![],
            )
            .await
            .ok()
            .and_then(|result| result.to_objects().into_iter().next())
            .and_then(|row| row.get("total").cloned())
            .and_then(|value| value.as_i64())
            .unwrap_or(0)
            > 0;
        if !current {
            self.ensure_schema().await?;
        }
        if let Ok(mut verified) = schema_verified_cache().lock() {
            verified.insert(cache_key);
        }
        Ok(())
    }

    /// Pemeriksaan database provisioning bersifat READ-ONLY: tidak membuat schema,
    /// tidak menulis apa pun. Salah input URL tidak boleh mencemari database lain.
    pub async fn inspect_database(&self) -> Result<DatabaseCheckResult, CommandError> {
        let started = std::time::Instant::now();
        let tables_result = self
            .query_one(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';",
                vec![],
            )
            .await?;
        let latency_ms = started.elapsed().as_millis() as u64;
        let tables: Vec<String> = tables_result
            .to_objects()
            .into_iter()
            .filter_map(|row| {
                row.get("name")
                    .and_then(Value::as_str)
                    .map(|name| name.to_owned())
            })
            .collect();
        let has_table = |name: &str| tables.iter().any(|table| table == name);
        let missing_tables: Vec<String> = DATABASE_CHECK_CORE_TABLES
            .iter()
            .filter(|table| !has_table(table))
            .map(|table| (*table).to_owned())
            .collect();

        let mut check = DatabaseCheckResult {
            reachable: true,
            server_origin: self.base_url.origin().ascii_serialization(),
            latency_ms: Some(latency_ms),
            empty_database: tables.is_empty(),
            schema_ready: missing_tables.is_empty(),
            missing_tables,
            table_count: tables.len() as i64,
            bootstrap_claimed: false,
            superadmin_exists: false,
            superadmin_count: 0,
            superadmin_username: None,
            operator_count: 0,
            client_count: 0,
            lead_count: 0,
            company_name: None,
            error_code: None,
            error_message: None,
        };

        if has_table("app_bootstrap_state") {
            check.bootstrap_claimed = self
                .count_scalar(
                    "SELECT COUNT(*) AS total FROM app_bootstrap_state WHERE bootstrap_key = 'superadmin';",
                )
                .await?
                > 0;
        }
        if has_table("master_operator") && has_table("app_role") {
            let superadmins = self
                .query_one(
                    r#"SELECT m.username AS username
                       FROM master_operator m
                       JOIN app_role r ON r.id = m.role_id
                       WHERE m.status = 'Active' AND r.is_superadmin = 1
                       ORDER BY m.id ASC;"#,
                    vec![],
                )
                .await?
                .to_objects();
            check.superadmin_count = superadmins.len() as i64;
            check.superadmin_exists = check.superadmin_count > 0;
            check.superadmin_username = superadmins
                .first()
                .and_then(|row| row.get("username"))
                .and_then(Value::as_str)
                .map(|username| username.to_owned());
            check.operator_count = self
                .count_scalar("SELECT COUNT(*) AS total FROM master_operator WHERE status = 'Active';")
                .await?;
        }
        // "Database ini berisi data siapa": jumlah klien dan lead yang sudah ada,
        // ditampilkan sebelum pengguna menghubungkannya.
        if has_table("clients") {
            check.client_count = self
                .count_scalar("SELECT COUNT(*) AS total FROM clients;")
                .await?;
        }
        if has_table("leads") {
            check.lead_count = self
                .count_scalar("SELECT COUNT(*) AS total FROM leads;")
                .await?;
        }
        if has_table("setting_gex_system") {
            check.company_name = self
                .query_one(
                    "SELECT value FROM setting_gex_system WHERE key = 'app_name' LIMIT 1;",
                    vec![],
                )
                .await?
                .to_objects()
                .first()
                .and_then(|row| row.get("value"))
                .and_then(Value::as_str)
                .map(|name| name.trim().to_owned())
                .filter(|name| !name.is_empty());
        }
        Ok(check)
    }

    /// Kode klien lain yang sudah memakai nomor WhatsApp ini, bila ada.
    async fn phone_owner(&self, phone: &str, client_id: &str) -> Result<Option<String>, CommandError> {
        if phone.is_empty() {
            return Ok(None);
        }
        Ok(self
            .query_one(
                "SELECT client_code FROM clients WHERE phone_normalized = ? AND id <> ? LIMIT 1;",
                vec![json!(phone), json!(client_id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .and_then(|row| row.get("client_code").and_then(Value::as_str).map(str::to_owned)))
    }

    async fn device_tag_of(&self, client_id: &str) -> Result<Option<String>, CommandError> {
        Ok(self
            .query_one(
                "SELECT tag FROM device_tag_registry WHERE client_id = ? LIMIT 1;",
                vec![json!(client_id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .and_then(|row| row.get("tag").and_then(Value::as_str).map(str::to_owned)))
    }

    /// Terbitkan tag perangkat (bagian `<KP>` kode klien) untuk `client_id`
    /// ini, atau kembalikan tag yang sudah pernah diterbitkan.
    ///
    /// Tag Web (`client_code_web_tag`) tidak pernah diberikan ke perangkat.
    /// `INSERT OR IGNORE` + baca ulang membuat dua perangkat yang mendaftar
    /// bersamaan tidak pernah mendapat tag yang sama: PK `tag` menolak yang
    /// kalah, dan ia mencoba tag berikutnya.
    pub async fn register_device_tag(&self, client_id: &str, web_tag: &str) -> Result<String, CommandError> {
        self.ensure_schema_current().await?;
        if let Some(tag) = self.device_tag_of(client_id).await? {
            return Ok(tag);
        }
        let taken = self
            .count_scalar("SELECT COUNT(*) AS total FROM device_tag_registry;")
            .await?
            .max(0) as u32;
        for index in (taken + 1)..=clients::MAX_CLIENT_SEQUENCE {
            let Some(tag) = clients::device_tag_from_index(index) else {
                break;
            };
            if tag == web_tag {
                continue;
            }
            let _ = self
                .query_one(
                    "INSERT OR IGNORE INTO device_tag_registry (tag, client_id, registered_at) VALUES (?, ?, datetime('now'));",
                    vec![json!(tag), json!(client_id)],
                )
                .await;
            if let Some(tag) = self.device_tag_of(client_id).await? {
                return Ok(tag);
            }
        }
        Err(CommandError::new(
            "DEVICE_TAG_EXHAUSTED",
            "No device tags are left in this database.",
        ))
    }

    /// Apakah tag ini sudah diberikan ke salah satu perangkat.
    pub async fn device_tag_taken(&self, tag: &str) -> Result<bool, CommandError> {
        self.ensure_schema_current().await?;
        Ok(self
            .query_one(
                "SELECT COUNT(*) AS total FROM device_tag_registry WHERE tag = ?;",
                vec![json!(tag)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .and_then(|row| row.get("total").cloned())
            .and_then(|value| value.as_i64().or_else(|| value.as_str().and_then(|text| text.parse().ok())))
            .unwrap_or(0)
            > 0)
    }

    async fn count_scalar(&self, sql: &str) -> Result<i64, CommandError> {
        Ok(self
            .query_one(sql, vec![])
            .await?
            .to_objects()
            .into_iter()
            .next()
            .and_then(|row| row.get("total").cloned())
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
            })
            .unwrap_or(0))
    }

    pub async fn bootstrap_status(&self) -> Result<BootstrapStatus, CommandError> {
        self.ensure_schema_current().await?;
        let result = self
            .query_one(
                r#"SELECT COUNT(*) AS total
                   FROM master_operator m
                   JOIN app_role r ON r.id = m.role_id
                   WHERE m.status = 'Active' AND r.is_superadmin = 1;"#,
                vec![],
            )
            .await?;
        let active_superadmins = result
            .to_objects()
            .into_iter()
            .next()
            .and_then(|row| row.get("total").cloned())
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
            })
            .unwrap_or(0);
        Ok(BootstrapStatus {
            configured: true,
            required: active_superadmins == 0,
            server_origin: self.base_url.origin().ascii_serialization(),
            reachable: true,
            message: None,
        })
    }

    /// Buat Superadmin pertama, lalu terbitkan kode pemulihannya.
    ///
    /// Kode dikembalikan di sini karena inilah satu-satunya saat ia bisa
    /// dibaca: database hanya memegang hash-nya. Akun pertama juga satu-satunya
    /// akun yang tidak punya siapa pun di atasnya untuk menyetujui pemulihan,
    /// sehingga tanpa kode ini sebuah pemasangan tanpa jaringan bisa terkunci
    /// selamanya hanya karena satu password terlupa.
    pub async fn bootstrap_superadmin(
        &self,
        draft: BootstrapSuperadminDraft,
    ) -> Result<Vec<String>, CommandError> {
        validate_bootstrap_draft(&draft)?;
        if !self.bootstrap_status().await?.required {
            return Err(CommandError::new(
                "TURSO_BOOTSTRAP_CLOSED",
                "Bootstrap is closed because an active Superadmin already exists.",
            ));
        }
        let superadmin_role_id = self
            .query_one(
                "SELECT id FROM app_role WHERE role_key = 'superadmin' AND is_superadmin = 1 AND status = 'Active' LIMIT 1;",
                vec![],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .and_then(|row| row.get("id").cloned())
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
            })
            .filter(|role_id| *role_id > 0)
            .ok_or_else(|| {
                CommandError::new(
                    "TURSO_SCHEMA_INVALID",
                    "No active Superadmin role exists in the cloud database schema.",
                )
            })?;
        let password = Zeroizing::new(draft.password);
        let password_hash = hash_password_pbkdf2(&password);
        let statements = vec![
            Statement::new(
                "INSERT INTO app_bootstrap_state (bootstrap_key, claimed_at) VALUES ('superadmin', datetime('now'));",
                vec![],
            ),
            Statement::new(
                r#"INSERT INTO master_operator (
                    kode_operator, nama_operator, username, password_hash,
                    role, role_id, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'Admin', ?, 'Active', datetime('now'), datetime('now'));"#,
                vec![
                    json!(draft.kode_operator.trim().to_ascii_uppercase()),
                    json!(draft.nama_operator.trim()),
                    json!(draft.username.trim()),
                    json!(password_hash),
                    json!(superadmin_role_id),
                ],
            ),
        ];
        self.execute_atomic(statements).await.map_err(|error| {
            if error.message.contains("UNIQUE") || error.message.contains("bootstrap") {
                CommandError::new(
                    "TURSO_BOOTSTRAP_CLOSED",
                    "Bootstrap is closed because it was already claimed on this database.",
                )
            } else {
                error
            }
        })?;
        if self.bootstrap_status().await?.required {
            return Err(CommandError::new(
                "TURSO_BOOTSTRAP_FAILED",
                "The first Superadmin could not be created.",
            ));
        }

        let operator_id = self
            .query_one(
                "SELECT id FROM master_operator WHERE username = ? COLLATE NOCASE LIMIT 1;",
                vec![json!(draft.username.trim())],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .and_then(|row| row.get("id").and_then(Value::as_i64))
            .ok_or_else(|| {
                CommandError::new(
                    "TURSO_BOOTSTRAP_FAILED",
                    "The first Superadmin could not be read back.",
                )
            })?;

        self.issue_password_recovery_codes(operator_id).await
    }

    /// Waktu dari jam DATABASE, bukan jam perangkat.
    ///
    /// Kode TOTP yang sah harus diterima sama di Web maupun Desktop. Kalau
    /// masing-masing memakai jamnya sendiri, satu kode bisa lolos di satu
    /// platform dan ditolak di platform lain — dan jam ponsel murah memang
    /// sering meleset. Prinsip yang sama dipakai `time_policy.rs`.
    async fn database_unix_seconds(&self) -> Result<i64, CommandError> {
        self.query_one(
            "SELECT CAST(strftime('%s','now') AS INTEGER) AS now;",
            vec![],
        )
        .await?
        .to_objects()
        .into_iter()
        .next()
        .and_then(|row| row.get("now").and_then(Value::as_i64))
        .ok_or_else(|| CommandError::new("TURSO_QUERY_FAILED", "The database clock could not be read."))
    }

    /// Status 2FA satu operator.
    pub async fn get_two_factor_status(&self, operator_id: i64) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self.read_operator_totp(operator_id).await?;
        Ok(json!({
            "status": {
                "enabled": row.enabled,
                "confirmedAt": row.confirmed_at,
                "recoveryRemaining": row.recovery_codes.len(),
                "requiredByRole": row.require_totp,
            }
        }))
    }

    async fn read_operator_totp(&self, operator_id: i64) -> Result<OperatorTotp, CommandError> {
        let row = self
            .query_one(
                r#"SELECT COALESCE(m.totp_secret, '') AS totp_secret,
                          COALESCE(m.totp_enabled, 0) AS totp_enabled,
                          COALESCE(m.totp_confirmed_at, '') AS totp_confirmed_at,
                          COALESCE(m.totp_recovery_codes, '[]') AS totp_recovery_codes,
                          m.username,
                          COALESCE(r.require_totp, 0) AS require_totp
                   FROM master_operator m
                   LEFT JOIN app_role r ON r.id = m.role_id
                   WHERE m.id = ? LIMIT 1;"#,
                vec![json!(operator_id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| CommandError::new("VALIDATION_ERROR", "Operator not found."))?;
        let text = |key: &str| {
            row.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let recovery_codes: Vec<String> =
            serde_json::from_str(&text("totp_recovery_codes")).unwrap_or_default();
        Ok(OperatorTotp {
            secret: text("totp_secret"),
            enabled: row.get("totp_enabled").and_then(Value::as_i64) == Some(1),
            confirmed_at: text("totp_confirmed_at"),
            recovery_codes,
            username: text("username"),
            require_totp: row.get("require_totp").and_then(Value::as_i64) == Some(1),
        })
    }

    /// Menerbitkan rahasia baru dalam keadaan BELUM aktif.
    pub async fn begin_two_factor_setup(&self, operator_id: i64) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self.read_operator_totp(operator_id).await?;
        if row.enabled {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Two-step verification is already on. Turn it off before enrolling a new device.",
            ));
        }
        let secret = generate_totp_secret();
        self.query_one(
            "UPDATE master_operator SET totp_secret = ?, totp_enabled = 0, totp_confirmed_at = NULL, totp_recovery_codes = NULL WHERE id = ?;",
            vec![json!(secret), json!(operator_id)],
        )
        .await?;
        let label = format!("App Template:{}", row.username);
        Ok(json!({
            "setup": {
                "secret": secret,
                "otpauthUri": format!(
                    // Issuer adalah nama yang MUNCUL DI APLIKASI AUTENTIKATOR pengguna,
                    // jadi ia wajib mengikuti identitas produk — bukan nama produk
                    // asal template.
                    "otpauth://totp/{}?secret={}&issuer={}&algorithm=SHA1&digits=6&period=30",
                    urlencoding_minimal(&label),
                    secret,
                    urlencoding_minimal(super::app_identity::APP_DISPLAY_NAME)
                ),
            }
        }))
    }

    /// Mengaktifkan 2FA setelah kode pertama terbukti cocok.
    pub async fn confirm_two_factor_setup(
        &self,
        operator_id: i64,
        code: &str,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self.read_operator_totp(operator_id).await?;
        if row.enabled {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Two-step verification is already on.",
            ));
        }
        if row.secret.is_empty() {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Enrollment has not started. Open the 2FA settings screen again.",
            ));
        }
        let now = self.database_unix_seconds().await?;
        if !verify_totp(&row.secret, code, now, TOTP_WINDOW_ONLINE) {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "The code does not match. Make sure your phone clock is set automatically and the code has not changed.",
            ));
        }
        let recovery_codes = generate_recovery_codes(8);
        let hashed: Vec<String> = recovery_codes
            .iter()
            .map(|code| sha256_hex(&normalize_recovery_code(code)))
            .collect();
        self.query_one(
            "UPDATE master_operator SET totp_enabled = 1, totp_confirmed_at = datetime('now'), totp_recovery_codes = ? WHERE id = ?;",
            vec![
                json!(serde_json::to_string(&hashed).unwrap_or_else(|_| "[]".to_string())),
                json!(operator_id),
            ],
        )
        .await?;
        Ok(json!({ "recoveryCodes": recovery_codes }))
    }

    /// Mematikan 2FA. `require_proof` benar ketika operator mematikan miliknya
    /// sendiri; Admin yang menolong operator kehilangan ponsel memakai `false`.
    pub async fn disable_two_factor(
        &self,
        operator_id: i64,
        require_proof: bool,
        code: &str,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self.read_operator_totp(operator_id).await?;
        if !row.enabled {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Two-step verification is not on.",
            ));
        }
        if require_proof && !self.consume_totp_or_recovery(operator_id, &row, code).await? {
            return Err(CommandError::new(
                "FORBIDDEN",
                "The verification code does not match.",
            ));
        }
        self.query_one(
            "UPDATE master_operator SET totp_secret = NULL, totp_enabled = 0, totp_confirmed_at = NULL, totp_recovery_codes = NULL WHERE id = ?;",
            vec![json!(operator_id)],
        )
        .await?;
        Ok(json!({ "sukses": true }))
    }

    /// Memeriksa kode TOTP atau kode cadangan; kode cadangan yang cocok
    /// langsung dihapus pada percobaan yang berhasil itu juga.
    async fn consume_totp_or_recovery(
        &self,
        operator_id: i64,
        row: &OperatorTotp,
        code: &str,
    ) -> Result<bool, CommandError> {
        let now = self.database_unix_seconds().await?;
        if verify_totp(&row.secret, code, now, TOTP_WINDOW_ONLINE) {
            return Ok(true);
        }
        let normalized = normalize_recovery_code(code);
        if normalized.len() < 6 {
            return Ok(false);
        }
        let hashed = sha256_hex(&normalized);
        if !row.recovery_codes.iter().any(|item| *item == hashed) {
            return Ok(false);
        }
        let remaining: Vec<&String> = row
            .recovery_codes
            .iter()
            .filter(|item| **item != hashed)
            .collect();
        self.query_one(
            "UPDATE master_operator SET totp_recovery_codes = ? WHERE id = ?;",
            vec![
                json!(serde_json::to_string(&remaining).unwrap_or_else(|_| "[]".to_string())),
                json!(operator_id),
            ],
        )
        .await?;
        Ok(true)
    }

    pub async fn authenticate_operator(
        &self,
        identifier: &str,
        password: &str,
        totp_code: Option<&str>,
    ) -> Result<OperatorUser, CommandError> {
        self.ensure_schema_current().await?;
        let id_clean = identifier.trim();
        let sql = r#"
            SELECT
                m.id, m.kode_operator, m.nama_operator, m.username, m.password_hash,
                COALESCE(m.totp_enabled, 0) AS totp_enabled,
                m.role_id, r.role_key, r.nama_role, r.is_superadmin
            FROM master_operator m
            JOIN app_role r ON r.id = m.role_id
            WHERE (m.username = ? COLLATE NOCASE OR m.kode_operator = ? COLLATE NOCASE)
              AND m.status = 'Active' AND r.status = 'Active'
            LIMIT 1;
        "#;

        let result = self
            .query_one(sql, vec![json!(id_clean), json!(id_clean)])
            .await?;

        let objects = result.to_objects();
        let row = objects.first().ok_or_else(|| {
            CommandError::new(
                "LOGIN_REJECTED",
                "Wrong username or password, or the account is inactive.",
            )
        })?;

        let stored_hash = row
            .get("password_hash")
            .and_then(Value::as_str)
            .unwrap_or("");

        if !verify_password(password, stored_hash) {
            return Err(CommandError::new(
                "LOGIN_REJECTED",
                "Wrong username or password.",
            ));
        }

        let op_id = row.get("id").and_then(Value::as_i64).unwrap_or(0);
        if !stored_hash.starts_with("pbkdf2-sha256$") && !stored_hash.starts_with("$argon2") {
            let upgraded_hash = hash_password_pbkdf2(password);
            self.query_one(
                "UPDATE master_operator SET password_hash = ?, updated_at = datetime('now') WHERE id = ? AND password_hash = ?;",
                vec![json!(upgraded_hash), json!(op_id), json!(stored_hash)],
            )
            .await?;
        }
        // Gerbang 2FA dijalankan SETELAH password terbukti benar. Urutan itu
        // penting: memberi tahu bahwa sebuah akun memakai 2FA sebelum
        // passwordnya benar akan mengubah layar login menjadi alat pemetaan
        // akun mana yang bernilai diserang.
        let totp = self.read_operator_totp(op_id).await?;
        if totp.enabled {
            let code = totp_code.unwrap_or("").trim();
            if code.is_empty() {
                return Err(CommandError::new(
                    "TOTP_REQUIRED",
                    "Enter the 6-digit code from your authenticator app.",
                ));
            }
            if !self.consume_totp_or_recovery(op_id, &totp, code).await? {
                return Err(CommandError::new(
                    "TOTP_INVALID",
                    "The verification code does not match. Check the latest code in your authenticator app.",
                ));
            }
        } else if totp.require_totp {
            return Err(CommandError::new(
                "TOTP_ENROLLMENT_REQUIRED",
                "This account's role requires two-step verification, but your account has not enrolled yet. Ask an Admin to open 2FA enrollment.",
            ));
        }

        self.hydrate_operator(row, op_id).await
    }

    /// Susun `OperatorUser` lengkap dari satu baris `master_operator` + `app_role`.
    ///
    /// Dipakai bersama oleh login dan pemuatan ulang sesi. Menyalin blok ini ke
    /// dua tempat akan membuat keduanya drift: permission hasil login dan
    /// permission hasil revalidasi harus dihitung dengan aturan yang persis sama.
    async fn hydrate_operator(
        &self,
        row: &HashMap<String, Value>,
        operator_id: i64,
    ) -> Result<OperatorUser, CommandError> {
        let kode_operator = row
            .get("kode_operator")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let nama_operator = row
            .get("nama_operator")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let username = row
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let role_id = row.get("role_id").and_then(Value::as_i64).unwrap_or(0);
        let role_key = row
            .get("role_key")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let nama_role = row
            .get("nama_role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let is_superadmin = row
            .get("is_superadmin")
            .and_then(|v| v.as_i64().map(|n| n == 1).or_else(|| v.as_bool()))
            .unwrap_or(false);

        // Permission selalu dibaca dari katalog aktif agar backend dan UI tidak drift.
        let permission_sql = if is_superadmin {
            "SELECT permission_key FROM app_permission WHERE is_active = 1 ORDER BY sort_order, permission_key;"
        } else {
            "SELECT p.permission_key FROM app_permission p JOIN role_permission rp ON rp.permission_key = p.permission_key WHERE p.is_active = 1 AND rp.role_id = ? AND rp.is_allowed = 1 ORDER BY p.sort_order, p.permission_key;"
        };
        let permission_args = if is_superadmin {
            vec![]
        } else {
            vec![json!(role_id)]
        };
        let permissions = self
            .query_one(permission_sql, permission_args)
            .await?
            .to_objects()
            .into_iter()
            .filter_map(|permission| {
                permission
                    .get("permission_key")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect();

        // Ambil rbac_revision
        let rev_query = self
            .query_one(
                "SELECT value FROM setting_gex_system WHERE key = 'rbac_revision' LIMIT 1;",
                vec![],
            )
            .await;
        let permission_revision = rev_query
            .ok()
            .and_then(|res| res.to_objects().into_iter().next())
            .and_then(|row| {
                row.get("value")
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<i64>().ok())
                    .or_else(|| row.get("value").and_then(Value::as_i64))
            })
            .unwrap_or(1);

        Ok(OperatorUser {
            id: operator_id,
            kode_operator,
            nama_operator,
            username,
            role: nama_role,
            role_id,
            role_key,
            is_superadmin,
            permissions,
            permission_revision,
            // Penanda akun, bukan penanda role — dibaca dari baris yang sama.
            totp_enabled: row
                .get("totp_enabled")
                .and_then(|value| value.as_i64().map(|n| n == 1).or_else(|| value.as_bool()))
                .unwrap_or(false),
            login_at: Some(chrono_like_now_iso()),
        })
    }

    /// Muat ulang status dan permission operator yang sedang memegang sesi.
    ///
    /// `Ok(None)` berarti operator sudah dihapus, dinonaktifkan, atau role-nya
    /// dimatikan di cloud — sesi perangkat WAJIB dicabut. Kegagalan jaringan
    /// tetap dikembalikan sebagai `Err` supaya sesi tidak pernah dicabut hanya
    /// karena koneksi sedang terganggu; itu akan membuat perangkat lapangan
    /// terlempar keluar setiap kali sinyal turun.
    pub async fn reload_operator(
        &self,
        operator_id: i64,
    ) -> Result<Option<OperatorUser>, CommandError> {
        let sql = r#"
            SELECT
                m.id, m.kode_operator, m.nama_operator, m.username,
                COALESCE(m.totp_enabled, 0) AS totp_enabled,
                m.role_id, r.role_key, r.nama_role, r.is_superadmin
            FROM master_operator m
            JOIN app_role r ON r.id = m.role_id
            WHERE m.id = ? AND m.status = 'Active' AND r.status = 'Active'
            LIMIT 1;
        "#;
        let result = self.query_one(sql, vec![json!(operator_id)]).await?;
        let objects = result.to_objects();
        let Some(row) = objects.first() else {
            return Ok(None);
        };
        self.hydrate_operator(row, operator_id).await.map(Some)
    }

    /// Membaca penghitung perubahan per tabel dari `sync_pulse`.
    ///
    /// `Ok(None)` berarti database cloud belum memiliki tabel/trigger pulse
    /// (database lama). Pemanggil wajib memperlakukannya sebagai "semua tabel
    /// berpotensi berubah" dan menarik snapshot penuh.
    pub async fn fetch_sync_pulse(&self) -> Result<Option<HashMap<String, i64>>, CommandError> {
        let Ok(result) = self
            .query_one("SELECT table_name, revision FROM sync_pulse;", vec![])
            .await
        else {
            return Ok(None);
        };
        let mut pulse = HashMap::with_capacity(SNAPSHOT_SOURCES.len());
        for row in result.to_objects() {
            let Some(table) = row.get("table_name").and_then(Value::as_str) else {
                continue;
            };
            let revision = row
                .get("revision")
                .and_then(|value| {
                    value
                        .as_i64()
                        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
                })
                .unwrap_or(0);
            pulse.insert(table.to_owned(), revision);
        }
        if pulse.is_empty() {
            return Ok(None);
        }
        Ok(Some(pulse))
    }

    /// Menarik snapshot cloud. Bila `wanted` diisi, hanya tabel di dalamnya yang
    /// dibaca — kunci payload tabel lain sengaja tidak dimunculkan sama sekali
    /// agar `sync::apply_table` memperlakukannya sebagai "tidak dikirim" dan
    /// melewatkannya (termasuk melewatkan penghapusan baris lokal).
    pub async fn pull_snapshot_tables(
        &self,
        last_revision: i64,
        wanted: Option<&HashSet<String>>,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let sources: Vec<&SnapshotSource> = SNAPSHOT_SOURCES
            .iter()
            .filter(|source| match wanted {
                None => true,
                Some(set) => set.contains(source.table),
            })
            .collect();

        let mut snapshot = json!({});
        let mut max_rev = last_revision;

        if !sources.is_empty() {
            let mut statements: Vec<Statement> = sources
                .iter()
                .map(|source| Statement::new(source.sql, vec![]))
                .collect();
            statements.push(Statement::new(
                "SELECT COALESCE(MAX(id), 0) AS max_rev FROM sync_changelog;",
                vec![],
            ));

            let results = self.execute_pipeline(statements).await?;
            let rev_result = results.last().ok_or_else(CommandError::internal)?;
            let queried_rev = rev_result
                .to_objects()
                .into_iter()
                .next()
                .and_then(|row| {
                    row.get("max_rev").and_then(|value| {
                        value
                            .as_i64()
                            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
                    })
                })
                .unwrap_or(0);
            max_rev = queried_rev.max(last_revision);

            for (idx, source) in sources.iter().enumerate() {
                let res = results.get(idx).ok_or_else(CommandError::internal)?;
                let rows_json: Vec<Value> =
                    res.to_objects().into_iter().map(|map| json!(map)).collect();
                snapshot[source.payload_key] = json!(rows_json);
            }
        }

        snapshot["revision"] = json!(max_rev);
        Ok(json!({ "snapshot": snapshot }))
    }

    pub async fn push_events(&self, events: &[Value]) -> Result<Vec<Value>, CommandError> {
        self.ensure_schema_current().await?;
        if events.is_empty() || events.len() > 50 {
            return Err(CommandError::new(
                "TURSO_SYNC_BATCH_INVALID",
                "A sync batch must contain 1 to 50 events.",
            ));
        }
        let mut push_results = Vec::new();

        // Pastikan tabel sync_changelog ada
        let ensure_changelog_sql = r#"
            CREATE TABLE IF NOT EXISTS sync_changelog (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id TEXT NOT NULL,
                event_id TEXT NOT NULL UNIQUE,
                domain TEXT NOT NULL,
                operation TEXT NOT NULL,
                entity_key TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
        "#;

        // Satu round-trip untuk seluruh batch: jaminan tabel changelog + pemetaan
        // changelog dan receipt untuk semua event sekaligus. Sebelumnya setiap
        // event menembak dua query terpisah secara berurutan, jadi satu batch 50
        // event berarti 100+ request HTTP bolak-balik ke Turso.
        let batch_event_ids: Vec<String> = events
            .iter()
            .filter_map(|event| {
                event
                    .get("event_id")
                    .or_else(|| event.get("eventId"))
                    .and_then(Value::as_str)
            })
            .filter(|event_id| !event_id.is_empty())
            .map(str::to_owned)
            .collect();

        let mut previous_events: HashMap<String, HashMap<String, Value>> = HashMap::new();
        let mut applied_receipts: HashSet<String> = HashSet::new();
        if batch_event_ids.is_empty() {
            self.query_one(ensure_changelog_sql, vec![]).await?;
        } else {
            let placeholders = vec!["?"; batch_event_ids.len()].join(", ");
            let args: Vec<Value> = batch_event_ids.iter().map(|id| json!(id)).collect();
            let prefetch = self
                .execute_pipeline(vec![
                    Statement::new(ensure_changelog_sql, vec![]),
                    Statement::new(
                        format!(
                            "SELECT id, event_id, client_id, domain, operation, entity_key, payload_json FROM sync_changelog WHERE event_id IN ({placeholders});"
                        ),
                        args.clone(),
                    ),
                    Statement::new(
                        format!(
                            "SELECT event_id FROM sync_operation_receipt WHERE status = 'applied' AND event_id IN ({placeholders});"
                        ),
                        args,
                    ),
                ])
                .await?;
            if let Some(result) = prefetch.get(1) {
                for row in result.to_objects() {
                    let Some(event_id) = row
                        .get("event_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                    else {
                        continue;
                    };
                    previous_events.insert(event_id, row);
                }
            }
            if let Some(result) = prefetch.get(2) {
                for row in result.to_objects() {
                    if let Some(event_id) = row.get("event_id").and_then(Value::as_str) {
                        applied_receipts.insert(event_id.to_owned());
                    }
                }
            }
        }

        for event in events {
            let event_id = event
                .get("event_id")
                .or_else(|| event.get("eventId"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let client_id = event
                .get("client_id")
                .or_else(|| event.get("clientId"))
                .and_then(Value::as_str)
                .unwrap_or("desktop-client");
            let raw_domain = event.get("domain").and_then(Value::as_str).unwrap_or("");
            let raw_operation = event.get("operation").and_then(Value::as_str).unwrap_or("");
            let entity_key = event
                .get("entity_key")
                .or_else(|| event.get("entityKey"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let base_revision = event
                .get("base_revision")
                .or_else(|| event.get("baseRevision"))
                .and_then(Value::as_i64);
            let payload_json = event
                .get("payload_json")
                .or_else(|| event.get("payloadJson"))
                .or_else(|| event.get("payload"))
                .map(|value| match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .unwrap_or_else(|| "{}".to_owned());

            let valid_event_id = event_id.len() == 68
                && event_id.starts_with("evt-")
                && event_id[4..].bytes().all(|byte| byte.is_ascii_hexdigit());
            let valid_client_id = client_id.len() == 72
                && client_id.starts_with("desktop-")
                && client_id[8..].bytes().all(|byte| byte.is_ascii_hexdigit());
            if !valid_event_id
                || !valid_client_id
                || raw_domain.is_empty()
                || raw_operation.is_empty()
                || entity_key.is_empty()
                || entity_key.len() > 160
                || base_revision.is_some_and(|revision| revision < 0)
                || payload_json.len() > 25_165_824
            {
                return Err(CommandError::new(
                    "TURSO_SYNC_EVENT_INVALID",
                    "The sync event is invalid or exceeds the payload limit.",
                ));
            }
            let parsed_payload = serde_json::from_str::<Value>(&payload_json).map_err(|_| {
                CommandError::new(
                    "TURSO_SYNC_EVENT_INVALID",
                    "Payload event sinkronisasi bukan JSON yang valid.",
                )
            })?;
            if !parsed_payload.is_object() {
                return Err(CommandError::new(
                    "TURSO_SYNC_EVENT_INVALID",
                    "The sync event payload must be a JSON object.",
                ));
            }
            let Some((domain, operation)) = canonical_sync_route(raw_domain, raw_operation) else {
                let message = format!(
                    "Unknown sync domain or operation: {raw_domain}/{raw_operation}."
                );
                push_results.push(json!({
                    "eventId": event_id,
                    "status": "conflict",
                    "reason": message.clone(),
                    "message": message,
                    "serverRevision": 0
                }));
                continue;
            };

            // Receipt adalah sumber idempotensi event sukses. Changelog tanpa receipt
            // hanya mungkin berasal dari versi lama yang belum atomik.
            let previous_event = previous_events.get(event_id);
            if let Some(previous) = previous_event {
                let previous_route = previous
                    .get("domain")
                    .and_then(Value::as_str)
                    .zip(previous.get("operation").and_then(Value::as_str))
                    .and_then(|(domain, operation)| canonical_sync_route(domain, operation));
                let same_event = previous.get("client_id").and_then(Value::as_str)
                    == Some(client_id)
                    && previous_route == Some((domain, operation))
                    && previous.get("entity_key").and_then(Value::as_str) == Some(entity_key)
                    && previous.get("payload_json").and_then(Value::as_str)
                        == Some(payload_json.as_str());
                if !same_event {
                    return Err(CommandError::new(
                        "TURSO_SYNC_EVENT_COLLISION",
                        "This event ID was already used with different contents.",
                    ));
                }
                let previous_revision = previous
                    .get("id")
                    .and_then(|value| {
                        value
                            .as_i64()
                            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
                    })
                    .filter(|revision| *revision > 0)
                    .ok_or_else(|| {
                        CommandError::new(
                            "TURSO_SYNC_REVISION_INVALID",
                            "The sync event revision could not be determined.",
                        )
                    })?;
                if applied_receipts.contains(event_id) {
                    push_results.push(json!({
                        "eventId": event_id,
                        "status": "applied",
                        "message": "The event was already applied.",
                        "serverRevision": previous_revision
                    }));
                    continue;
                }
                self.query_one(
                    "DELETE FROM sync_changelog WHERE event_id = ?;",
                    vec![json!(event_id)],
                )
                .await?;
            }

            let now_epoch = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or_default();

            // Titik pasang guard domain. Di aplikasi operasional, di sinilah
            // hierarki prioritas sumber operasional dan konkurensi optimistis
            // ditegakkan SEBELUM mutasi disusun. Tambahkan guard Anda di sini
            // bila domain Anda punya aturan "siapa boleh menimpa siapa".
            //
            // Nomor WhatsApp unik per database, dijaga aplikasi (bukan UNIQUE).
            // Dua perangkat offline yang mendaftarkan nomor sama: yang kedua
            // tiba menjadi konflik yang menyebut pemilik nomornya (PRD E-04).
            // ponytail: ada jeda sempit antara pemeriksaan ini dan transaksi
            // mutasinya; bila dua push untuk nomor sama tiba di milidetik yang
            // sama, keduanya bisa lolos. Pindahkan ke guard di dalam transaksi
            // bila itu pernah terjadi.
            if domain == "client" {
                let phone = parsed_payload
                    .get("phone_normalized")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some(owner) = self.phone_owner(phone, entity_key).await? {
                    let message = format!(
                        "The WhatsApp number {phone} is already registered to client {owner}."
                    );
                    push_results.push(json!({
                        "eventId": event_id,
                        "status": "conflict",
                        "reason": message.clone(),
                        "message": message,
                        "serverRevision": 0
                    }));
                    continue;
                }
            }

            let collector = StatementCollector::default();
            if let Err(error) =
                apply_event_to_turso(&collector, domain, operation, entity_key, &parsed_payload)
                    .await
            {
                push_results.push(json!({
                    "eventId": event_id,
                    "status": "conflict",
                    "reason": error.message.clone(),
                    "message": error.message,
                    "serverRevision": 0
                }));
                continue;
            }
            let mutations = collector.finish()?;
            if mutations.is_empty() {
                let message = format!(
                    "The event payload produced no mutation: {domain}/{operation} ({entity_key})."
                );
                push_results.push(json!({
                    "eventId": event_id,
                    "status": "conflict",
                    "reason": message.clone(),
                    "message": message,
                    "serverRevision": 0
                }));
                continue;
            }
            let mut transaction_statements = vec![Statement::new(
                r#"INSERT INTO sync_changelog (
                    client_id, event_id, domain, operation, entity_key, payload_json, created_at
                ) VALUES (
                    CASE WHEN ? IS NULL OR COALESCE((
                        SELECT MAX(id) FROM sync_changelog
                        WHERE domain = ? AND entity_key = ?
                    ), 0) <= ? THEN ? ELSE NULL END,
                    ?, ?, ?, ?, ?, ?
                )
                ON CONFLICT(event_id) DO UPDATE SET
                    client_id = CASE WHEN
                        sync_changelog.client_id = excluded.client_id
                        AND sync_changelog.domain = excluded.domain
                        AND sync_changelog.operation = excluded.operation
                        AND sync_changelog.entity_key = excluded.entity_key
                        AND sync_changelog.payload_json = excluded.payload_json
                    THEN sync_changelog.client_id ELSE NULL END;"#,
                vec![
                    json!(base_revision),
                    json!(domain),
                    json!(entity_key),
                    json!(base_revision),
                    json!(client_id),
                    json!(event_id),
                    json!(domain),
                    json!(operation),
                    json!(entity_key),
                    json!(payload_json),
                    json!(now_epoch),
                ],
            )];
            transaction_statements.extend(mutations);
            let receipt = json!({ "eventId": event_id, "status": "applied" });
            let payload_hash = hex::encode(Sha256::digest(payload_json.as_bytes()));
            transaction_statements.push(Statement::new(
                r#"INSERT OR REPLACE INTO sync_operation_receipt (
                    event_id, client_id, domain, operation, entity_key, payload_hash,
                    server_revision, status, result_json, base_revision, actor_operator_id,
                    receipt_json, created_at, processed_at
                ) VALUES (?, ?, ?, ?, ?,
                    ?, (SELECT id FROM sync_changelog WHERE event_id = ?),
                    'applied', ?, ?, 0, ?, datetime('now'), datetime('now'));"#,
                vec![
                    json!(event_id),
                    json!(client_id),
                    json!(domain),
                    json!(operation),
                    json!(entity_key),
                    json!(payload_hash),
                    json!(event_id),
                    json!(receipt.to_string()),
                    json!(base_revision),
                    json!(receipt.to_string()),
                ],
            ));

            if let Err(error) = self.execute_atomic(transaction_statements).await {
                let current_revision = if let Some(base_revision) = base_revision {
                    self.query_one(
                        "SELECT COALESCE(MAX(id), 0) AS revision FROM sync_changelog WHERE domain = ? AND entity_key = ?;",
                        vec![json!(domain), json!(entity_key)],
                    )
                    .await
                    .ok()
                    .and_then(|result| result.to_objects().into_iter().next())
                    .and_then(|row| row.get("revision").cloned())
                    .and_then(|value| {
                        value
                            .as_i64()
                            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
                    })
                    .filter(|revision| *revision > base_revision)
                } else {
                    None
                };
                let message = current_revision
                    .map(|_| "Server data changed after the local snapshot was taken.".to_owned())
                    .unwrap_or(error.message);
                push_results.push(json!({
                    "eventId": event_id,
                    "status": "conflict",
                    "reason": message.clone(),
                    "message": message,
                    "serverRevision": current_revision.unwrap_or(0)
                }));
                continue;
            }
            let server_revision = self
                .query_one(
                    "SELECT id FROM sync_changelog WHERE event_id = ? LIMIT 1;",
                    vec![json!(event_id)],
                )
                .await?
                .to_objects()
                .into_iter()
                .next()
                .and_then(|row| row.get("id").cloned())
                .and_then(|value| {
                    value
                        .as_i64()
                        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
                })
                .filter(|revision| *revision > 0)
                .ok_or_else(|| {
                    CommandError::new(
                        "TURSO_SYNC_REVISION_INVALID",
                        "The sync event revision could not be determined.",
                    )
                })?;
            push_results.push(json!({
                "eventId": event_id,
                "status": "applied",
                "message": "The event was applied atomically to the Turso database.",
                "serverRevision": server_revision
            }));
        }

        Ok(push_results)
    }

    pub async fn get_master_operators(&self) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let sql = r#"
            SELECT
                m.id, m.kode_operator, m.nama_operator, m.username,
                COALESCE(m.email, '') AS email,
                COALESCE(m.no_hp, '') AS no_hp,
                COALESCE(m.totp_enabled, 0) AS totp_enabled,
                COALESCE(m.role_id, 2) AS role_id,
                COALESCE(m.status, 'Active') AS status,
                COALESCE(r.nama_role, 'Admin') AS nama_role,
                COALESCE(r.role_key, 'admin') AS role_key,
                COALESCE(r.is_superadmin, 0) AS is_superadmin,
                COALESCE(m.created_at, '') AS created_at,
                COALESCE(m.updated_at, '') AS updated_at
            FROM master_operator m
            LEFT JOIN app_role r ON r.id = m.role_id
            ORDER BY m.id ASC;
        "#;
        let res = self.query_one(sql, vec![]).await?;
        let rows: Vec<Value> = res.to_objects().into_iter().map(|m| json!(m)).collect();
        Ok(json!({ "operators": rows }))
    }

    pub async fn create_operator(&self, draft: &Value) -> Result<Value, CommandError> {
        let kode_operator = draft
            .get("kode_operator")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let nama_operator = draft
            .get("nama_operator")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let username = draft
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let password = draft
            .get("password")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let role_id = draft.get("role_id").and_then(Value::as_i64).unwrap_or(2);
        let status = draft
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("Active");
        let email =
            normalize_operator_email(draft.get("email").and_then(Value::as_str).unwrap_or(""));
        let no_hp =
            normalize_operator_phone(draft.get("no_hp").and_then(Value::as_str).unwrap_or(""));

        if kode_operator.is_empty()
            || nama_operator.is_empty()
            || username.is_empty()
            || password.is_empty()
        {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "The operator data is incomplete.",
            ));
        }
        validate_operator_contact(&email, &no_hp)?;

        let password_hash = hash_password_pbkdf2(password);

        // Kolom warisan `role` WAJIB diisi: pada database yang di-provisioning
        // dari Web ia `NOT NULL` dengan CHECK ('Admin','Operator','Scanner') dan
        // tanpa DEFAULT, sehingga INSERT tanpa `role` selalu ditolak. Nilainya
        // diturunkan dari `app_role` agar tetap konsisten dengan RBAC.
        let sql = r#"
            INSERT INTO master_operator (
                kode_operator, nama_operator, username, email, no_hp, password_hash,
                role, role_id, status, created_at, updated_at
            )
            VALUES (
                ?, ?, ?, ?, ?, ?,
                COALESCE((
                    SELECT CASE
                        WHEN r.is_superadmin = 1 THEN 'Admin'
                        WHEN LOWER(r.role_key) = 'admin' THEN 'Admin'
                        WHEN LOWER(r.role_key) = 'scanner' THEN 'Scanner'
                        ELSE 'Operator'
                    END FROM app_role r WHERE r.id = ?
                ), 'Operator'),
                ?, ?, datetime('now'), datetime('now')
            );
        "#;

        let res = self
            .query_one(
                sql,
                vec![
                    json!(kode_operator),
                    json!(nama_operator),
                    json!(username),
                    json!(email),
                    json!(no_hp),
                    json!(password_hash),
                    json!(role_id),
                    json!(role_id),
                    json!(status),
                ],
            )
            .await?;

        let new_id = res.last_insert_rowid.unwrap_or(0);
        Ok(json!({
            "sukses": true,
            "operator": {
                "id": new_id,
                "kode_operator": kode_operator,
                "nama_operator": nama_operator,
                "username": username,
                "email": email,
                "no_hp": no_hp,
                "role_id": role_id,
                "status": status
            }
        }))
    }

    pub async fn update_operator(&self, id: i64, draft: &Value) -> Result<Value, CommandError> {
        let target = self
            .query_one(
                "SELECT r.is_superadmin FROM master_operator m JOIN app_role r ON r.id = m.role_id WHERE m.id = ? LIMIT 1;",
                vec![json!(id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| CommandError::new("VALIDATION_ERROR", "Operator not found."))?;
        if target.get("is_superadmin").and_then(Value::as_i64) == Some(1) {
            if draft.get("status").and_then(Value::as_str) == Some("Inactive") {
                return Err(CommandError::new(
                    "FORBIDDEN",
                    "The last active Superadmin cannot be deactivated.",
                ));
            }
            if let Some(next_role_id) = draft.get("role_id").and_then(Value::as_i64) {
                let next_is_superadmin = self
                    .query_one(
                        "SELECT is_superadmin FROM app_role WHERE id = ? AND status = 'Active' LIMIT 1;",
                        vec![json!(next_role_id)],
                    )
                    .await?
                    .to_objects()
                    .into_iter()
                    .next()
                    .and_then(|row| row.get("is_superadmin").and_then(Value::as_i64))
                    == Some(1);
                if !next_is_superadmin {
                    return Err(CommandError::new(
                        "FORBIDDEN",
                        "The last active Superadmin cannot be moved to another role.",
                    ));
                }
            }
        }
        let mut updates = Vec::new();
        let mut args = Vec::new();

        if let Some(nama) = draft.get("nama_operator").and_then(Value::as_str) {
            updates.push("nama_operator = ?");
            args.push(json!(nama.trim()));
        }
        if let Some(role_id) = draft.get("role_id").and_then(Value::as_i64) {
            updates.push("role_id = ?");
            args.push(json!(role_id));
        }
        if let Some(status) = draft.get("status").and_then(Value::as_str) {
            updates.push("status = ?");
            args.push(json!(status));
        }
        // Kontak hanya divalidasi ketika formulir benar-benar mengirimkannya,
        // supaya pemanggil yang hanya mengubah status/role tidak dipaksa
        // mengirim ulang seluruh data akun. Yang divalidasi selalu hasil
        // GABUNGAN nilai baru dan nilai tersimpan, sehingga akun tidak bisa
        // berakhir dengan email kosong lewat pembaruan sebagian.
        let next_email = draft
            .get("email")
            .and_then(Value::as_str)
            .map(normalize_operator_email);
        let next_phone = draft
            .get("no_hp")
            .and_then(Value::as_str)
            .map(normalize_operator_phone);
        if next_email.is_some() || next_phone.is_some() {
            let stored = self
                .query_one(
                    "SELECT COALESCE(email, '') AS email, COALESCE(no_hp, '') AS no_hp FROM master_operator WHERE id = ? LIMIT 1;",
                    vec![json!(id)],
                )
                .await?
                .to_objects()
                .into_iter()
                .next()
                .unwrap_or_default();
            let email = next_email.clone().unwrap_or_else(|| {
                stored
                    .get("email")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            });
            let phone = next_phone.clone().unwrap_or_else(|| {
                stored
                    .get("no_hp")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            });
            validate_operator_contact(&email, &phone)?;
            if let Some(email) = next_email {
                updates.push("email = ?");
                args.push(json!(email));
            }
            if let Some(phone) = next_phone {
                updates.push("no_hp = ?");
                args.push(json!(phone));
            }
        }
        if let Some(password) = draft.get("password").and_then(Value::as_str) {
            if !password.trim().is_empty() {
                updates.push("password_hash = ?");
                args.push(json!(hash_password_pbkdf2(password.trim())));
            }
        }

        if updates.is_empty() {
            return Ok(json!({ "sukses": true }));
        }

        let now_epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or_default();
        updates.push("updated_at = ?");
        args.push(json!(now_epoch));

        args.push(json!(id));
        let sql = format!(
            "UPDATE master_operator SET {} WHERE id = ?;",
            updates.join(", ")
        );

        self.query_one(&sql, args).await?;
        Ok(json!({ "sukses": true }))
    }

    pub async fn delete_operator(&self, id: i64) -> Result<Value, CommandError> {
        let check_sql = "SELECT is_superadmin FROM app_role r JOIN master_operator m ON m.role_id = r.id WHERE m.id = ?;";
        let check = self.query_one(check_sql, vec![json!(id)]).await?;
        if let Some(row) = check.to_objects().first() {
            if row
                .get("is_superadmin")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
                == 1
            {
                return Err(CommandError::new(
                    "FORBIDDEN",
                    "The main Superadmin account cannot be deleted.",
                ));
            }
        }

        // `password_reset_request` ber-CASCADE ke `master_operator`, jadi DELETE
        // di sini ikut memusnahkan riwayat pengajuan reset beserta foto wajah
        // pemohonnya — bukti audit yang justru paling perlu bertahan. Aturan ini
        // WAJIB sama dengan `removeOperator` di
        // `src/lib/operators/operator-admin.ts`.
        let reset_history = self
            .query_one(
                "SELECT COUNT(*) AS total FROM password_reset_request WHERE operator_id = ?;",
                vec![json!(id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .and_then(|row| row.get("total").and_then(Value::as_i64))
            .unwrap_or(0);
        if reset_history > 0 {
            return Err(CommandError::new(
                "FORBIDDEN",
                "This operator has password reset requests with verification photos. Delete that history first on the Password resets page, or deactivate the account so the audit evidence stays intact.",
            ));
        }

        self.query_one("DELETE FROM master_operator WHERE id = ?;", vec![json!(id)])
            .await?;
        Ok(json!({ "sukses": true }))
    }

    pub async fn get_roles(&self) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let roles_sql = "SELECT id, role_key, nama_role, deskripsi, is_superadmin, status, COALESCE(require_totp, 0) AS require_totp FROM app_role ORDER BY id ASC;";
        let perms_sql = "SELECT role_id, permission_key, is_allowed FROM role_permission;";

        let mut results = self
            .execute_pipeline(vec![
                Statement::new(roles_sql, vec![]),
                Statement::new(perms_sql, vec![]),
            ])
            .await?;

        let perms_res = results.pop().unwrap_or_default();
        let roles_res = results.pop().unwrap_or_default();

        let mut role_perms: HashMap<i64, Vec<String>> = HashMap::new();
        for p in perms_res.to_objects() {
            let r_id = p.get("role_id").and_then(Value::as_i64).unwrap_or(0);
            let is_allowed = p.get("is_allowed").and_then(Value::as_i64).unwrap_or(0) == 1;
            let key = p
                .get("permission_key")
                .and_then(Value::as_str)
                .unwrap_or("");
            if is_allowed && !key.is_empty() {
                role_perms.entry(r_id).or_default().push(key.to_owned());
            }
        }

        let mut roles = Vec::new();
        for r in roles_res.to_objects() {
            let r_id = r.get("id").and_then(Value::as_i64).unwrap_or(0);
            let mut role_obj = json!(r);
            let perms = role_perms.get(&r_id).cloned().unwrap_or_default();
            role_obj["permissions"] = json!(perms);
            roles.push(role_obj);
        }

        Ok(json!({ "roles": roles }))
    }

    pub async fn create_role(&self, draft: &Value) -> Result<Value, CommandError> {
        let role_key = draft
            .get("role_key")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let nama_role = draft
            .get("nama_role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let deskripsi = draft.get("deskripsi").and_then(Value::as_str).unwrap_or("");

        if role_key.is_empty() || nama_role.is_empty() {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "The role data is incomplete.",
            ));
        }
        if role_key.len() > 64
            || !role_key
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || role_key.starts_with('-')
            || role_key.ends_with('-')
        {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "The role key must use lowercase letters, numbers, and hyphens.",
            ));
        }

        let mut statements = vec![Statement::new(
            "INSERT INTO app_role (role_key, nama_role, deskripsi, is_superadmin, status, created_at, updated_at) VALUES (?, ?, ?, 0, 'Active', datetime('now'), datetime('now'));",
            vec![json!(role_key), json!(nama_role), json!(deskripsi)],
        )];
        if let Some(perms) = draft.get("permissions").and_then(Value::as_array) {
            statements.extend(perms
                .iter()
                .filter_map(|p| p.as_str())
                .map(|p_key| {
                    Statement::new(
                        "INSERT OR REPLACE INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by) VALUES ((SELECT id FROM app_role WHERE role_key = ?), ?, 1, datetime('now'), 'system');",
                        vec![json!(role_key), json!(p_key)],
                    )
                }));
        }
        statements.push(Statement::new(
            "INSERT INTO setting_gex_system (key, value) VALUES ('rbac_revision', strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value = strftime('%s','now');",
            vec![],
        ));
        self.execute_atomic(statements).await?;
        let role_id = self
            .query_one(
                "SELECT id FROM app_role WHERE role_key = ? LIMIT 1;",
                vec![json!(role_key)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .and_then(|row| row.get("id").and_then(Value::as_i64))
            .ok_or_else(|| {
                CommandError::new(
                    "TURSO_ROLE_CREATE_FAILED",
                    "The new role was not found after the transaction.",
                )
            })?;
        Ok(json!({ "sukses": true, "role_id": role_id }))
    }

    pub async fn update_role(&self, role_id: i64, draft: &Value) -> Result<Value, CommandError> {
        let target = self
            .query_one(
                "SELECT is_superadmin FROM app_role WHERE id = ? LIMIT 1;",
                vec![json!(role_id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| CommandError::new("VALIDATION_ERROR", "Role not found."))?;
        if target.get("is_superadmin").and_then(Value::as_i64) == Some(1) {
            return Err(CommandError::new(
                "FORBIDDEN",
                "The Superadmin role cannot be changed or deactivated.",
            ));
        }
        let mut updates = Vec::new();
        let mut args = Vec::new();

        if let Some(nama) = draft.get("nama_role").and_then(Value::as_str) {
            updates.push("nama_role = ?");
            args.push(json!(nama.trim()));
        }
        if let Some(deskripsi) = draft.get("deskripsi").and_then(Value::as_str) {
            updates.push("deskripsi = ?");
            args.push(json!(deskripsi));
        }
        if let Some(require_totp) = draft.get("require_totp").and_then(Value::as_bool) {
            updates.push("require_totp = ?");
            args.push(json!(if require_totp { 1 } else { 0 }));
        }

        if !updates.is_empty() {
            updates.push("updated_at = datetime('now')");
            args.push(json!(role_id));
            let sql = format!("UPDATE app_role SET {} WHERE id = ?;", updates.join(", "));
            self.query_one(&sql, args).await?;
        }

        Ok(json!({ "sukses": true }))
    }

    pub async fn set_role_permissions(
        &self,
        role_id: i64,
        permissions: &[String],
    ) -> Result<Value, CommandError> {
        let target = self
            .query_one(
                "SELECT is_superadmin FROM app_role WHERE id = ? LIMIT 1;",
                vec![json!(role_id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| CommandError::new("VALIDATION_ERROR", "Role not found."))?;
        if target.get("is_superadmin").and_then(Value::as_i64) == Some(1) {
            return Err(CommandError::new(
                "FORBIDDEN",
                "Superadmin permissions always follow the active catalog and cannot be reduced.",
            ));
        }
        let available: HashSet<String> = self
            .query_one(
                "SELECT permission_key FROM app_permission WHERE is_active = 1;",
                vec![],
            )
            .await?
            .to_objects()
            .into_iter()
            .filter_map(|row| {
                row.get("permission_key")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect();
        if permissions
            .iter()
            .any(|permission| !available.contains(permission))
        {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "The permission list contains inactive or unknown keys.",
            ));
        }
        let mut stmts = vec![Statement::new(
            "DELETE FROM role_permission WHERE role_id = ?;",
            vec![json!(role_id)],
        )];

        for p_key in permissions {
            stmts.push(Statement::new(
                "INSERT INTO role_permission (role_id, permission_key, is_allowed, updated_at, updated_by) VALUES (?, ?, 1, datetime('now'), 'system');",
                vec![json!(role_id), json!(p_key)],
            ));
        }

        // Bump rbac revision
        stmts.push(Statement::new(
            "INSERT INTO setting_gex_system (key, value) VALUES ('rbac_revision', strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value = strftime('%s','now');",
            vec![],
        ));

        self.execute_atomic(stmts).await?;
        Ok(json!({ "sukses": true }))
    }

    pub async fn delete_role(&self, role_id: i64) -> Result<Value, CommandError> {
        let check = self
            .query_one(
                "SELECT r.is_superadmin, r.is_system, COUNT(m.id) AS operator_count FROM app_role r LEFT JOIN master_operator m ON m.role_id = r.id WHERE r.id = ? GROUP BY r.id;",
                vec![json!(role_id)],
            )
            .await?;
        if let Some(row) = check.to_objects().first() {
            let protected = row.get("is_superadmin").and_then(Value::as_i64) == Some(1)
                || row.get("is_system").and_then(Value::as_i64) == Some(1)
                || row
                    .get("operator_count")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    > 0;
            if protected {
                return Err(CommandError::new(
                    "FORBIDDEN",
                    "System roles and roles still used by operators cannot be deleted.",
                ));
            }
        }

        self.execute_atomic(vec![
            Statement::new(
                "DELETE FROM role_permission WHERE role_id = ?;",
                vec![json!(role_id)],
            ),
            Statement::new("DELETE FROM app_role WHERE id = ?;", vec![json!(role_id)]),
            Statement::new(
                "INSERT INTO setting_gex_system (key, value) VALUES ('rbac_revision', strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value = strftime('%s','now');",
                vec![],
            ),
        ])
        .await?;

        Ok(json!({ "sukses": true }))
    }
}

/// Normalisasi pasangan domain/operation ke bentuk kanonik.
///
/// Ini gerbang tunggal batas cloud: pasangan yang tidak terdaftar di sini
/// DITOLAK sebagai konflik, bukan diam-diam diterima. Alias lama (bentuk
/// `snake_case`) dinormalisasi di sini saja; yang tersimpan ke `sync_changelog`
/// dan `sync_operation_receipt` WAJIB bentuk kanonik hyphen-case.
///
/// Daftar ini WAJIB sama persis dengan `CANONICAL_SYNC_ROUTES` di `sync.rs`.
fn canonical_sync_route(domain: &str, operation: &str) -> Option<(&'static str, &'static str)> {
    let canonical_domain = match domain {
        "client" | "clients" => "client",
        "master-option" | "master_option" => "master-option",
        "setting" | "setting_gex_system" => "setting",
        "company-profile" | "company_profile" => "company-profile",
        "lead-interaction" | "lead_interactions" => "lead-interaction",
        "lead" | "leads" => "lead",
        _ => return None,
    };
    let canonical_operation = match (canonical_domain, operation) {
        ("client", "register") => "register",
        ("client", "update") => "update",
        ("master-option", "upsert") => "upsert",
        ("setting", "update") => "update",
        ("setting", "upsert") => "upsert",
        ("company-profile", "update") => "update",
        ("lead-interaction", "record") => "record",
        ("lead", "reassign") => "reassign",
        _ => return None,
    };
    Some((canonical_domain, canonical_operation))
}

/// Terjemahkan satu event outbox menjadi statement mutasi cloud.
///
/// Seluruh statement dikumpulkan dulu oleh `StatementCollector`, lalu dijalankan
/// dalam satu transaksi `BEGIN IMMEDIATE` bersama penulisan changelog dan
/// receipt. Karena itu fungsi ini TIDAK boleh menulis langsung ke database.
///
/// Aturan yang wajib dipertahankan saat Anda mengganti handler ini:
///
/// - Event yang tidak menghasilkan satu pun statement WAJIB berakhir sebagai
///   konflik, bukan `applied`. Pemanggil sudah menegakkannya lewat
///   `mutations.is_empty()`; jangan menyiasatinya dengan statement kosong.
/// - `entity_key` adalah identitas resmi baris. Field id di dalam payload hanya
///   boleh dipakai sebagai override setelah divalidasi.
/// - Pakai `INSERT ... ON CONFLICT(...) DO UPDATE` supaya push yang terkirim dua
///   kali tidak menggandakan baris.
async fn apply_event_to_turso(
    turso: &StatementCollector,
    domain: &str,
    operation: &str,
    entity_key: &str,
    payload: &Value,
) -> Result<(), CommandError> {
    if !payload.is_object() {
        return Err(CommandError::new(
            "TURSO_SYNC_PAYLOAD_INVALID",
            "The sync event payload must be a JSON object.",
        ));
    }

    let text = |key: &str| -> String {
        payload
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let number = |key: &str| -> i64 {
        payload
            .get(key)
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
            })
            .unwrap_or_default()
    };

    match (domain, operation) {
        ("client", "register" | "update") => {
            // Satu event membawa baris `clients` DAN `leads` supaya registrasi
            // tidak pernah tiba separuh. `client_code`, `created_by`, dan
            // `created_at` tidak pernah berubah setelah registrasi; kolom
            // interaksi lead (`last_*`, `total_followups`) milik F-05 dan tidak
            // ditimpa pengubahan profil dari perangkat lain.
            let lead_id = text("lead_id");
            let name = text("name");
            let phone = text("phone_normalized");
            let code = text("client_code");
            let lifecycle = text("lifecycle_status");
            let valid = !entity_key.is_empty()
                && !lead_id.is_empty()
                && !code.is_empty()
                && name.trim().chars().count() >= clients::CLIENT_NAME_MIN
                && clients::normalize_whatsapp(&phone).as_deref() == Some(phone.as_str())
                && !text("channel_option_id").is_empty()
                && !text("product_category_option_id").is_empty()
                && clients::CLIENT_LIFECYCLE_STATUSES.contains(&lifecycle.as_str());
            if !valid {
                return Err(CommandError::new(
                    "TURSO_SYNC_PAYLOAD_INVALID",
                    "The client payload is incomplete or invalid.",
                ));
            }
            let optional_id = |key: &str| -> Value {
                payload
                    .get(key)
                    .filter(|value| value.is_i64())
                    .cloned()
                    .unwrap_or(Value::Null)
            };
            turso
                .query_one(
                    r#"INSERT INTO clients
                        (id, client_code, name, phone_normalized, address, city, province,
                         lifecycle_status, free_revision_limit, is_white_label, assigned_crm_id,
                         created_by, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET
                         name = excluded.name,
                         phone_normalized = excluded.phone_normalized,
                         address = excluded.address,
                         city = excluded.city,
                         province = excluded.province,
                         lifecycle_status = excluded.lifecycle_status,
                         free_revision_limit = excluded.free_revision_limit,
                         is_white_label = excluded.is_white_label,
                         assigned_crm_id = excluded.assigned_crm_id,
                         updated_at = excluded.updated_at;"#,
                    vec![
                        json!(entity_key),
                        json!(code),
                        json!(name),
                        json!(phone),
                        json!(text("address")),
                        json!(text("city")),
                        json!(text("province")),
                        json!(lifecycle),
                        json!(number("free_revision_limit")),
                        json!(number("is_white_label")),
                        optional_id("assigned_crm_id"),
                        optional_id("created_by"),
                        json!(text("created_at")),
                        json!(text("updated_at")),
                    ],
                )
                .await?;
            turso
                .query_one(
                    r#"INSERT INTO leads
                        (id, client_id, pic_cs_id, channel_option_id, product_category_option_id,
                         needs_notes, last_followup_at, last_client_response_at, total_followups,
                         created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET
                         channel_option_id = excluded.channel_option_id,
                         product_category_option_id = excluded.product_category_option_id,
                         needs_notes = excluded.needs_notes,
                         updated_at = excluded.updated_at;"#,
                    vec![
                        json!(lead_id),
                        json!(entity_key),
                        optional_id("pic_cs_id"),
                        json!(text("channel_option_id")),
                        json!(text("product_category_option_id")),
                        json!(text("needs_notes")),
                        json!(text("last_followup_at")),
                        json!(text("last_client_response_at")),
                        json!(number("total_followups")),
                        json!(text("created_at")),
                        json!(text("updated_at")),
                    ],
                )
                .await?;
        }
        ("master-option", "upsert") => {
            let kind = text("kind");
            let code = text("code");
            let label = text("label");
            let valid = !entity_key.is_empty()
                && clients::MASTER_OPTION_KINDS.contains(&kind.as_str())
                && clients::normalize_option_code(&code).as_deref() == Some(code.as_str())
                && !label.trim().is_empty()
                && label.chars().count() <= clients::OPTION_LABEL_MAX;
            if !valid {
                return Err(CommandError::new(
                    "TURSO_SYNC_PAYLOAD_INVALID",
                    "The master data option is incomplete or invalid.",
                ));
            }
            // `kind` sengaja tidak ikut DO UPDATE: opsi tidak pernah pindah jenis.
            turso
                .query_one(
                    r#"INSERT INTO master_option (id, kind, code, label, is_active, sort_order, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET
                         code = excluded.code,
                         label = excluded.label,
                         is_active = excluded.is_active,
                         sort_order = excluded.sort_order,
                         updated_at = excluded.updated_at;"#,
                    vec![
                        json!(entity_key),
                        json!(kind),
                        json!(code),
                        json!(label),
                        json!(i64::from(number("is_active") != 0)),
                        json!(number("sort_order")),
                        json!(text("updated_at")),
                    ],
                )
                .await?;
        }
        ("lead-interaction", "record") => {
            // Hanya baris interaksi yang dikirim; ringkasan lead diperbarui di
            // sini dengan aturan yang aman diulang, sehingga dua perangkat
            // offline yang mencatat di lead yang sama tidak saling bentrok.
            let lead_id = text("lead_id");
            let direction = text("direction");
            let kind = text("kind");
            let notes = text("notes");
            let occurred_at = text("occurred_at");
            let valid = !entity_key.is_empty()
                && !lead_id.is_empty()
                && clients::LEAD_INTERACTION_DIRECTIONS.contains(&direction.as_str())
                && clients::LEAD_INTERACTION_KINDS.contains(&kind.as_str())
                && !notes.trim().is_empty()
                && notes.chars().count() <= clients::INTERACTION_NOTES_MAX
                // Bentuk kanonik saja: perbandingan `>` di SQL membandingkan teks.
                && clients::parse_stored_timestamp(&occurred_at)
                    .map(clients::utc_timestamp)
                    .as_deref()
                    == Some(occurred_at.as_str());
            if !valid {
                return Err(CommandError::new(
                    "TURSO_SYNC_PAYLOAD_INVALID",
                    "The lead interaction is incomplete or invalid.",
                ));
            }
            let operator_id = payload
                .get("operator_id")
                .filter(|value| value.is_i64())
                .cloned()
                .unwrap_or(Value::Null);
            turso
                .query_one(
                    clients::LEAD_SUMMARY_UPDATE_SQL,
                    vec![json!(direction), json!(occurred_at), json!(lead_id), json!(entity_key)],
                )
                .await?;
            turso
                .query_one(
                    clients::LEAD_INTERACTION_INSERT_SQL,
                    vec![
                        json!(entity_key),
                        json!(lead_id),
                        operator_id,
                        json!(direction),
                        json!(kind),
                        json!(notes),
                        json!(occurred_at),
                        json!(text("created_at")),
                    ],
                )
                .await?;
        }
        ("lead", "reassign") => {
            let pic = payload.get("pic_cs_id").and_then(Value::as_i64).filter(|id| *id > 0);
            let (Some(pic), false) = (pic, entity_key.is_empty()) else {
                return Err(CommandError::new(
                    "TURSO_SYNC_PAYLOAD_INVALID",
                    "The lead reassignment is incomplete or invalid.",
                ));
            };
            turso
                .query_one(
                    "UPDATE leads SET pic_cs_id = ?, updated_at = ? WHERE id = ?;",
                    vec![json!(pic), json!(text("updated_at")), json!(entity_key)],
                )
                .await?;
        }
        ("setting", "update" | "upsert") => {
            if entity_key.is_empty() {
                return Err(CommandError::new(
                    "TURSO_SYNC_PAYLOAD_INVALID",
                    "A setting must include a key.",
                ));
            }
            turso
                .query_one(
                    r#"INSERT INTO setting_gex_system (key, value) VALUES (?, ?)
                       ON CONFLICT(key) DO UPDATE SET value = excluded.value;"#,
                    vec![json!(entity_key), json!(text("value"))],
                )
                .await?;
        }
        ("company-profile", "update") => {
            // Baris tunggal: `entity_key` selalu 'default_company', dan
            // ON CONFLICT membuat push yang terkirim dua kali tidak pernah
            // menggandakan baris. Nama kosong ditolak, bukan disimpan kosong —
            // nilai itu muncul di kop setiap dokumen yang dicetak aplikasi.
            let company_name = text("company_name");
            if company_name.trim().is_empty() {
                return Err(CommandError::new(
                    "TURSO_SYNC_PAYLOAD_INVALID",
                    "The company name is required.",
                ));
            }
            let optional = |key: &str| -> Value {
                let value = text(key);
                if value.trim().is_empty() {
                    Value::Null
                } else {
                    json!(value)
                }
            };
            let timezone = text("timezone");
            let timezone = if timezone.trim().is_empty() {
                "Asia/Jakarta".to_owned()
            } else {
                timezone
            };
            turso
                .query_one(
                    r#"INSERT INTO company_profile
                        (id, company_name, branch_name, logo_url, signature_url,
                         address, phone, email, website,
                         leader_name, leader_title, timezone, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                       ON CONFLICT(id) DO UPDATE SET
                         company_name = excluded.company_name,
                         branch_name = excluded.branch_name,
                         logo_url = excluded.logo_url,
                         signature_url = excluded.signature_url,
                         address = excluded.address,
                         phone = excluded.phone,
                         email = excluded.email,
                         website = excluded.website,
                         leader_name = excluded.leader_name,
                         leader_title = excluded.leader_title,
                         timezone = excluded.timezone,
                         updated_at = excluded.updated_at;"#,
                    vec![
                        json!(if entity_key.is_empty() {
                            "default_company"
                        } else {
                            entity_key
                        }),
                        json!(company_name),
                        optional("branch_name"),
                        optional("logo_url"),
                        optional("signature_url"),
                        optional("address"),
                        optional("phone"),
                        optional("email"),
                        optional("website"),
                        optional("leader_name"),
                        optional("leader_title"),
                        json!(timezone),
                    ],
                )
                .await?;
        }
        _ => {
            return Err(CommandError::new(
                "TURSO_SYNC_ROUTE_UNSUPPORTED",
                format!("Unsupported sync route: {domain}/{operation}."),
            ));
        }
    }

    Ok(())
}

/// `idx_master_operator_email` memakai `LOWER(email)`.
///
/// Cerminan Rust dari `src/lib/operators/contact.ts`. Kedua sisi menulis ke
/// kolom yang sama, jadi aturan yang berbeda akan membuat satu operator
/// tersimpan dalam dua bentuk dan pencarian "Lupa Password" gagal menemukannya.
pub fn normalize_operator_email(value: &str) -> String {
    value.trim().to_lowercase()
}

/// Normalisasi nomor HP Indonesia ke bentuk kanonik `+62…`.
pub fn normalize_operator_phone(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|character| character.is_ascii_digit() || *character == '+')
        .collect();
    if cleaned.is_empty() {
        return String::new();
    }
    let had_plus = cleaned.starts_with('+');
    let bare: String = cleaned.chars().filter(char::is_ascii_digit).collect();
    if bare.is_empty() {
        return String::new();
    }
    if let Some(rest) = bare.strip_prefix("62") {
        return format!("+62{rest}");
    }
    if let Some(rest) = bare.strip_prefix('0') {
        return format!("+62{rest}");
    }
    if bare.starts_with('8') {
        return format!("+62{bare}");
    }
    if had_plus {
        return format!("+{bare}");
    }
    String::new()
}

pub fn is_valid_operator_email(value: &str) -> bool {
    let email = normalize_operator_email(value);
    if email.is_empty() || email.len() > 120 || email.chars().any(char::is_whitespace) {
        return false;
    }
    let mut parts = email.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains("..")
}

pub fn is_valid_operator_phone(value: &str) -> bool {
    let phone = normalize_operator_phone(value);
    let digits = phone.trim_start_matches('+');
    phone.starts_with('+') && (9..=15).contains(&digits.len())
}

/// Email dan nomor HP wajib pada setiap akun operator: email adalah satu-satunya
/// jalur pengiriman link "Lupa Password".
pub fn validate_operator_contact(email: &str, phone: &str) -> Result<(), CommandError> {
    if !is_valid_operator_email(email) {
        return Err(CommandError::new(
            "VALIDATION_ERROR",
            "Enter a valid operator email.",
        ));
    }
    if !is_valid_operator_phone(phone) {
        return Err(CommandError::new(
            "VALIDATION_ERROR",
            "The operator phone number is required. Use the format 08xxxxxxxxxx or +62xxxxxxxxxx.",
        ));
    }
    Ok(())
}

/// Menyamarkan email untuk layar "Lupa Password" yang terbuka tanpa login.
pub fn mask_operator_email(value: &str) -> String {
    let email = normalize_operator_email(value);
    let Some(at) = email.rfind('@') else {
        return String::new();
    };
    if at == 0 {
        return String::new();
    }
    let local = &email[..at];
    let domain = &email[at + 1..];
    let head: String = local.chars().take(1).collect();
    let tail: String = if local.chars().count() > 2 {
        local.chars().rev().take(1).collect()
    } else {
        String::new()
    };
    let hidden = local
        .chars()
        .count()
        .saturating_sub(head.chars().count() + tail.chars().count())
        .max(2);
    let masked_domain = match domain.find('.') {
        Some(dot) if dot > 1 => format!(
            "{}{}{}",
            &domain[..1],
            "*".repeat(dot - 1),
            &domain[dot..]
        ),
        _ => domain.to_string(),
    };
    format!("{head}{}{tail}@{masked_domain}", "*".repeat(hidden))
}

/// Menyamarkan nomor HP: hanya awalan negara dan empat digit terakhir.
pub fn mask_operator_phone(value: &str) -> String {
    let phone = normalize_operator_phone(value);
    if phone.is_empty() {
        return String::new();
    }
    let digits = &phone[1..];
    if digits.len() <= 4 {
        return format!("+{}", "*".repeat(digits.len()));
    }
    format!(
        "+{}{}{}",
        &digits[..2],
        "*".repeat(digits.len() - 6),
        &digits[digits.len() - 4..]
    )
}

/// Langkah waktu TOTP (RFC 6238). WAJIB sama dengan TOTP_STEP_SECONDS di
/// src/lib/security/totp.ts.
/// Data 2FA satu operator, dibaca sekali lalu dipakai beberapa pemeriksaan.
struct OperatorTotp {
    secret: String,
    enabled: bool,
    confirmed_at: String,
    recovery_codes: Vec<String>,
    username: String,
    require_totp: bool,
}

/// Meng-escape label otpauth seperlunya. Label hanya berisi nama aplikasi dan
/// username operator, jadi cukup menangani karakter yang merusak URI.
fn urlencoding_minimal(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            ' ' => "%20".to_string(),
            ':' => "%3A".to_string(),
            '/' => "%2F".to_string(),
            '?' => "%3F".to_string(),
            '#' => "%23".to_string(),
            '&' => "%26".to_string(),
            other => other.to_string(),
        })
        .collect()
}

const TOTP_STEP_SECONDS: i64 = 30;
const TOTP_DIGITS: u32 = 6;
/// Toleransi langkah waktu saat verifikasi. Sempit ketika waktunya diambil dari
/// jam server database; lebar ketika terpaksa memakai jam perangkat.
pub const TOTP_WINDOW_ONLINE: i64 = 1;

const BASE32_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// Membaca base32 dengan memaafkan bentuk yang biasa diketik manusia: spasi,
/// tanda hubung, huruf kecil, dan padding `=`.
pub fn decode_base32(value: &str) -> Option<Vec<u8>> {
    let mut bits: u32 = 0;
    let mut accumulator: u32 = 0;
    let mut output = Vec::new();
    for character in value.chars() {
        if character == ' ' || character == '-' || character == '=' {
            continue;
        }
        let upper = character.to_ascii_uppercase() as u8;
        let index = BASE32_ALPHABET.iter().position(|item| *item == upper)?;
        accumulator = (accumulator << 5) | index as u32;
        bits += 5;
        if bits >= 8 {
            output.push(((accumulator >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    Some(output)
}

pub fn encode_base32(bytes: &[u8]) -> String {
    let mut bits: u32 = 0;
    let mut value: u32 = 0;
    let mut output = String::new();
    for byte in bytes {
        value = (value << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            output.push(BASE32_ALPHABET[((value >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        output.push(BASE32_ALPHABET[((value << (5 - bits)) & 31) as usize] as char);
    }
    output
}

/// HOTP (RFC 4226): HMAC-SHA1 dari pencacah, lalu pemotongan dinamis 6 digit.
pub fn generate_hotp(secret_base32: &str, counter: u64) -> Option<String> {
    use hmac::{Hmac, Mac};
    use sha1::Sha1;

    let key = decode_base32(secret_base32)?;
    if key.is_empty() {
        return None;
    }
    let mut mac = Hmac::<Sha1>::new_from_slice(&key).ok()?;
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = (u32::from(digest[offset] & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);
    let modulo = 10u32.pow(TOTP_DIGITS);
    Some(format!(
        "{:0width$}",
        binary % modulo,
        width = TOTP_DIGITS as usize
    ))
}

/// Pasangan penghasil kode untuk `verify_totp`. Produksi hanya memverifikasi,
/// tetapi vektor uji RFC 6238 menuntut sisi penghasilnya juga dibuktikan benar.
#[allow(dead_code)]
pub fn generate_totp(secret_base32: &str, unix_seconds: i64) -> Option<String> {
    let counter = unix_seconds.div_euclid(TOTP_STEP_SECONDS);
    if counter < 0 {
        return None;
    }
    generate_hotp(secret_base32, counter as u64)
}

/// Memverifikasi kode terhadap jendela langkah waktu di sekitar `unix_seconds`.
///
/// Seluruh jendela selalu ditelusuri sampai habis, tanpa keluar lebih awal saat
/// menemukan kecocokan, supaya lama pemrosesan tidak membocorkan posisi
/// langkah waktu yang cocok.
pub fn verify_totp(secret_base32: &str, code: &str, unix_seconds: i64, window: i64) -> bool {
    let clean: String = code.chars().filter(char::is_ascii_digit).collect();
    if clean.len() != TOTP_DIGITS as usize {
        return false;
    }
    let center = unix_seconds.div_euclid(TOTP_STEP_SECONDS);
    let mut matched = false;
    for offset in -window..=window {
        let counter = center + offset;
        if counter < 0 {
            continue;
        }
        if let Some(expected) = generate_hotp(secret_base32, counter as u64) {
            // Perbandingan waktu-tetap: panjangnya selalu sama enam digit.
            let mut difference: u8 = 0;
            for (left, right) in expected.bytes().zip(clean.bytes()) {
                difference |= left ^ right;
            }
            if difference == 0 {
                matched = true;
            }
        }
    }
    matched
}

/// Rahasia TOTP acak 20 byte, dikembalikan dalam base32.
pub fn generate_totp_secret() -> String {
    use rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 20];
    OsRng.fill_bytes(&mut bytes);
    encode_base32(&bytes)
}

/// Kode cadangan sekali pakai untuk operator yang kehilangan ponselnya.
///
/// Alfabetnya membuang karakter yang mudah tertukar saat disalin tangan
/// (O, I, 0, 1), karena kode ini memang dimaksudkan untuk dicatat di kertas.
pub fn generate_recovery_codes(count: usize) -> Vec<String> {
    use rand_core::{OsRng, RngCore};
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    (0..count)
        .map(|_| {
            let mut bytes = [0u8; 8];
            OsRng.fill_bytes(&mut bytes);
            let raw: String = bytes
                .iter()
                .map(|byte| ALPHABET[(*byte as usize) % ALPHABET.len()] as char)
                .collect();
            format!("{}-{}", &raw[0..4], &raw[4..8])
        })
        .collect()
}

pub fn normalize_recovery_code(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_uppercase()
}

/// Kegagalan pengiriman email: pesan aman untuk pemohon, dan penjelasan apa
/// adanya dari penyedia untuk pemegang izin.
struct MailFailure {
    message: String,
    detail: String,
}

const RESET_MAX_CHALLENGE_SWAPS: i64 = 2;
const RESET_CHALLENGE_TTL_MINUTES: i64 = 15;
/// Umur token reset setelah email terkirim (menit).
const RESET_TOKEN_TTL_MINUTES: i64 = 30;
/// Ambang skor liveness. WAJIB sama dengan LIVENESS_MIN_SCORE di
/// src/lib/security/face-liveness.ts.
const RESET_LIVENESS_MIN_SCORE: f64 = 0.7;
/// Batas ukuran foto bukti dalam base64.
const RESET_PHOTO_MAX_LEN: usize = 900_000;

/// Token acak 32 byte, base64url tanpa padding. Yang disimpan hanya hash
/// SHA-256-nya, sama seperti `hashSessionToken` di sisi TypeScript.
fn random_reset_token() -> String {
    use rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    BASE64_URL_SAFE_NO_PAD.encode(bytes)
}

fn random_request_id() -> String {
    use rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

/// Memilih urutan tantangan liveness secara acak di sisi server.
///
/// Urutan ini disimpan di database dan tidak pernah bisa ditebak klien, jadi
/// rekaman verifikasi lama tidak bisa dipakai ulang untuk permintaan baru.
fn pick_reset_challenges() -> Vec<String> {
    use rand_core::{OsRng, RngCore};
    let mut pool = vec![
        "KEDIP".to_string(),
        "TENGOK_KIRI".to_string(),
        "TENGOK_KANAN".to_string(),
        "DEKATKAN_WAJAH".to_string(),
        "JAUHKAN_WAJAH".to_string(),
    ];
    let mut picked = Vec::with_capacity(3);
    for _ in 0..3 {
        if pool.is_empty() {
            break;
        }
        let index = (OsRng.next_u32() as usize) % pool.len();
        picked.push(pool.remove(index));
    }
    picked
}

/// Membaca `liveness_report` menjadi alasan + daftar tantangan.
///
/// Kolom itu ditulis dua penulis berbeda — TypeScript menyimpan vonis lengkap,
/// Rust menyimpan vonis yang dikirim aplikasi — jadi pembacanya harus
/// memaafkan bentuk yang tidak dikenal. Riwayat tetap berguna walau satu baris
/// lamanya tidak bisa diurai.
fn parse_liveness_report(raw: &str) -> (String, Vec<String>) {
    let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
        return (String::new(), Vec::new());
    };
    let reason = parsed
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let challenges = parsed
        .get("challenges")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.as_str()
                        .map(str::to_string)
                        .or_else(|| {
                            item.get("challenge")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                })
                .collect()
        })
        .unwrap_or_default();
    (reason, challenges)
}

fn reset_error(message: impl Into<String>) -> CommandError {
    CommandError::new("PASSWORD_RESET_REJECTED", message)
}

/// Kekuatan password baru. Cerminan `validatePasswordStrength` di
/// `src/lib/auth/password.ts` supaya aturan yang sama berlaku di kedua jalur.
fn validate_new_password(password: &str) -> Result<(), CommandError> {
    if password.chars().count() < 12 {
        return Err(reset_error("The password needs at least 12 characters."));
    }
    if !password.chars().any(char::is_lowercase) || !password.chars().any(char::is_uppercase) {
        return Err(reset_error(
            "The password must have lowercase and uppercase letters.",
        ));
    }
    if !password.chars().any(|item| item.is_ascii_digit()) {
        return Err(reset_error("The password must have a number."));
    }
    Ok(())
}

impl TursoClient {
    /// Mencari akun yang boleh dipulihkan dari username, kode operator, atau email.
    async fn find_reset_operator(
        &self,
        identifier: &str,
    ) -> Result<Option<HashMap<String, Value>>, CommandError> {
        let clean = identifier.trim();
        if clean.len() < 3 || clean.len() > 120 {
            return Ok(None);
        }
        let email = normalize_operator_email(clean);
        let sql = r#"
            SELECT m.id, m.nama_operator, m.kode_operator, m.username,
                   COALESCE(m.email, '') AS email, COALESCE(m.no_hp, '') AS no_hp
            FROM master_operator m
            JOIN app_role r ON r.id = m.role_id
            WHERE (
                m.username = ? COLLATE NOCASE
                OR m.kode_operator = ? COLLATE NOCASE
                OR LOWER(COALESCE(m.email, '')) = ?
            )
            AND m.status = 'Active' AND r.status = 'Active'
            LIMIT 1;
        "#;
        Ok(self
            .query_one(sql, vec![json!(clean), json!(clean), json!(email)])
            .await?
            .to_objects()
            .into_iter()
            .next())
    }

    fn require_recoverable(
        operator: Option<HashMap<String, Value>>,
    ) -> Result<HashMap<String, Value>, CommandError> {
        let row = operator.ok_or_else(|| {
            reset_error("No account with that username or email was found.")
        })?;
        let email = row
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if email.is_empty() {
            return Err(reset_error(
                "This account has no registered email, so a reset link cannot be sent. Ask an Admin to complete the account details.",
            ));
        }
        Ok(row)
    }

    /// Riwayat pengajuan "Lupa Password" untuk peninjauan manusia.
    ///
    /// `photo_base64` sengaja TIDAK ikut di-select: satu foto sekitar 40 KB dan
    /// seratus baris akan mengirim puluhan megabyte lewat IPC setiap kali
    /// halaman dibuka. Foto diambil per baris lewat `get_password_reset_photo`
    /// hanya ketika benar-benar dibuka.
    pub async fn list_password_reset_history(
        &self,
        status: &str,
        search: &str,
        limit: i64,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let mut conditions: Vec<String> = Vec::new();
        let mut args: Vec<Value> = Vec::new();

        if !status.is_empty() && status != "ALL" {
            conditions.push("p.status = ?".to_string());
            args.push(json!(status));
        }
        let search = search.trim();
        if !search.is_empty() {
            conditions.push(
                "(m.nama_operator LIKE ? COLLATE NOCASE OR m.username LIKE ? COLLATE NOCASE \
                 OR m.kode_operator LIKE ? COLLATE NOCASE OR p.identifier_used LIKE ? COLLATE NOCASE)"
                    .to_string(),
            );
            let like = format!("%{}%", search.chars().take(60).collect::<String>());
            for _ in 0..4 {
                args.push(json!(like));
            }
        }
        let limit = limit.clamp(1, 500);
        args.push(json!(limit));

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };
        let sql = format!(
            r#"SELECT
                p.id, p.operator_id, p.identifier_used, p.contact_target, p.status,
                p.liveness_score, p.liveness_report, p.delivery_status, p.delivery_error,
                p.requested_at, p.verified_at, p.sent_at, p.used_at, p.expires_at,
                CASE WHEN p.photo_base64 IS NOT NULL AND TRIM(p.photo_base64) <> '' THEN 1 ELSE 0 END AS has_photo,
                m.nama_operator, m.username, m.kode_operator
               FROM password_reset_request p
               JOIN master_operator m ON m.id = p.operator_id
               {where_clause}
               ORDER BY p.requested_at DESC
               LIMIT ?;"#
        );

        let rows = self.query_one(sql, args).await?.to_objects();
        let entries: Vec<Value> = rows
            .into_iter()
            .map(|row| {
                let text = |key: &str| {
                    row.get(key)
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                };
                let (reason, challenges) = parse_liveness_report(&text("liveness_report"));
                json!({
                    "id": text("id"),
                    "operatorId": row.get("operator_id").and_then(Value::as_i64).unwrap_or(0),
                    "operatorName": text("nama_operator"),
                    "username": text("username"),
                    "kodeOperator": text("kode_operator"),
                    "identifierUsed": text("identifier_used"),
                    "maskedEmail": mask_operator_email(&text("contact_target")),
                    "status": text("status"),
                    "livenessScore": row.get("liveness_score").and_then(Value::as_f64),
                    "livenessReason": reason,
                    "livenessChallenges": challenges,
                    "deliveryStatus": text("delivery_status"),
                    "deliveryError": text("delivery_error"),
                    "hasPhoto": row.get("has_photo").and_then(Value::as_i64).unwrap_or(0) == 1,
                    "requestedAt": text("requested_at"),
                    "verifiedAt": text("verified_at"),
                    "sentAt": text("sent_at"),
                    "usedAt": text("used_at"),
                    "expiresAt": text("expires_at"),
                })
            })
            .collect();
        Ok(json!({ "entries": entries }))
    }

    pub async fn get_password_reset_photo(&self, request_id: &str) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let id = request_id.trim();
        if id.is_empty() || id.len() > 64 {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Invalid request ID.",
            ));
        }
        let row = self
            .query_one(
                "SELECT COALESCE(photo_mime, '') AS photo_mime, COALESCE(photo_base64, '') AS photo_base64 FROM password_reset_request WHERE id = ? LIMIT 1;",
                vec![json!(id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| CommandError::new("NOT_FOUND", "Request not found."))?;
        let base64 = row
            .get("photo_base64")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if base64.is_empty() {
            return Err(CommandError::new(
                "NOT_FOUND",
                "This request has no verification photo.",
            ));
        }
        let mime = row
            .get("photo_mime")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        Ok(json!({
            "photo": {
                "mime": if mime.is_empty() { "image/jpeg".to_string() } else { mime },
                "base64": base64,
            }
        }))
    }

    pub async fn delete_password_reset_history(
        &self,
        request_id: &str,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let id = request_id.trim();
        if id.is_empty() || id.len() > 64 {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Invalid request ID.",
            ));
        }
        let result = self
            .query_one(
                "DELETE FROM password_reset_request WHERE id = ?;",
                vec![json!(id)],
            )
            .await?;
        if result.rows_affected == 0 {
            return Err(CommandError::new(
                "NOT_FOUND",
                "The history was not found or has already been deleted.",
            ));
        }
        Ok(json!({ "sukses": true, "deleted": 1 }))
    }

    /// Membersihkan riwayat yang sudah selesai dan lebih tua dari `days` hari.
    ///
    /// Baris `Terkirim` dan `Menunggu Verifikasi` sengaja dilewati: membersihkan
    /// arsip tidak boleh memutus pemulihan yang sedang berjalan.
    pub async fn purge_password_reset_history(&self, days: i64) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        if !(1..=3650).contains(&days) {
            return Err(CommandError::new(
                "VALIDATION_ERROR",
                "Invalid cleanup day range.",
            ));
        }
        let result = self
            .query_one(
                "DELETE FROM password_reset_request WHERE status IN ('Used', 'Expired', 'Cancelled') AND requested_at <= datetime('now', ?);",
                vec![json!(format!("-{days} days"))],
            )
            .await?;
        Ok(json!({ "sukses": true, "deleted": result.rows_affected }))
    }

    /// Langkah 1: identitas tersamar untuk dikonfirmasi pemohon.

    pub async fn password_reset_lookup(&self, identifier: &str) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = Self::require_recoverable(self.find_reset_operator(identifier).await?)?;
        let text = |key: &str| {
            row.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        Ok(json!({
            "account": {
                "name": text("nama_operator"),
                "kode_operator": text("kode_operator"),
                "username": text("username"),
                "masked_email": mask_operator_email(&text("email")),
                "masked_phone": mask_operator_phone(&text("no_hp")),
            }
        }))
    }

    /// Langkah 2: identitas diketik ulang, lalu tantangan liveness diterbitkan.
    pub async fn password_reset_confirm(
        &self,
        identifier: &str,
        confirmation: &str,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = Self::require_recoverable(self.find_reset_operator(identifier).await?)?;
        let operator_id = row.get("id").and_then(Value::as_i64).unwrap_or(0);
        let confirmed = self.find_reset_operator(confirmation).await?;
        let matches = confirmed
            .as_ref()
            .and_then(|item| item.get("id"))
            .and_then(Value::as_i64)
            == Some(operator_id);
        if !matches {
            return Err(reset_error(
                "The confirmed username or email does not match the selected account.",
            ));
        }
        let email = row
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        // Satu akun hanya boleh punya satu permintaan hidup, supaya token lama
        // tidak ikut berlaku setelah permintaan baru dibuat.
        self.query_one(
            "UPDATE password_reset_request SET status = 'Cancelled' WHERE operator_id = ? AND status IN ('Pending Verification', 'Sent');",
            vec![json!(operator_id)],
        )
        .await?;

        let challenges = pick_reset_challenges();
        let challenge_token = random_reset_token();
        let request_id = random_request_id();
        let sql = format!(
            r#"INSERT INTO password_reset_request (
                id, operator_id, identifier_used, contact_channel, contact_target,
                challenge_hash, challenge_sequence, status, requested_at, expires_at
            ) VALUES (?, ?, ?, 'email', ?, ?, ?, 'Pending Verification', datetime('now'), datetime('now', '+{RESET_CHALLENGE_TTL_MINUTES} minutes'));"#
        );
        self.query_one(
            sql,
            vec![
                json!(request_id),
                json!(operator_id),
                json!(identifier.trim().chars().take(120).collect::<String>()),
                json!(email),
                json!(sha256_hex(&challenge_token)),
                json!(serde_json::to_string(&challenges).unwrap_or_else(|_| "[]".to_string())),
            ],
        )
        .await?;

        let expires_at = self
            .query_one(
                "SELECT expires_at FROM password_reset_request WHERE id = ? LIMIT 1;",
                vec![json!(request_id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .and_then(|item| item.get("expires_at").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();

        Ok(json!({
            "challenge": {
                "request_id": request_id,
                "challenge_token": challenge_token,
                "challenges": challenges,
                "masked_email": mask_operator_email(&email),
                "expires_at": expires_at,
            }
        }))
    }

    /// Mengganti satu tantangan yang tidak pernah terbaca kamera pemohon.
    ///
    /// Deteksi kedipan bergantung pada beberapa piksel pita mata; pada kamera
    /// kelas bawah, ruang redup, atau wajah berkacamata, tantangan itu bisa
    /// memang tidak pernah terbaca — dan tanpa jalan keluar, pemiliknya
    /// terkunci selamanya dari akunnya sendiri. Penggantinya tetap dipilih
    /// server, tetap acak, dan jumlahnya dibatasi supaya ini bukan cara memilih
    /// tantangan termudah.
    pub async fn password_reset_swap_challenge(
        &self,
        request_id: &str,
        challenge_token: &str,
        step_index: i64,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self
            .query_one(
                r#"SELECT p.id, p.challenge_sequence, p.status, p.liveness_report,
                          CASE WHEN p.expires_at <= datetime('now') THEN 1 ELSE 0 END AS is_expired
                   FROM password_reset_request p
                   WHERE p.id = ? AND p.challenge_hash = ? LIMIT 1;"#,
                vec![json!(request_id), json!(sha256_hex(challenge_token))],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| reset_error("Verification session not found."))?;

        if row.get("status").and_then(Value::as_str) != Some("Pending Verification") {
            return Err(reset_error(
                "This verification session is no longer valid. Start over.",
            ));
        }
        if row.get("is_expired").and_then(Value::as_i64) == Some(1) {
            return Err(reset_error(
                "Verification time ran out. Start the request over.",
            ));
        }

        let mut challenges: Vec<String> = serde_json::from_str(
            row.get("challenge_sequence")
                .and_then(Value::as_str)
                .unwrap_or("[]"),
        )
        .unwrap_or_default();
        if step_index < 0 || step_index as usize >= challenges.len() {
            return Err(reset_error("Unknown challenge step."));
        }

        let report: Value = serde_json::from_str(
            row.get("liveness_report")
                .and_then(Value::as_str)
                .unwrap_or("{}"),
        )
        .unwrap_or_else(|_| json!({}));
        let attempts = report.get("attempts").and_then(Value::as_i64).unwrap_or(0);
        let swaps = report.get("swaps").and_then(Value::as_i64).unwrap_or(0);
        if swaps >= RESET_MAX_CHALLENGE_SWAPS {
            return Err(reset_error(format!(
                "The challenge swap limit ({RESET_MAX_CHALLENGE_SWAPS}) was reached. Start the request over somewhere brighter."
            )));
        }

        let alternatives: Vec<String> = [
            "KEDIP",
            "TENGOK_KIRI",
            "TENGOK_KANAN",
            "DEKATKAN_WAJAH",
            "JAUHKAN_WAJAH",
        ]
        .into_iter()
        .filter(|item| !challenges.iter().any(|used| used == item))
        .map(str::to_string)
        .collect();
        if alternatives.is_empty() {
            return Err(reset_error("No replacement challenges are left."));
        }
        let pick = {
            use rand_core::{OsRng, RngCore};
            (OsRng.next_u32() as usize) % alternatives.len()
        };
        challenges[step_index as usize] = alternatives[pick].clone();

        self.query_one(
            "UPDATE password_reset_request SET challenge_sequence = ?, liveness_report = ? WHERE id = ? AND status = 'Pending Verification';",
            vec![
                json!(serde_json::to_string(&challenges).unwrap_or_else(|_| "[]".to_string())),
                json!(json!({ "attempts": attempts, "swaps": swaps + 1 }).to_string()),
                json!(request_id),
            ],
        )
        .await?;

        Ok(json!({ "challenges": challenges }))
    }

    /// Langkah 3: menerima vonis liveness, lalu mengirim link reset.

    ///
    /// Yang diperiksa di sini bukan piksel — analisisnya berjalan di aplikasi
    /// memakai modul TypeScript yang sama dengan Web — melainkan hal yang hanya
    /// diketahui database: urutan tantangan acak yang diterbitkan pada langkah
    /// sebelumnya, umur permintaan, dan status barisnya. Rekaman lama atau
    /// vonis untuk urutan tantangan yang berbeda ditolak di sini.
    /// Jalur penyerahan token pemulihan yang berlaku pada instalasi ini.
    ///
    /// Mode Database Lokal tidak punya jaringan sama sekali, sehingga
    /// pengiriman email SELALU gagal di sana — dan kegagalan itu membatalkan
    /// permintaannya, membuat fitur "Lupa Password" mati total. Karena itu
    /// jalurnya tidak boleh mengasumsikan jaringan, dengan alasan yang sama
    /// yang membuat verifikasi dua langkah memakai TOTP alih-alih penyedia
    /// identitas pihak ketiga.
    ///
    /// Bawaannya DITENTUKAN OTOMATIS, bukan dipaksakan: instalasi yang sudah
    /// mengaktifkan email tetap memakai email setelah pembaruan, sisanya —
    /// termasuk seluruh pemasangan mode lokal — memakai persetujuan di
    /// aplikasi. Nilai eksplisit di `setting_gex_system` mengalahkan keduanya.
    /// Jumlah kode pemulihan yang diterbitkan sekali jalan.
    ///
    /// Cukup banyak untuk bertahan bertahun-tahun bagi akun yang jarang lupa,
    /// tetapi masih muat dicetak pada selembar kertas dan disimpan di brankas.
    const RECOVERY_CODE_COUNT: usize = 8;

    /// Terbitkan ulang kode pemulihan password untuk sebuah akun.
    ///
    /// Yang tersimpan hanya hash SHA-256-nya, sama seperti kode cadangan 2FA.
    /// Bentuk aslinya dikembalikan SEKALI dan tidak pernah bisa dibaca lagi —
    /// karena itu pemanggil wajib menampilkannya sampai pengguna menyatakan
    /// sudah menyimpannya.
    ///
    /// Menerbitkan ulang MENGGANTI seluruh kode lama: daftar yang sebagiannya
    /// sudah tercetak di kertas lama tidak boleh tetap berlaku bersamaan dengan
    /// yang baru.
    pub async fn issue_password_recovery_codes(
        &self,
        operator_id: i64,
    ) -> Result<Vec<String>, CommandError> {
        let codes = generate_recovery_codes(Self::RECOVERY_CODE_COUNT);
        let hashes: Vec<String> = codes
            .iter()
            .map(|code| sha256_hex(&normalize_recovery_code(code)))
            .collect();

        self.query_one(
            "UPDATE master_operator SET password_recovery_codes = ?, password_recovery_created_at = datetime('now') WHERE id = ?;",
            vec![
                json!(serde_json::to_string(&hashes).unwrap_or_else(|_| "[]".to_string())),
                json!(operator_id),
            ],
        )
        .await?;

        Ok(codes)
    }

    /// Masuk kembali memakai kode pemulihan, lalu setel password baru.
    ///
    /// Inilah satu-satunya jalan pulih bagi Superadmin pada pemasangan tanpa
    /// jaringan: tidak ada email yang bisa dikirim, dan tidak ada Superadmin
    /// lain yang bisa menyetujui permintaannya.
    ///
    /// Kode yang dipakai LANGSUNG DIHAPUS, bahkan bila langkah berikutnya
    /// gagal — kode sekali pakai yang masih hidup setelah dipakai bukan lagi
    /// kode sekali pakai. Verifikasinya memakai perbandingan hash, sehingga
    /// database tidak pernah memegang bentuk aslinya.
    pub async fn password_recovery_with_code(
        &self,
        identifier: &str,
        code: &str,
        new_password: &str,
    ) -> Result<Value, CommandError> {
        let identifier = identifier.trim();
        if identifier.is_empty() {
            return Err(CommandError::new(
                "RECOVERY_REJECTED",
                "Enter a username or operator code.",
            ));
        }
        if new_password.chars().count() < 8 {
            return Err(CommandError::new(
                "RECOVERY_PASSWORD_WEAK",
                "The new password needs at least 8 characters.",
            ));
        }

        let normalized = normalize_recovery_code(code);
        if normalized.is_empty() {
            return Err(CommandError::new(
                "RECOVERY_REJECTED",
                "Enter a recovery code.",
            ));
        }

        let row = self
            .query_one(
                r#"SELECT m.id, COALESCE(m.password_recovery_codes, '[]') AS kode,
                          COALESCE(m.nama_operator, '') AS nama_operator
                   FROM master_operator m
                   JOIN app_role r ON r.id = m.role_id
                   WHERE (m.username = ? COLLATE NOCASE OR m.kode_operator = ? COLLATE NOCASE)
                     AND m.status = 'Active' AND r.status = 'Active'
                   LIMIT 1;"#,
                vec![json!(identifier), json!(identifier)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next();

        // Akun yang tidak ada dan kode yang salah dijawab SAMA. Membedakannya
        // akan mengubah layar ini menjadi alat memetakan akun mana yang ada.
        let ditolak = || {
            CommandError::new(
                "RECOVERY_REJECTED",
                "The recovery code is wrong, or it has already been used.",
            )
        };

        let Some(row) = row else {
            return Err(ditolak());
        };
        let operator_id = row.get("id").and_then(Value::as_i64).unwrap_or(0);
        let stored: Vec<String> = row
            .get("kode")
            .and_then(Value::as_str)
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or_default();

        let hashed = sha256_hex(&normalized);
        if !stored.iter().any(|item| *item == hashed) {
            return Err(ditolak());
        }

        let remaining: Vec<&String> = stored.iter().filter(|item| **item != hashed).collect();
        self.query_one(
            "UPDATE master_operator SET password_recovery_codes = ? WHERE id = ?;",
            vec![
                json!(serde_json::to_string(&remaining).unwrap_or_else(|_| "[]".to_string())),
                json!(operator_id),
            ],
        )
        .await?;

        let password_hash = hash_password_pbkdf2(new_password);
        self.query_one(
            "UPDATE master_operator SET password_hash = ?, updated_at = datetime('now') WHERE id = ?;",
            vec![json!(password_hash), json!(operator_id)],
        )
        .await?;

        // Sesi lama dicabut: siapa pun yang masih memegang sesi dengan password
        // lama tidak boleh tetap masuk setelah pemiliknya memulihkan akunnya.
        self.query_one(
            "UPDATE app_session SET revoked_at = datetime('now'), revoked_reason = 'password-recovery' WHERE operator_id = ? AND revoked_at IS NULL;",
            vec![json!(operator_id)],
        )
        .await
        .ok();

        Ok(json!({
            "sukses": true,
            "namaOperator": row.get("nama_operator").and_then(Value::as_str).unwrap_or(""),
            "sisaKode": remaining.len(),
        }))
    }

    pub async fn password_reset_route(&self) -> Result<String, CommandError> {
        let explicit = self
            .query_one(
                "SELECT value FROM setting_gex_system WHERE key = 'password_reset_route' LIMIT 1;",
                vec![],
            )
            .await
            .ok()
            .and_then(|result| result.to_objects().into_iter().next())
            .and_then(|row| {
                row.get("value")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
            });

        if let Some(value) = explicit {
            return Ok(if value == "email" {
                "email".to_owned()
            } else {
                "in_app".to_owned()
            });
        }

        let mail_active = self
            .query_one(
                "SELECT COALESCE(is_active, 0) AS is_active FROM app_mail_config WHERE id = 'default' LIMIT 1;",
                vec![],
            )
            .await
            .ok()
            .and_then(|result| result.to_objects().into_iter().next())
            .and_then(|row| {
                row.get("is_active")
                    .and_then(|value| value.as_i64().or_else(|| value.as_bool().map(i64::from)))
            })
            .unwrap_or(0);

        Ok(if mail_active == 1 {
            "email".to_owned()
        } else {
            "in_app".to_owned()
        })
    }

    /// Setujui permintaan pemulihan dan serahkan tokennya SEKALI.
    ///
    /// Token baru dibuat di sini, bukan saat verifikasi wajah. Itu disengaja:
    /// kalau ia dibuat lebih dulu, bentuk aslinya harus disimpan di suatu tempat
    /// sampai disetujui — dan database hanya boleh memegang hash-nya.
    ///
    /// Peninjau manusia yang melihat foto wajah pemohon adalah faktor kedua di
    /// jalur ini, dan sebenarnya lebih kuat daripada email: email hanya
    /// membuktikan penguasaan kotak masuk, bukan siapa yang meminta.
    ///
    /// Siapa yang menyetujui dicatat pemanggilnya lewat `storage::audit`. Tabel
    /// `role_permission_audit` khusus perubahan izin per role; INSERT lama ke
    /// sana memakai kolom yang tidak pernah ada dan selalu gagal diam-diam.
    pub async fn password_reset_approve(
        &self,
        request_id: &str,
    ) -> Result<Value, CommandError> {
        let existing = self
            .query_one(
                r#"SELECT p.id, p.status, p.delivery_status, p.identifier_used,
                          COALESCE(m.nama_operator, '') AS nama_operator,
                          CASE WHEN p.expires_at <= datetime('now') THEN 1 ELSE 0 END AS kedaluwarsa
                   FROM password_reset_request p
                   LEFT JOIN master_operator m ON m.id = p.operator_id
                   WHERE p.id = ? LIMIT 1;"#,
                vec![json!(request_id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| {
                CommandError::new(
                    "RESET_REQUEST_NOT_FOUND",
                    "Recovery request not found.",
                )
            })?;

        if existing.get("status").and_then(Value::as_str) != Some("Pending Verification") {
            return Err(CommandError::new(
                "RESET_REQUEST_NOT_PENDING",
                "This request was already processed.",
            ));
        }
        if existing.get("delivery_status").and_then(Value::as_str) != Some("Awaiting Approval") {
            return Err(CommandError::new(
                "RESET_REQUEST_NOT_PENDING",
                "This request is not awaiting approval.",
            ));
        }
        if existing
            .get("kedaluwarsa")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            == 1
        {
            self.query_one(
                "UPDATE password_reset_request SET status = 'Expired' WHERE id = ?;",
                vec![json!(request_id)],
            )
            .await?;
            return Err(CommandError::new(
                "RESET_REQUEST_EXPIRED",
                "This request has expired. Ask the requester to start over.",
            ));
        }

        let reset_token = random_reset_token();
        let update_sql = format!(
            r#"UPDATE password_reset_request
               SET token_hash = ?, status = 'Sent', delivery_status = 'Approved',
                   delivery_error = NULL, sent_at = datetime('now'),
                   expires_at = datetime('now', '+{RESET_TOKEN_TTL_MINUTES} minutes')
               WHERE id = ? AND status = 'Pending Verification';"#
        );
        let applied = self
            .query_one(
                update_sql,
                vec![json!(sha256_hex(&reset_token)), json!(request_id)],
            )
            .await?;
        if applied.rows_affected == 0 {
            return Err(CommandError::new(
                "RESET_REQUEST_NOT_PENDING",
                "This request was already processed by someone else.",
            ));
        }

        Ok(json!({
            "sukses": true,
            "token": reset_token,
            "berlakuMenit": RESET_TOKEN_TTL_MINUTES,
            "namaOperator": existing.get("nama_operator").and_then(Value::as_str).unwrap_or(""),
            "identifier": existing.get("identifier_used").and_then(Value::as_str).unwrap_or(""),
        }))
    }

    pub async fn password_reset_verify(
        &self,
        request_id: &str,
        challenge_token: &str,
        verdict: &Value,
        photo_base64: &str,
        photo_mime: &str,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let photo = photo_base64.trim();
        if photo.is_empty() || photo.len() > RESET_PHOTO_MAX_LEN {
            return Err(reset_error(
                "The verification photo is invalid or too large.",
            ));
        }

        let row = self
            .query_one(
                r#"SELECT p.id, p.operator_id, p.contact_target, p.challenge_sequence, p.status,
                          m.nama_operator,
                          CASE WHEN p.expires_at <= datetime('now') THEN 1 ELSE 0 END AS is_expired
                   FROM password_reset_request p
                   JOIN master_operator m ON m.id = p.operator_id
                   WHERE p.id = ? AND p.challenge_hash = ? LIMIT 1;"#,
                vec![json!(request_id), json!(sha256_hex(challenge_token))],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| reset_error("Verification session not found."))?;

        if row.get("status").and_then(Value::as_str) != Some("Pending Verification") {
            return Err(reset_error(
                "This verification session is no longer valid. Start over.",
            ));
        }
        if row.get("is_expired").and_then(Value::as_i64) == Some(1) {
            self.query_one(
                "UPDATE password_reset_request SET status = 'Expired' WHERE id = ?;",
                vec![json!(request_id)],
            )
            .await?;
            return Err(reset_error(
                "Verification time ran out. Start the request over.",
            ));
        }

        let expected: Vec<String> = serde_json::from_str(
            row.get("challenge_sequence")
                .and_then(Value::as_str)
                .unwrap_or("[]"),
        )
        .unwrap_or_default();
        let reported: Vec<String> = verdict
            .get("challenges")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if expected.is_empty() || expected != reported {
            return Err(reset_error(
                "The challenge order does not match. Repeat the verification.",
            ));
        }

        let score = verdict.get("score").and_then(Value::as_f64).unwrap_or(0.0);
        let passed = verdict.get("passed").and_then(Value::as_bool) == Some(true);
        if !passed || score < RESET_LIVENESS_MIN_SCORE {
            let reason = verdict
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("Face verification failed.");
            self.query_one(
                "UPDATE password_reset_request SET liveness_score = ?, liveness_report = ?, photo_mime = ?, photo_base64 = ?, status = 'Cancelled' WHERE id = ?;",
                vec![
                    json!(score),
                    json!(verdict.to_string()),
                    json!(photo_mime.chars().take(40).collect::<String>()),
                    json!(photo),
                    json!(request_id),
                ],
            )
            .await?;
            return Err(reset_error(reason));
        }

        // Jalur persetujuan di aplikasi: tidak ada token yang dibuat di sini,
        // dan tidak ada yang dikirim ke mana pun. Permintaannya tetap
        // "Pending Verification" sampai seorang Superadmin melihat foto wajahnya
        // dan menyetujui — barulah token dibuat, sekali, di layar peninjau.
        if self.password_reset_route().await? != "email" {
            let update_sql = format!(
                r#"UPDATE password_reset_request
                   SET liveness_score = ?, liveness_report = ?, photo_mime = ?, photo_base64 = ?,
                       contact_channel = 'in_app', delivery_status = 'Awaiting Approval',
                       delivery_error = NULL, verified_at = datetime('now'),
                       expires_at = datetime('now', '+{RESET_TOKEN_TTL_MINUTES} minutes')
                   WHERE id = ? AND status = 'Pending Verification';"#
            );
            self.query_one(
                update_sql,
                vec![
                    json!(score),
                    json!(verdict.to_string()),
                    json!(photo_mime.chars().take(40).collect::<String>()),
                    json!(photo),
                    json!(request_id),
                ],
            )
            .await?;

            return Ok(json!({
                "delivery": {
                    "delivered": false,
                    "mode": "in_app",
                    "message": format!(
                        "Your request was recorded and is awaiting Superadmin approval. Ask the Superadmin to review it, then ask for the recovery code, which is valid for {RESET_TOKEN_TTL_MINUTES} minutes."
                    ),
                    "score": score,
                }
            }));
        }

        let reset_token = random_reset_token();
        let update_sql = format!(
            r#"UPDATE password_reset_request
               SET token_hash = ?, status = 'Sent', liveness_score = ?, liveness_report = ?,
                   photo_mime = ?, photo_base64 = ?, verified_at = datetime('now'),
                   expires_at = datetime('now', '+{RESET_TOKEN_TTL_MINUTES} minutes')
               WHERE id = ? AND status = 'Pending Verification';"#
        );
        self.query_one(
            update_sql,
            vec![
                json!(sha256_hex(&reset_token)),
                json!(score),
                json!(verdict.to_string()),
                json!(photo_mime.chars().take(40).collect::<String>()),
                json!(photo),
                json!(request_id),
            ],
        )
        .await?;

        let contact = row
            .get("contact_target")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let operator_name = row
            .get("nama_operator")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let delivery = self
            .send_reset_email(&contact, &operator_name, &reset_token)
            .await;

        match delivery {
            Ok(()) => {
                self.query_one(
                    "UPDATE password_reset_request SET delivery_status = 'Sent', delivery_error = NULL, sent_at = datetime('now') WHERE id = ?;",
                    vec![json!(request_id)],
                )
                .await?;
                Ok(json!({
                    "delivery": {
                        "delivered": true,
                        "masked_email": mask_operator_email(&contact),
                        "message": format!(
                            "A password reset link was sent to {}. It is valid for {} minutes.",
                            mask_operator_email(&contact),
                            RESET_TOKEN_TTL_MINUTES
                        ),
                        "score": score,
                    }
                }))
            }
            Err(failure) => {
                // Permintaan dibatalkan ketika email gagal terkirim: token yang
                // tidak pernah sampai ke pemiliknya tidak boleh tetap hidup.
                // Yang disimpan adalah penjelasan penyedia, bukan pesan generik —
                // itulah satu-satunya petunjuk yang bisa dibaca Admin nanti di
                // halaman Riwayat Reset Password.
                self.query_one(
                    "UPDATE password_reset_request SET delivery_status = 'Failed', delivery_error = ?, status = 'Cancelled' WHERE id = ?;",
                    vec![
                        json!(if failure.detail.is_empty() {
                            failure.message.clone()
                        } else {
                            failure.detail.clone()
                        }),
                        json!(request_id),
                    ],
                )
                .await?;
                Err(reset_error(failure.message))
            }
        }
    }

    /// Langkah 4: memvalidasi token sebelum form password baru ditampilkan.
    pub async fn password_reset_inspect(&self, token: &str) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self.load_reset_token(token).await?;
        let text = |key: &str| {
            row.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        Ok(json!({
            "token": {
                "operator_name": text("nama_operator"),
                "username": text("username"),
                "masked_email": mask_operator_email(&text("contact_target")),
                "expires_at": text("expires_at"),
            }
        }))
    }

    async fn load_reset_token(&self, token: &str) -> Result<HashMap<String, Value>, CommandError> {
        let clean = token.trim();
        if clean.len() < 16 || clean.len() > 256 {
            return Err(reset_error("Invalid reset token."));
        }
        let row = self
            .query_one(
                r#"SELECT p.id, p.operator_id, p.contact_target, p.status, p.expires_at,
                          m.nama_operator, m.username,
                          CASE WHEN p.expires_at <= datetime('now') THEN 1 ELSE 0 END AS is_expired
                   FROM password_reset_request p
                   JOIN master_operator m ON m.id = p.operator_id
                   WHERE p.token_hash = ? LIMIT 1;"#,
                vec![json!(sha256_hex(clean))],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .ok_or_else(|| reset_error("Unknown reset token, or it was already used."))?;

        match row.get("status").and_then(Value::as_str) {
            Some("Used") => {
                return Err(reset_error("This reset token was already used."));
            }
            Some("Sent") => {}
            _ => return Err(reset_error("The reset token is no longer valid.")),
        }
        if row.get("is_expired").and_then(Value::as_i64) == Some(1) {
            let id = row.get("id").cloned().unwrap_or(Value::Null);
            self.query_one(
                "UPDATE password_reset_request SET status = 'Expired' WHERE id = ?;",
                vec![id],
            )
            .await?;
            return Err(reset_error(
                "The reset token has expired. Start the request over.",
            ));
        }
        Ok(row)
    }

    /// Langkah 5: password lama benar-benar digantikan yang baru.
    pub async fn password_reset_complete(
        &self,
        token: &str,
        password: &str,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self.load_reset_token(token).await?;
        validate_new_password(password)?;
        let request_id = row.get("id").cloned().unwrap_or(Value::Null);
        let operator_id = row.get("operator_id").and_then(Value::as_i64).unwrap_or(0);

        // Token dikonsumsi lebih dulu: dua permintaan paralel dengan token yang
        // sama tidak boleh sama-sama sempat menulis password.
        let consumed = self
            .query_one(
                "UPDATE password_reset_request SET status = 'Used', used_at = datetime('now') WHERE id = ? AND status = 'Sent';",
                vec![request_id.clone()],
            )
            .await?;
        if consumed.rows_affected == 0 {
            return Err(reset_error("This reset token was already used."));
        }

        let password_hash = hash_password_pbkdf2(password);
        self.query_one(
            "UPDATE master_operator SET password_hash = ?, updated_at = datetime('now') WHERE id = ?;",
            vec![json!(password_hash), json!(operator_id)],
        )
        .await?;
        // Sesi Web yang masih hidup ikut dicabut; kalau tidak, penyerang yang
        // terlanjur masuk tetap memegang sesi walau passwordnya sudah diganti.
        self.query_one(
            "UPDATE app_session SET revoked_at = datetime('now'), revoked_reason = 'password-reset' WHERE operator_id = ? AND revoked_at IS NULL;",
            vec![json!(operator_id)],
        )
        .await?;

        Ok(json!({
            "sukses": true,
            "username": row.get("username").cloned().unwrap_or(Value::Null),
        }))
    }

    /// Konfigurasi email tanpa kunci API — aman dikirim ke lapisan UI.
    pub async fn get_mail_config(&self) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self
            .query_one(
                "SELECT provider, COALESCE(api_key, '') AS api_key, COALESCE(sender_email, '') AS sender_email, COALESCE(sender_name, '') AS sender_name, COALESCE(reset_base_url, '') AS reset_base_url, is_active, updated_at, COALESCE(updated_by, '') AS updated_by FROM app_mail_config WHERE id = 'default' LIMIT 1;",
                vec![],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .unwrap_or_default();
        let text = |key: &str| {
            row.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        Ok(json!({
            "config": {
                "provider": if text("provider").is_empty() { "resend".to_string() } else { text("provider") },
                "hasApiKey": !text("api_key").trim().is_empty(),
                "senderEmail": text("sender_email"),
                "senderName": text("sender_name"),
                "resetBaseUrl": text("reset_base_url"),
                "isActive": row.get("is_active").and_then(Value::as_i64).unwrap_or(0) == 1,
                "updatedAt": text("updated_at"),
                "updatedBy": text("updated_by"),
            }
        }))
    }

    pub async fn save_mail_config(
        &self,
        draft: &Value,
        actor: &str,
    ) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let field = |key: &str| {
            draft
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let provider = match field("provider").as_str() {
            "brevo" => "brevo".to_string(),
            _ => "resend".to_string(),
        };
        let is_active = draft.get("is_active").and_then(Value::as_bool) == Some(true);
        let sender_email = field("sender_email").to_lowercase();
        let sender_name = field("sender_name");
        let api_key = field("api_key");

        let stored = self
            .query_one(
                "SELECT COALESCE(api_key, '') AS api_key FROM app_mail_config WHERE id = 'default' LIMIT 1;",
                vec![],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .and_then(|row| row.get("api_key").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();

        if is_active {
            if api_key.is_empty() && stored.trim().is_empty() {
                return Err(CommandError::new(
                    "VALIDATION_ERROR",
                    "The email provider API key is required.",
                ));
            }
            if !is_valid_operator_email(&sender_email) {
                return Err(CommandError::new(
                    "VALIDATION_ERROR",
                    "Enter a valid sender email.",
                ));
            }
            if sender_name.chars().count() < 2 {
                return Err(CommandError::new(
                    "VALIDATION_ERROR",
                    "Nama pengirim minimal 2 karakter.",
                ));
            }
        }

        // Kunci hanya ditimpa ketika formulir mengirim kunci baru: UI tidak
        // pernah menerima kunci tersimpan sehingga selalu mengirim string kosong.
        let next_key = if api_key.is_empty() { stored } else { api_key };
        let base_url = field("reset_base_url")
            .trim_end_matches('/')
            .to_string();

        self.query_one(
            r#"INSERT INTO app_mail_config (
                    id, provider, api_key, sender_email, sender_name,
                    reset_base_url, is_active, updated_at, updated_by
               ) VALUES ('default', ?, ?, ?, ?, ?, ?, datetime('now'), ?)
               ON CONFLICT(id) DO UPDATE SET
                    provider = excluded.provider,
                    api_key = excluded.api_key,
                    sender_email = excluded.sender_email,
                    sender_name = excluded.sender_name,
                    reset_base_url = excluded.reset_base_url,
                    is_active = excluded.is_active,
                    updated_at = excluded.updated_at,
                    updated_by = excluded.updated_by;"#,
            vec![
                json!(provider),
                json!(next_key),
                json!(sender_email),
                json!(sender_name),
                json!(base_url),
                json!(if is_active { 1 } else { 0 }),
                json!(actor),
            ],
        )
        .await?;
        self.get_mail_config().await
    }

    /// Mengirim email percobaan ke alamat Admin yang sedang login.
    ///
    /// Balasannya memuat penjelasan apa adanya dari penyedia — aman karena
    /// command pemanggilnya menuntut izin `settings.manage`. Tanpa ini, satu-
    /// satunya cara menguji konfigurasi adalah menjalankan seluruh alur
    /// "Lupa Password" sampai verifikasi wajah.
    pub async fn send_test_mail(&self, operator_id: i64) -> Result<Value, CommandError> {
        self.ensure_schema_current().await?;
        let row = self
            .query_one(
                "SELECT COALESCE(email, '') AS email, nama_operator FROM master_operator WHERE id = ? LIMIT 1;",
                vec![json!(operator_id)],
            )
            .await?
            .to_objects()
            .into_iter()
            .next()
            .unwrap_or_default();
        let to = row
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if to.is_empty() {
            return Ok(json!({
                "test": {
                    "delivered": false,
                    "message": "Your account has no registered email. Add your account email on the Operators page first.",
                    "detail": "",
                    "to": "",
                }
            }));
        }
        let name = row
            .get("nama_operator")
            .and_then(Value::as_str)
            .unwrap_or("Admin")
            .to_string();
        let body = format!(
            "Hello {name},\n\nThis email was sent from Settings > System email to test the sender settings.\nIf it arrived, Forgot password is ready to use.\n\nApp Template"
        );
        match self
            .deliver_mail(&to, "Uji Kirim Email Sistem App Template", &body)
            .await
        {
            Ok(()) => Ok(json!({
                "test": {
                    "delivered": true,
                    "message": format!("Email uji terkirim ke {to}."),
                    "detail": "",
                    "to": to,
                }
            })),
            Err(error) => Ok(json!({
                "test": {
                    "delivered": false,
                    "message": error.message,
                    "detail": error.detail,
                    "to": to,
                }
            })),
        }
    }

    /// Mengirim email lewat HTTP API penyedia.
    async fn deliver_mail(
        &self,
        to: &str,
        subject: &str,
        body_text: &str,
    ) -> Result<(), MailFailure> {
        let row = self
            .query_one(
                "SELECT provider, COALESCE(api_key, '') AS api_key, COALESCE(sender_email, '') AS sender_email, COALESCE(sender_name, '') AS sender_name, is_active FROM app_mail_config WHERE id = 'default' LIMIT 1;",
                vec![],
            )
            .await
            .map_err(|error| MailFailure {
                message: "The email settings could not be read from the database.".to_string(),
                detail: error.message,
            })?
            .to_objects()
            .into_iter()
            .next()
            .unwrap_or_default();
        let text = |key: &str| {
            row.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let api_key = text("api_key");
        let sender_email = text("sender_email");
        if row.get("is_active").and_then(Value::as_i64) != Some(1)
            || api_key.trim().is_empty()
            || sender_email.is_empty()
        {
            return Err(MailFailure {
                message: "Email sending is not configured. Ask an Admin to fill in Settings > System email.".to_string(),
                detail: "Email settings are off, the API key is empty, or the sender email is not set.".to_string(),
            });
        }
        let sender_name = if text("sender_name").is_empty() {
            "App Template".to_string()
        } else {
            text("sender_name")
        };
        let provider = text("provider");

        let request = if provider == "brevo" {
            self.http
                .post("https://api.brevo.com/v3/smtp/email")
                .header("api-key", api_key.trim())
                .json(&json!({
                    "sender": { "name": sender_name, "email": sender_email },
                    "to": [{ "email": to }],
                    "subject": subject,
                    "textContent": body_text,
                }))
        } else {
            self.http
                .post("https://api.resend.com/emails")
                .bearer_auth(api_key.trim())
                .json(&json!({
                    "from": format!("{sender_name} <{sender_email}>"),
                    "to": [to],
                    "subject": subject,
                    "text": body_text,
                }))
        };

        let response = request.send().await.map_err(|error| MailFailure {
            message: "The email could not be sent because no network is available. Try again once the device is online.".to_string(),
            // Penyebab teknisnya disimpan terpisah: "tidak ada internet" yang
            // muncul padahal internet menyala hampir selalu berarti DNS, TLS,
            // atau proxy — bukan kabel terputus.
            detail: format!("Request to {provider} failed: {error}"),
        })?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(MailFailure {
                message: format!("Penyedia email menolak pengiriman (HTTP {}).", status.as_u16()),
                detail: format!(
                    "HTTP {} from {provider}: {}",
                    status.as_u16(),
                    body.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(400).collect::<String>()
                ),
            });
        }
        Ok(())
    }

    /// Mengirim email lewat HTTP API penyedia.
    ///
    /// Bukan SMTP: WebView Tauri di Android maupun runtime Vercel tidak
    /// menjamin soket keluar port 587, sementara HTTPS keluar sudah pasti
    /// tersedia — jalur yang sama yang dipakai klien Turso ini.
    async fn send_reset_email(
        &self,
        to: &str,
        operator_name: &str,
        reset_token: &str,
    ) -> Result<(), MailFailure> {
        let base_url = self
            .query_one(
                "SELECT COALESCE(reset_base_url, '') AS reset_base_url FROM app_mail_config WHERE id = 'default' LIMIT 1;",
                vec![],
            )
            .await
            .ok()
            .and_then(|result| result.to_objects().into_iter().next())
            .and_then(|row| row.get("reset_base_url").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();
        let action = if base_url.is_empty() {
            format!(
                "Masukkan kode berikut pada halaman \"Lupa Password\" di aplikasi:
{reset_token}"
            )
        } else {
            format!(
                "Buka tautan berikut untuk membuat password baru:
{base_url}/forgot-password/reset?token={reset_token}"
            )
        };
        let body_text = format!(
            "Halo {operator_name},

\
             Kami menerima permintaan pemulihan password untuk akun App Template Anda.
\
             Permintaan ini sudah melewati verifikasi wajah pada perangkat pemohon.

\
             {action}

\
             Tautan/kode ini berlaku {RESET_TOKEN_TTL_MINUTES} menit dan hanya dapat dipakai satu kali.
\
             Jika Anda tidak merasa mengajukan permintaan ini, abaikan email ini dan segera
\
             laporkan ke Admin — foto pemohon sudah tersimpan sebagai bukti.

\
             App Template"
        );
        self.deliver_mail(to, "App Template password recovery", &body_text)
            .await
    }
}

fn validate_bootstrap_draft(draft: &BootstrapSuperadminDraft) -> Result<(), CommandError> {
    let code = draft.kode_operator.trim().to_ascii_uppercase();
    let name = draft.nama_operator.trim();
    let username = draft.username.trim();
    let password = draft.password.as_str();
    if code != "SPD001" {
        return Err(CommandError::new(
            "TURSO_BOOTSTRAP_INVALID",
            "The Superadmin bootstrap code must be SPD001.",
        ));
    }
    if !(3..=120).contains(&name.chars().count()) {
        return Err(CommandError::new(
            "TURSO_BOOTSTRAP_INVALID",
            "The Superadmin name must be 3-120 characters.",
        ));
    }
    if !(3..=64).contains(&username.len())
        || !username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(CommandError::new(
            "TURSO_BOOTSTRAP_INVALID",
            "The username must be 3-64 characters of letters, numbers, dots, underscores, or hyphens.",
        ));
    }
    let has_upper = password.chars().any(char::is_uppercase);
    let has_lower = password.chars().any(char::is_lowercase);
    let has_digit = password.chars().any(|character| character.is_ascii_digit());
    let has_symbol = password
        .chars()
        .any(|character| !character.is_alphanumeric() && !character.is_whitespace());
    if !(12..=128).contains(&password.chars().count())
        || !has_upper
        || !has_lower
        || !has_digit
        || !has_symbol
        || password.to_lowercase().contains(&username.to_lowercase())
    {
        return Err(CommandError::new(
            "TURSO_BOOTSTRAP_PASSWORD_WEAK",
            "The password needs at least 12 characters with uppercase, lowercase, a number, and a symbol, and must not contain the username.",
        ));
    }
    Ok(())
}

pub fn verify_password(password: &str, stored_hash: &str) -> bool {
    if stored_hash.is_empty() {
        return false;
    }

    let parts: Vec<&str> = stored_hash.split('$').collect();
    if parts.len() == 4 && parts[0] == "pbkdf2-sha256" {
        let Ok(iterations) = parts[1].parse::<u32>() else {
            return false;
        };
        let Ok(salt) = BASE64_STANDARD.decode(parts[2]) else {
            return false;
        };
        let Ok(expected_hash) = BASE64_STANDARD.decode(parts[3]) else {
            return false;
        };

        if iterations < 1_000 {
            return false;
        }

        let mut derived = vec![0u8; expected_hash.len()];
        pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, iterations, &mut derived);

        let mut diff = 0u8;
        for (a, b) in derived.iter().zip(expected_hash.iter()) {
            diff |= a ^ b;
        }
        return diff == 0 && derived.len() == expected_hash.len();
    }

    // Cek Argon2 jika format $argon2id$...
    if stored_hash.starts_with("$argon2") {
        if let Ok(parsed) = argon2::PasswordHash::new(stored_hash) {
            return argon2::Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok();
        }
    }

    // Fallback legacy plaintext
    stored_hash == password
}

pub fn hash_password_pbkdf2_with_iterations(password: &str, iterations: u32) -> String {
    use rand_core::{OsRng, RngCore};
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let mut derived = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, iterations, &mut derived);
    format!(
        "pbkdf2-sha256${}${}${}",
        iterations,
        BASE64_STANDARD.encode(salt),
        BASE64_STANDARD.encode(derived)
    )
}

pub fn hash_password_pbkdf2(password: &str) -> String {
    hash_password_pbkdf2_with_iterations(password, 600_000)
}

fn chrono_like_now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    format!("{now}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Vektor uji resmi RFC 4226 dan RFC 6238, sama persis dengan yang diuji
    /// `src/lib/security/totp.test.ts`.
    ///
    /// Dua implementasi menguji vektor yang sama adalah cara paritas TOTP
    /// dijaga: kode yang diterima Web wajib diterima Desktop/Mobile juga,
    /// karena keduanya memverifikasi rahasia yang sama dari database yang sama.
    #[test]
    fn totp_matches_the_official_rfc_vectors() {
        let secret = encode_base32(b"12345678901234567890");
        assert_eq!(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");

        // RFC 4226 Appendix D: delapan pencacah pertama.
        let hotp = [
            "755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583",
        ];
        for (counter, expected) in hotp.iter().enumerate() {
            assert_eq!(
                generate_hotp(&secret, counter as u64).as_deref(),
                Some(*expected),
                "HOTP pencacah {counter}"
            );
        }

        // RFC 6238 Appendix B, baris SHA-1. Delapan digit dipotong jadi enam.
        for (seconds, eight_digits) in [
            (59i64, "94287082"),
            (1_111_111_109, "07081804"),
            (1_111_111_111, "14050471"),
            (1_234_567_890, "89005924"),
            (2_000_000_000, "69279037"),
        ] {
            assert_eq!(
                generate_totp(&secret, seconds).as_deref(),
                Some(&eight_digits[2..]),
                "TOTP detik {seconds}"
            );
        }
    }

    #[test]
    fn base32_decoding_forgives_human_typing() {
        let rapi = decode_base32("GEZDGNBVGY3TQOJQ").expect("base32");
        assert_eq!(decode_base32("gezd gnbv gy3t qojq").as_deref(), Some(&rapi[..]));
        assert_eq!(decode_base32("GEZD-GNBV-GY3T-QOJQ").as_deref(), Some(&rapi[..]));
        assert_eq!(decode_base32("GEZDGNBVGY3TQOJQ====").as_deref(), Some(&rapi[..]));
        // Karakter di luar alfabet base32 ditolak, bukan diam-diam dilewati.
        assert!(decode_base32("GEZD0189").is_none());
    }

    #[test]
    fn totp_verification_window_behaves_like_typescript() {
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        let now = 1_700_000_000i64;
        let code = generate_totp(secret, now).expect("kode");

        assert!(verify_totp(secret, &code, now, TOTP_WINDOW_ONLINE));
        // Kode yang berganti tepat saat tombol ditekan tetap diterima.
        let sebelum = generate_totp(secret, now - 30).expect("kode");
        let sesudah = generate_totp(secret, now + 30).expect("kode");
        assert!(verify_totp(secret, &sebelum, now, TOTP_WINDOW_ONLINE));
        assert!(verify_totp(secret, &sesudah, now, TOTP_WINDOW_ONLINE));

        // Di luar toleransi sempit ditolak, tetapi jendela offline yang lebih
        // lebar menerimanya — itulah gunanya membedakan keduanya.
        let meleset = generate_totp(secret, now + 90).expect("kode");
        assert!(!verify_totp(secret, &meleset, now, TOTP_WINDOW_ONLINE));
        // Jendela lebar yang dipakai sisi TypeScript untuk jam perangkat.
        assert!(verify_totp(secret, &meleset, now, 4));

        // Panjang salah dan spasi yang ikut tersalin.
        assert!(!verify_totp(secret, "12345", now, TOTP_WINDOW_ONLINE));
        assert!(!verify_totp(secret, "", now, TOTP_WINDOW_ONLINE));
        let berspasi = format!("{} {}", &code[0..3], &code[3..]);
        assert!(verify_totp(secret, &berspasi, now, TOTP_WINDOW_ONLINE));
    }

    #[test]
    fn generated_secrets_and_recovery_codes_are_usable() {
        let first = generate_totp_secret();
        let second = generate_totp_secret();
        assert_eq!(first.len(), 32);
        assert_ne!(first, second);
        assert_eq!(decode_base32(&first).map(|bytes| bytes.len()), Some(20));

        let codes = generate_recovery_codes(8);
        assert_eq!(codes.len(), 8);
        for code in &codes {
            assert_eq!(code.len(), 9);
            assert_eq!(code.as_bytes()[4], b'-');
            // Karakter yang mudah tertukar saat disalin tangan tidak dipakai.
            assert!(!code.contains(['O', 'I', '0', '1']));
        }
        assert_eq!(normalize_recovery_code("abcd-efgh"), "ABCDEFGH");
    }


    #[test]
    fn test_normalize_operator_phone_matches_typescript() {
        for input in [
            "081234567890",
            "+62 812-3456-7890",
            "6281234567890",
            "(0812) 3456 7890",
        ] {
            assert_eq!(normalize_operator_phone(input), "+6281234567890");
        }
        assert_eq!(normalize_operator_phone("+15551234567"), "+15551234567");
        assert_eq!(normalize_operator_phone("12345"), "");
        assert_eq!(normalize_operator_phone("bukan nomor"), "");
        assert_eq!(normalize_operator_phone(""), "");
    }

    #[test]
    fn test_normalize_operator_email_is_lowercased() {
        assert_eq!(
            normalize_operator_email("  Operator@CONTOH.ID "),
            "operator@contoh.id"
        );
    }

    #[test]
    fn test_operator_email_validation() {
        assert!(is_valid_operator_email("operator.satu@contoh.id"));
        assert!(is_valid_operator_email("a@b.co"));
        for invalid in [
            "",
            "operator",
            "operator@",
            "@contoh.id",
            "operator@contoh",
            "operator @contoh.id",
            "a@b@c.id",
        ] {
            assert!(!is_valid_operator_email(invalid), "harus ditolak: {invalid}");
        }
    }

    #[test]
    fn test_operator_phone_validation() {
        assert!(is_valid_operator_phone("081234567890"));
        assert!(!is_valid_operator_phone("0812"));
        assert!(!is_valid_operator_phone(""));
    }

    #[test]
    fn test_validate_operator_contact_rejects_incomplete_data() {
        assert!(validate_operator_contact("operator@contoh.id", "081234567890").is_ok());
        assert!(validate_operator_contact("", "081234567890").is_err());
        assert!(validate_operator_contact("operator@contoh.id", "").is_err());
        assert!(validate_operator_contact("bukan-email", "081234567890").is_err());
    }

    /// Layar "Lupa Password" terbuka tanpa login, jadi kontak lengkap tidak
    /// boleh ditampilkan di sana.
    #[test]
    fn test_contact_masking_hides_identity() {
        let masked = mask_operator_email("operator01@contoh.id");
        assert!(!masked.contains("operator01"));
        assert!(masked.starts_with('o'));
        assert!(masked.ends_with(".id"));
        assert_eq!(mask_operator_email(""), "");
        assert_eq!(mask_operator_email("@contoh.id"), "");

        let phone = mask_operator_phone("081234567890");
        assert!(phone.starts_with("+62"));
        assert!(phone.ends_with("7890"));
        assert!(phone.contains('*'));
        assert!(!phone.contains("123456"));
        assert_eq!(mask_operator_phone("bukan nomor"), "");
    }

    /// Tantangan liveness harus acak dan tidak berulang dalam satu sesi.
    #[test]
    fn test_pick_reset_challenges_returns_unique_triplet() {
        let picked = pick_reset_challenges();
        assert_eq!(picked.len(), 3);
        let unique: std::collections::HashSet<&String> = picked.iter().collect();
        assert_eq!(unique.len(), 3);
        for challenge in &picked {
            assert!([
                "KEDIP",
                "TENGOK_KIRI",
                "TENGOK_KANAN",
                "DEKATKAN_WAJAH",
                "JAUHKAN_WAJAH"
            ]
            .contains(&challenge.as_str()));
        }
    }

    /// Aturan kekuatan password baru harus sama dengan
    /// `validatePasswordStrength` di `src/lib/auth/password.ts`.
    #[test]
    fn test_validate_new_password_mirrors_typescript_rules() {
        assert!(validate_new_password("PasswordBaruKuat1").is_ok());
        assert!(validate_new_password("pendek").is_err());
        assert!(validate_new_password("semuahurufkecil1").is_err());
        assert!(validate_new_password("SEMUAHURUFBESAR1").is_err());
        assert!(validate_new_password("TanpaAngkaSamaSekali").is_err());
    }

    /// Token reset tidak pernah disimpan apa adanya — hanya hash SHA-256-nya,
    /// sama seperti `hashSessionToken` di sisi TypeScript.
    #[test]
    fn test_random_reset_token_is_unique_and_hashed() {
        let first = random_reset_token();
        let second = random_reset_token();
        assert_ne!(first, second);
        assert!(first.len() >= 40);
        assert_eq!(sha256_hex(&first).len(), 64);
        assert_ne!(sha256_hex(&first), sha256_hex(&second));
        assert_eq!(sha256_hex(&first), sha256_hex(&first));
    }

    #[test]
    fn test_normalize_turso_url() {
        let turso = |raw: &str| normalize_database_url(raw, DatabaseProvider::Turso, false);
        assert_eq!(
            turso("libsql://my-db.turso.io").unwrap().as_str(),
            "https://my-db.turso.io/"
        );
        assert_eq!(
            turso("https://my-db.turso.io/path?query=1").unwrap().as_str(),
            "https://my-db.turso.io/"
        );
        assert!(turso("ftp://my-db.turso.io").is_err());
        assert!(turso("").is_err());
    }

    #[test]
    fn self_hosted_allows_plain_http_on_private_networks() {
        // Justru inilah tujuan mode server sendiri: server libSQL di LAN kantor
        // atau di rumah yang berjalan tanpa TLS. Ini harus lolos pada build
        // rilis, bukan hanya pada build debug.
        for address in [
            "http://192.168.1.10:8080",
            "http://10.20.30.40:8080",
            "http://172.16.5.4:8080",
            "http://localhost:8080",
            "http://127.0.0.1:8080",
            "http://nas.local:8080",
            "ws://192.168.1.10:8080",
        ] {
            assert!(
                normalize_database_url(address, DatabaseProvider::SelfHosted, false).is_ok(),
                "alamat privat harus diterima: {address}"
            );
        }
    }

    #[test]
    fn self_hosted_rejects_plain_http_on_public_hosts_unless_opted_in() {
        // VPS berisi IP publik: HTTP polos di sana mengirim Auth Token dan data
        // data tanpa enkripsi, jadi harus ditolak sampai pengguna menyatakan
        // menerima risikonya secara eksplisit.
        let error = normalize_database_url("http://203.0.113.10:8080", DatabaseProvider::SelfHosted, false)
            .expect_err("host publik ber-HTTP harus ditolak tanpa opt-in");
        assert_eq!(error.code, "TURSO_URL_INSECURE");
        assert!(
            normalize_database_url("http://203.0.113.10:8080", DatabaseProvider::SelfHosted, true)
                .is_ok()
        );
        // Opt-in tidak boleh menular ke provider Turso terkelola.
        assert!(normalize_database_url("http://203.0.113.10:8080", DatabaseProvider::Turso, true).is_err());
    }

    #[test]
    fn self_hosted_keeps_custom_port_and_strips_path() {
        let url = normalize_database_url(
            "http://192.168.1.10:9000/some/path?x=1#frag",
            DatabaseProvider::SelfHosted,
            false,
        )
        .unwrap();
        assert_eq!(url.as_str(), "http://192.168.1.10:9000/");
    }

    #[test]
    fn database_url_never_carries_credentials() {
        for provider in [DatabaseProvider::Turso, DatabaseProvider::SelfHosted] {
            assert!(
                normalize_database_url("https://user:secret@db.example.com", provider, false)
                    .is_err()
            );
        }
    }

    #[test]
    fn auth_token_is_optional_only_where_it_is_safe() {
        // sqld di LAN lazim berjalan tanpa autentikasi sama sekali.
        let lan = TursoConfig::new(
            "http://192.168.1.10:8080".into(),
            String::new(),
            DatabaseProvider::SelfHosted,
            false,
        );
        assert!(!lan.requires_auth_token());
        assert!(TursoClient::from_config(&lan, Client::new()).is_ok());

        // Server sendiri yang sudah ber-HTTPS publik berarti terekspos internet:
        // token menjadi satu-satunya penghalang yang tersisa.
        let public = TursoConfig::new(
            "https://db.kantor-anda.com".into(),
            String::new(),
            DatabaseProvider::SelfHosted,
            false,
        );
        assert!(public.requires_auth_token());
        assert!(TursoClient::from_config(&public, Client::new()).is_err());

        // Turso terkelola selalu wajib token.
        let turso = TursoConfig::turso("libsql://my-db.turso.io".into(), String::new());
        assert!(turso.requires_auth_token());
        assert!(TursoClient::from_config(&turso, Client::new()).is_err());
    }

    #[test]
    fn matches_url_compares_normalized_spellings() {
        let config = TursoConfig::turso("libsql://my-db.turso.io".into(), "token".into());
        assert!(config.matches_url("https://my-db.turso.io"));
        assert!(config.matches_url("https://my-db.turso.io/"));
        assert!(config.matches_url("  libsql://my-db.turso.io  "));
        assert!(!config.matches_url("https://other-db.turso.io"));
    }

    #[test]
    fn insecure_flag_is_dropped_outside_self_hosted_mode() {
        let config = TursoConfig::new(
            "libsql://my-db.turso.io".into(),
            "token".into(),
            DatabaseProvider::Turso,
            true,
        );
        assert!(!config.allow_insecure_transport);
    }

    #[test]
    fn legacy_vault_payload_defaults_to_turso_provider() {
        // Vault yang ditulis versi lama hanya memuat dua field. Kalau default-nya
        // tidak Turso, seluruh instalasi lama akan gagal memuat konfigurasi.
        let config: TursoConfig = serde_json::from_str(
            r#"{"database_url":"libsql://my-db.turso.io","auth_token":"token"}"#,
        )
        .unwrap();
        assert_eq!(config.provider, DatabaseProvider::Turso);
        assert!(!config.allow_insecure_transport);
    }

    #[test]
    fn test_pbkdf2_hash_and_verify() {
        let password = "MySecretPassword123!";
        let hash = hash_password_pbkdf2_with_iterations(password, 1_000);
        assert!(hash.starts_with("pbkdf2-sha256$1000$"));
        assert!(verify_password(password, &hash));
        assert!(!verify_password("WrongPassword", &hash));
    }

    #[test]
    fn test_legacy_plaintext_verify() {
        assert!(verify_password("plaintext123", "plaintext123"));
        assert!(!verify_password("plaintext123", "different"));
    }

    #[test]
    fn bootstrap_requires_a_strong_non_default_password() {
        let strong = BootstrapSuperadminDraft {
            kode_operator: "SPD001".into(),
            nama_operator: "Pemilik Usaha".into(),
            username: "pemilik.contoh".into(),
            password: "Aman-Sekali-2026!".into(),
        };
        assert!(validate_bootstrap_draft(&strong).is_ok());
        let weak = BootstrapSuperadminDraft {
            password: "admin123".into(),
            ..strong
        };
        assert_eq!(
            validate_bootstrap_draft(&weak)
                .expect_err("weak password")
                .code,
            "TURSO_BOOTSTRAP_PASSWORD_WEAK"
        );
    }

    #[test]
    fn atomic_batch_has_guarded_commit_and_rollback() {
        let statements = vec![
            Statement::new("INSERT INTO a VALUES (?);", vec![json!(1)]),
            Statement::new("INSERT INTO b VALUES (?);", vec![json!(2)]),
        ];
        let (steps, commit_step) = atomic_batch_steps(&statements);
        assert_eq!(steps.len(), 5);
        assert_eq!(commit_step, 3);
        assert_eq!(steps[2]["condition"], json!({ "type": "ok", "step": 1 }));
        assert_eq!(
            steps[4]["condition"],
            json!({ "type": "not", "cond": { "type": "ok", "step": 3 } })
        );
    }

    #[test]
    fn sync_routes_are_canonicalized_and_unsupported_mutations_are_closed() {
        // Alias lama dinormalisasi ke bentuk kanonik...
        assert_eq!(
            canonical_sync_route("clients", "register"),
            Some(("client", "register"))
        );
        assert_eq!(
            canonical_sync_route("master_option", "upsert"),
            Some(("master-option", "upsert"))
        );
        // ...dan pasangan yang tidak terdaftar ditolak, bukan diloloskan.
        assert_eq!(
            canonical_sync_route("lead_interactions", "record"),
            Some(("lead-interaction", "record"))
        );
        assert_eq!(canonical_sync_route("leads", "reassign"), Some(("lead", "reassign")));
        assert_eq!(canonical_sync_route("lead-interaction", "delete"), None);
        assert_eq!(canonical_sync_route("lead", "update"), None);
        assert_eq!(canonical_sync_route("client", "delete"), None);
        assert_eq!(canonical_sync_route("item", "create"), None);
        assert_eq!(canonical_sync_route("pelanggan", "create"), None);
    }

    // ── Mode Database Lokal Murni ──────────────────────────────────────────
    //
    // Janji arsitektur ini: SQL yang sama persis yang membangun database cloud
    // juga membangun berkas lokal. Bukan salinan DDL, bukan skema kedua —
    // `ensure_schema()` yang sama, hanya dengan transport yang ditukar. Selama
    // uji-uji di bawah lulus, drift antara tabel lokal dan tabel cloud tidak
    // mungkin terjadi, karena keduanya lahir dari satu fungsi.

    /// Provisioning mode lokal membangun SELURUH tabel yang dituntut aplikasi.
    #[test]
    fn provisioning_lokal_membangun_seluruh_tabel_cloud() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime uji");
        runtime.block_on(async {
            let dir = tempfile::tempdir().expect("direktori sementara");
            let hub = dir.path().join("app-hub.db");

            let client = TursoClient::local_file(
                Url::parse(LOCAL_FILE_ORIGIN).expect("origin lokal"),
                &hub,
                Client::new(),
            );
            client.ensure_schema().await.expect("provisioning lokal");

            let connection = rusqlite::Connection::open(&hub).expect("buka hub");

            // Daftar ini WAJIB sama dengan `REQUIRED_TABLES` di `db-schema.ts`.
            // Sengaja dieja ulang: kalau salah satunya berhenti dibuat, jalur
            // Web akan menganggap database selamanya belum siap — dan tanpa uji
            // ini, kegagalannya baru terlihat di tangan pengguna.
            for table in [
                "app_role",
                "app_permission",
                "role_permission",
                "role_permission_audit",
                "master_operator",
                "app_bootstrap_state",
                "app_session",
                "auth_login_rate_limit",
                "password_reset_request",
                "app_mail_config",
                "schema_migration",
                "sync_changelog",
                "sync_change_log",
                "sync_operation_receipt",
                "setting_gex_system",
                "company_profile",
                "clients",
                "leads",
                "master_option",
                "device_tag_registry",
                "lead_interactions",
            ] {
                let ada: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1;",
                        [table],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                assert_eq!(ada, 1, "tabel '{table}' tidak dibuat oleh ensure_schema()");
            }

            // Penghitung perubahan per tabel: tanpa ini, setiap siklus tarik
            // akan menganggap seluruh tabel berpotensi berubah.
            let pulse: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sync_pulse';",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            assert_eq!(pulse, 1, "sync_pulse tidak dibuat");

            let versi: i64 = connection
                .query_row(
                    "SELECT COALESCE(MAX(version), 0) FROM schema_migration WHERE version > 0;",
                    [],
                    |row| row.get(0),
                )
                .expect("versi skema");
            assert_eq!(
                versi,
                crate::desktop::sync::CLIENT_SCHEMA_VERSION,
                "versi skema hasil provisioning lokal berbeda dari versi klien"
            );
        });
    }

    /// Katalog permission ikut tertanam, bukan hanya tabelnya.
    ///
    /// Database tanpa baris permission membuat setiap pemeriksaan hak akses
    /// gagal — Superadmin pun tidak bisa membuka apa pun.
    #[test]
    fn provisioning_lokal_menanam_role_dan_permission() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime uji");
        runtime.block_on(async {
            let dir = tempfile::tempdir().expect("direktori sementara");
            let hub = dir.path().join("app-hub.db");

            let client = TursoClient::local_file(
                Url::parse(LOCAL_FILE_ORIGIN).expect("origin lokal"),
                &hub,
                Client::new(),
            );
            client.ensure_schema().await.expect("provisioning lokal");

            let connection = rusqlite::Connection::open(&hub).expect("buka hub");
            let permissions: i64 = connection
                .query_row("SELECT COUNT(*) FROM app_permission;", [], |row| row.get(0))
                .expect("hitung permission");
            assert!(
                permissions > 0,
                "katalog permission kosong: seluruh pemeriksaan hak akses akan gagal"
            );

            let superadmin: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM app_role WHERE role_key = 'superadmin';",
                    [],
                    |row| row.get(0),
                )
                .expect("hitung role");
            assert_eq!(superadmin, 1, "role superadmin tidak ditanam");
        });
    }

    /// Mode lokal tidak punya jaringan, jadi tidak pernah ada token.
    #[test]
    fn mode_lokal_tidak_pernah_menuntut_token() {
        let local = TursoConfig::new(
            "C:/data/app-hub.db".into(),
            String::new(),
            DatabaseProvider::LocalFile,
            false,
        );
        assert!(!local.requires_auth_token());

        let client = TursoClient::from_config(&local, Client::new()).expect("klien lokal");
        assert!(client.is_local());
    }

    /// Origin mode lokal adalah konstanta, bukan turunan dari isi path.
    ///
    /// Origin dipakai sebagai kunci identitas klien sinkronisasi. Kalau ia ikut
    /// berubah saat berkas hub dipindahkan, perangkat yang sama akan dianggap
    /// perangkat baru dan seluruh kursornya kembali ke nol.
    #[test]
    fn origin_mode_lokal_stabil_dan_tidak_bergantung_isi_path() {
        let a = normalize_database_url("C:/data/app-hub.db", DatabaseProvider::LocalFile, false)
            .expect("origin lokal");
        let b = normalize_database_url("/home/pengguna/lain.db", DatabaseProvider::LocalFile, false)
            .expect("origin lokal");

        assert_eq!(a, b);
        assert_eq!(a.as_str().trim_end_matches('/'), LOCAL_FILE_ORIGIN);
    }

    /// Lokasi berkas yang kosong adalah kesalahan yang harus TERLIHAT, bukan
    /// berkas kosong yang diam-diam dibuat di direktori kerja.
    #[test]
    fn lokasi_berkas_lokal_wajib_terisi() {
        let kosong = TursoConfig::new(
            "   ".into(),
            String::new(),
            DatabaseProvider::LocalFile,
            false,
        );
        let error = kosong.local_file_path().expect_err("harus gagal");
        assert_eq!(error.code, "LOCAL_DB_PATH_MISSING");
        assert!(TursoClient::from_config(&kosong, Client::new()).is_err());
    }
}

//! Portabilitas data: mengeluarkan dan memasukkan kembali berkas hub.
//!
//! Tanpa cloud, tidak ada cadangan otomatis di mana pun — customer sendiri yang
//! memegang datanya. Kalau perangkatnya rusak dan tidak ada jalan mengeluarkan
//! isinya, mode lokal justru kehilangan hal yang dijanjikannya.
//!
//! Tiga hal yang menentukan bentuk modul ini:
//!
//! 1. **"Salin berkas `.db`" bukan backup.** SQLite mode WAL menyimpan transaksi
//!    terbaru di `-wal`, sehingga menyalin berkas utama selagi aplikasi berjalan
//!    menghasilkan cadangan yang diam-diam ketinggalan. `VACUUM INTO` adalah
//!    jawabannya: satu perintah, salinan konsisten dan terpadatkan, tanpa perlu
//!    menutup aplikasi.
//!
//! 2. **Vault TIDAK ikut.** Yang diekspor hanya berkas hub. `desktop-security.db`
//!    memuat vault yang terikat pada `device_id` perangkat ini; memulihkannya ke
//!    perangkat lain justru membawa identitas yang salah. Setelah restore,
//!    pengguna cukup login ulang dan vault terbentuk sendiri.
//!
//! 3. **Restore adalah MENGGANTI, bukan menggabungkan.** Menggabungkan dua
//!    database yang pernah berjalan sendiri-sendiri adalah persoalan tabrakan
//!    constraint, dan itu ditangani skrip promosi terpisah — bukan oleh tombol
//!    pulihkan.

use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use rusqlite::Connection;
use serde::Serialize;
use zeroize::{Zeroize, Zeroizing};

use super::config::DesktopState;
use super::models::CommandError;
use super::sync::CLIENT_SCHEMA_VERSION;

/// Penanda berkas cadangan terenkripsi.
///
/// Ikut sebagai AAD sehingga header tidak bisa ditukar diam-diam dengan header
/// versi lain tanpa membuat dekripsi gagal.
const BACKUP_MAGIC: &[u8; 16] = b"APPDBBACKUPAESv1";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

/// Ukuran maksimum berkas cadangan yang mau dibaca ke memori saat impor.
///
/// Batas yang longgar tetapi terbatas: tanpa ini, sebuah berkas 8 GB yang salah
/// pilih akan mematikan aplikasi lewat kehabisan memori, bukan lewat pesan yang
/// bisa dibaca pengguna.
const MAX_BACKUP_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Folder yang benar-benar bisa dijangkau pengguna, berurutan menurut prioritas.
///
/// Dipisahkan dari [`save_desktop_file`] supaya ekspor cadangan database memakai
/// daftar yang SAMA. Kalau daftarnya diduplikasi, satu sisi cepat atau lambat
/// akan menyimpan berkas ke tempat yang tidak dicari sisi lain.
///
/// TIDAK ADA direktori sementara di sini. Di Android `std::env::temp_dir()`
/// adalah folder privat aplikasi: ketika penulisan ke `/storage/emulated/0/Download`
/// ditolak — dan sejak Android 10 penolakan itu lazim, karena manifest membatasi
/// WRITE_EXTERNAL_STORAGE pada maxSdkVersion 28 — berkasnya tetap tertulis,
/// pemanggil melaporkan sukses, dan pengguna tidak pernah menemukan hasilnya.
/// Kegagalan yang dilaporkan sebagai keberhasilan jauh lebih buruk daripada
/// kegagalan yang terlihat.
pub fn public_output_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();

    // 1. Direktori publik Android
    dirs.push(std::path::PathBuf::from("/storage/emulated/0/Download"));
    dirs.push(std::path::PathBuf::from("/sdcard/Download"));
    dirs.push(std::path::PathBuf::from("/storage/emulated/0/Pictures"));
    dirs.push(std::path::PathBuf::from("/storage/emulated/0/DCIM"));

    // 2. Folder Unduhan standar Windows / Linux / macOS
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        dirs.push(std::path::PathBuf::from(user_profile).join("Downloads"));
    }
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(std::path::PathBuf::from(home).join("Downloads"));
    }

    dirs
}

/// Salin sebuah berkas ke folder pertama yang benar-benar bisa ditulisi.
///
/// `None` berarti tidak ada satu pun folder publik yang menerima tulisan —
/// keadaan nyata pada Android 10, dan pemanggil WAJIB menyampaikannya apa adanya
/// alih-alih berpura-pura berhasil.
pub fn copy_to_public_dir(source: &std::path::Path, file_name: &str) -> Option<std::path::PathBuf> {
    let sanitized = file_name.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    for dir in public_output_dirs() {
        if !dir.exists() {
            let _ = std::fs::create_dir_all(&dir);
        }
        let target = dir.join(&sanitized);
        if std::fs::copy(source, &target).is_ok() {
            return Some(target);
        }
    }
    None
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub encrypted: bool,
    /// Lokasi salinan di folder yang benar-benar bisa dibuka pengguna.
    ///
    /// `None` berarti tidak ada folder publik yang menerima tulisan — keadaan
    /// nyata pada Android 10, di mana folder data aplikasi bersifat privat.
    /// Berkasnya tetap ada di `path`, tetapi pengguna tidak akan menemukannya
    /// tanpa bantuan, dan UI wajib menyampaikan itu apa adanya.
    pub public_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub schema_version: i64,
    pub table_count: i64,
    pub restored_from: String,
    pub previous_backup: Option<String>,
}

/// Turunkan kunci dari frasa sandi pengguna.
///
/// Sengaja BUKAN dari `device_id` seperti vault: berkas cadangan harus bisa
/// dibuka di perangkat lain — itu justru gunanya.
fn derive_backup_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], CommandError> {
    let mut key = [0_u8; 32];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|_| {
            CommandError::new(
                "BACKUP_KEY_FAILED",
                "The backup encryption key could not be created.",
            )
        })?;
    Ok(key)
}

fn hub_path(state: &DesktopState) -> Result<PathBuf, CommandError> {
    let config = state.turso_config().ok_or_else(|| {
        CommandError::new(
            "LOCAL_MODE_REQUIRED",
            "No database is configured on this device.",
        )
    })?;
    if !config.provider.is_local_file() {
        return Err(CommandError::new(
            "LOCAL_MODE_REQUIRED",
            "File export and restore only apply in Local Database Mode. In cloud mode the master data is on the server: back it up there.",
        ));
    }
    config.local_file_path()
}

/// Salinan konsisten dari database yang sedang berjalan.
///
/// `VACUUM INTO` menolak menulis ke berkas yang sudah ada, jadi sisa percobaan
/// sebelumnya dibersihkan lebih dulu.
fn vacuum_into(source: &Path, destination: &Path) -> Result<(), CommandError> {
    let _ = fs::remove_file(destination);
    let connection = Connection::open(source).map_err(|error| {
        CommandError::new(
            "LOCAL_DB_UNAVAILABLE",
            format!("The local database could not be opened: {error}"),
        )
    })?;
    connection
        .execute("VACUUM INTO ?1;", [destination.to_string_lossy().as_ref()])
        .map_err(|error| {
            CommandError::new(
                "BACKUP_FAILED",
                format!("The database copy could not be created: {error}"),
            )
        })?;
    Ok(())
}

fn encrypt_backup(plain: &[u8], passphrase: &str) -> Result<Vec<u8>, CommandError> {
    let mut salt = [0_u8; SALT_LEN];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut salt);
    let mut nonce_bytes = [0_u8; NONCE_LEN];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut nonce_bytes);

    let mut key = derive_backup_key(passphrase, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| CommandError::internal())?;
    key.zeroize();

    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plain,
                aad: BACKUP_MAGIC,
            },
        )
        .map_err(|_| {
            CommandError::new("BACKUP_FAILED", "The backup file could not be encrypted.")
        })?;

    let mut payload = Vec::with_capacity(BACKUP_MAGIC.len() + SALT_LEN + NONCE_LEN + ciphertext.len());
    payload.extend_from_slice(BACKUP_MAGIC);
    payload.extend_from_slice(&salt);
    payload.extend_from_slice(&nonce_bytes);
    payload.extend_from_slice(&ciphertext);
    Ok(payload)
}

fn decrypt_backup(payload: &[u8], passphrase: &str) -> Result<Vec<u8>, CommandError> {
    let header = BACKUP_MAGIC.len() + SALT_LEN + NONCE_LEN;
    if payload.len() <= header {
        return Err(CommandError::new(
            "BACKUP_CORRUPT",
            "The encrypted backup file is incomplete.",
        ));
    }
    let salt = &payload[BACKUP_MAGIC.len()..BACKUP_MAGIC.len() + SALT_LEN];
    let nonce_bytes = &payload[BACKUP_MAGIC.len() + SALT_LEN..header];

    let mut key = derive_backup_key(passphrase, salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| CommandError::internal())?;
    key.zeroize();

    cipher
        .decrypt(
            Nonce::from_slice(nonce_bytes),
            Payload {
                msg: &payload[header..],
                aad: BACKUP_MAGIC,
            },
        )
        .map_err(|_| {
            CommandError::new(
                "BACKUP_PASSPHRASE_INVALID",
                "The backup passphrase is wrong, or the file is corrupt.",
            )
        })
}

pub fn is_encrypted_backup(payload: &[u8]) -> bool {
    payload.starts_with(BACKUP_MAGIC)
}

/// Nama berkas cadangan: mudah diurutkan dan tidak pernah bentrok.
fn backup_file_name(encrypted: bool) -> String {
    let stamp = super::storage::now_epoch_seconds();
    let extension = if encrypted { "appbak" } else { "db" };
    format!("app-{stamp}.{extension}")
}

/// Keluarkan isi database hub ke satu berkas mandiri.
///
/// Frasa sandi kosong menghasilkan berkas SQLite polos — berguna untuk diagnosa
/// karena bisa dibuka di DB Browser, tetapi ia memuat hash password, rahasia
/// TOTP, dan berkas lampiran. Pemanggil WAJIB memperingatkan penggunanya.
pub fn export_database(
    state: &DesktopState,
    passphrase: Option<&str>,
) -> Result<ExportReport, CommandError> {
    let source = hub_path(state)?;
    if !source.is_file() {
        return Err(CommandError::new(
            "LOCAL_DB_UNAVAILABLE",
            "The local database file does not exist on this device yet.",
        ));
    }

    let staging_dir = state.data_dir.join("backup-staging");
    fs::create_dir_all(&staging_dir).map_err(|_| {
        CommandError::new("BACKUP_FAILED", "The temporary backup folder could not be created.")
    })?;

    let plain_path = staging_dir.join("hub-export.db");
    vacuum_into(&source, &plain_path)?;

    let passphrase = passphrase.map(str::trim).filter(|value| !value.is_empty());
    let encrypted = passphrase.is_some();
    let file_name = backup_file_name(encrypted);
    let output = staging_dir.join(&file_name);

    let size_bytes = if let Some(passphrase) = passphrase {
        let plain = Zeroizing::new(fs::read(&plain_path).map_err(|_| {
            CommandError::new("BACKUP_FAILED", "The database copy could not be read.")
        })?);
        let payload = encrypt_backup(&plain, passphrase)?;
        let size = payload.len() as u64;
        fs::write(&output, payload).map_err(|_| {
            CommandError::new("BACKUP_FAILED", "The backup file could not be written.")
        })?;
        // Salinan polos tidak boleh tertinggal di disk setelah dienkripsi.
        let _ = fs::remove_file(&plain_path);
        size
    } else {
        fs::rename(&plain_path, &output).map_err(|_| {
            CommandError::new("BACKUP_FAILED", "The backup file could not be prepared.")
        })?;
        fs::metadata(&output).map(|meta| meta.len()).unwrap_or(0)
    };

    // Salin ke folder yang benar-benar bisa dibuka pengguna. Berkas di folder
    // staging tetap dipertahankan sebagai sumber: pada Android ia satu-satunya
    // salinan yang pasti ada, dan jalur berbagi nanti membacanya dari sana.
    let public_path = copy_to_public_dir(&output, &file_name)
        .map(|path| path.to_string_lossy().into_owned());

    Ok(ExportReport {
        path: output.to_string_lossy().into_owned(),
        file_name,
        size_bytes,
        encrypted,
        public_path,
    })
}

/// Periksa apakah berkas benar-benar database hub yang layak dipulihkan.
///
/// Menolak lebih awal jauh lebih baik daripada menimpa data perusahaan dengan
/// berkas yang ternyata bukan database, atau yang skemanya lebih baru daripada
/// yang dipahami aplikasi ini.
fn inspect_candidate(path: &Path) -> Result<(i64, i64), CommandError> {
    let connection = Connection::open(path).map_err(|_| {
        CommandError::new(
            "BACKUP_CORRUPT",
            "This file is not a SQLite database that can be opened.",
        )
    })?;

    let integrity: String = connection
        .query_row("PRAGMA integrity_check;", [], |row| row.get(0))
        .map_err(|_| {
            CommandError::new(
                "BACKUP_CORRUPT",
                "This file is not a valid SQLite database.",
            )
        })?;
    if integrity != "ok" {
        return Err(CommandError::new(
            "BACKUP_CORRUPT",
            format!("Database cadangan rusak: {integrity}"),
        ));
    }

    let table_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('master_operator', 'app_role', 'app_permission', 'setting_gex_system', 'schema_migration');",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if table_count < 5 {
        return Err(CommandError::new(
            "BACKUP_NOT_RECOGNIZED",
            "This file is a SQLite database, but not this app's database.",
        ));
    }

    let schema_version: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migration WHERE version > 0;",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    if schema_version > CLIENT_SCHEMA_VERSION {
        return Err(CommandError::new(
            "SCHEMA_VERSION_OUTDATED",
            format!(
                "The backup file uses schema version {schema_version}, but this app only supports version {CLIENT_SCHEMA_VERSION}. Update the app first so columns from the newer version are not lost."
            ),
        ));
    }

    let total_tables: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    Ok((schema_version, total_tables))
}

/// Ganti berkas hub dengan isi berkas cadangan.
///
/// Berkas lama TIDAK dihapus, melainkan disimpan berdampingan: pemulihan yang
/// salah pilih berkas tidak boleh berarti kehilangan data yang lama.
pub fn import_database(
    state: &DesktopState,
    source: &Path,
    passphrase: Option<&str>,
) -> Result<ImportReport, CommandError> {
    let metadata = fs::metadata(source).map_err(|_| {
        CommandError::new("BACKUP_NOT_FOUND", "The backup file could not be read.")
    })?;
    if metadata.len() > MAX_BACKUP_BYTES {
        return Err(CommandError::new(
            "BACKUP_TOO_LARGE",
            "The backup file is larger than can be processed.",
        ));
    }

    let raw = fs::read(source).map_err(|_| {
        CommandError::new("BACKUP_NOT_FOUND", "The backup file could not be read.")
    })?;

    import_payload(state, &raw, &source.to_string_lossy(), passphrase)
}

/// Pulihkan dari isi berkas yang sudah dibaca WebView.
///
/// Android tidak pernah menyerahkan path sebenarnya kepada halaman web —
/// `<input type="file">` hanya memberi isinya. Jalur ini karena itu WAJIB ada
/// agar pemulihan bisa dilakukan di Mobile, dan ia memakai validasi yang sama
/// persis dengan jalur berbasis path: tidak ada pintu belakang yang lebih
/// longgar hanya karena berkasnya datang dari pemilih berkas.
pub fn import_database_bytes(
    state: &DesktopState,
    payload: &[u8],
    label: &str,
    passphrase: Option<&str>,
) -> Result<ImportReport, CommandError> {
    if payload.len() as u64 > MAX_BACKUP_BYTES {
        return Err(CommandError::new(
            "BACKUP_TOO_LARGE",
            "The backup file is larger than can be processed.",
        ));
    }
    import_payload(state, payload, label, passphrase)
}

fn import_payload(
    state: &DesktopState,
    raw: &[u8],
    label: &str,
    passphrase: Option<&str>,
) -> Result<ImportReport, CommandError> {
    let destination = hub_path(state)?;

    let staging_dir = state.data_dir.join("backup-staging");
    fs::create_dir_all(&staging_dir).map_err(|_| {
        CommandError::new("BACKUP_FAILED", "The temporary backup folder could not be created.")
    })?;
    let candidate = staging_dir.join("hub-import.db");
    let _ = fs::remove_file(&candidate);

    if is_encrypted_backup(raw) {
        let passphrase = passphrase
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                CommandError::new(
                    "BACKUP_PASSPHRASE_REQUIRED",
                    "This backup file is encrypted. Enter the passphrase used when exporting it.",
                )
            })?;
        let plain = Zeroizing::new(decrypt_backup(raw, passphrase)?);
        fs::write(&candidate, plain.as_slice()).map_err(|_| {
            CommandError::new("BACKUP_FAILED", "The backup file could not be prepared.")
        })?;
    } else {
        fs::write(&candidate, raw).map_err(|_| {
            CommandError::new("BACKUP_FAILED", "The backup file could not be prepared.")
        })?;
    }

    let (schema_version, table_count) = inspect_candidate(&candidate)?;

    // Simpan berkas lama sebelum ditimpa. Pemulihan yang keliru tidak boleh
    // berarti kehilangan data yang sudah ada.
    let previous_backup = if destination.is_file() {
        let stamp = super::storage::now_epoch_seconds();
        let kept = destination.with_extension(format!("pre-restore-{stamp}.db"));
        match fs::rename(&destination, &kept) {
            Ok(()) => Some(kept.to_string_lossy().into_owned()),
            Err(_) => {
                return Err(CommandError::new(
                    "RESTORE_FAILED",
                    "The old database could not be secured, so the restore was cancelled.",
                ))
            }
        }
    } else {
        None
    };

    // Berkas `-wal`/`-shm` milik database lama tidak boleh tertinggal: keduanya
    // menunjuk database yang sudah tidak ada lagi dan akan merusak berkas baru.
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = destination.clone().into_os_string();
        sidecar.push(suffix);
        let _ = fs::remove_file(PathBuf::from(sidecar));
    }

    if let Err(error) = fs::rename(&candidate, &destination) {
        // Kembalikan berkas lama agar perangkat tidak tertinggal tanpa database.
        if let Some(kept) = previous_backup.as_ref() {
            let _ = fs::rename(PathBuf::from(kept), &destination);
        }
        return Err(CommandError::new(
            "RESTORE_FAILED",
            format!("The backup database could not be installed: {error}"),
        ));
    }

    Ok(ImportReport {
        schema_version,
        table_count,
        restored_from: label.to_owned(),
        previous_backup,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Database hub minimal yang lolos pemeriksaan `inspect_candidate`.
    fn buat_hub(path: &Path) {
        let connection = Connection::open(path).expect("buka");
        connection
            .execute_batch(
                "CREATE TABLE schema_migration (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);
                 CREATE TABLE master_operator (id INTEGER PRIMARY KEY, username TEXT);
                 CREATE TABLE app_role (id INTEGER PRIMARY KEY, role_key TEXT);
                 CREATE TABLE app_permission (permission_key TEXT PRIMARY KEY);
                 CREATE TABLE setting_gex_system (key TEXT PRIMARY KEY, value TEXT);
                 INSERT INTO setting_gex_system (key, value) VALUES ('contoh', '1');",
            )
            .expect("skema uji");
        connection
            .execute(
                "INSERT INTO schema_migration (version, name, applied_at) VALUES (?1, 'versi-klien', '2026-01-01');",
                [CLIENT_SCHEMA_VERSION],
            )
            .expect("versi skema klien");
    }

    #[test]
    fn berkas_terenkripsi_bolak_balik_utuh() {
        let asli = b"isi database rahasia".to_vec();
        let terenkripsi = encrypt_backup(&asli, "frasa sandi kantor").expect("enkripsi");

        assert!(is_encrypted_backup(&terenkripsi));
        // Isi asli tidak boleh terbaca mentah di dalam berkas.
        assert!(!terenkripsi.windows(asli.len()).any(|w| w == asli.as_slice()));

        let kembali = decrypt_backup(&terenkripsi, "frasa sandi kantor").expect("dekripsi");
        assert_eq!(kembali, asli);
    }

    #[test]
    fn frasa_sandi_salah_ditolak_dengan_kode_yang_jelas() {
        let terenkripsi = encrypt_backup(b"rahasia", "benar").expect("enkripsi");
        let error = decrypt_backup(&terenkripsi, "salah").expect_err("harus gagal");
        assert_eq!(error.code, "BACKUP_PASSPHRASE_INVALID");
    }

    /// Inti Fase 05: salinan diambil dari database yang SEDANG berjalan, dan
    /// transaksi terakhir tetap ikut. Menyalin berkas utama begitu saja pada
    /// mode WAL akan kehilangan baris terakhir ini.
    #[test]
    fn vacuum_into_menangkap_transaksi_terakhir_pada_mode_wal() {
        let dir = tempdir().expect("dir");
        let hub = dir.path().join("hub.db");
        let connection = Connection::open(&hub).expect("buka");
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE catatan (id INTEGER PRIMARY KEY, nama TEXT);
                 INSERT INTO catatan (nama) VALUES ('lama');",
            )
            .expect("siapkan");

        // Koneksi SENGAJA dibiarkan terbuka: inilah keadaan aplikasi yang hidup.
        connection
            .execute("INSERT INTO catatan (nama) VALUES ('baru');", [])
            .expect("baris terakhir");

        let salinan = dir.path().join("salinan.db");
        vacuum_into(&hub, &salinan).expect("vacuum into");

        let dibaca = Connection::open(&salinan).expect("buka salinan");
        let jumlah: i64 = dibaca
            .query_row("SELECT COUNT(*) FROM catatan;", [], |row| row.get(0))
            .expect("hitung");
        assert_eq!(jumlah, 2, "baris terakhir wajib ikut tersalin");
    }

    #[test]
    fn database_asing_ditolak_sebelum_menimpa_apa_pun() {
        let dir = tempdir().expect("dir");
        let asing = dir.path().join("asing.db");
        Connection::open(&asing)
            .expect("buka")
            .execute_batch("CREATE TABLE lain (x INTEGER);")
            .expect("skema asing");

        let error = inspect_candidate(&asing).expect_err("harus ditolak");
        assert_eq!(error.code, "BACKUP_NOT_RECOGNIZED");
    }

    #[test]
    fn berkas_bukan_database_ditolak() {
        let dir = tempdir().expect("dir");
        let sampah = dir.path().join("sampah.db");
        fs::write(&sampah, b"ini hanya teks biasa, bukan database").expect("tulis");
        assert!(inspect_candidate(&sampah).is_err());
    }

    /// Cadangan dari aplikasi yang LEBIH BARU wajib ditolak: memulihkannya
    /// berarti membuang kolom yang belum dikenal aplikasi ini.
    #[test]
    fn skema_lebih_baru_ditolak() {
        let dir = tempdir().expect("dir");
        let hub = dir.path().join("hub.db");
        buat_hub(&hub);
        Connection::open(&hub)
            .expect("buka")
            .execute(
                "INSERT INTO schema_migration (version, name, applied_at) VALUES (?1, 'masa depan', '2027-01-01');",
                [CLIENT_SCHEMA_VERSION + 1],
            )
            .expect("versi masa depan");

        let error = inspect_candidate(&hub).expect_err("harus ditolak");
        assert_eq!(error.code, "SCHEMA_VERSION_OUTDATED");
    }

    #[test]
    fn hub_yang_sah_diterima_dengan_versi_skemanya() {
        let dir = tempdir().expect("dir");
        let hub = dir.path().join("hub.db");
        buat_hub(&hub);

        let (versi, jumlah_tabel) = inspect_candidate(&hub).expect("harus diterima");
        assert_eq!(versi, CLIENT_SCHEMA_VERSION);
        assert!(jumlah_tabel >= 5);
    }
}

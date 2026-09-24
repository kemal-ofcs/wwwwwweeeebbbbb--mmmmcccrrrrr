//! Lisensi offline Ed25519 (format `LIS1`) untuk build Desktop dan Mobile.
//!
//! Penerbitnya hidup DI LUAR repo ini — alat `E:\Freelance\lisensi` milik
//! Kemal Office Studio, dipakai lintas produk — dan satu-satunya yang tahu
//! private key. Aplikasi hanya memegang PUBLIC key, jadi lisensi bisa diperiksa
//! tanpa jaringan.
//!
//! Berkas ini SENGAJA mandiri (helper tanggal dibawa sendiri di bagian bawah)
//! supaya bisa disalin utuh ke aplikasi baru. Setelah `rename-project.ts`,
//! yang perlu diganti hanya `LICENSE_PRODUCT` (diganti skrip itu) dan
//! `PRODUCT_PUBLIC_KEY_HEX` (hasil `bun run keygen kos-<aplikasi>`).
//!
//! Aturan validasi isi lisensi WAJIB identik dengan `validasiLisensi` di
//! `lisensi/src/format.ts`; keduanya diuji dengan vektor yang sama
//! (`VECTOR_V1`/`VECTOR_V2` di bawah = `VEKTOR_V1`/`VEKTOR_V2` di
//! `lisensi/test/format.test.ts`, produk `kos-absensi`).
//!
//! Lisensinya disimpan di kunci `app_license` tabel `setting_gex_system` yang
//! ikut sinkronisasi: dipasang SEKALI per lembaga, perangkat lain menerimanya
//! lewat pull. Web sengaja tidak menegakkannya.

use base64::prelude::*;
use ring::signature::{UnparsedPublicKey, ED25519};
use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{config::DesktopState, models::CommandError, storage, sync};

/// Kode produk aplikasi ini di alat lisensi. Setiap aplikasi penerbit punya
/// kode (dan pasangan kunci) sendiri, supaya lisensi satu aplikasi tidak sah
/// di aplikasi lain.
pub const LICENSE_PRODUCT: &str = "kos-template";
pub const LICENSE_SETTING_KEY: &str = "app_license";
/// Penerbit lisensi yang disebut di pesan untuk klien. Padanannya di UI:
/// `LICENSE_ISSUER` di `lib/gateways/license.ts`.
pub const LICENSE_ISSUER: &str = "Kemal Office Studio";

/// Public key produk ini, hasil `bun run keygen <LICENSE_PRODUCT>` di folder
/// alat lisensi. Aman dibagikan. Selama masih berisi nol, SETIAP lisensi
/// ditolak — gagal tertutup, bukan terbuka. `rename-project.ts` mengembalikannya
/// ke nol, karena aplikasi baru wajib punya pasangan kunci sendiri.
const PRODUCT_PUBLIC_KEY_HEX: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

/// Tanggal build (WIB), ditulis `build.rs`. Dibandingkan dengan
/// `pembaruan_sampai`: versi yang dibangun setelah masa pembaruan habis tidak
/// tercakup lisensinya, sementara versi lama tetap bisa dipakai selamanya.
pub const BUILD_DATE: &str = env!("KOS_BUILD_DATE");

const LICENSE_PREFIX: &str = "LIS1";
const MAX_LICENSE_TEXT: usize = 16_384;
const MAX_DEVICES: usize = 200;
const MAX_HOLDER_CHARS: usize = 120;
const LICENSE_KINDS: [&str; 2] = ["beli_putus", "sewa"];
const LICENSE_KEYS: [&str; 10] = [
    "v",
    "produk",
    "id",
    "pemegang",
    "jenis",
    "terbit",
    "pembaruan_sampai",
    "berlaku_sampai",
    "perangkat",
    "kunci_mobile",
];

/// Izin yang tetap boleh dalam mode baca-saja selain semua `*.view`.
/// Sinkronisasi harus tetap jalan supaya data yang masih tertahan di outbox
/// sampai ke cloud, dan ekspor harus tetap jalan karena datanya milik klien —
/// lisensi yang habis tidak boleh menyandera data absensi dan gaji mereka.
const READ_ONLY_EXTRA_PERMISSIONS: [&str; 2] = ["sync.retry", "database_backup.export"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicensePayload {
    pub id: String,
    pub holder: String,
    pub kind: String,
    pub issued: String,
    pub updates_until: String,
    pub valid_until: Option<String>,
    pub devices: Vec<String>,
    pub lock_mobile: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LicenseState {
    Active,
    ReadOnly,
    Missing,
    Invalid,
    DeviceNotListed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadOnlyReason {
    Expired,
    VersionNotCovered,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Evaluation {
    pub state: LicenseState,
    pub read_only_reason: Option<ReadOnlyReason>,
    pub message: Option<String>,
    pub payload: Option<LicensePayload>,
}

/// Hak yang dibawa sesi login. `read_only` dihitung saat login; `valid_until`
/// dibandingkan ulang di setiap gerbang izin karena terminal pemindai bisa
/// tetap login berbulan-bulan melewati tanggal berakhirnya sewa.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LicenseGrant {
    pub read_only: Option<ReadOnlyReason>,
    pub valid_until: Option<String>,
    pub updates_until: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    pub state: LicenseState,
    pub read_only_reason: Option<ReadOnlyReason>,
    pub message: Option<String>,
    pub license: Option<LicensePayload>,
    /// Sisa hari sewa (hari ini ikut dihitung); `None` untuk beli putus.
    pub days_left: Option<i64>,
    pub device_code: String,
    pub device_bound: bool,
    pub build_date: String,
}

fn is_product_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    (2..=40).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn is_license_id(value: &str) -> bool {
    (1..=40).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub fn is_device_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 21
        && matches!(bytes[0], b'W' | b'L' | b'A' | b'M')
        && bytes.iter().enumerate().skip(1).all(|(index, byte)| {
            if index % 5 == 1 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'A'..=b'F').contains(byte)
            }
        })
}

fn string_field<'a>(object: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

/// Cermin `validasiLisensi` (TS): urutan pemeriksaan dan pesannya sama.
fn validate_payload(value: &Value) -> Result<(String, LicensePayload), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "The license contents must be a JSON object.".to_owned())?;
    if let Some(unknown) = object
        .keys()
        .find(|key| !LICENSE_KEYS.contains(&key.as_str()))
    {
        return Err(format!("Unknown license field: {unknown}."));
    }
    if object.get("v").and_then(Value::as_i64) != Some(1) {
        return Err("Unsupported license version.".into());
    }
    let product = string_field(object, "produk")
        .filter(|value| is_product_code(value))
        .ok_or_else(|| "Invalid product code.".to_owned())?;
    let id = string_field(object, "id")
        .filter(|value| is_license_id(value))
        .ok_or_else(|| "Invalid license ID.".to_owned())?;
    let holder = string_field(object, "pemegang")
        .filter(|value| {
            !value.is_empty()
                && value.trim() == *value
                && value.chars().count() <= MAX_HOLDER_CHARS
                && !value
                    .chars()
                    .any(|character| matches!(character, '\u{0}'..='\u{1f}' | '\u{7f}'))
        })
        .ok_or_else(|| "Invalid license holder name.".to_owned())?;
    let kind = string_field(object, "jenis")
        .filter(|value| LICENSE_KINDS.contains(value))
        .ok_or_else(|| "Unknown license type.".to_owned())?;
    let issued = string_field(object, "terbit")
        .filter(|value| is_calendar_date(value))
        .ok_or_else(|| "Invalid issue date.".to_owned())?;
    let updates_until = string_field(object, "pembaruan_sampai")
        .filter(|value| is_calendar_date(value))
        .ok_or_else(|| "Invalid pembaruan_sampai (updates until) date.".to_owned())?;
    if updates_until < issued {
        return Err("pembaruan_sampai (updates until) cannot be before the issue date.".into());
    }
    let valid_until = if kind == "beli_putus" {
        if object.get("berlaku_sampai") != Some(&Value::Null) {
            return Err("A beli_putus (perpetual) license has no berlaku_sampai (valid until).".into());
        }
        None
    } else {
        let until = string_field(object, "berlaku_sampai")
            .filter(|value| is_calendar_date(value))
            .ok_or_else(|| "A sewa (rental) license must have berlaku_sampai (valid until).".to_owned())?;
        if until < issued {
            return Err("berlaku_sampai (valid until) cannot be before the issue date.".into());
        }
        Some(until.to_owned())
    };
    let devices = object
        .get("perangkat")
        .and_then(Value::as_array)
        .filter(|devices| devices.len() <= MAX_DEVICES)
        .ok_or_else(|| {
            format!("The device list must be an array of at most {MAX_DEVICES} codes.")
        })?;
    let mut codes: Vec<String> = Vec::with_capacity(devices.len());
    for device in devices {
        let code = device
            .as_str()
            .filter(|code| is_device_code(code))
            .ok_or_else(|| format!("Invalid device code: {device}."))?;
        if codes.iter().any(|seen| seen == code) {
            return Err(format!("Duplicate device code: {code}."));
        }
        codes.push(code.to_owned());
    }
    let lock_mobile = object
        .get("kunci_mobile")
        .and_then(Value::as_bool)
        .ok_or_else(|| "kunci_mobile must be true or false.".to_owned())?;
    Ok((
        product.to_owned(),
        LicensePayload {
            id: id.to_owned(),
            holder: holder.to_owned(),
            kind: kind.to_owned(),
            issued: issued.to_owned(),
            updates_until: updates_until.to_owned(),
            valid_until,
            devices: codes,
            lock_mobile,
        },
    ))
}

/// Buang SEMUA spasi, tab, dan baris baru. Teks yang disalin dari terminal atau
/// WhatsApp sering terpotong di tengah; base64url tidak pernah memuat spasi,
/// jadi membuangnya tidak mungkin mengubah lisensi yang sah.
/// Cermin `rapikanTeks` di `lisensi/src/format.ts`.
pub fn compact_license_text(text: &str) -> String {
    text.chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

/// Verifikasi tanda tangan lalu validasi isi. Tanda tangan dihitung atas byte
/// `LIS1.<payload>` persis seperti tertulis, jadi JSON-nya tidak pernah disusun
/// ulang dan urutan kunci tidak memengaruhi keabsahan.
pub fn parse_license(text: &str, public_key: &[u8]) -> Result<LicensePayload, String> {
    parse_license_for(text, public_key, LICENSE_PRODUCT)
}

/// `parse_license` untuk kode produk tertentu. Tes memakainya dengan vektor
/// kanonik alat penerbit (`kos-absensi`), supaya vektor tidak perlu dibuat
/// ulang setiap kali template dijadikan aplikasi baru.
pub fn parse_license_for(
    text: &str,
    public_key: &[u8],
    expected_product: &str,
) -> Result<LicensePayload, String> {
    if text.len() > MAX_LICENSE_TEXT * 4 {
        return Err("The license text is too long.".into());
    }
    let text = compact_license_text(text);
    if text.len() > MAX_LICENSE_TEXT {
        return Err("The license text is too long.".into());
    }
    let parts = text.split('.').collect::<Vec<_>>();
    if parts.len() != 3 || parts[0] != LICENSE_PREFIX {
        return Err("This text is not a LIS1 license.".into());
    }
    let signature = BASE64_URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| "The license signature is corrupt.".to_owned())?;
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    UnparsedPublicKey::new(&ED25519, public_key)
        .verify(signing_input.as_bytes(), &signature)
        .map_err(|_| "The license signature does not match.".to_owned())?;
    let payload = BASE64_URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| "The license contents are corrupt.".to_owned())?;
    let value: Value =
        serde_json::from_slice(&payload).map_err(|_| "The license contents are corrupt.".to_owned())?;
    let (product, license) = validate_payload(&value)?;
    if product != expected_product {
        return Err(format!(
            "This license was issued for another product ({product})."
        ));
    }
    Ok(license)
}

/// Apakah perangkat ini WAJIB tercantum di daftar perangkat lisensi.
pub fn device_must_be_listed(license: &LicensePayload, is_mobile: bool) -> bool {
    !license.devices.is_empty() && (!is_mobile || license.lock_mobile)
}

pub fn evaluate(
    text: Option<&str>,
    public_key: &[u8],
    device_code: &str,
    is_mobile: bool,
    build_date: &str,
    today: &str,
) -> Evaluation {
    let blocked =
        |state: LicenseState, message: String, payload: Option<LicensePayload>| Evaluation {
            state,
            read_only_reason: None,
            message: Some(message),
            payload,
        };
    let Some(text) = text.map(str::trim).filter(|text| !text.is_empty()) else {
        return blocked(
            LicenseState::Missing,
            format!("This app has no license yet. Send the device code below to {LICENSE_ISSUER} to get one."),
            None,
        );
    };
    if public_key.iter().all(|byte| *byte == 0) {
        return blocked(
            LicenseState::Invalid,
            format!(
                "This app build has no license public key yet. Contact {LICENSE_ISSUER}."
            ),
            None,
        );
    }
    let license = match parse_license(text, public_key) {
        Ok(license) => license,
        Err(reason) => {
            return blocked(
                LicenseState::Invalid,
                format!("Invalid license: {reason}"),
                None,
            )
        }
    };
    if device_must_be_listed(&license, is_mobile)
        && !license.devices.iter().any(|code| code == device_code)
    {
        let message = format!(
            "This device ({device_code}) is not registered in license {}. Send this device code to {LICENSE_ISSUER} to have it added.",
            license.holder
        );
        return blocked(LicenseState::DeviceNotListed, message, Some(license));
    }
    let read_only = |reason: ReadOnlyReason, message: String, license: LicensePayload| Evaluation {
        state: LicenseState::ReadOnly,
        read_only_reason: Some(reason),
        message: Some(message),
        payload: Some(license),
    };
    if let Some(until) = license.valid_until.as_deref() {
        if today > until {
            let message = expired_message(until);
            return read_only(ReadOnlyReason::Expired, message, license);
        }
    }
    if build_date > license.updates_until.as_str() {
        let message = version_message(&license.updates_until, build_date);
        return read_only(ReadOnlyReason::VersionNotCovered, message, license);
    }
    Evaluation {
        state: LicenseState::Active,
        read_only_reason: None,
        message: None,
        payload: Some(license),
    }
}

fn expired_message(until: &str) -> String {
    format!(
        "The license expired on {until}. The app runs in read-only mode: data can still be viewed, exported, and synced. Activate a new license to change data again."
    )
}

fn version_message(updates_until: &str, build_date: &str) -> String {
    format!(
        "This app version (build {build_date}) is newer than the license update period (until {updates_until}). The app runs in read-only mode. Renew the update plan, or reinstall a version released before that date."
    )
}

/// Hak sesi dari hasil evaluasi. `None` = lisensi tidak mengizinkan login sama sekali.
pub fn grant_from(evaluation: &Evaluation) -> Option<LicenseGrant> {
    if !matches!(
        evaluation.state,
        LicenseState::Active | LicenseState::ReadOnly
    ) {
        return None;
    }
    let license = evaluation.payload.as_ref()?;
    Some(LicenseGrant {
        read_only: evaluation.read_only_reason,
        valid_until: license.valid_until.clone(),
        updates_until: license.updates_until.clone(),
    })
}

pub fn read_only_allows(permission: &str) -> bool {
    permission.ends_with(".view") || READ_ONLY_EXTRA_PERMISSIONS.contains(&permission)
}

pub fn grant_allows(grant: &LicenseGrant, permission: &str, today: &str) -> bool {
    if read_only_allows(permission) {
        return true;
    }
    grant.read_only.is_none()
        && grant
            .valid_until
            .as_deref()
            .map_or(true, |until| today <= until)
}

fn read_only_error(grant: &LicenseGrant) -> CommandError {
    let message = match (grant.read_only, grant.valid_until.as_deref()) {
        (Some(ReadOnlyReason::VersionNotCovered), _) => {
            version_message(&grant.updates_until, BUILD_DATE)
        }
        (_, Some(until)) => expired_message(until),
        _ => "The license is in read-only mode.".to_owned(),
    };
    CommandError::new("LICENSE_READ_ONLY", message)
}

/// Kode perangkat: 16 hex pertama SHA-256 id mentah, diawali huruf platform.
/// Id mentahnya di-hash supaya MachineGuid asli tidak pernah bocor, dan nama
/// produk ikut di-hash supaya PC yang sama memberi kode berbeda untuk tiap
/// aplikasi milik penerbit yang sama.
pub fn device_code(platform_prefix: char, raw_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"lisensi-perangkat-v1:");
    hash.update(LICENSE_PRODUCT.as_bytes());
    hash.update(b":");
    hash.update(raw_id.as_bytes());
    let hex = hex::encode_upper(&hash.finalize()[..8]);
    format!(
        "{platform_prefix}-{}-{}-{}-{}",
        &hex[0..4],
        &hex[4..8],
        &hex[8..12],
        &hex[12..16]
    )
}

// ---------------------------------------------------------------------------
// I/O: identitas perangkat, penyimpanan, dan gerbang.
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
const PLATFORM_PREFIX: char = 'W';
#[cfg(all(target_os = "linux", not(target_os = "android")))]
const PLATFORM_PREFIX: char = 'L';
#[cfg(target_os = "android")]
const PLATFORM_PREFIX: char = 'A';
#[cfg(any(target_os = "macos", target_os = "ios"))]
const PLATFORM_PREFIX: char = 'M';

const IS_MOBILE: bool = cfg!(any(target_os = "android", target_os = "ios"));

/// Id mesin yang bertahan melewati instal ulang aplikasi. Windows: MachineGuid
/// (berubah bila Windows diinstal ulang, dan SAMA pada PC hasil kloning image).
/// Linux: machine-id. Platform lain — dan kegagalan membaca — jatuh ke id acak
/// aplikasi, yang hilang bila aplikasi dihapus beserta datanya.
fn hardware_id() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        windows_registry::LOCAL_MACHINE
            .open("SOFTWARE\\Microsoft\\Cryptography")
            .and_then(|key| key.get_string("MachineGuid"))
            .ok()
            .map(|value| value.trim().to_lowercase())
            .filter(|value| !value.is_empty())
    }
    #[cfg(all(target_os = "linux", not(target_os = "android")))]
    {
        ["/etc/machine-id", "/var/lib/dbus/machine-id"]
            .iter()
            .find_map(|path| std::fs::read_to_string(path).ok())
            .map(|value| value.trim().to_lowercase())
            .filter(|value| !value.is_empty())
    }
    #[cfg(not(any(
        target_os = "windows",
        all(target_os = "linux", not(target_os = "android"))
    )))]
    {
        None
    }
}

pub fn current_device_code(state: &DesktopState) -> Result<String, CommandError> {
    let raw = match hardware_id() {
        Some(raw) => raw,
        None => storage::get_or_create_device_id(&state.data_dir)?,
    };
    Ok(device_code(PLATFORM_PREFIX, &raw))
}

pub fn today_wib() -> String {
    wib_date_from_epoch(storage::now_epoch_seconds())
}

fn product_public_key() -> Vec<u8> {
    hex::decode(PRODUCT_PUBLIC_KEY_HEX).unwrap_or_default()
}

fn stored_license(state: &DesktopState) -> Result<Option<String>, CommandError> {
    storage::get_system_setting(&state.data_dir, LICENSE_SETTING_KEY)
}

fn evaluate_text(text: Option<&str>, device_code: &str) -> Evaluation {
    evaluate(
        text,
        &product_public_key(),
        device_code,
        IS_MOBILE,
        BUILD_DATE,
        &today_wib(),
    )
}

/// Ambil lisensi dari cloud bila salinan lokal belum sah — perangkat baru yang
/// bergabung ke database yang sudah berlisensi belum pernah menarik snapshot.
/// Baris lokal yang event outbox-nya masih menggantung (lisensi yang baru saja
/// dipasang saat offline) tidak ditimpa, sama seperti aturan pull biasa.
async fn refresh_from_cloud(state: &DesktopState) -> Result<(), CommandError> {
    let Ok(client) = state.get_turso_client() else {
        return Ok(());
    };
    let pending: bool = storage::database(&state.data_dir)?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM desktop_sync_outbox WHERE domain = 'setting' AND entity_key = ? AND status IN ('pending', 'failed', 'conflict') LIMIT 1);",
            params![LICENSE_SETTING_KEY],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())?;
    if pending {
        return Ok(());
    }
    let cloud = client
        .query_one(
            "SELECT value FROM setting_gex_system WHERE key = ? LIMIT 1;",
            vec![json!(LICENSE_SETTING_KEY)],
        )
        .await?
        .to_objects()
        .into_iter()
        .next()
        .and_then(|row| row.get("value").and_then(Value::as_str).map(str::to_owned))
        .filter(|value| !value.trim().is_empty());
    if let Some(value) = cloud {
        storage::set_system_setting(&state.data_dir, LICENSE_SETTING_KEY, &value)?;
    }
    Ok(())
}

/// Evaluasi lisensi perangkat ini. Membaca lokal lebih dulu; cloud hanya
/// ditanya bila salinan lokal tidak aktif, supaya layar login pemasangan yang
/// sehat tidak pernah menunggu jaringan.
pub async fn resolve(state: &DesktopState) -> Result<(Evaluation, String), CommandError> {
    let code = current_device_code(state)?;
    let local = evaluate_text(stored_license(state)?.as_deref(), &code);
    if local.state == LicenseState::Active {
        return Ok((local, code));
    }
    if let Err(error) = refresh_from_cloud(state).await {
        eprintln!("[license] The cloud license could not be read: {}", error.code);
        return Ok((local, code));
    }
    Ok((
        evaluate_text(stored_license(state)?.as_deref(), &code),
        code,
    ))
}

/// Sisa hari sewa dengan hari ini ikut dihitung: hari terakhir sewa = 1, sewa
/// yang sudah lewat = 0. Sama dengan cara alat penerbit menghitung `--hari`,
/// sehingga sewa 30 hari menampilkan "30 hari" pada hari terbitnya.
pub fn rental_days_left(valid_until: &str, today: &str) -> Option<i64> {
    days_between(today, valid_until)
        .ok()
        .map(|days| (days + 1).max(0))
}

fn to_status(evaluation: Evaluation, device_code: String) -> LicenseStatus {
    let device_bound = evaluation
        .payload
        .as_ref()
        .is_some_and(|license| device_must_be_listed(license, IS_MOBILE));
    let days_left = evaluation
        .payload
        .as_ref()
        .and_then(|license| license.valid_until.as_deref())
        .and_then(|until| rental_days_left(until, &today_wib()));
    LicenseStatus {
        state: evaluation.state,
        read_only_reason: evaluation.read_only_reason,
        message: evaluation.message,
        license: evaluation.payload,
        days_left,
        device_code,
        device_bound,
        build_date: BUILD_DATE.to_owned(),
    }
}

pub async fn status(state: &DesktopState) -> Result<LicenseStatus, CommandError> {
    let (evaluation, code) = resolve(state).await?;
    Ok(to_status(evaluation, code))
}

/// Gerbang login: tanpa lisensi, lisensi tidak sah, atau perangkat yang tidak
/// terdaftar tidak boleh membuat sesi sama sekali. Lisensi yang habis tetap
/// boleh masuk — dalam mode baca-saja.
pub async fn gate_login(state: &DesktopState) -> Result<LicenseGrant, CommandError> {
    let (evaluation, _) = resolve(state).await?;
    if let Some(grant) = grant_from(&evaluation) {
        return Ok(grant);
    }
    let code = match evaluation.state {
        LicenseState::DeviceNotListed => "LICENSE_DEVICE_NOT_LISTED",
        LicenseState::Missing => "LICENSE_MISSING",
        _ => "LICENSE_INVALID",
    };
    Err(CommandError::new(
        code,
        evaluation
            .message
            .unwrap_or_else(|| "Invalid license.".into()),
    ))
}

/// Verifikasi lisensi yang akan dipasang: hanya lisensi yang AKTIF penuh untuk
/// perangkat ini yang diterima, supaya tidak ada yang bisa mengunci dirinya
/// sendiri keluar dengan memasang lisensi yang tidak mencantumkan perangkatnya.
pub fn check_installable(text: &str, device_code: &str) -> Result<LicensePayload, CommandError> {
    let evaluation = evaluate_text(Some(text), device_code);
    match (evaluation.state, evaluation.payload) {
        (LicenseState::Active, Some(license)) => Ok(license),
        (_, _) => Err(CommandError::new(
            "LICENSE_REJECTED",
            evaluation
                .message
                .unwrap_or_else(|| "Invalid license.".into()),
        )),
    }
}

/// Fungsi sinkron terpisah: koneksi rusqlite tidak `Send`, jadi ia wajib sudah
/// tertutup sebelum `install` menunggu jaringan.
fn store_local_and_enqueue(state: &DesktopState, text: &str) -> Result<(), CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    transaction
        .execute(
            "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            params![LICENSE_SETTING_KEY, text],
        )
        .map_err(|_| CommandError::internal())?;
    let _ = transaction.execute(
        "DELETE FROM desktop_sync_conflict WHERE domain = 'setting' AND entity_key = ?;",
        params![LICENSE_SETTING_KEY],
    );
    let _ = transaction.execute(
        "DELETE FROM desktop_sync_outbox WHERE domain = 'setting' AND entity_key = ? AND status IN ('pending', 'failed', 'conflict');",
        params![LICENSE_SETTING_KEY],
    );
    sync::enqueue(
        &transaction,
        &client_id,
        "setting",
        "update",
        LICENSE_SETTING_KEY,
        &json!({ "key": LICENSE_SETTING_KEY, "value": text }),
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())
}

/// Pasang lisensi di perangkat ini dan antrekan ke cloud lewat rute kanonik
/// `setting/update`. Juga ditulis langsung ke cloud bila terjangkau, supaya
/// perangkat lain menerimanya tanpa menunggu siapa pun login di sini.
pub async fn install(state: &DesktopState, text: &str) -> Result<LicenseStatus, CommandError> {
    let text = compact_license_text(text);
    let code = current_device_code(state)?;
    let license = check_installable(&text, &code)?;
    let (current, _) = resolve(state).await?;
    let operator = state
        .session
        .lock()
        .map_err(|_| CommandError::internal())?
        .as_ref()
        .map(|session| session.operator.clone());
    if current.state == LicenseState::Active
        && !operator
            .as_ref()
            .is_some_and(|operator| operator.is_superadmin)
    {
        return Err(CommandError::new(
            "LICENSE_REPLACE_FORBIDDEN",
            "An active license can only be replaced by the Superadmin after signing in.",
        ));
    }

    // Pemasangan baru memasang lisensi SEBELUM database diatur. None yet
    // tujuan sync, jadi lisensi cukup disimpan lokal; bootstrap Superadmin atau
    // "gabung ke database yang sudah ada" yang kemudian membawanya ke cloud.
    if state.turso_config().is_none() {
        storage::set_system_setting(&state.data_dir, LICENSE_SETTING_KEY, &text)?;
    } else {
        store_local_and_enqueue(state, &text)?;
    }

    if let Ok(client) = state.get_turso_client() {
        let _ = client
            .query_one(
                "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                vec![json!(LICENSE_SETTING_KEY), json!(text)],
            )
            .await;
    }

    let (evaluation, code) = resolve(state).await?;
    if let Some(grant) = grant_from(&evaluation) {
        if let Some(session) = state
            .session
            .lock()
            .map_err(|_| CommandError::internal())?
            .as_mut()
        {
            session.license = grant;
        }
    }
    storage::audit(
        &state.data_dir,
        operator.map(|operator| operator.id),
        "license-installed",
        Some(&license.id),
    );
    Ok(to_status(evaluation, code))
}

/// Teks lisensi untuk bootstrap Superadmin: yang diketik di formulir bila ada,
/// selain itu lisensi yang sudah dipasang di layar aktivasi sebelum provisioning.
pub fn bootstrap_license_text(
    state: &DesktopState,
    provided: Option<String>,
) -> Result<String, CommandError> {
    let provided = provided
        .map(|text| compact_license_text(&text))
        .unwrap_or_default();
    if !provided.is_empty() {
        return Ok(provided);
    }
    Ok(stored_license(state)?.unwrap_or_default())
}

/// Tulis lisensi yang sudah terverifikasi ke database cloud yang baru saja
/// diprovisioning. Dipanggil dari bootstrap Superadmin, sebelum pull pertama.
pub async fn store_bootstrap_license(
    state: &DesktopState,
    client: &super::turso::TursoClient,
    text: &str,
) -> Result<(), CommandError> {
    client
        .query_one(
            "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            vec![json!(LICENSE_SETTING_KEY), json!(text)],
        )
        .await?;
    storage::set_system_setting(&state.data_dir, LICENSE_SETTING_KEY, text)
}

/// Perangkat yang memasang lisensi sebelum provisioning lalu bergabung ke
/// database yang SUDAH ADA: bila database itu belum berlisensi (misalnya dibuat
/// lewat Web), lisensi perangkat ini dibawa ke sana. Tanpa ini, pull pertama
/// menimpa salinan lokalnya dan perangkat terkunci di login berikutnya.
/// Lisensi yang sudah ada di database tidak pernah ditimpa.
pub async fn publish_local_if_cloud_missing(
    state: &DesktopState,
    client: &super::turso::TursoClient,
) -> Result<(), CommandError> {
    let Some(local) = stored_license(state)? else {
        return Ok(());
    };
    let code = current_device_code(state)?;
    if grant_from(&evaluate_text(Some(&local), &code)).is_none() {
        return Ok(());
    }
    client
        .query_one(
            "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING;",
            vec![json!(LICENSE_SETTING_KEY), json!(local)],
        )
        .await?;
    Ok(())
}

/// Gerbang mode baca-saja untuk satu izin. Perpanjangan bisa tiba lewat sync
/// atau dipasang di perangkat lain saat sesi ini masih berjalan, jadi sebelum
/// menolak, lisensi lokal dibaca ulang sekali — hanya di jalur penolakan,
/// supaya jalur normal tidak pernah menyentuh disk.
pub fn enforce_any(
    state: &DesktopState,
    grant: &mut LicenseGrant,
    permissions: &[&str],
) -> Result<(), CommandError> {
    let today = today_wib();
    if permissions
        .iter()
        .any(|permission| grant_allows(grant, permission, &today))
    {
        return Ok(());
    }
    let fresh = current_device_code(state).ok().and_then(|code| {
        let text = stored_license(state).ok().flatten();
        grant_from(&evaluate_text(text.as_deref(), &code))
    });
    if let Some(fresh) = fresh {
        *grant = fresh;
        if permissions
            .iter()
            .any(|permission| grant_allows(grant, permission, &today))
        {
            return Ok(());
        }
    }
    Err(read_only_error(grant))
}

// ---------------------------------------------------------------------------
// Helper tanggal (dibawa sendiri supaya berkas ini mandiri).
// ---------------------------------------------------------------------------

fn days_from_civil(mut year: i64, month: i64, day: i64) -> i64 {
    year -= i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(mut days: i64) -> (i64, i64, i64) {
    days += 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

/// Nomor hari sejak epoch untuk tanggal `YYYY-MM-DD` yang benar-benar ada.
fn parse_date(value: &str) -> Result<i64, String> {
    let bytes = value.as_bytes();
    let shaped = bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 4 | 7) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        });
    if !shaped {
        return Err("The date must use the YYYY-MM-DD format.".into());
    }
    let year: i64 = value[0..4]
        .parse()
        .map_err(|_| "Invalid year.".to_owned())?;
    let month: i64 = value[5..7]
        .parse()
        .map_err(|_| "Invalid month.".to_owned())?;
    let day: i64 = value[8..10]
        .parse()
        .map_err(|_| "Invalid day.".to_owned())?;
    let ordinal = days_from_civil(year, month, day);
    if !(1..=12).contains(&month) || civil_from_days(ordinal) != (year, month, day) {
        return Err("Invalid calendar date.".into());
    }
    Ok(ordinal)
}

/// `YYYY-MM-DD` persis (4-2-2 digit) DAN tanggal yang benar-benar ada.
fn is_calendar_date(value: &str) -> bool {
    parse_date(value).is_ok()
}

fn days_between(from: &str, to: &str) -> Result<i64, String> {
    Ok(parse_date(to)? - parse_date(from)?)
}

/// Tanggal kalender WIB dari detik epoch — nilai yang sama dengan
/// `date('now','+7 hours')`, tanpa membuka koneksi SQLite.
fn wib_date_from_epoch(epoch_seconds: i64) -> String {
    let (year, month, day) = civil_from_days((epoch_seconds + 7 * 3600).div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    /// Kunci uji: seed 32 byte bernilai 0x01 — sama dengan `KUNCI_UJI` di
    /// `lisensi/test/format.test.ts`.
    fn test_key() -> Ed25519KeyPair {
        Ed25519KeyPair::from_seed_unchecked(&[1_u8; 32]).expect("seed uji")
    }
    const TEST_PUBLIC_HEX: &str =
        "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";

    /// Vektor kembar dari `lisensi/test/format.test.ts` — WAJIB sama persis.
    const VECTOR_V1: &str = "LIS1.eyJ2IjoxLCJwcm9kdWsiOiJrb3MtYWJzZW5zaSIsImlkIjoiTElTLTIwMjYtMDAwMSIsInBlbWVnYW5nIjoiU1BQRyBVamkgVmVrdG9yIiwiamVuaXMiOiJzZXdhIiwidGVyYml0IjoiMjAyNi0wOS0yMyIsInBlbWJhcnVhbl9zYW1wYWkiOiIyMDI3LTA5LTIzIiwiYmVybGFrdV9zYW1wYWkiOiIyMDI3LTA5LTIzIiwicGVyYW5na2F0IjpbIlctMUEyQi0zQzRELTVFNkYtN0E4QiJdLCJrdW5jaV9tb2JpbGUiOmZhbHNlfQ.mZd_W7LOv0CTY3GS9PjkRpLObWV7znUwvhBkYBorZJttYTlSAxSdiIjGsNkgmlinP8iXiTVXJ0G81WSqS_WCAQ";
    const VECTOR_V2: &str = "LIS1.eyJ2IjoxLCJwcm9kdWsiOiJrb3MtYWJzZW5zaSIsImlkIjoiTElTLTIwMjYtMDAwMiIsInBlbWVnYW5nIjoiU1BQRyBOdXNhbnRhcmEg4oCUIENhYmFuZyBUaW11ciIsImplbmlzIjoiYmVsaV9wdXR1cyIsInRlcmJpdCI6IjIwMjYtMDktMjMiLCJwZW1iYXJ1YW5fc2FtcGFpIjoiMjAyNy0wOS0yMyIsImJlcmxha3Vfc2FtcGFpIjpudWxsLCJwZXJhbmdrYXQiOltdLCJrdW5jaV9tb2JpbGUiOmZhbHNlfQ.SJNWqONTGK2IoCbHUtvTNO3meDdRHqtjc-TJx3s1hTbVp1zTPlLQOITVKO5b20uH1o81MnTeL4KC5RLD5SjMCQ";
    /// Kode produk yang ditandatangani di vektor kanonik alat penerbit.
    const VECTOR_PRODUCT: &str = "kos-absensi";
    const DEVICE: &str = "W-1A2B-3C4D-5E6F-7A8B";
    const OTHER_DEVICE: &str = "W-0000-1111-2222-3333";

    fn public_key() -> Vec<u8> {
        hex::decode(TEST_PUBLIC_HEX).unwrap()
    }

    fn sign(payload: &Value) -> String {
        let body = BASE64_URL_SAFE_NO_PAD.encode(payload.to_string());
        let input = format!("LIS1.{body}");
        let signature = test_key().sign(input.as_bytes());
        format!(
            "{input}.{}",
            BASE64_URL_SAFE_NO_PAD.encode(signature.as_ref())
        )
    }

    fn base_payload() -> Value {
        json!({
            "v": 1, "produk": LICENSE_PRODUCT, "id": "LIS-UJI", "pemegang": "SPPG Uji",
            "jenis": "beli_putus", "terbit": "2026-09-23", "pembaruan_sampai": "2027-09-23",
            "berlaku_sampai": null, "perangkat": [], "kunci_mobile": false
        })
    }

    fn with(changes: Value) -> String {
        let mut payload = base_payload();
        for (key, value) in changes.as_object().unwrap() {
            payload[key] = value.clone();
        }
        sign(&payload)
    }

    fn eval(text: &str, device: &str, mobile: bool, build: &str, today: &str) -> Evaluation {
        evaluate(Some(text), &public_key(), device, mobile, build, today)
    }

    #[test]
    fn test_key_matches_issuer_vector() {
        assert_eq!(
            hex::encode(test_key().public_key().as_ref()),
            TEST_PUBLIC_HEX
        );
    }

    #[test]
    fn twin_vectors_verify_and_parse() {
        let v1 = parse_license_for(VECTOR_V1, &public_key(), VECTOR_PRODUCT).expect("V1 sah");
        assert_eq!(
            v1,
            LicensePayload {
                id: "LIS-2026-0001".into(),
                holder: "SPPG Uji Vektor".into(),
                kind: "sewa".into(),
                issued: "2026-09-23".into(),
                updates_until: "2027-09-23".into(),
                valid_until: Some("2027-09-23".into()),
                devices: vec![DEVICE.into()],
                lock_mobile: false,
            }
        );
        let v2 = parse_license_for(VECTOR_V2, &public_key(), VECTOR_PRODUCT).expect("V2 sah");
        assert_eq!(v2.holder, "SPPG Nusantara — Cabang Timur");
        assert_eq!(v2.kind, "beli_putus");
        assert_eq!(v2.valid_until, None);
        assert!(v2.devices.is_empty());
    }

    #[test]
    fn rust_signing_reproduces_issuer_vector_bytes() {
        // Ed25519 deterministik: payload JSON yang sama byte demi byte harus
        // menghasilkan tanda tangan yang sama dengan penerbit TypeScript.
        let body = VECTOR_V1.split('.').nth(1).unwrap();
        let input = format!("LIS1.{body}");
        let signature = BASE64_URL_SAFE_NO_PAD.encode(test_key().sign(input.as_bytes()).as_ref());
        assert_eq!(format!("{input}.{signature}"), VECTOR_V1);
    }

    #[test]
    fn tampering_and_foreign_keys_are_rejected() {
        let mut parts = VECTOR_V1.split('.').map(str::to_owned).collect::<Vec<_>>();
        let replacement = if &parts[1][10..11] == "A" { "B" } else { "A" };
        parts[1].replace_range(10..11, replacement);
        assert!(parse_license(&parts.join("."), &public_key()).is_err());

        let other = Ed25519KeyPair::from_seed_unchecked(&[2_u8; 32]).unwrap();
        assert_eq!(
            parse_license(VECTOR_V1, other.public_key().as_ref()),
            Err("The license signature does not match.".into())
        );
        assert_eq!(
            parse_license(&VECTOR_V1.replacen("LIS1", "LIS2", 1), &public_key()),
            Err("This text is not a LIS1 license.".into())
        );
    }

    #[test]
    fn payload_rules_match_issuer() {
        let reject = |changes: Value| parse_license(&with(changes), &public_key()).unwrap_err();
        assert_eq!(
            reject(json!({ "maks_perangkat": 9 })),
            "Unknown license field: maks_perangkat."
        );
        assert_eq!(reject(json!({ "v": 2 })), "Unsupported license version.");
        assert_eq!(
            reject(json!({ "produk": "Absensi" })),
            "Invalid product code."
        );
        assert_eq!(
            reject(json!({ "pemegang": " SPPG" })),
            "Invalid license holder name."
        );
        assert_eq!(
            reject(json!({ "pemegang": "A\u{7}" })),
            "Invalid license holder name."
        );
        assert_eq!(
            reject(json!({ "jenis": "gratis" })),
            "Unknown license type."
        );
        assert_eq!(
            reject(json!({ "terbit": "2026-02-30" })),
            "Invalid issue date."
        );
        assert_eq!(
            reject(json!({ "terbit": "2026-9-23" })),
            "Invalid issue date."
        );
        assert_eq!(
            reject(json!({ "pembaruan_sampai": "2026-01-01" })),
            "pembaruan_sampai (updates until) cannot be before the issue date."
        );
        assert_eq!(
            reject(json!({ "berlaku_sampai": "2027-01-01" })),
            "A beli_putus (perpetual) license has no berlaku_sampai (valid until)."
        );
        assert_eq!(
            reject(json!({ "jenis": "sewa" })),
            "A sewa (rental) license must have berlaku_sampai (valid until)."
        );
        assert_eq!(
            reject(json!({ "perangkat": ["w-1a2b-3c4d-5e6f-7a8b"] })),
            "Invalid device code: \"w-1a2b-3c4d-5e6f-7a8b\"."
        );
        assert_eq!(
            reject(json!({ "perangkat": [DEVICE, DEVICE] })),
            format!("Duplicate device code: {DEVICE}.")
        );
        assert_eq!(
            reject(json!({ "kunci_mobile": "ya" })),
            "kunci_mobile must be true or false."
        );
        assert_eq!(
            reject(json!({ "produk": "produk-lain" })),
            "This license was issued for another product (produk-lain)."
        );

        let mut missing = base_payload();
        missing.as_object_mut().unwrap().remove("berlaku_sampai");
        assert!(parse_license(&sign(&missing), &public_key()).is_err());
    }

    #[test]
    fn evaluation_states() {
        let today = "2026-10-01";
        let build = "2026-09-30";
        let perpetual = with(json!({}));
        assert_eq!(
            eval(&perpetual, DEVICE, false, build, today).state,
            LicenseState::Active
        );

        let expired = with(json!({ "jenis": "sewa", "berlaku_sampai": "2026-09-30" }));
        let evaluation = eval(&expired, DEVICE, false, build, today);
        assert_eq!(evaluation.state, LicenseState::ReadOnly);
        assert_eq!(evaluation.read_only_reason, Some(ReadOnlyReason::Expired));
        // Hari terakhir masih berlaku penuh.
        assert_eq!(
            eval(&expired, DEVICE, false, build, "2026-09-30").state,
            LicenseState::Active
        );

        let old_maintenance = with(json!({ "pembaruan_sampai": "2026-09-29" }));
        let evaluation = eval(&old_maintenance, DEVICE, false, build, today);
        assert_eq!(
            evaluation.read_only_reason,
            Some(ReadOnlyReason::VersionNotCovered)
        );
        // Versi yang dibangun sebelum masa pembaruan habis tetap penuh selamanya.
        assert_eq!(
            eval(&old_maintenance, DEVICE, false, "2026-09-29", "2030-01-01").state,
            LicenseState::Active
        );

        assert_eq!(
            evaluate(None, &public_key(), DEVICE, false, build, today).state,
            LicenseState::Missing
        );
        assert_eq!(
            eval("sampah", DEVICE, false, build, today).state,
            LicenseState::Invalid
        );
        assert_eq!(
            evaluate(Some(&perpetual), &[0_u8; 32], DEVICE, false, build, today).state,
            LicenseState::Invalid
        );
    }

    #[test]
    fn device_binding_respects_mobile_flag() {
        let today = "2026-10-01";
        let build = "2026-09-30";
        let bound = with(json!({ "perangkat": [DEVICE] }));
        assert_eq!(
            eval(&bound, DEVICE, false, build, today).state,
            LicenseState::Active
        );
        let other = eval(&bound, OTHER_DEVICE, false, build, today);
        assert_eq!(other.state, LicenseState::DeviceNotListed);
        assert!(other.message.unwrap().contains(OTHER_DEVICE));
        // HP bebas selama kunci_mobile mati...
        assert_eq!(
            eval(&bound, "A-9999-8888-7777-6666", true, build, today).state,
            LicenseState::Active
        );
        // ...dan ikut dikunci bila dinyalakan.
        let bound_mobile = with(json!({ "perangkat": [DEVICE], "kunci_mobile": true }));
        assert_eq!(
            eval(&bound_mobile, "A-9999-8888-7777-6666", true, build, today).state,
            LicenseState::DeviceNotListed
        );
        // Daftar kosong = tidak dikunci sama sekali.
        assert_eq!(
            eval(&with(json!({})), OTHER_DEVICE, false, build, today).state,
            LicenseState::Active
        );
    }

    #[test]
    fn read_only_gate() {
        assert!(read_only_allows("payroll.view"));
        assert!(read_only_allows("sync.retry"));
        assert!(read_only_allows("database_backup.export"));
        assert!(!read_only_allows("scanner.use"));
        assert!(!read_only_allows("payroll.run.create"));
        assert!(!read_only_allows("database_backup.restore"));

        let active = LicenseGrant {
            read_only: None,
            valid_until: Some("2026-10-31".into()),
            updates_until: "2027-01-01".into(),
        };
        assert!(grant_allows(&active, "scanner.use", "2026-10-31"));
        // Langganan yang habis saat sesi masih berjalan.
        assert!(!grant_allows(&active, "scanner.use", "2026-11-01"));
        assert!(grant_allows(&active, "home.view", "2026-11-01"));
        let read_only = LicenseGrant {
            read_only: Some(ReadOnlyReason::VersionNotCovered),
            ..active
        };
        assert!(!grant_allows(&read_only, "employees.manage", "2026-10-01"));
        assert_eq!(read_only_error(&read_only).code, "LICENSE_READ_ONLY");
    }

    #[test]
    fn grant_only_for_usable_states() {
        let evaluation = eval(&with(json!({})), DEVICE, false, "2026-09-30", "2026-10-01");
        assert_eq!(
            grant_from(&evaluation),
            Some(LicenseGrant {
                read_only: None,
                valid_until: None,
                updates_until: "2027-09-23".into(),
            })
        );
        let missing = evaluate(
            None,
            &public_key(),
            DEVICE,
            false,
            "2026-09-30",
            "2026-10-01",
        );
        assert_eq!(grant_from(&missing), None);
    }

    #[test]
    fn device_code_is_stable_and_well_formed() {
        let code = device_code('W', "4c4c4544-0042-3510-8052-b4c04f4e3432");
        assert!(is_device_code(&code), "{code}");
        assert_eq!(
            code,
            device_code('W', "4c4c4544-0042-3510-8052-b4c04f4e3432")
        );
        assert_ne!(
            code,
            device_code('W', "4c4c4544-0042-3510-8052-b4c04f4e3433")
        );
        assert!(code.starts_with("W-"));
        assert!(!is_device_code("W-1A2B-3C4D-5E6F-7A8"));
        assert!(!is_device_code("X-1A2B-3C4D-5E6F-7A8B"));
        assert!(!is_device_code("W-1A2B-3C4D-5E6F-7a8b"));
    }

    #[test]
    fn build_date_is_a_calendar_date() {
        assert!(is_calendar_date(BUILD_DATE), "{BUILD_DATE}");
    }

    #[test]
    fn whitespace_inside_license_is_ignored() {
        // Cermin tes "spasi dan baris baru di tengah teks dibuang" di
        // `lisensi/test/format.test.ts`: salinan dari terminal/WhatsApp.
        let broken = format!(
            "  {}\r\n{} \t{}\n",
            &VECTOR_V1[..120],
            &VECTOR_V1[120..200],
            &VECTOR_V1[200..]
        );
        assert_eq!(
            parse_license_for(&broken, &public_key(), VECTOR_PRODUCT),
            parse_license_for(VECTOR_V1, &public_key(), VECTOR_PRODUCT)
        );
        assert_eq!(compact_license_text(&broken), VECTOR_V1);
    }

    #[test]
    fn rental_days_left_counts_today() {
        // Sewa 30 hari terbit 24 Sep berakhir 23 Okt (lihat `akhirSewa` di alat
        // penerbit): hari pertama = 30, hari terakhir = 1, sesudahnya = 0.
        assert_eq!(rental_days_left("2026-10-23", "2026-09-24"), Some(30));
        assert_eq!(rental_days_left("2026-10-23", "2026-10-23"), Some(1));
        assert_eq!(rental_days_left("2026-10-23", "2026-10-24"), Some(0));
        assert_eq!(rental_days_left("2026-10-23", "2027-01-01"), Some(0));
        assert_eq!(rental_days_left("bukan-tanggal", "2026-10-01"), None);
        assert_eq!(days_between("2028-02-28", "2028-03-01"), Ok(2));
    }

    #[test]
    fn wib_date_rolls_over_at_17_utc() {
        // 2026-09-23 16:59:59 UTC = 23:59:59 WIB; satu detik kemudian sudah besok.
        assert_eq!(wib_date_from_epoch(1_790_182_799), "2026-09-23");
        assert_eq!(wib_date_from_epoch(1_790_182_800), "2026-09-24");
    }
}

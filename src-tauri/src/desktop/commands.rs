use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde_json::{json, Value};
use tauri::State;
use zeroize::Zeroizing;

use super::{
    config::DesktopState,
    license,
    models::{
        CommandError, DesktopLoginResult, DesktopRuntimeStatus, DesktopSession, DesktopSyncStatus,
        OperatorUser, SessionMode,
    },
    portability, secrets, storage, sync, turso,
};

/// Pastikan sesi aktif memiliki permission yang diminta.
///
/// Ini lapisan guard di sisi backend. Menyembunyikan tombol di UI TIDAK PERNAH
/// cukup: setiap perintah IPC wajib memeriksa ulang di sini, karena perintah
/// dapat dipanggil langsung tanpa melewati UI sama sekali.
///
/// Superadmin sengaja lolos tanpa dicek terhadap daftar permission: role itu
/// memang memegang seluruh katalog, termasuk permission yang baru ditambahkan
/// setelah sesinya dibuat.
/// Sesi login yang sah, tanpa menuntut izin tertentu.
///
/// Dipakai tindakan yang hanya menyentuh akun milik pemanggil sendiri —
/// mendaftarkan atau mematikan verifikasi dua langkahnya sendiri. Memaksakan
/// sebuah izin di sini akan salah: setiap operator berhak mengamankan akunnya.
fn require_session(state: &DesktopState) -> Result<OperatorUser, CommandError> {
    let session = state.session.lock().map_err(|_| CommandError::internal())?;
    let session = session.as_ref().ok_or_else(|| {
        CommandError::new(
            "DESKTOP_SESSION_MISSING",
            "The desktop session is not available. Sign in again.",
        )
    })?;
    Ok(session.operator.clone())
}

// `pub(crate)`, bukan privat: build Mobile punya perintah yang tidak ada
// padanannya di Desktop (`device_storage.rs`), dan perintah itu wajib melewati
// gerbang izin yang SAMA. Menyalin logikanya ke sana akan membuat dua gerbang
// yang cepat atau lambat berbeda.
pub(crate) fn require_permission(
    state: &DesktopState,
    permission: &str,
) -> Result<OperatorUser, CommandError> {
    let mut session = state.session.lock().map_err(|_| CommandError::internal())?;
    let session = session.as_mut().ok_or_else(|| {
        CommandError::new(
            "DESKTOP_SESSION_MISSING",
            "The desktop session is not available. Sign in again.",
        )
    })?;
    if !session.operator.is_superadmin
        && !session
            .operator
            .permissions
            .iter()
            .any(|key| key == permission)
    {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Access denied for this action.",
        ));
    }
    // Gerbang izin TUNGGAL: mode baca-saja lisensi ditegakkan di sini, jadi
    // command yang memakai gerbang lain akan lolos darinya.
    license::enforce_any(state, &mut session.license, &[permission])?;
    Ok(session.operator.clone())
}

fn clear_expired_session(state: &DesktopState, error: &CommandError) {
    if error.code == "DESKTOP_SESSION_EXPIRED" {
        if let Ok(mut session) = state.session.lock() {
            *session = None;
        }
    }
}

fn ensure_login_not_locked(state: &DesktopState, identifier: &str) -> Result<(), CommandError> {
    if let Some(seconds) = storage::login_lock_remaining(&state.data_dir, identifier)? {
        return Err(CommandError::new(
            "LOGIN_RATE_LIMITED",
            format!(
                "Too many sign-in attempts. Try again in {} minutes {} seconds.",
                seconds / 60,
                seconds % 60
            ),
        ));
    }
    Ok(())
}

fn reject_login(state: &DesktopState, identifier: &str) -> Result<(), CommandError> {
    if let Some(seconds) = storage::record_failed_login(&state.data_dir, identifier)? {
        return Err(CommandError::new(
            "LOGIN_RATE_LIMITED",
            format!(
                "Too many sign-in attempts. Try again in {} minutes {} seconds.",
                seconds / 60,
                seconds % 60
            ),
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_get_session(
    state: State<'_, DesktopState>,
) -> Result<Option<OperatorUser>, CommandError> {
    let session = state.session.lock().map_err(|_| CommandError::internal())?;
    Ok(session.as_ref().map(|session| session.operator.clone()))
}

#[tauri::command]
pub fn desktop_get_runtime_status(
    state: State<'_, DesktopState>,
) -> Result<DesktopRuntimeStatus, CommandError> {
    let session = state.session.lock().map_err(|_| CommandError::internal())?;
    Ok(DesktopRuntimeStatus {
        configured: true,
        server_origin: state.server_origin(),
        offline_max_age_hours: state.offline_max_age_hours,
        has_active_session: session.is_some(),
        mode: session.as_ref().map(|session| session.mode),
    })
}

/// Status lisensi perangkat ini. Sengaja tanpa sesi: layar login perlu tahu
/// apakah harus menampilkan layar aktivasi (beserta kode perangkat) sebelum
/// siapa pun bisa masuk.
#[tauri::command]
pub async fn desktop_get_license_status(
    state: State<'_, DesktopState>,
) -> Result<license::LicenseStatus, CommandError> {
    license::status(&state).await
}

/// Pasang lisensi. Tanpa sesi hanya bila lisensi saat ini tidak aktif penuh;
/// mengganti lisensi yang masih aktif menuntut Superadmin.
#[tauri::command]
pub async fn desktop_install_license(
    state: State<'_, DesktopState>,
    license: String,
) -> Result<license::LicenseStatus, CommandError> {
    license::install(&state, &license).await
}

#[tauri::command]
pub async fn desktop_get_bootstrap_status(
    state: State<'_, DesktopState>,
) -> Result<turso::BootstrapStatus, CommandError> {
    // Perintah ini menentukan apakah layar provisioning muncul, jadi ia tidak
    // boleh gagal keras. Sebelumnya, database cloud yang mati/terhapus membuat
    // perintah ini mengembalikan Err, frontend menelannya menjadi `null`, dan
    // perangkat terkunci selamanya di layar login tanpa jalan kembali ke
    // provisioning. Sekarang kegagalan koneksi dilaporkan sebagai status.
    match state.get_turso_client() {
        Ok(client) => {
            let origin = state.server_origin();
            match client.bootstrap_status().await {
                Ok(status) => Ok(status),
                Err(error) => Ok(turso::BootstrapStatus::unreachable(origin, &error)),
            }
        }
        Err(error) if error.code == "TURSO_NOT_CONFIGURED" => Ok(turso::BootstrapStatus {
            configured: false,
            required: true,
            server_origin: String::new(),
            reachable: false,
            message: Some(error.message),
        }),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn desktop_bootstrap_superadmin(
    state: State<'_, DesktopState>,
    draft: turso::BootstrapSuperadminDraft,
    database_url: Option<String>,
    auth_token: Option<String>,
    provider: Option<turso::DatabaseProvider>,
    allow_insecure_transport: Option<bool>,
    license: Option<String>,
) -> Result<Value, CommandError> {
    if state
        .session
        .lock()
        .map_err(|_| CommandError::internal())?
        .is_some()
    {
        return Err(CommandError::new(
            "TURSO_BOOTSTRAP_CLOSED",
            "Bootstrap is only available before a user session is active.",
        ));
    }
    // Lisensi diverifikasi SEBELUM Superadmin dibuat: lisensi yang ditolak
    // setelahnya meninggalkan database yang tidak bisa dipakai login sekaligus
    // tidak bisa diprovisioning ulang. Kolom kosong = pakai lisensi yang sudah
    // dipasang di layar aktivasi sebelum provisioning.
    let license_text = license::bootstrap_license_text(&state, license)?;
    let device_code = license::current_device_code(&state)?;

    // Kredensial dari form SELALU menang atas kredensial yang sudah tersimpan.
    // Dulu cabang "sudah terkonfigurasi" langsung memakai klien vault dan
    // membuang `database_url`/`auth_token` yang baru saja diketik, sehingga
    // pengguna yang mengarahkan aplikasi ke database Turso baru justru
    // memprovisioning database lama — yang bahkan mungkin sudah dihapus.
    // `resolve_bootstrap_turso_config` memakai vault hanya bila form dikosongkan.
    let config = resolve_bootstrap_turso_config(
        &state,
        database_url,
        auth_token,
        provider,
        allow_insecure_transport,
    )?;
    let client = turso::TursoClient::from_config(&config, state.http.clone())?;
    let status = client.bootstrap_status().await?;
    // Kode pemulihan hanya bisa dibaca SEKALI — database memegang hash-nya
    // saja. Karena itu ia ikut dalam balasan ini, dan layar bootstrap wajib
    // menampilkannya sampai pengguna menyatakan sudah menyimpannya.
    let recovery_codes = if status.required {
        license::check_installable(&license_text, &device_code)?;
        let codes = client.bootstrap_superadmin(draft).await?;
        license::store_bootstrap_license(&state, &client, &license_text).await?;
        codes
    } else {
        // Database yang sudah berisi: lisensinya (bila ada) sudah di sana, dan
        // yang belum berlisensi ditangani layar lisensi sebelum login.
        Vec::new()
    };
    state.set_database_config(&config)?;
    let _ = sync::pull_snapshot(&state).await;
    storage::audit(&state.data_dir, None, "bootstrap-superadmin-success", None);
    Ok(json!({ "sukses": true, "recoveryCodes": recovery_codes }))
}

fn ensure_bootstrap_window_open(state: &DesktopState) -> Result<(), CommandError> {
    if state
        .session
        .lock()
        .map_err(|_| CommandError::internal())?
        .is_some()
    {
        return Err(CommandError::new(
            "TURSO_BOOTSTRAP_CLOSED",
            "The provisioning database check is only available before a user session is active.",
        ));
    }
    Ok(())
}

/// Resolusi kredensial untuk pemeriksaan provisioning: pakai input form bila diisi,
/// selain itu jatuh ke konfigurasi vault yang sudah tersimpan. Token yang sudah ada
/// di vault tidak pernah dikirim balik ke frontend, jadi field kosong = pakai token lama.
fn resolve_bootstrap_turso_config(
    state: &DesktopState,
    database_url: Option<String>,
    auth_token: Option<String>,
    provider: Option<turso::DatabaseProvider>,
    allow_insecure_transport: Option<bool>,
) -> Result<turso::TursoConfig, CommandError> {
    let url = database_url.unwrap_or_default().trim().to_owned();
    let token = auth_token.unwrap_or_default().trim().to_owned();
    let stored = state.turso_config();

    // Provider yang tidak dikirim frontend mewarisi pilihan yang sudah tersimpan;
    // instalasi lama yang belum punya konfigurasi apa pun tetap jatuh ke Turso.
    //
    // WAJIB ditentukan SEBELUM alamat kosong ditolak di bawah: Mode Database
    // Lokal memang tidak punya alamat, dan formulirnya sengaja tidak menampilkan
    // kolom itu. Memeriksa alamat lebih dulu membuat provisioning perangkat baru
    // dalam mode lokal selalu berhenti dengan "Alamat database wajib diisi" —
    // menuntut sesuatu yang tidak pernah bisa diisi pengguna.
    let requested_provider = provider
        .or_else(|| stored.as_ref().map(|config| config.provider))
        .unwrap_or_default();

    if requested_provider.is_local_file() {
        // Lokasi berkas hub ditentukan di sini persis seperti pada
        // `set_database_config`, supaya kedua pintu masuk konfigurasi memakai
        // lokasi bawaan yang sama. Alamat yang dikirim eksplisit tetap
        // dihormati, agar hub bisa ditaruh di drive lain.
        let path = if url.is_empty() {
            state.local_hub_path().to_string_lossy().into_owned()
        } else {
            url
        };
        return Ok(turso::TursoConfig::new(
            path,
            String::new(),
            turso::DatabaseProvider::LocalFile,
            false,
        ));
    }

    if url.is_empty() {
        return stored.ok_or_else(|| {
            CommandError::new(
                "TURSO_NOT_CONFIGURED",
                "Enter the database address to check the database.",
            )
        });
    }

    let provider = requested_provider;
    let allow_insecure_transport = allow_insecure_transport
        .or_else(|| {
            stored
                .as_ref()
                .map(|config| config.allow_insecure_transport)
        })
        .unwrap_or(false);

    // Token kosong berarti "pakai token vault", tapi hanya bila URL-nya memang
    // database yang sama. Perbandingan wajib ternormalisasi: versi lama menyamakan
    // string mentah, sehingga mengetik `https://x` untuk vault yang menyimpan
    // `libsql://x` membuang token yang sebenarnya masih berlaku dan memunculkan
    // "Auth Token wajib diisi" pada database yang sudah terhubung.
    let token = if token.is_empty() {
        stored
            .as_ref()
            .filter(|config| config.matches_url(&url))
            .map(|config| config.auth_token.clone())
            .unwrap_or_default()
    } else {
        token
    };

    let config = turso::TursoConfig::new(url, token, provider, allow_insecure_transport);
    // Server libSQL sendiri di LAN boleh tanpa autentikasi; hanya endpoint yang
    // benar-benar terekspos internet yang wajib bertoken.
    if config.auth_token.trim().is_empty() && config.requires_auth_token() {
        return Err(CommandError::new(
            "TURSO_TOKEN_REQUIRED",
            "An Auth Token is required to check this database.",
        ));
    }
    Ok(config)
}

#[tauri::command]
pub async fn desktop_check_bootstrap_database(
    state: State<'_, DesktopState>,
    database_url: Option<String>,
    auth_token: Option<String>,
    provider: Option<turso::DatabaseProvider>,
    allow_insecure_transport: Option<bool>,
) -> Result<turso::DatabaseCheckResult, CommandError> {
    ensure_bootstrap_window_open(&state)?;
    let config = resolve_bootstrap_turso_config(
        &state,
        database_url,
        auth_token,
        provider,
        allow_insecure_transport,
    )?;
    let origin = config
        .normalized_url()
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default();
    let client = match turso::TursoClient::from_config(&config, state.http.clone()) {
        Ok(client) => client,
        Err(error) => return Ok(turso::DatabaseCheckResult::unreachable(origin, &error)),
    };
    match client.inspect_database().await {
        Ok(check) => Ok(check),
        Err(error) => Ok(turso::DatabaseCheckResult::unreachable(origin, &error)),
    }
}

/// Menyimpan kredensial database yang sudah punya Superadmin aktif tanpa membuat akun baru.
#[tauri::command]
pub async fn desktop_link_bootstrap_database(
    state: State<'_, DesktopState>,
    database_url: Option<String>,
    auth_token: Option<String>,
    provider: Option<turso::DatabaseProvider>,
    allow_insecure_transport: Option<bool>,
) -> Result<turso::DatabaseCheckResult, CommandError> {
    ensure_bootstrap_window_open(&state)?;
    let config = resolve_bootstrap_turso_config(
        &state,
        database_url,
        auth_token,
        provider,
        allow_insecure_transport,
    )?;
    let client = turso::TursoClient::from_config(&config, state.http.clone())?;
    let check = client.inspect_database().await?;
    if !check.superadmin_exists {
        return Err(CommandError::new(
            "TURSO_SUPERADMIN_MISSING",
            "This database has no active Superadmin yet. Continue provisioning to create the first account.",
        ));
    }
    // SEBELUM pull: pull menimpa setting lokal dengan isi database, termasuk
    // lisensi yang dipasang di layar aktivasi sebelum provisioning.
    if let Err(error) = license::publish_local_if_cloud_missing(&state, &client).await {
        eprintln!("[link-database] The local license could not be carried to the database: {}", error.code);
    }
    state.set_database_config(&config)?;
    let _ = sync::pull_snapshot(&state).await;
    storage::audit(&state.data_dir, None, "bootstrap-database-linked", None);
    Ok(check)
}

/// Bolehkah akun ini masuk lewat jalur offline?
///
/// Jalur offline hanya memeriksa username + password terhadap snapshot vault.
/// Untuk akun ber-2FA itu berarti faktor kedua hilang seluruhnya, sehingga
/// perangkat yang punya cache offline justru menjadi cara termudah melewatinya.
///
/// Rahasia TOTP SENGAJA tidak ikut disimpan di vault supaya bisa diverifikasi
/// offline: vault dibuka dengan password akun itu sendiri, jadi penyerang yang
/// berhasil membukanya sudah melewati faktor pertama — menyimpan rahasianya di
/// sana membuat faktor kedua tidak menambah perlindungan apa pun. Yang benar
/// adalah menolak, lalu meminta satu kali koneksi.
///
/// Catatan: pada Mode Database Lokal batasan ini tidak pernah terasa, karena
/// `authenticate_operator` berjalan penuh terhadap berkas lokal — termasuk
/// verifikasi TOTP-nya.
fn assert_offline_login_allowed(operator: &OperatorUser) -> Result<(), CommandError> {
    if operator.totp_enabled {
        return Err(CommandError::new(
            "TOTP_REQUIRED_ONLINE",
            "This account uses two-step verification, so its code cannot be checked while the device is offline. Connect the device to the database once to sign in.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_login(
    state: State<'_, DesktopState>,
    identifier: String,
    password: String,
    totp_code: Option<String>,
) -> Result<DesktopLoginResult, CommandError> {
    let identifier = identifier.trim().to_owned();
    if identifier.len() < 3 || identifier.len() > 64 || password.len() > 256 {
        return Err(CommandError::new(
            "LOGIN_REJECTED",
            "Wrong username or password.",
        ));
    }
    ensure_login_not_locked(&state, &identifier)?;
    // Lisensi diperiksa SEBELUM kredensial, satu kali untuk jalur online dan
    // offline sekaligus. Statusnya sudah terbuka lewat
    // `desktop_get_license_status`, jadi urutan ini tidak membocorkan apa pun.
    let license_grant = license::gate_login(&state).await?;
    let password = Zeroizing::new(password);

    // Alasan kegagalan koneksi cloud, disimpan supaya pesan error terakhir bisa
    // menyebut penyebab sebenarnya. Dulu alasan ini dibuang, sehingga perangkat
    // yang kredensialnya menunjuk database Turso terhapus hanya melaporkan
    // "wajib login online minimal satu kali" — pesan yang membuat pengguna
    // mengira internetnya mati padahal internetnya aktif.
    let mut cloud_failure: Option<String> = None;

    // 1. Coba login online via Turso jika Turso Client tersedia
    if let Ok(turso) = state.get_turso_client() {
        // Mode Database Lokal tidak punya jaringan yang bisa gagal. Kegagalan di
        // sana berarti berkasnya bermasalah, dan menyamarkannya sebagai "cloud
        // tidak terjangkau" akan meneruskan login ke fallback offline — jalur
        // yang hanya memeriksa username + password.
        let backend_is_local = turso.is_local();
        match turso
            .authenticate_operator(&identifier, &password, totp_code.as_deref())
            .await
        {
            Ok(operator) => {
                storage::clear_login_failures(&state.data_dir, &identifier)?;
                // Sesi tunggal (PRD FR-03): login online terakhir menang. Sesi
                // lain operator ini dicabut di transaksi cloud yang sama dengan
                // pembuatan sesi baru. Mode Database Lokal tidak punya perangkat
                // lain, jadi tidak membuka sesi cloud.
                let session_id = if backend_is_local {
                    None
                } else {
                    let (kind, label) = sync::device_identity(&state);
                    let (session_id, created_at) = turso
                        .open_device_session(&operator, kind, &label, true)
                        .await?;
                    sync::record_session_contact(&state, operator.id, &created_at);
                    Some(session_id)
                };
                let provisioned = secrets::provision(&state, operator.clone(), &password);
                let (offline_ready, offline_valid_until, mut message): (
                    bool,
                    Option<i64>,
                    String,
                ) = match provisioned {
                    Ok(credential) => (
                        true,
                        Some(credential.offline_valid_until),
                        "Signed in online to the cloud database. Offline access on this device was updated.".into(),
                    ),
                    Err(_) => (
                        false,
                        None,
                        "Signed in online, but offline storage could not be updated yet.".into(),
                    ),
                };

                storage::audit(
                    &state.data_dir,
                    Some(operator.id),
                    "login-online-turso-success",
                    None,
                );

                // Sesi dipasang SEBELUM sinkronisasi pertama: pemeriksaan sesi
                // tunggal di awal siklus membaca sesi ini.
                *state.session.lock().map_err(|_| CommandError::internal())? =
                    Some(DesktopSession {
                        operator: operator.clone(),
                        mode: SessionMode::Online,
                        license: license_grant,
                        session_id: session_id.clone(),
                    });
                sync::set_current_actor(Some(operator.id), session_id);
                sync::clear_session_ended();

                if operator
                    .permissions
                    .iter()
                    .any(|permission| permission == "sync.view")
                {
                    match sync::synchronize(&state).await {
                        Ok(_) => {
                            message.push_str(" Local operational data was synced.");
                        }
                        Err(err) => {
                            eprintln!("[desktop_login] Cloud data sync failed: {:?}", err);
                        }
                    }
                }

                return Ok(DesktopLoginResult {
                    sukses: true,
                    pesan: message,
                    operator,
                    mode: SessionMode::Online,
                    offline_ready,
                    offline_valid_until,
                });
            }
            Err(err) if err.code == "LOGIN_REJECTED" => {
                storage::audit(
                    &state.data_dir,
                    None,
                    "login-online-rejected",
                    Some(&err.code),
                );
                reject_login(&state, &identifier)?;
                return Err(err);
            }
            // Kegagalan 2FA BUKAN "cloud tidak terjangkau". Tanpa lengan ini
            // ketiga kode di bawah jatuh ke lengan Err umum, yang meneruskan
            // login ke fallback offline — dan fallback itu hanya memeriksa
            // username + password, sehingga verifikasi dua langkah terlewati
            // seluruhnya pada perangkat yang punya cache offline.
            Err(err)
                if matches!(
                    err.code,
                    "TOTP_REQUIRED" | "TOTP_INVALID" | "TOTP_ENROLLMENT_REQUIRED"
                ) =>
            {
                storage::audit(&state.data_dir, None, "login-online-totp", Some(&err.code));
                // Hanya kode yang SALAH yang dihitung sebagai percobaan gagal.
                // "Belum mengirim kode" adalah langkah normal alur login, dan
                // menghitungnya akan mengunci akun yang justru patuh memakai 2FA.
                if err.code == "TOTP_INVALID" {
                    reject_login(&state, &identifier)?;
                }
                return Err(err);
            }
            Err(err) => {
                storage::audit(
                    &state.data_dir,
                    None,
                    "login-online-turso-unavailable",
                    Some(&err.code),
                );
                // Tidak ada "offline" yang masuk akal pada berkas lokal:
                // laporkan kerusakannya apa adanya, jangan diam-diam turun ke
                // jalur yang lebih lemah.
                if backend_is_local {
                    return Err(err);
                }
                // Koneksi network Turso gagal, lanjut ke fallback di bawah
                cloud_failure = Some(err.message);
            }
        }
    }

    // Template ini murni 2-tier: perangkat berbicara langsung ke database.
    // Tidak ada server aplikasi perantara, sehingga tidak ada jalur login HTTP
    // selain yang di atas. Kalau database tidak menjawab, langkah berikutnya
    // adalah snapshot offline — bukan mengirim kredensial ke tempat lain.

    // 3. Fallback offline credential snapshot
    let credential = match secrets::load_offline(&state, &identifier, &password) {
        Ok(credential) => credential,
        Err(error) => {
            if matches!(
                error.code,
                "OFFLINE_CREDENTIAL_INVALID" | "OFFLINE_SNAPSHOT_INVALID"
            ) {
                reject_login(&state, &identifier)?;
            }
            // Perangkat belum punya snapshot offline DAN database cloud memang
            // tidak menjawab: yang salah adalah konfigurasi database, bukan
            // koneksi internet pengguna. Sebutkan penyebab aslinya.
            if error.code == "OFFLINE_NOT_PROVISIONED" {
                if let Some(reason) = cloud_failure {
                    return Err(CommandError::new(
                        "TURSO_UNREACHABLE",
                        format!(
                            "The cloud database ({}) cannot be reached, so the first sign-in on this device cannot happen yet. Cause: {} Check the database URL and Auth Token on the database settings screen.",
                            state.server_origin(),
                            reason,
                        ),
                    ));
                }
            }
            return Err(error);
        }
    };
    // Gerbang 2FA untuk jalur offline. Sampai di sini password sudah terbukti
    // benar terhadap vault — sama seperti pada jalur online, gerbang 2FA berdiri
    // SETELAH password, supaya layar login tidak bisa dipakai memetakan akun
    // mana yang memakai verifikasi dua langkah.
    if let Err(error) = assert_offline_login_allowed(&credential.operator) {
        storage::audit(
            &state.data_dir,
            Some(credential.operator.id),
            "login-offline-blocked-totp",
            Some(&error.code),
        );
        return Err(error);
    }

    storage::clear_login_failures(&state.data_dir, &identifier)?;
    storage::audit(
        &state.data_dir,
        Some(credential.operator.id),
        "login-offline-success",
        None,
    );
    // Login offline tidak membuka sesi cloud dan tidak mengusir siapa pun.
    // Siklus sync pertama yang tersambung memutuskan: tersusul, atau
    // dipromosikan menjadi sesi cloud (lihat `sync::check_session`).
    *state.session.lock().map_err(|_| CommandError::internal())? = Some(DesktopSession {
        operator: credential.operator.clone(),
        mode: SessionMode::Offline,
        license: license_grant,
        session_id: None,
    });
    sync::set_current_actor(Some(credential.operator.id), None);
    sync::clear_session_ended();
    Ok(DesktopLoginResult {
        sukses: true,
        pesan: "The cloud database is unreachable. Signed in with a validated offline snapshot."
            .into(),
        operator: credential.operator,
        mode: SessionMode::Offline,
        offline_ready: true,
        offline_valid_until: Some(credential.offline_valid_until),
    })
}

#[tauri::command]
pub async fn desktop_logout(state: State<'_, DesktopState>) -> Result<(), CommandError> {
    let previous = state
        .session
        .lock()
        .map_err(|_| CommandError::internal())?
        .take();
    sync::set_current_actor(None, None);
    if let Some(session) = previous {
        storage::audit(&state.data_dir, Some(session.operator.id), "logout", None);
        // Cabut baris `app_session` cloud-nya, sebisanya: logout lokal tidak
        // boleh gagal atau menunggu hanya karena jaringan terputus.
        if let (Some(session_id), Ok(turso)) = (session.session_id, state.get_turso_client()) {
            let _ = turso.revoke_device_session(&session_id).await;
        }
    }
    Ok(())
}


/// Riwayat "Lupa Password".
///
/// Berbeda dengan command `desktop_password_reset_*` yang sengaja terbuka tanpa
/// sesi, membaca dan menghapus riwayat butuh izin: setiap baris menyimpan foto
/// wajah pemohon.
/// Setujui permintaan pemulihan password, lalu serahkan kodenya sekali.
///
/// Berbeda dari langkah `desktop_password_reset_*` lain yang sengaja terbuka
/// tanpa sesi, langkah ini menuntut izin: yang terjadi di sini adalah
/// menyerahkan kendali sebuah akun kepada orang yang berdiri di depan layar.
#[tauri::command]
pub async fn desktop_password_reset_approve(
    state: State<'_, DesktopState>,
    request_id: String,
) -> Result<Value, CommandError> {
    let actor = require_permission(&state, "password_reset.approve")?;
    let hasil = state
        .get_turso_client()?
        .password_reset_approve(request_id.trim())
        .await?;
    storage::audit(
        &state.data_dir,
        Some(actor.id),
        "password-reset-approved",
        Some(request_id.trim()),
    );
    Ok(hasil)
}

/// Jalur penyerahan token yang berlaku pada pemasangan ini.
#[tauri::command]
pub async fn desktop_password_reset_route(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    let route = state.get_turso_client()?.password_reset_route().await?;
    Ok(json!({ "route": route }))
}

/// Masuk kembali memakai kode pemulihan, lalu setel password baru.
///
/// Sengaja TANPA sesi: yang memakainya justru orang yang sedang terkunci di
/// luar. Yang menjaganya adalah kode sekali pakai itu sendiri — disimpan
/// sebagai hash, dihapus begitu dipakai.
#[tauri::command]
pub async fn desktop_password_recovery_with_code(
    state: State<'_, DesktopState>,
    identifier: String,
    code: String,
    new_password: String,
) -> Result<Value, CommandError> {
    ensure_login_not_locked(&state, identifier.trim())?;
    let hasil = state
        .get_turso_client()?
        .password_recovery_with_code(&identifier, &code, &new_password)
        .await;
    match hasil {
        Ok(value) => {
            storage::clear_login_failures(&state.data_dir, identifier.trim())?;
            storage::audit(&state.data_dir, None, "password-recovery-code-used", None);
            Ok(value)
        }
        Err(error) => {
            // Kode salah dihitung sebagai percobaan gagal: tanpa itu, kode 8
            // karakter bisa ditebak dengan mencoba terus-menerus.
            if error.code == "RECOVERY_REJECTED" {
                reject_login(&state, identifier.trim())?;
            }
            Err(error)
        }
    }
}

/// Terbitkan ulang kode pemulihan untuk akun yang sedang login.
///
/// SENGAJA hanya untuk akun sendiri, diambil dari sesi — bukan dari id yang
/// dikirim pemanggil. Mencetak kode bagi akun orang lain berarti membuat kunci
/// cadangan ke akun itu tanpa pemiliknya pernah tahu.
#[tauri::command]
pub async fn desktop_issue_recovery_codes(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    let actor = require_session(&state)?;
    let codes = state
        .get_turso_client()?
        .issue_password_recovery_codes(actor.id)
        .await?;
    storage::audit(
        &state.data_dir,
        Some(actor.id),
        "password-recovery-codes-reissued",
        None,
    );
    Ok(json!({ "codes": codes }))
}

#[tauri::command]
pub async fn desktop_list_password_reset_history(
    state: State<'_, DesktopState>,
    status: Option<String>,
    search: Option<String>,
    limit: Option<i64>,
) -> Result<Value, CommandError> {
    require_permission(&state, "password_reset.view")?;
    state
        .get_turso_client()?
        .list_password_reset_history(
            status.as_deref().unwrap_or("ALL"),
            search.as_deref().unwrap_or(""),
            limit.unwrap_or(100),
        )
        .await
}

#[tauri::command]
pub async fn desktop_get_password_reset_photo(
    state: State<'_, DesktopState>,
    request_id: String,
) -> Result<Value, CommandError> {
    require_permission(&state, "password_reset.view")?;
    state
        .get_turso_client()?
        .get_password_reset_photo(&request_id)
        .await
}

#[tauri::command]
pub async fn desktop_delete_password_reset_history(
    state: State<'_, DesktopState>,
    request_id: String,
) -> Result<Value, CommandError> {
    require_permission(&state, "password_reset.delete")?;
    state
        .get_turso_client()?
        .delete_password_reset_history(&request_id)
        .await
}

#[tauri::command]
pub async fn desktop_purge_password_reset_history(
    state: State<'_, DesktopState>,
    older_than_days: i64,
) -> Result<Value, CommandError> {
    require_permission(&state, "password_reset.delete")?;
    state
        .get_turso_client()?
        .purge_password_reset_history(older_than_days)
        .await
}

/// Perintah alur "Lupa Password".

///
/// Sengaja TIDAK memakai `require_permission`: pemohon justru sedang terkunci
/// di luar akunnya sendiri, jadi tidak ada sesi yang bisa diperiksa. Penjaganya
/// adalah verifikasi wajah, urutan tantangan acak yang hanya diketahui
/// database, umur token yang pendek, dan penyerahan link lewat email pemilik
/// akun — bukan sesi.
#[tauri::command]
pub async fn desktop_password_reset_lookup(
    state: State<'_, DesktopState>,
    identifier: String,
) -> Result<Value, CommandError> {
    state.get_turso_client()?.password_reset_lookup(&identifier).await
}

#[tauri::command]
pub async fn desktop_password_reset_confirm(
    state: State<'_, DesktopState>,
    identifier: String,
    confirmation: String,
) -> Result<Value, CommandError> {
    state
        .get_turso_client()?
        .password_reset_confirm(&identifier, &confirmation)
        .await
}

#[tauri::command]
pub async fn desktop_password_reset_swap_challenge(
    state: State<'_, DesktopState>,
    request_id: String,
    challenge_token: String,
    step_index: i64,
) -> Result<Value, CommandError> {
    state
        .get_turso_client()?
        .password_reset_swap_challenge(&request_id, &challenge_token, step_index)
        .await
}

#[tauri::command]
pub async fn desktop_password_reset_verify(
    state: State<'_, DesktopState>,
    request_id: String,
    challenge_token: String,
    verdict: Value,
    photo_base64: String,
    photo_mime: String,
) -> Result<Value, CommandError> {
    state
        .get_turso_client()?
        .password_reset_verify(
            &request_id,
            &challenge_token,
            &verdict,
            &photo_base64,
            &photo_mime,
        )
        .await
}

#[tauri::command]
pub async fn desktop_password_reset_inspect(
    state: State<'_, DesktopState>,
    token: String,
) -> Result<Value, CommandError> {
    state.get_turso_client()?.password_reset_inspect(&token).await
}

#[tauri::command]
pub async fn desktop_password_reset_complete(
    state: State<'_, DesktopState>,
    token: String,
    password: String,
) -> Result<Value, CommandError> {
    let password = Zeroizing::new(password);
    state
        .get_turso_client()?
        .password_reset_complete(&token, &password)
        .await
}

#[tauri::command]
pub async fn desktop_send_test_mail(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    let actor = require_permission(&state, "settings.manage")?;
    state.get_turso_client()?.send_test_mail(actor.id).await
}

#[tauri::command]
pub async fn desktop_get_mail_config(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    require_permission(&state, "settings.manage")?;
    state.get_turso_client()?.get_mail_config().await
}

#[tauri::command]
pub async fn desktop_save_mail_config(
    state: State<'_, DesktopState>,
    draft: Value,
) -> Result<Value, CommandError> {
    let actor = require_permission(&state, "settings.manage")?;
    state
        .get_turso_client()?
        .save_mail_config(&draft, &actor.kode_operator)
        .await
}

/// Pengelolaan verifikasi dua langkah.
///
/// `status`, `begin`, `confirm`, dan `disable` selalu bekerja pada akun
/// PEMANGGIL — id operatornya diambil dari sesi, tidak pernah dari argumen.
/// Tanpa aturan itu, siapa pun yang punya sesi bisa mematikan 2FA milik orang
/// lain hanya dengan menebak id.
#[tauri::command]
pub async fn desktop_get_two_factor_status(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    let actor = require_session(&state)?;
    state
        .get_turso_client()?
        .get_two_factor_status(actor.id)
        .await
}

#[tauri::command]
pub async fn desktop_begin_two_factor_setup(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    let actor = require_session(&state)?;
    state
        .get_turso_client()?
        .begin_two_factor_setup(actor.id)
        .await
}

#[tauri::command]
pub async fn desktop_confirm_two_factor_setup(
    state: State<'_, DesktopState>,
    code: String,
) -> Result<Value, CommandError> {
    let actor = require_session(&state)?;
    state
        .get_turso_client()?
        .confirm_two_factor_setup(actor.id, &code)
        .await
}

#[tauri::command]
pub async fn desktop_disable_two_factor(
    state: State<'_, DesktopState>,
    code: String,
) -> Result<Value, CommandError> {
    let actor = require_session(&state)?;
    state
        .get_turso_client()?
        .disable_two_factor(actor.id, true, &code)
        .await
}

/// Mematikan 2FA operator lain — untuk operator yang kehilangan ponselnya.
/// Dijaga izin `two_factor.reset` yang masuk daftar mutasi sensitif.
#[tauri::command]
pub async fn desktop_admin_disable_two_factor(
    state: State<'_, DesktopState>,
    operator_id: i64,
) -> Result<Value, CommandError> {
    require_permission(&state, "two_factor.reset")?;
    state
        .get_turso_client()?
        .disable_two_factor(operator_id, false, "")
        .await
}

#[tauri::command]
pub async fn desktop_get_master_operators(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    require_permission(&state, "operators.view")?;
    if let Ok(turso) = state.get_turso_client() {
        return turso.get_master_operators().await;
    }
    Err(CommandError::new(
        "DATABASE_NOT_CONFIGURED",
        "The database is not configured. Open Settings to connect it.",
    ))
}

#[tauri::command]
pub async fn desktop_create_operator(
    state: State<'_, DesktopState>,
    draft: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "operators.manage")?;
    if let Ok(turso) = state.get_turso_client() {
        return turso.create_operator(&draft).await;
    }
    Err(CommandError::new(
        "DATABASE_NOT_CONFIGURED",
        "The database is not configured. Open Settings to connect it.",
    ))
}

#[tauri::command]
pub async fn desktop_update_operator(
    state: State<'_, DesktopState>,
    operator_id: i64,
    draft: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "operators.manage")?;
    if let Ok(turso) = state.get_turso_client() {
        return turso.update_operator(operator_id, &draft).await;
    }
    Err(CommandError::new(
        "DATABASE_NOT_CONFIGURED",
        "The database is not configured. Open Settings to connect it.",
    ))
}

#[tauri::command]
pub async fn desktop_delete_operator(
    state: State<'_, DesktopState>,
    operator_id: i64,
) -> Result<Value, CommandError> {
    require_permission(&state, "operators.manage")?;
    if let Ok(turso) = state.get_turso_client() {
        return turso.delete_operator(operator_id).await;
    }
    Err(CommandError::new(
        "DATABASE_NOT_CONFIGURED",
        "The database is not configured. Open Settings to connect it.",
    ))
}

#[tauri::command]
pub async fn desktop_get_roles(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    require_permission(&state, "roles.manage")?;
    if let Ok(turso) = state.get_turso_client() {
        return turso.get_roles().await;
    }
    Err(CommandError::new(
        "DATABASE_NOT_CONFIGURED",
        "The database is not configured. Open Settings to connect it.",
    ))
}

#[tauri::command]
pub async fn desktop_create_role(
    state: State<'_, DesktopState>,
    draft: Value,
    permission_keys: Vec<String>,
) -> Result<Value, CommandError> {
    require_permission(&state, "roles.manage")?;
    if let Ok(turso) = state.get_turso_client() {
        let mut full_draft = draft.clone();
        full_draft["permissions"] = json!(permission_keys);
        return turso.create_role(&full_draft).await;
    }
    Err(CommandError::new(
        "DATABASE_NOT_CONFIGURED",
        "The database is not configured. Open Settings to connect it.",
    ))
}

#[tauri::command]
pub async fn desktop_update_role(
    state: State<'_, DesktopState>,
    role_id: i64,
    draft: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "roles.manage")?;
    if let Ok(turso) = state.get_turso_client() {
        return turso.update_role(role_id, &draft).await;
    }
    Err(CommandError::new(
        "DATABASE_NOT_CONFIGURED",
        "The database is not configured. Open Settings to connect it.",
    ))
}

#[tauri::command]
pub async fn desktop_set_role_permissions(
    state: State<'_, DesktopState>,
    role_id: i64,
    permission_keys: Vec<String>,
) -> Result<Value, CommandError> {
    require_permission(&state, "roles.manage")?;
    if let Ok(turso) = state.get_turso_client() {
        return turso.set_role_permissions(role_id, &permission_keys).await;
    }
    Err(CommandError::new(
        "DATABASE_NOT_CONFIGURED",
        "The database is not configured. Open Settings to connect it.",
    ))
}

#[tauri::command]
pub async fn desktop_delete_role(
    state: State<'_, DesktopState>,
    role_id: i64,
) -> Result<Value, CommandError> {
    require_permission(&state, "roles.manage")?;
    if let Ok(turso) = state.get_turso_client() {
        return turso.delete_role(role_id).await;
    }
    Err(CommandError::new(
        "DATABASE_NOT_CONFIGURED",
        "The database is not configured. Open Settings to connect it.",
    ))
}

#[tauri::command]
pub fn desktop_get_sync_status(
    state: State<'_, DesktopState>,
) -> Result<DesktopSyncStatus, CommandError> {
    require_permission(&state, "sync.view")?;
    sync::status(&state)
}

#[tauri::command]
pub async fn desktop_sync_now(
    state: State<'_, DesktopState>,
) -> Result<DesktopSyncStatus, CommandError> {
    // Pesan dibuat spesifik: role tanpa `sync.view` membuat auto-sync berhenti
    // total, dan gejalanya di lapangan hanya "data tidak masuk" tanpa petunjuk.
    require_permission(&state, "sync.view").map_err(|error| {
        if error.code == "DESKTOP_ACCESS_DENIED" {
            CommandError::new(
                "DESKTOP_ACCESS_DENIED",
                "This account's role does not have the 'sync.view' permission, so automatic sync cannot run. Add that permission to the role on the Operators page.",
            )
        } else {
            error
        }
    })?;
    // Sengaja TIDAK menuntut sesi online. Perangkat yang login lewat snapshot
    // offline tetap harus bisa mendorong antrean lokalnya begitu database dapat
    // dihubungi kembali; menolaknya di sini adalah persis gejala "push & pull
    // mati" yang pernah terjadi.
    if state.turso_config().is_none() {
        return Err(CommandError::new(
            "DATABASE_NOT_CONFIGURED",
            "The database is not configured. Open Settings to connect it.",
        ));
    }
    let result = sync::synchronize(&state).await;
    if let Err(error) = &result {
        clear_expired_session(&state, error);
    }
    result
}

#[tauri::command]
pub fn desktop_get_sync_conflicts(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    require_permission(&state, "sync.view")?;
    sync::conflicts(&state)
}

#[tauri::command]
pub async fn desktop_retry_failed_sync(
    state: State<'_, DesktopState>,
    event_id: Option<String>,
) -> Result<DesktopSyncStatus, CommandError> {
    require_permission(&state, "sync.retry")?;
    sync::retry_failed(&state, event_id.as_deref())?;
    desktop_sync_now(state).await
}

#[tauri::command]
pub async fn desktop_resolve_sync_conflicts(
    state: State<'_, DesktopState>,
    event_id: Option<String>,
) -> Result<DesktopSyncStatus, CommandError> {
    require_permission(&state, "sync.retry")?;
    sync::resolve_conflicts(&state, event_id.as_deref())?;
    desktop_sync_now(state).await
}

#[tauri::command]
pub async fn desktop_resolve_sync_conflicts_local(
    state: State<'_, DesktopState>,
    event_id: Option<String>,
) -> Result<DesktopSyncStatus, CommandError> {
    require_permission(&state, "sync.retry")?;
    sync::resolve_conflicts_local(&state, event_id.as_deref())?;
    desktop_sync_now(state).await
}

#[tauri::command]
pub fn desktop_clear_failed_sync(
    state: State<'_, DesktopState>,
    event_id: Option<String>,
) -> Result<DesktopSyncStatus, CommandError> {
    require_permission(&state, "sync.retry")?;
    sync::clear_failed(&state, event_id.as_deref())?;
    desktop_get_sync_status(state)
}

/// Keluarkan seluruh isi database lokal ke satu berkas cadangan.
///
/// Frasa sandi kosong menghasilkan berkas SQLite polos. Itu sah — berguna untuk
/// diagnosa karena bisa dibuka di DB Browser — tetapi berkasnya memuat hash
/// password dan rahasia TOTP, sehingga UI WAJIB memperingatkan pengguna
/// sebelum memilihnya.
#[tauri::command]
pub fn desktop_export_database(
    state: State<'_, DesktopState>,
    passphrase: Option<String>,
) -> Result<portability::ExportReport, CommandError> {
    let operator = require_permission(&state, "database_backup.export")?;
    let report = portability::export_database(&state, passphrase.as_deref())?;
    storage::audit(
        &state.data_dir,
        Some(operator.id),
        if report.encrypted {
            "database-export-encrypted"
        } else {
            "database-export-plaintext"
        },
        Some(&report.file_name),
    );
    Ok(report)
}

/// Ganti isi database lokal dengan isi berkas cadangan.
///
/// Ini MENIMPA seluruh data perangkat, bukan menggabungkannya — karena itu
/// izinnya masuk `SENSITIVE_MUTATION_PERMISSIONS`. Berkas lama tetap disimpan
/// berdampingan oleh `portability::import_database`, sehingga salah pilih
/// berkas masih bisa dibatalkan secara manual.
#[tauri::command]
pub fn desktop_import_database(
    state: State<'_, DesktopState>,
    source_path: String,
    passphrase: Option<String>,
) -> Result<portability::ImportReport, CommandError> {
    let operator = require_permission(&state, "database_backup.restore")?;
    let report = portability::import_database(
        &state,
        std::path::Path::new(source_path.trim()),
        passphrase.as_deref(),
    )?;
    storage::audit(
        &state.data_dir,
        Some(operator.id),
        "database-restore",
        Some(&format!("schema v{}", report.schema_version)),
    );
    Ok(report)
}

/// Pulihkan dari berkas yang dipilih lewat `<input type="file">`.
///
/// Android tidak pernah menyerahkan path sebenarnya kepada halaman web, jadi
/// tanpa jalur ini pemulihan mustahil dilakukan di Mobile. Validasinya sama
/// persis dengan jalur berbasis path — datangnya berkas dari pemilih berkas
/// bukan alasan untuk melonggarkan pemeriksaan apa pun.
#[tauri::command]
pub fn desktop_import_database_bytes(
    state: State<'_, DesktopState>,
    file_name: String,
    base64_data: String,
    passphrase: Option<String>,
) -> Result<portability::ImportReport, CommandError> {
    let operator = require_permission(&state, "database_backup.restore")?;
    let payload = BASE64_STANDARD.decode(base64_data.trim()).map_err(|_| {
        CommandError::new("BACKUP_CORRUPT", "The backup file contents could not be read.")
    })?;
    let report = portability::import_database_bytes(
        &state,
        &payload,
        file_name.trim(),
        passphrase.as_deref(),
    )?;
    storage::audit(
        &state.data_dir,
        Some(operator.id),
        "database-restore-upload",
        Some(&format!("schema v{}", report.schema_version)),
    );
    Ok(report)
}

/// Lokasi folder data aplikasi, untuk ditampilkan di layar Cadangan.
///
/// Pada Desktop pengguna bisa membukanya sendiri di file explorer dan menyalin
/// berkasnya secara manual — asalkan aplikasi ditutup lebih dulu. Pada Android
/// folder ini privat dan tidak terjangkau, sehingga UI mengarahkan penggunanya
/// ke tombol Bagikan.
#[tauri::command]
pub fn desktop_get_data_folder(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    require_permission(&state, "database_backup.export")?;
    Ok(json!({
        "dataDir": state.data_dir.to_string_lossy(),
        "hubPath": state.local_hub_path().to_string_lossy(),
    }))
}

#[tauri::command]
pub fn desktop_get_server_url(state: State<'_, DesktopState>) -> Result<String, CommandError> {
    Ok(state.server_origin())
}

#[tauri::command]
pub fn desktop_set_server_url(
    state: State<'_, DesktopState>,
    url: String,
) -> Result<String, CommandError> {
    state.set_server_url(&url)
}

#[tauri::command]
pub fn desktop_get_turso_url(
    state: State<'_, DesktopState>,
) -> Result<Option<String>, CommandError> {
    let operator = require_permission(&state, "settings.view")?;
    if !operator.is_superadmin {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Cloud database settings can only be viewed by the Superadmin.",
        ));
    }
    Ok(state.turso_config().map(|c| c.database_url))
}

/// Ringkasan konfigurasi database aktif untuk halaman Pengaturan.
///
/// `desktop_get_turso_url` hanya mengembalikan URL, sehingga UI tidak punya cara
/// mengetahui provider mana yang aktif dan selalu menampilkan ulang formulir
/// dalam mode Turso — termasuk pada perangkat yang justru terhubung ke server
/// LAN. Auth Token tetap tidak pernah ikut keluar dari vault.
#[tauri::command]
pub fn desktop_get_database_config(
    state: State<'_, DesktopState>,
) -> Result<turso::DatabaseConfigView, CommandError> {
    let operator = require_permission(&state, "settings.view")?;
    if !operator.is_superadmin {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Database settings can only be viewed by the Superadmin.",
        ));
    }
    Ok(state
        .turso_config()
        .as_ref()
        .map(turso::DatabaseConfigView::from_config)
        .unwrap_or_else(turso::DatabaseConfigView::empty))
}

#[tauri::command]
pub async fn desktop_save_turso_config(
    state: State<'_, DesktopState>,
    database_url: String,
    auth_token: String,
    provider: Option<turso::DatabaseProvider>,
    allow_insecure_transport: Option<bool>,
) -> Result<String, CommandError> {
    let operator = require_permission(&state, "settings.manage")?;
    if !operator.is_superadmin {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Only the Superadmin can change the cloud database settings.",
        ));
    }
    // Provider yang tidak dikirim mewarisi pilihan tersimpan supaya klien lama
    // yang hanya mengirim url+token tidak diam-diam menurunkan konfigurasi
    // server sendiri menjadi Turso — yang akan langsung menolak alamat LAN-nya.
    let stored = state.turso_config();
    let provider = provider
        .or_else(|| stored.as_ref().map(|config| config.provider))
        .unwrap_or_default();
    let allow_insecure_transport = allow_insecure_transport
        .or_else(|| {
            stored
                .as_ref()
                .map(|config| config.allow_insecure_transport)
        })
        .unwrap_or(false);
    let origin = state.set_database_config(&turso::TursoConfig::new(
        database_url,
        auth_token,
        provider,
        allow_insecure_transport,
    ))?;
    let _ = sync::pull_snapshot(&state).await;
    Ok(origin)
}

#[tauri::command]
pub async fn desktop_test_turso_connection(
    state: State<'_, DesktopState>,
    database_url: Option<String>,
    auth_token: Option<String>,
    provider: Option<turso::DatabaseProvider>,
    allow_insecure_transport: Option<bool>,
) -> Result<turso::TursoConnectionStatus, CommandError> {
    let operator = require_permission(&state, "settings.view")?;
    if !operator.is_superadmin {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Only the Superadmin can test the cloud database connection.",
        ));
    }

    let stored = state.turso_config();
    let config = if let Some(u) = database_url.as_ref().filter(|u| !u.trim().is_empty()) {
        let provider = provider
            .or_else(|| stored.as_ref().map(|config| config.provider))
            .unwrap_or_default();
        let allow_insecure_transport = allow_insecure_transport
            .or_else(|| {
                stored
                    .as_ref()
                    .map(|config| config.allow_insecure_transport)
            })
            .unwrap_or(false);
        // Perbandingan URL wajib ternormalisasi. Versi lama menyamakan string
        // mentah, jadi menekan "Tes Koneksi" setelah mengetik ulang URL yang sama
        // dengan ejaan berbeda mengirim token kosong dan selalu gagal.
        let auth_token = if let Some(t) = auth_token.as_ref().filter(|t| !t.trim().is_empty()) {
            t.trim().to_owned()
        } else {
            stored
                .as_ref()
                .filter(|config| config.matches_url(u))
                .map(|config| config.auth_token.clone())
                .unwrap_or_default()
        };

        turso::TursoConfig::new(
            u.trim().to_owned(),
            auth_token,
            provider,
            allow_insecure_transport,
        )
    } else if let Some(cfg) = stored {
        cfg
    } else {
        return Err(CommandError::new(
            "TURSO_NOT_CONFIGURED",
            "The Turso cloud database is not configured.",
        ));
    };

    let client = match turso::TursoClient::from_config(&config, state.http.clone()) {
        Ok(c) => c,
        Err(e) => {
            return Ok(turso::TursoConnectionStatus {
                connected: false,
                url: config.database_url,
                latency_ms: None,
                error_message: Some(e.message),
            });
        }
    };

    match client.ping().await {
        Ok(latency_ms) => Ok(turso::TursoConnectionStatus {
            connected: true,
            url: client.base_url().to_string(),
            latency_ms: Some(latency_ms),
            error_message: None,
        }),
        Err(e) => Ok(turso::TursoConnectionStatus {
            connected: false,
            url: client.base_url().to_string(),
            latency_ms: None,
            error_message: Some(e.message),
        }),
    }
}

#[tauri::command]
pub fn desktop_clear_turso_config(state: State<'_, DesktopState>) -> Result<(), CommandError> {
    let operator = require_permission(&state, "settings.manage")?;
    if !operator.is_superadmin {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Only the Superadmin can reset the cloud database settings.",
        ));
    }
    secrets::clear_turso_config(&state)?;
    storage::set_system_setting(&state.data_dir, "turso_database_url", "")?;
    storage::set_system_setting(&state.data_dir, "turso_auth_token", "")?;
    storage::set_system_setting(&state.data_dir, "turso_database_provider", "")?;
    storage::set_system_setting(&state.data_dir, "turso_allow_insecure_transport", "")?;
    *state
        .turso_config
        .write()
        .map_err(|_| CommandError::internal())? = None;
    Ok(())
}

// ===========================================================================
// PROFIL PERUSAHAAN — bagian PLATFORM, bukan domain contoh.
//
// Jangan hapus bersama domain contoh: hampir setiap aplikasi bisnis memerlukan
// identitas pemakainya untuk kop dokumen, cetakan, dan ekspor.
//
// Tabelnya berbentuk BARIS TUNGGAL (`id = 'default_company'`), berbeda dari
// setiap tabel lain di template ini. Karena itu `entity_key`-nya konstanta,
// dan handler cloud memakai `ON CONFLICT(id) DO UPDATE` sehingga push yang
// terkirim dua kali tidak pernah menggandakan baris.
// ===========================================================================

/// Satu baris log audit domain (PRD FR-10) untuk mutasi yang sedang ditulis.
struct AuditEntry<'a> {
    actor: &'a OperatorUser,
    action: &'static str,
    entity_type: &'static str,
    entity_id: &'a str,
    summary: Value,
    /// Divisi yang diwakili (D-23: CS mencatat atas nama RnD/Finance).
    /// `None` = role pelaku sendiri.
    on_behalf_of: Option<&'static str>,
}

/// Tulis satu mutasi lokal beserta event outbox-nya dalam satu transaksi.
/// Bila `audit` diisi, baris log audit dan event `audit/record`-nya ikut
/// transaksi yang sama (PRD FR-10.1): mutasi dan jejaknya tidak pernah terpisah.
fn commit_with_outbox(
    state: &DesktopState,
    domain: &str,
    operation: &str,
    entity_key: &str,
    payload: Value,
    audit: Option<AuditEntry<'_>>,
    apply: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<(), CommandError>,
) -> Result<(), CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    apply(&transaction)?;
    if let Some(entry) = audit {
        write_audit(&transaction, &client_id, entry)?;
    }
    sync::enqueue(
        &transaction,
        &client_id,
        domain,
        operation,
        entity_key,
        &payload,
        // `base_revision` dipakai untuk konkurensi optimistis: isi dengan revisi
        // baris yang Anda baca sebelum mengubahnya bila domain Anda perlu
        // menolak penimpaan data yang sudah lebih baru di cloud.
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(())
}

/// Tulis satu baris log audit beserta event `audit/record`-nya di transaksi
/// lokal yang sedang berjalan.
fn write_audit(
    transaction: &rusqlite::Transaction<'_>,
    client_id: &str,
    entry: AuditEntry<'_>,
) -> Result<(), CommandError> {
    let id = clients::new_uuid();
    let occurred_at = clients::utc_timestamp(storage::now_epoch_seconds());
    let summary = entry.summary.to_string();
    let division = entry.on_behalf_of.unwrap_or(&entry.actor.role);
    transaction
        .execute(
            clients::DOMAIN_AUDIT_INSERT_SQL,
            rusqlite::params![
                &id,
                entry.actor.id,
                division,
                entry.action,
                entry.entity_type,
                entry.entity_id,
                &summary,
                &occurred_at
            ],
        )
        .map_err(|_| CommandError::internal())?;
    sync::enqueue(
        transaction,
        client_id,
        "audit",
        "record",
        &id,
        &json!({
            "id": id,
            "actor_operator_id": entry.actor.id,
            "on_behalf_of_division": division,
            "action": entry.action,
            "entity_type": entry.entity_type,
            "entity_id": entry.entity_id,
            "summary_json": summary,
            "occurred_at": occurred_at,
        }),
        None,
    )?;
    Ok(())
}

/// Nilai bawaan sebuah pemasangan yang belum pernah disunting.
///
/// Baris ini TIDAK di-seed saat provisioning, melainkan dibuat saat pertama
/// kali dibaca. Alasannya: menyeednya di `ensure_schema` berarti setiap
/// perangkat baru mendorong baris "Company Name" ke cloud lewat outbox, dan
/// perangkat yang kebetulan sinkron belakangan akan menimpa identitas asli yang
/// sudah diisi orang lain.
fn default_company_profile(now: &str) -> Value {
    json!({
        "id": "default_company",
        "company_name": "Company Name",
        "branch_name": Value::Null,
        "logo_url": Value::Null,
        "signature_url": Value::Null,
        "address": Value::Null,
        "phone": Value::Null,
        "email": Value::Null,
        "website": Value::Null,
        "leader_name": Value::Null,
        "leader_title": Value::Null,
        "timezone": "Asia/Jakarta",
        "updated_at": now,
    })
}

/// Identitas perusahaan pemakai aplikasi.
///
/// SENGAJA hanya menuntut sesi, bukan `settings.view`. Nilai-nilai ini muncul
/// di kop setiap dokumen yang dicetak aplikasi, jadi menguncinya di balik izin
/// pengaturan akan membuat operator biasa mencetak dokumen tanpa kop. Isinya
/// pun bukan rahasia — ini kepala surat perusahaan itu sendiri.
#[tauri::command]
pub fn desktop_get_company_profile(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    require_session(&state)?;
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT id, company_name, branch_name, logo_url, signature_url, address,
                    phone, email, website, leader_name, leader_title, timezone, updated_at
             FROM company_profile WHERE id = 'default_company' LIMIT 1;",
        )
        .map_err(|_| CommandError::internal())?;
    let mut rows = statement
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "company_name": row.get::<_, String>(1)?,
                "branch_name": row.get::<_, Option<String>>(2)?,
                "logo_url": row.get::<_, Option<String>>(3)?,
                "signature_url": row.get::<_, Option<String>>(4)?,
                "address": row.get::<_, Option<String>>(5)?,
                "phone": row.get::<_, Option<String>>(6)?,
                "email": row.get::<_, Option<String>>(7)?,
                "website": row.get::<_, Option<String>>(8)?,
                "leader_name": row.get::<_, Option<String>>(9)?,
                "leader_title": row.get::<_, Option<String>>(10)?,
                "timezone": row.get::<_, Option<String>>(11)?
                    .unwrap_or_else(|| "Asia/Jakarta".to_owned()),
                "updated_at": row.get::<_, String>(12)?,
            }))
        })
        .map_err(|_| CommandError::internal())?;

    match rows.next() {
        Some(Ok(profile)) => Ok(profile),
        // Belum pernah diisi. Nilai bawaan dikembalikan TANPA menulis apa pun —
        // lihat catatan di `default_company_profile`.
        _ => Ok(default_company_profile("")),
    }
}

/// Simpan identitas perusahaan, lalu antrekan untuk disinkronkan.
#[tauri::command]
pub async fn desktop_update_company_profile(
    state: State<'_, DesktopState>,
    profile: Value,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "settings.manage")?;

    let text = |key: &str| -> String {
        profile
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    let company_name = text("company_name");
    if company_name.chars().count() < 2 {
        return Err(CommandError::new(
            "COMPANY_PROFILE_INVALID",
            "Nama perusahaan minimal dua karakter.",
        ));
    }
    let optional = |key: &str| -> Option<String> {
        let value = text(key);
        if value.is_empty() { None } else { Some(value) }
    };
    let timezone = {
        let value = text("timezone");
        if value.is_empty() {
            "Asia/Jakarta".to_owned()
        } else {
            value
        }
    };

    // Stempel waktu dihitung SQLite, bukan jam proses: satu baris yang sama
    // ditulis Rust di perangkat dan TypeScript di Web, dan keduanya harus
    // menghasilkan bentuk yang dapat dibandingkan.
    let now: String = storage::database(&state.data_dir)?
        .query_row("SELECT datetime('now');", [], |row| row.get(0))
        .map_err(|_| CommandError::internal())?;

    let payload = json!({
        "id": "default_company",
        "company_name": company_name,
        "branch_name": optional("branch_name"),
        "logo_url": optional("logo_url"),
        "signature_url": optional("signature_url"),
        "address": optional("address"),
        "phone": optional("phone"),
        "email": optional("email"),
        "website": optional("website"),
        "leader_name": optional("leader_name"),
        "leader_title": optional("leader_title"),
        "timezone": timezone,
        "updated_at": now,
    });

    let row = payload.clone();
    commit_with_outbox(
        &state,
        "company-profile",
        "update",
        "default_company",
        payload.clone(),
        None,
        move |transaction| {
            let value = |key: &str| -> Option<String> {
                row.get(key)
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            };
            transaction
                .execute(
                    r#"INSERT INTO company_profile
                        (id, company_name, branch_name, logo_url, signature_url,
                         address, phone, email, website,
                         leader_name, leader_title, timezone, updated_at)
                       VALUES ('default_company', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
                    rusqlite::params![
                        value("company_name"),
                        value("branch_name"),
                        value("logo_url"),
                        value("signature_url"),
                        value("address"),
                        value("phone"),
                        value("email"),
                        value("website"),
                        value("leader_name"),
                        value("leader_title"),
                        value("timezone"),
                        value("updated_at"),
                    ],
                )
                .map_err(|_| CommandError::internal())?;
            Ok(())
        },
    )?;

    storage::audit(
        &state.data_dir,
        Some(operator.id),
        "company-profile-update",
        None,
    );
    let _ = sync::synchronize(&state).await;
    Ok(payload)
}

// ===========================================================================
// DOMAIN MAKLONOS: klien, lead, Master Data, dan setelan kode klien.
//
// Padanan jalur Web: `src/lib/server/clients.ts`. Pesan validasi dan aturan
// keduanya WAJIB sama; aturan murninya ada di `clients.rs` / `client.ts` dan
// diuji dengan vektor kembar.
//
// Pola yang wajib dipertahankan pada setiap mutasi:
//
//   1. Tulis perubahan ke SQLite lokal DAN daftarkan event outbox dalam SATU
//      transaksi (`commit_with_outbox`).
//   2. Pakai pasangan (domain, operation) yang terdaftar di
//      `CANONICAL_SYNC_ROUTES`. Pasangan lain ditolak batas cloud.
//   3. `entity_key` adalah identitas resmi baris (UUID buatan perangkat).
//   4. Picu sinkronisasi latar setelah commit, jangan sebelum.
// ===========================================================================

use super::{clients, samples};

fn draft_text(draft: &Value, key: &str) -> String {
    draft
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn client_invalid(message: impl Into<String>) -> CommandError {
    CommandError::new("CLIENT_INVALID", message)
}

struct ClientDraft {
    name: String,
    phone: String,
    address: String,
    city: String,
    province: String,
    channel: String,
    category: String,
    needs: String,
}

/// Opsi Master Data boleh dipakai bila ada, jenisnya cocok, dan aktif — atau
/// memang nilai yang sudah tersimpan (opsi yang dinonaktifkan belakangan tidak
/// boleh membuat klien lama tidak bisa disunting).
fn option_usable(
    connection: &rusqlite::Connection,
    id: &str,
    kind: &str,
    current: Option<&str>,
) -> Result<bool, CommandError> {
    use rusqlite::OptionalExtension;
    if id.is_empty() {
        return Ok(false);
    }
    let active = connection
        .query_row(
            "SELECT is_active FROM master_option WHERE id = ? AND kind = ?;",
            rusqlite::params![id, kind],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;
    Ok(match active {
        Some(flag) => flag == 1 || current == Some(id),
        None => false,
    })
}

fn validate_client_draft(
    connection: &rusqlite::Connection,
    draft: &Value,
    current: Option<(&str, &str)>,
) -> Result<ClientDraft, CommandError> {
    let name = draft_text(draft, "name");
    let length = name.chars().count();
    if !(clients::CLIENT_NAME_MIN..=clients::CLIENT_NAME_MAX).contains(&length) {
        return Err(client_invalid("The client name must be 2-120 characters."));
    }
    let phone = clients::normalize_whatsapp(&draft_text(draft, "phone")).ok_or_else(|| {
        client_invalid("Enter a valid WhatsApp number that starts with 0 or 62.")
    })?;
    let address = draft_text(draft, "address");
    let city = draft_text(draft, "city");
    let province = draft_text(draft, "province");
    if [&address, &city, &province]
        .iter()
        .any(|value| value.chars().count() > clients::CLIENT_TEXT_MAX)
    {
        return Err(client_invalid(
            "Address, city, and province can be at most 300 characters each.",
        ));
    }
    let needs = draft_text(draft, "needs_notes");
    if needs.chars().count() > clients::CLIENT_NOTES_MAX {
        return Err(client_invalid("Client needs can be at most 2000 characters."));
    }
    let channel = draft_text(draft, "channel_option_id");
    if !option_usable(connection, &channel, "LEAD_CHANNEL", current.map(|c| c.0))? {
        return Err(client_invalid("Choose an active lead channel."));
    }
    let category = draft_text(draft, "product_category_option_id");
    if !option_usable(connection, &category, "PRODUCT_CATEGORY", current.map(|c| c.1))? {
        return Err(client_invalid("Choose an active product category."));
    }
    Ok(ClientDraft {
        name,
        phone,
        address,
        city,
        province,
        channel,
        category,
        needs,
    })
}

/// Kode klien lain yang sudah memakai nomor ini di data lokal. Cloud
/// memeriksa ulang saat push (guard di `turso.rs::push_events`).
fn local_phone_owner(
    connection: &rusqlite::Connection,
    phone: &str,
    client_id: &str,
) -> Result<Option<String>, CommandError> {
    use rusqlite::OptionalExtension;
    connection
        .query_row(
            "SELECT client_code FROM clients WHERE phone_normalized = ? AND id <> ? LIMIT 1;",
            rusqlite::params![phone, client_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())
}

fn duplicate_phone(phone: &str, owner: &str) -> CommandError {
    CommandError::new(
        "CLIENT_PHONE_TAKEN",
        format!("The WhatsApp number {phone} is already registered to client {owner}."),
    )
}

fn company_timezone(connection: &rusqlite::Connection) -> String {
    connection
        .query_row(
            "SELECT timezone FROM company_profile WHERE id = 'default_company';",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Asia/Jakarta".to_owned())
}

/// Setelan bisnis dari `setting_gex_system` lokal (PRD FR-11). Padanan
/// `loadBusinessSettings` di `src/lib/server/business-settings.ts`.
fn business_settings(connection: &rusqlite::Connection) -> samples::BusinessSettings {
    let mut values = std::collections::HashMap::new();
    for key in samples::BUSINESS_SETTING_KEYS {
        if let Ok(value) = connection.query_row(
            "SELECT value FROM setting_gex_system WHERE key = ? LIMIT 1;",
            [key],
            |row| row.get::<_, String>(0),
        ) {
            values.insert((*key).to_owned(), value);
        }
    }
    samples::read_business_settings(&values)
}

fn client_code_prefix(state: &DesktopState) -> String {
    storage::get_system_setting(&state.data_dir, clients::CLIENT_CODE_PREFIX_SETTING)
        .ok()
        .flatten()
        .and_then(|value| clients::normalize_code_prefix(&value))
        .unwrap_or_else(|| clients::DEFAULT_CLIENT_CODE_PREFIX.to_owned())
}

fn client_code_web_tag(state: &DesktopState) -> String {
    storage::get_system_setting(&state.data_dir, clients::CLIENT_CODE_WEB_TAG_SETTING)
        .ok()
        .flatten()
        .and_then(|value| clients::normalize_device_tag(&value))
        .unwrap_or_else(|| clients::DEFAULT_CLIENT_CODE_WEB_TAG.to_owned())
}

/// Daftar klien beserta lead-nya, terbaru dulu. Bentuk barisnya sama dengan
/// `listClients` di `src/lib/server/clients.ts`. Segmen dihitung saat dibaca
/// dari jam perangkat (PRD FR-05.3, FR-05.7), tidak pernah disimpan.
#[tauri::command]
pub fn desktop_list_clients(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    require_permission(&state, "clients.view")?;
    let connection = storage::database(&state.data_dir)?;
    let timezone = company_timezone(&connection);
    let business = business_settings(&connection);
    let now = storage::now_epoch_seconds();
    let mut statement = connection
        .prepare(
            "SELECT c.id, c.client_code, c.name, c.phone_normalized, c.address, c.city,
                    c.province, c.lifecycle_status, c.created_by, c.created_at, c.updated_at,
                    l.id, l.pic_cs_id, l.channel_option_id, l.product_category_option_id,
                    l.needs_notes, l.last_client_response_at, l.total_followups,
                    l.last_followup_at, o.nama_operator, c.free_revision_limit
             FROM clients c
             LEFT JOIN leads l ON l.client_id = c.id
             LEFT JOIN master_operator o ON o.id = l.pic_cs_id
             ORDER BY c.created_at DESC, c.id;",
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| {
            let lifecycle = row.get::<_, String>(7)?;
            let last_response = row.get::<_, Option<String>>(16)?.unwrap_or_default();
            let days = clients::days_since_response(&last_response, now, &timezone);
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "client_code": row.get::<_, String>(1)?,
                "name": row.get::<_, String>(2)?,
                "phone_normalized": row.get::<_, String>(3)?,
                "address": row.get::<_, String>(4)?,
                "city": row.get::<_, String>(5)?,
                "province": row.get::<_, String>(6)?,
                "segment": clients::lead_segment(
                    &lifecycle,
                    days,
                    business.lead_hot_max_days,
                    business.lead_warm_max_days,
                ),
                "free_revision_limit": row.get::<_, Option<i64>>(20)?.unwrap_or(0),
                "lifecycle_status": lifecycle,
                "created_by": row.get::<_, Option<i64>>(8)?,
                "created_at": row.get::<_, String>(9)?,
                "updated_at": row.get::<_, String>(10)?,
                "lead_id": row.get::<_, Option<String>>(11)?,
                "pic_cs_id": row.get::<_, Option<i64>>(12)?,
                "pic_cs_name": row.get::<_, Option<String>>(19)?,
                "channel_option_id": row.get::<_, Option<String>>(13)?.unwrap_or_default(),
                "product_category_option_id": row.get::<_, Option<String>>(14)?.unwrap_or_default(),
                "needs_notes": row.get::<_, Option<String>>(15)?.unwrap_or_default(),
                "last_client_response_at": last_response,
                "last_followup_at": row.get::<_, Option<String>>(18)?.unwrap_or_default(),
                "total_followups": row.get::<_, Option<i64>>(17)?.unwrap_or(0),
                "days_since_response": days,
            }))
        })
        .map_err(|_| CommandError::internal())?;
    Ok(Value::Array(
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?,
    ))
}

/// Kuota revisi per klien (FR-06.5). `null`/tidak dikirim = pertahankan.
/// Padanan `clientFreeRevisionLimit` di `src/lib/server/clients.ts`.
fn client_free_revision_limit(value: Option<&Value>, current: i64) -> Result<i64, CommandError> {
    match value {
        None | Some(Value::Null) => Ok(current),
        Some(value) => value
            .as_i64()
            .filter(|limit| (0..=samples::FREE_REVISION_LIMIT_MAX).contains(limit))
            .ok_or_else(|| {
                CommandError::new(
                    "CLIENT_INVALID",
                    "Free revisions must be a whole number from 0 to 20.",
                )
            }),
    }
}

/// Daftarkan lead baru: satu baris `clients` + satu baris `leads`, kode
/// `KLN-YYYYMMDD-<KP><NN>` dihitung dari data lokal sehingga aman saat offline.
#[tauri::command]
pub async fn desktop_register_client(
    state: State<'_, DesktopState>,
    client: Value,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "clients.manage")?;
    let tag = sync::local_device_tag(&state)?.ok_or_else(|| {
        CommandError::new(
            "DEVICE_TAG_MISSING",
            "This device has no client code tag yet. Connect it to the database once to get one.",
        )
    })?;
    let now = storage::now_epoch_seconds();
    let (draft, code, free_revisions) = {
        let connection = storage::database(&state.data_dir)?;
        let draft = validate_client_draft(&connection, &client, None)?;
        // Disalin saat klien dibuat (FR-06.5, kriteria terima FR-11).
        let free_revisions = business_settings(&connection).default_free_revision_limit;
        if let Some(owner) = local_phone_owner(&connection, &draft.phone, "")? {
            return Err(duplicate_phone(&draft.phone, &owner));
        }
        let stamp = clients::company_date_stamp(now, &company_timezone(&connection));
        let mut statement = connection
            .prepare("SELECT client_code FROM clients WHERE client_code LIKE ?;")
            .map_err(|_| CommandError::internal())?;
        let codes = statement
            .query_map([format!("%-{stamp}-{tag}__")], |row| row.get::<_, String>(0))
            .map_err(|_| CommandError::internal())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?;
        let code = clients::next_client_sequence(codes.iter().map(String::as_str), &stamp, &tag)
            .and_then(|sequence| {
                clients::format_client_code(&client_code_prefix(&state), &stamp, &tag, sequence)
            })
            .ok_or_else(|| {
                CommandError::new(
                    "CLIENT_CODE_EXHAUSTED",
                    "This device has used up its client codes for today.",
                )
            })?;
        (draft, code, free_revisions)
    };

    let id = clients::new_uuid();
    let lead_id = clients::new_uuid();
    let timestamp = clients::utc_timestamp(now);
    let payload = json!({
        "id": id,
        "client_code": code,
        "name": draft.name,
        "phone_normalized": draft.phone,
        "address": draft.address,
        "city": draft.city,
        "province": draft.province,
        "lifecycle_status": "LEAD",
        "free_revision_limit": free_revisions,
        "is_white_label": 0,
        "assigned_crm_id": Value::Null,
        "created_by": operator.id,
        "created_at": timestamp,
        "updated_at": timestamp,
        "lead_id": lead_id,
        "pic_cs_id": operator.id,
        "channel_option_id": draft.channel,
        "product_category_option_id": draft.category,
        "needs_notes": draft.needs,
        "last_followup_at": "",
        // Lead masuk = klien yang menghubungi, jadi itulah respons pertamanya.
        "last_client_response_at": timestamp,
        "total_followups": 0,
    });

    let audit = AuditEntry {
        actor: &operator,
        action: "client.register",
        entity_type: "client",
        entity_id: &id,
        summary: json!({ "client_code": code, "name": draft.name }),
        on_behalf_of: None,
    };
    commit_with_outbox(&state, "client", "register", &id, payload, Some(audit), |transaction| {
        transaction
            .execute(
                r#"INSERT INTO clients
                    (id, client_code, name, phone_normalized, address, city, province,
                     lifecycle_status, free_revision_limit, is_white_label, assigned_crm_id,
                     created_by, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'LEAD', ?, 0, NULL, ?, ?, ?);"#,
                rusqlite::params![
                    &id, &code, &draft.name, &draft.phone, &draft.address, &draft.city,
                    &draft.province, free_revisions, operator.id, &timestamp, &timestamp
                ],
            )
            .map_err(|_| CommandError::new("CLIENT_SAVE_FAILED", "The client could not be saved."))?;
        transaction
            .execute(
                r#"INSERT INTO leads
                    (id, client_id, pic_cs_id, channel_option_id, product_category_option_id,
                     needs_notes, last_followup_at, last_client_response_at, total_followups,
                     created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, '', ?, 0, ?, ?);"#,
                rusqlite::params![
                    &lead_id, &id, operator.id, &draft.channel, &draft.category, &draft.needs,
                    &timestamp, &timestamp, &timestamp
                ],
            )
            .map_err(|_| CommandError::new("CLIENT_SAVE_FAILED", "The client could not be saved."))?;
        Ok(())
    })?;

    let _ = sync::synchronize(&state).await;
    Ok(json!({ "sukses": true, "id": id, "client_code": code }))
}

/// Ubah data kontak klien dan kebutuhan lead-nya. Kode klien, pembuat, dan
/// kolom interaksi lead tidak ikut berubah.
#[tauri::command]
pub async fn desktop_update_client(
    state: State<'_, DesktopState>,
    client: Value,
) -> Result<Value, CommandError> {
    use rusqlite::OptionalExtension;
    let operator = require_permission(&state, "clients.manage")?;
    let id = draft_text(&client, "id");
    let now = clients::utc_timestamp(storage::now_epoch_seconds());
    let (draft, current) = {
        let connection = storage::database(&state.data_dir)?;
        let current = connection
            .query_row(
                "SELECT c.client_code, c.lifecycle_status, c.free_revision_limit, c.is_white_label,
                        c.assigned_crm_id, c.created_by, c.created_at, l.id, l.pic_cs_id,
                        l.channel_option_id, l.product_category_option_id, l.last_followup_at,
                        l.last_client_response_at, l.total_followups, l.created_at
                 FROM clients c JOIN leads l ON l.client_id = c.id WHERE c.id = ? LIMIT 1;",
                [&id],
                |row| {
                    Ok(json!({
                        "client_code": row.get::<_, String>(0)?,
                        "lifecycle_status": row.get::<_, String>(1)?,
                        "free_revision_limit": row.get::<_, i64>(2)?,
                        "is_white_label": row.get::<_, i64>(3)?,
                        "assigned_crm_id": row.get::<_, Option<i64>>(4)?,
                        "created_by": row.get::<_, Option<i64>>(5)?,
                        "created_at": row.get::<_, String>(6)?,
                        "lead_id": row.get::<_, String>(7)?,
                        "pic_cs_id": row.get::<_, Option<i64>>(8)?,
                        "channel_option_id": row.get::<_, String>(9)?,
                        "product_category_option_id": row.get::<_, String>(10)?,
                        "last_followup_at": row.get::<_, String>(11)?,
                        "last_client_response_at": row.get::<_, String>(12)?,
                        "total_followups": row.get::<_, i64>(13)?,
                        "lead_created_at": row.get::<_, String>(14)?,
                    }))
                },
            )
            .optional()
            .map_err(|_| CommandError::internal())?
            .ok_or_else(|| CommandError::new("CLIENT_NOT_FOUND", "Client not found."))?;
        let draft = validate_client_draft(
            &connection,
            &client,
            Some((
                current["channel_option_id"].as_str().unwrap_or_default(),
                current["product_category_option_id"].as_str().unwrap_or_default(),
            )),
        )?;
        if let Some(owner) = local_phone_owner(&connection, &draft.phone, &id)? {
            return Err(duplicate_phone(&draft.phone, &owner));
        }
        (draft, current)
    };
    let free_revisions = client_free_revision_limit(
        client.get("free_revision_limit"),
        current["free_revision_limit"].as_i64().unwrap_or(0),
    )?;

    let lead_id = current["lead_id"].as_str().unwrap_or_default().to_owned();
    let payload = json!({
        "id": id,
        "client_code": current["client_code"],
        "name": draft.name,
        "phone_normalized": draft.phone,
        "address": draft.address,
        "city": draft.city,
        "province": draft.province,
        "lifecycle_status": current["lifecycle_status"],
        "free_revision_limit": free_revisions,
        "is_white_label": current["is_white_label"],
        "assigned_crm_id": current["assigned_crm_id"],
        "created_by": current["created_by"],
        "created_at": current["created_at"],
        "updated_at": now,
        "lead_id": lead_id,
        "pic_cs_id": current["pic_cs_id"],
        "channel_option_id": draft.channel,
        "product_category_option_id": draft.category,
        "needs_notes": draft.needs,
        "last_followup_at": current["last_followup_at"],
        "last_client_response_at": current["last_client_response_at"],
        "total_followups": current["total_followups"],
    });

    let audit = AuditEntry {
        actor: &operator,
        action: "client.update",
        entity_type: "client",
        entity_id: &id,
        summary: json!({ "client_code": current["client_code"], "name": draft.name }),
        on_behalf_of: None,
    };
    commit_with_outbox(&state, "client", "update", &id, payload, Some(audit), |transaction| {
        transaction
            .execute(
                "UPDATE clients SET name = ?, phone_normalized = ?, address = ?, city = ?, province = ?, free_revision_limit = ?, updated_at = ? WHERE id = ?;",
                rusqlite::params![
                    &draft.name, &draft.phone, &draft.address, &draft.city, &draft.province,
                    free_revisions, &now, &id
                ],
            )
            .map_err(|_| CommandError::new("CLIENT_SAVE_FAILED", "The client could not be saved."))?;
        transaction
            .execute(
                "UPDATE leads SET channel_option_id = ?, product_category_option_id = ?, needs_notes = ?, updated_at = ? WHERE id = ?;",
                rusqlite::params![&draft.channel, &draft.category, &draft.needs, &now, &lead_id],
            )
            .map_err(|_| CommandError::new("CLIENT_SAVE_FAILED", "The client could not be saved."))?;
        Ok(())
    })?;

    let _ = sync::synchronize(&state).await;
    Ok(json!({ "sukses": true, "id": id }))
}

/// Daftar pilihan Master Data (saluran lead, kategori produk), aktif maupun
/// tidak. Bentuk barisnya sama dengan `listMasterOptions` di TS.
#[tauri::command]
pub fn desktop_list_master_options(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    require_permission(&state, "clients.view")?;
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT id, kind, code, label, is_active, sort_order, updated_at
             FROM master_option ORDER BY kind, sort_order, label;",
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "kind": row.get::<_, String>(1)?,
                "code": row.get::<_, String>(2)?,
                "label": row.get::<_, String>(3)?,
                "is_active": row.get::<_, i64>(4)? == 1,
                "sort_order": row.get::<_, i64>(5)?,
                "updated_at": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|_| CommandError::internal())?;
    Ok(Value::Array(
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?,
    ))
}

/// Tambah atau ubah satu pilihan Master Data. Opsi tidak pernah dihapus, hanya
/// dinonaktifkan: data lama yang memakainya harus tetap terbaca.
#[tauri::command]
pub async fn desktop_save_master_option(
    state: State<'_, DesktopState>,
    option: Value,
) -> Result<Value, CommandError> {
    use rusqlite::OptionalExtension;
    let operator = require_permission(&state, "master_data.manage")?;
    let invalid = |message: &str| CommandError::new("MASTER_OPTION_INVALID", message);
    let requested_id = draft_text(&option, "id");
    let code = clients::normalize_option_code(&draft_text(&option, "code"))
        .ok_or_else(|| invalid("The code must be 1-20 characters: letters, numbers, _ or -."))?;
    let label = draft_text(&option, "label");
    if label.is_empty() || label.chars().count() > clients::OPTION_LABEL_MAX {
        return Err(invalid("The label must be 1-80 characters."));
    }
    let is_active = option.get("is_active").and_then(Value::as_bool).unwrap_or(true);
    let now = clients::utc_timestamp(storage::now_epoch_seconds());

    let (id, kind, sort_order) = {
        let connection = storage::database(&state.data_dir)?;
        let (id, kind, sort_order) = if requested_id.is_empty() {
            let kind = draft_text(&option, "kind");
            if !clients::MASTER_OPTION_KINDS.contains(&kind.as_str()) {
                return Err(invalid("Unknown master data type."));
            }
            let next: i64 = connection
                .query_row(
                    "SELECT COALESCE(MAX(sort_order), 0) + 10 FROM master_option WHERE kind = ?;",
                    [&kind],
                    |row| row.get(0),
                )
                .map_err(|_| CommandError::internal())?;
            (clients::new_uuid(), kind, next)
        } else {
            let (kind, sort_order) = connection
                .query_row(
                    "SELECT kind, sort_order FROM master_option WHERE id = ?;",
                    [&requested_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()
                .map_err(|_| CommandError::internal())?
                .ok_or_else(|| CommandError::new("MASTER_OPTION_NOT_FOUND", "Option not found."))?;
            (requested_id.clone(), kind, sort_order)
        };
        let taken: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM master_option WHERE kind = ? AND code = ? AND id <> ?;",
                rusqlite::params![&kind, &code, &id],
                |row| row.get(0),
            )
            .map_err(|_| CommandError::internal())?;
        if taken > 0 {
            return Err(invalid("Another option of this type already uses that code."));
        }
        (id, kind, sort_order)
    };

    let payload = json!({
        "id": id,
        "kind": kind,
        "code": code,
        "label": label,
        "is_active": i64::from(is_active),
        "sort_order": sort_order,
        "updated_at": now,
    });
    let audit = AuditEntry {
        actor: &operator,
        action: "master_option.save",
        entity_type: "master_option",
        entity_id: &id,
        summary: json!({ "kind": kind, "code": code, "label": label, "is_active": is_active }),
        on_behalf_of: None,
    };
    commit_with_outbox(&state, "master-option", "upsert", &id, payload.clone(), Some(audit), |transaction| {
        transaction
            .execute(
                r#"INSERT INTO master_option (id, kind, code, label, is_active, sort_order, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     code = excluded.code,
                     label = excluded.label,
                     is_active = excluded.is_active,
                     sort_order = excluded.sort_order,
                     updated_at = excluded.updated_at;"#,
                rusqlite::params![&id, &kind, &code, &label, i64::from(is_active), sort_order, &now],
            )
            .map_err(|_| CommandError::internal())?;
        Ok(())
    })?;

    let _ = sync::synchronize(&state).await;
    Ok(json!({
        "id": id,
        "kind": kind,
        "code": code,
        "label": label,
        "is_active": is_active,
        "sort_order": sort_order,
        "updated_at": now,
    }))
}

/// Awalan kode klien, tag Web, dan tag perangkat ini (bila sudah ada).
#[tauri::command]
pub fn desktop_get_client_code_settings(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    require_permission(&state, "clients.view")?;
    Ok(json!({
        "client_code_prefix": client_code_prefix(&state),
        "client_code_web_tag": client_code_web_tag(&state),
        "device_tag": sync::local_device_tag(&state)?,
    }))
}

/// Simpan awalan kode klien dan tag Web. Mengganti tag Web butuh koneksi ke
/// database: tag itu tidak boleh sama dengan tag yang sudah dipegang perangkat.
#[tauri::command]
pub async fn desktop_save_client_code_settings(
    state: State<'_, DesktopState>,
    settings: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "settings.manage")?;
    let invalid = |message: &str| CommandError::new("CLIENT_CODE_SETTINGS_INVALID", message);
    let prefix = clients::normalize_code_prefix(&draft_text(&settings, "client_code_prefix"))
        .ok_or_else(|| invalid("The client code prefix must be 2-5 letters."))?;
    let web_tag = clients::normalize_device_tag(&draft_text(&settings, "client_code_web_tag"))
        .ok_or_else(|| invalid("The Web tag must be exactly 2 letters or numbers."))?;
    if web_tag != client_code_web_tag(&state) {
        let turso = state.get_turso_client().map_err(|_| {
            invalid("Changing the Web tag needs a database connection.")
        })?;
        let taken = turso
            .device_tag_taken(&web_tag)
            .await
            .map_err(|_| invalid("Changing the Web tag needs a database connection."))?;
        if taken {
            return Err(invalid("That Web tag is already used by a device."));
        }
    }

    let client_id = sync::ensure_client_id(&state)?;
    // Koneksi dan transaksi SQLite tidak `Send`: keduanya wajib sudah ditutup
    // sebelum `sync::synchronize(...).await` di bawah, atau command ini tidak
    // bisa didaftarkan ke `generate_handler!`.
    {
        let mut connection = storage::database(&state.data_dir)?;
        let transaction = connection
            .transaction()
            .map_err(|_| CommandError::internal())?;
        for (key, value) in [
            (clients::CLIENT_CODE_PREFIX_SETTING, prefix.as_str()),
            (clients::CLIENT_CODE_WEB_TAG_SETTING, web_tag.as_str()),
        ] {
            transaction
                .execute(
                    "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                    rusqlite::params![key, value],
                )
                .map_err(|_| CommandError::internal())?;
            sync::enqueue(
                &transaction,
                &client_id,
                "setting",
                "update",
                key,
                &json!({ "key": key, "value": value }),
                None,
            )?;
        }
        transaction.commit().map_err(|_| CommandError::internal())?;
    }

    let _ = sync::synchronize(&state).await;
    Ok(json!({
        "client_code_prefix": prefix,
        "client_code_web_tag": web_tag,
        "device_tag": sync::local_device_tag(&state)?,
    }))
}

fn operator_can(operator: &OperatorUser, permission: &str) -> bool {
    operator.is_superadmin || operator.permissions.iter().any(|key| key == permission)
}

fn lead_invalid(message: impl Into<String>) -> CommandError {
    CommandError::new("LEAD_INVALID", message)
}

/// Riwayat interaksi satu lead, terbaru dulu. Cermin `listLeadInteractions`.
#[tauri::command]
pub fn desktop_list_lead_interactions(
    state: State<'_, DesktopState>,
    lead_id: String,
) -> Result<Value, CommandError> {
    require_permission(&state, "leads.view")?;
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT i.id, i.lead_id, i.operator_id, o.nama_operator, i.direction, i.kind,
                    i.notes, i.occurred_at, i.created_at
             FROM lead_interactions i LEFT JOIN master_operator o ON o.id = i.operator_id
             WHERE i.lead_id = ? ORDER BY i.occurred_at DESC, i.created_at DESC, i.rowid DESC;",
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([lead_id.trim()], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "lead_id": row.get::<_, String>(1)?,
                "operator_id": row.get::<_, Option<i64>>(2)?,
                "operator_name": row.get::<_, Option<String>>(3)?,
                "direction": row.get::<_, String>(4)?,
                "kind": row.get::<_, String>(5)?,
                "notes": row.get::<_, String>(6)?,
                "occurred_at": row.get::<_, String>(7)?,
                "created_at": row.get::<_, String>(8)?,
            }))
        })
        .map_err(|_| CommandError::internal())?;
    Ok(Value::Array(
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?,
    ))
}

/// Catat satu follow up (`OUTBOUND`) atau respons klien (`INBOUND`). Hanya di
/// lead milik sendiri, kecuali pemegang `leads.reassign` (PRD OQ-34). Baris
/// interaksi, ringkasan lead, dan outbox ditulis dalam satu transaksi.
#[tauri::command]
pub async fn desktop_record_lead_interaction(
    state: State<'_, DesktopState>,
    interaction: Value,
) -> Result<Value, CommandError> {
    use rusqlite::OptionalExtension;
    let operator = require_permission(&state, "leads.manage")?;
    let lead_id = draft_text(&interaction, "lead_id");
    let direction = draft_text(&interaction, "direction");
    if !clients::LEAD_INTERACTION_DIRECTIONS.contains(&direction.as_str()) {
        return Err(lead_invalid("Choose whether this is a follow up or a client response."));
    }
    let kind = draft_text(&interaction, "kind");
    if !clients::LEAD_INTERACTION_KINDS.contains(&kind.as_str()) {
        return Err(lead_invalid("Choose how the contact happened."));
    }
    let notes = draft_text(&interaction, "notes");
    if notes.is_empty() || notes.chars().count() > clients::INTERACTION_NOTES_MAX {
        return Err(lead_invalid("Notes are required, up to 1000 characters."));
    }
    let now = storage::now_epoch_seconds();
    let occurred = clients::resolve_interaction_time(interaction.get("occurred_at"), now)
        .map_err(lead_invalid)?;
    let client_code = {
        let connection = storage::database(&state.data_dir)?;
        let (pic, code) = connection
            .query_row(
                "SELECT l.pic_cs_id, c.client_code FROM leads l JOIN clients c ON c.id = l.client_id WHERE l.id = ?;",
                [&lead_id],
                |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|_| CommandError::internal())?
            .ok_or_else(|| CommandError::new("LEAD_NOT_FOUND", "Lead not found."))?;
        if pic != Some(operator.id) && !operator_can(&operator, "leads.reassign") {
            return Err(CommandError::new(
                "LEAD_NOT_OWNED",
                "Only the lead's CS can record on it. Ask an Admin to reassign the lead.",
            ));
        }
        code
    };

    let id = clients::new_uuid();
    let occurred_at = clients::utc_timestamp(occurred);
    let created_at = clients::utc_timestamp(now);
    let payload = json!({
        "id": id,
        "lead_id": lead_id,
        "operator_id": operator.id,
        "direction": direction,
        "kind": kind,
        "notes": notes,
        "occurred_at": occurred_at,
        "created_at": created_at,
    });
    let audit = AuditEntry {
        actor: &operator,
        action: "lead_interaction.record",
        entity_type: "lead",
        entity_id: &lead_id,
        summary: json!({ "client_code": client_code, "interaction_id": id, "direction": direction, "kind": kind }),
        on_behalf_of: None,
    };
    commit_with_outbox(&state, "lead-interaction", "record", &id, payload, Some(audit), |transaction| {
        transaction
            .execute(
                clients::LEAD_SUMMARY_UPDATE_SQL,
                rusqlite::params![&direction, &occurred_at, &lead_id, &id],
            )
            .map_err(|_| CommandError::internal())?;
        transaction
            .execute(
                clients::LEAD_INTERACTION_INSERT_SQL,
                rusqlite::params![
                    &id, &lead_id, operator.id, &direction, &kind, &notes, &occurred_at, &created_at
                ],
            )
            .map_err(|_| CommandError::internal())?;
        Ok(())
    })?;

    let _ = sync::synchronize(&state).await;
    Ok(json!({ "sukses": true, "id": id }))
}

/// Operator aktif untuk nama PIC dan pilihan pindah PIC. Dibaca dari direktori
/// hanya-baca yang ikut snapshot, jadi tetap jalan saat offline.
#[tauri::command]
pub fn desktop_list_operator_directory(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    require_permission(&state, "leads.view")?;
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT id, kode_operator, nama_operator, COALESCE(role, '') FROM master_operator
             WHERE COALESCE(status, 'Active') = 'Active' ORDER BY nama_operator, id;",
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "kode_operator": row.get::<_, String>(1)?,
                "nama_operator": row.get::<_, String>(2)?,
                "role_key": row.get::<_, String>(3)?,
            }))
        })
        .map_err(|_| CommandError::internal())?;
    Ok(Value::Array(
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?,
    ))
}

/// Pindahkan lead ke PIC CS lain (PRD OQ-34). Cermin `reassignLead`.
#[tauri::command]
pub async fn desktop_reassign_lead(
    state: State<'_, DesktopState>,
    lead_id: String,
    pic_cs_id: i64,
) -> Result<Value, CommandError> {
    use rusqlite::OptionalExtension;
    let operator = require_permission(&state, "leads.reassign")?;
    let lead_id = lead_id.trim().to_owned();
    let client_code = {
        let connection = storage::database(&state.data_dir)?;
        let code = connection
            .query_row(
                "SELECT c.client_code FROM leads l JOIN clients c ON c.id = l.client_id WHERE l.id = ?;",
                [&lead_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| CommandError::internal())?
            .ok_or_else(|| CommandError::new("LEAD_NOT_FOUND", "Lead not found."))?;
        let active = connection
            .query_row(
                "SELECT 1 FROM master_operator WHERE id = ? AND COALESCE(status, 'Active') = 'Active';",
                [pic_cs_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| CommandError::internal())?;
        if active.is_none() {
            return Err(lead_invalid("Choose an active operator."));
        }
        code
    };
    let updated_at = clients::utc_timestamp(storage::now_epoch_seconds());
    let payload = json!({ "id": lead_id, "pic_cs_id": pic_cs_id, "updated_at": updated_at });
    let audit = AuditEntry {
        actor: &operator,
        action: "lead.reassign",
        entity_type: "lead",
        entity_id: &lead_id,
        summary: json!({ "client_code": client_code, "pic_cs_id": pic_cs_id }),
        on_behalf_of: None,
    };
    commit_with_outbox(&state, "lead", "reassign", &lead_id, payload, Some(audit), |transaction| {
        transaction
            .execute(
                "UPDATE leads SET pic_cs_id = ?, updated_at = ? WHERE id = ?;",
                rusqlite::params![pic_cs_id, &updated_at, &lead_id],
            )
            .map_err(|_| CommandError::internal())?;
        Ok(())
    })?;
    let _ = sync::synchronize(&state).await;
    Ok(json!({ "sukses": true }))
}

/// Log audit domain (PRD FR-10.3). Online: dari cloud, jadi terlihat seluruh
/// perangkat dan Web. Offline: hanya catatan yang pernah ditulis perangkat ini,
/// dan `source` memberitahu layar yang mana.
#[tauri::command]
pub async fn desktop_list_audit_log(
    state: State<'_, DesktopState>,
    filter: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "audit.view")?;
    let timezone = {
        let connection = storage::database(&state.data_dir)?;
        company_timezone(&connection)
    };
    let entity_type = draft_text(&filter, "entity_type");
    let actor = filter.get("actor_operator_id").and_then(Value::as_i64).unwrap_or(0);
    let from = clients::company_day_bounds_utc(&draft_text(&filter, "from"), &timezone)
        .map(|(start, _)| start)
        .unwrap_or_default();
    let to = clients::company_day_bounds_utc(&draft_text(&filter, "to"), &timezone)
        .map(|(_, end)| end)
        .unwrap_or_default();

    if let Ok(turso) = state.get_turso_client() {
        let params = vec![json!(entity_type), json!(actor), json!(from), json!(to)];
        if let Ok(entries) = turso.list_domain_audit(params).await {
            return Ok(json!({ "source": "cloud", "entries": entries }));
        }
    }

    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(clients::DOMAIN_AUDIT_LIST_SQL)
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map(rusqlite::params![entity_type, actor, from, to], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "actor_operator_id": row.get::<_, Option<i64>>(1)?,
                "actor_name": row.get::<_, Option<String>>(2)?,
                "on_behalf_of_division": row.get::<_, String>(3)?,
                "action": row.get::<_, String>(4)?,
                "entity_type": row.get::<_, String>(5)?,
                "entity_id": row.get::<_, String>(6)?,
                "summary_json": row.get::<_, String>(7)?,
                "occurred_at": row.get::<_, String>(8)?,
            }))
        })
        .map_err(|_| CommandError::internal())?;
    let entries = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| CommandError::internal())?;
    Ok(json!({ "source": "device", "entries": entries }))
}

/// Entri outbox yang dikarantina karena sesi pembuatnya tersusul (PRD FR-03
/// butir 5). Pemegang `sync.retry` melihat semua entri di perangkat ini.
#[tauri::command]
pub fn desktop_list_quarantine(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    let actor = require_permission(&state, "sync.view")?;
    sync::quarantine_entries(&state, actor.id, operator_can(&actor, "sync.retry"))
}

/// Putuskan entri karantina: `send` melepasnya ke antrean biasa (konflik tetap
/// ditangani `base_revision`), `discard` menghapusnya dari outbox (butuh
/// `sync.retry`, tercatat di log audit). Data di tabel lokal tidak disentuh.
#[tauri::command]
pub async fn desktop_resolve_quarantine(
    state: State<'_, DesktopState>,
    action: String,
    event_ids: Vec<String>,
) -> Result<Value, CommandError> {
    let actor = require_permission(&state, "sync.view")?;
    let see_all = operator_can(&actor, "sync.retry");
    let event_ids: Vec<String> = event_ids
        .into_iter()
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
        .take(500)
        .collect();
    if event_ids.is_empty() {
        return Err(CommandError::new("VALIDATION_ERROR", "Choose at least one entry."));
    }
    match action.as_str() {
        "send" => {
            let released = sync::release_quarantine(&state, &event_ids, actor.id, see_all)?;
            let _ = sync::synchronize(&state).await;
            Ok(json!({ "count": released }))
        }
        "discard" => {
            let actor = require_permission(&state, "sync.retry")?;
            let client_id = sync::ensure_client_id(&state)?;
            let mut connection = storage::database(&state.data_dir)?;
            let transaction = connection
                .transaction()
                .map_err(|_| CommandError::internal())?;
            let discarded = sync::discard_quarantine(&transaction, &event_ids, actor.id, true)?;
            if !discarded.is_empty() {
                write_audit(
                    &transaction,
                    &client_id,
                    AuditEntry {
                        actor: &actor,
                        action: "sync.quarantine_discard",
                        entity_type: "sync",
                        entity_id: &client_id,
                        summary: json!({ "count": discarded.len(), "entries": discarded }),
                        on_behalf_of: None,
                    },
                )?;
            }
            transaction.commit().map_err(|_| CommandError::internal())?;
            Ok(json!({ "count": discarded.len() }))
        }
        _ => Err(CommandError::new("VALIDATION_ERROR", "Choose send or discard.")),
    }
}

/// Sesi aktif semua operator (PRD FR-10.3). Hanya online: sesi hidup di cloud.
#[tauri::command]
pub async fn desktop_list_active_sessions(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    require_permission(&state, "sessions.manage")?;
    let current = state
        .session
        .lock()
        .map_err(|_| CommandError::internal())?
        .as_ref()
        .and_then(|session| session.session_id.clone());
    let sessions = state.get_turso_client()?.list_active_sessions().await?;
    Ok(json!({ "current_session_id": current, "sessions": sessions }))
}

/// Akhiri satu sesi (PRD FR-10.4). Perangkat targetnya keluar dalam satu
/// siklus sync; alasan wajib dan tercatat di log audit.
#[tauri::command]
pub async fn desktop_end_session(
    state: State<'_, DesktopState>,
    session_id: String,
    reason: String,
) -> Result<Value, CommandError> {
    let actor = require_permission(&state, "sessions.manage")?;
    let reason = clients::session_end_reason(&reason)
        .map_err(|message| CommandError::new("VALIDATION_ERROR", message))?;
    let ended = state
        .get_turso_client()?
        .end_sessions(&actor, Some(session_id.trim()), None, &reason)
        .await?;
    Ok(json!({ "count": ended }))
}

/// Akhiri semua sesi seorang operator, dengan alasan wajib.
#[tauri::command]
pub async fn desktop_end_operator_sessions(
    state: State<'_, DesktopState>,
    operator_id: i64,
    reason: String,
) -> Result<Value, CommandError> {
    let actor = require_permission(&state, "sessions.manage")?;
    let reason = clients::session_end_reason(&reason)
        .map_err(|message| CommandError::new("VALIDATION_ERROR", message))?;
    let ended = state
        .get_turso_client()?
        .end_sessions(&actor, None, Some(operator_id), &reason)
        .await?;
    Ok(json!({ "count": ended }))
}

// ===========================================================================
// Setelan bisnis (PRD FR-11) dan tiket sampel (PRD FR-06). Cermin
// `src/lib/server/business-settings.ts` dan `src/lib/server/samples.ts`;
// aturannya di `samples.rs` (vektor kembar dengan `sample.ts`).
// ===========================================================================

/// Baris query sebagai objek JSON menurut nama kolomnya.
fn query_json(
    connection: &rusqlite::Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Result<Vec<Value>, CommandError> {
    use rusqlite::types::ValueRef;
    let mut statement = connection.prepare(sql).map_err(|_| CommandError::internal())?;
    let names: Vec<String> = statement.column_names().iter().map(|name| (*name).to_owned()).collect();
    let mut rows = statement.query(params).map_err(|_| CommandError::internal())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|_| CommandError::internal())? {
        let mut object = serde_json::Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index).map_err(|_| CommandError::internal())? {
                ValueRef::Null | ValueRef::Blob(_) => Value::Null,
                ValueRef::Integer(number) => json!(number),
                ValueRef::Real(number) => json!(number),
                ValueRef::Text(text) => json!(String::from_utf8_lossy(text)),
            };
            object.insert(name.clone(), value);
        }
        out.push(Value::Object(object));
    }
    Ok(out)
}

/// Setelan bisnis, dibaca pemegang `settings.view` (kartu Pengaturan).
#[tauri::command]
pub fn desktop_get_business_settings(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    require_permission(&state, "settings.view")?;
    let connection = storage::database(&state.data_dir)?;
    Ok(business_settings(&connection).to_json())
}

/// Simpan setelan bisnis. Berlaku untuk data yang dibuat SESUDAHNYA (kriteria
/// terima FR-11). Setiap kunci ikut sinkronisasi lewat rute `setting/upsert`.
#[tauri::command]
pub async fn desktop_save_business_settings(
    state: State<'_, DesktopState>,
    settings: Value,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "settings.manage")?;
    let checked = samples::validate_business_settings(&settings)
        .map_err(|message| CommandError::new("BUSINESS_SETTINGS_INVALID", message))?;
    let client_id = sync::ensure_client_id(&state)?;
    {
        let mut connection = storage::database(&state.data_dir)?;
        let transaction = connection.transaction().map_err(|_| CommandError::internal())?;
        for (key, value) in checked.to_rows() {
            transaction
                .execute(
                    "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                    rusqlite::params![key, &value],
                )
                .map_err(|_| CommandError::internal())?;
            sync::enqueue(
                &transaction,
                &client_id,
                "setting",
                "upsert",
                key,
                &json!({ "key": key, "value": value }),
                None,
            )?;
        }
        write_audit(
            &transaction,
            &client_id,
            AuditEntry {
                actor: &operator,
                action: "settings.business",
                entity_type: "setting",
                entity_id: "business",
                summary: checked.to_json(),
                on_behalf_of: None,
            },
        )?;
        transaction.commit().map_err(|_| CommandError::internal())?;
    }
    let _ = sync::synchronize(&state).await;
    Ok(checked.to_json())
}

const SAMPLE_LIST_SQL: &str = "SELECT s.*, c.client_code, c.name AS client_name, c.free_revision_limit, o.nama_operator AS pic_crm_name FROM sample_requests s LEFT JOIN clients c ON c.id = s.client_id LEFT JOIN master_operator o ON o.id = s.pic_crm_id";

fn sample_invalid(message: impl Into<String>) -> CommandError {
    CommandError::new("SAMPLE_INVALID", message)
}

/// Tiket sampel, terbaru dulu, beserta mode biaya perusahaan (form butuh
/// tahu apakah pilihan gratis/berbayar ditampilkan). Cermin `listSampleRequests`.
#[tauri::command]
pub fn desktop_list_sample_requests(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    require_permission(&state, "samples.view")?;
    let connection = storage::database(&state.data_dir)?;
    let requests = query_json(
        &connection,
        &format!("{SAMPLE_LIST_SQL} ORDER BY s.created_at DESC, s.id;"),
        &[],
    )?;
    Ok(json!({
        "requests": requests,
        "sample_fee_mode": business_settings(&connection).sample_fee_mode,
    }))
}

/// Satu tiket beserta linimasa langkah dan keputusan klien per iterasi.
#[tauri::command]
pub fn desktop_get_sample_request(state: State<'_, DesktopState>, id: String) -> Result<Value, CommandError> {
    require_permission(&state, "samples.view")?;
    let connection = storage::database(&state.data_dir)?;
    let request = query_json(&connection, &format!("{SAMPLE_LIST_SQL} WHERE s.id = ?;"), &[&id])?
        .into_iter()
        .next()
        .ok_or_else(|| CommandError::new("SAMPLE_NOT_FOUND", "Sample request not found."))?;
    let status_log = query_json(
        &connection,
        "SELECT l.*, o.nama_operator AS recorded_by_name FROM sample_status_log l LEFT JOIN master_operator o ON o.id = l.recorded_by WHERE l.sample_request_id = ? ORDER BY l.recorded_at DESC, l.rowid DESC;",
        &[&id],
    )?;
    let feedbacks = query_json(
        &connection,
        "SELECT * FROM sample_feedbacks WHERE sample_request_id = ? ORDER BY iteration_number, recorded_at;",
        &[&id],
    )?;
    Ok(json!({ "request": request, "status_log": status_log, "feedbacks": feedbacks }))
}

/// Periksa pilihan Master Data dan PIC CRM draft terhadap database lokal.
/// `current` = tiket yang sedang disunting (pilihan lamanya tetap sah
/// walau sudah dinonaktifkan). Pesan identik dengan `checkSampleReferences`.
fn check_sample_references(
    connection: &rusqlite::Connection,
    draft: &Value,
    current: Option<&Value>,
) -> Result<(), CommandError> {
    let current_text = |key: &str| current.and_then(|row| row[key].as_str());
    let required = draft["product_category_option_id"].as_str().unwrap_or_default();
    if !option_usable(connection, required, "PRODUCT_CATEGORY", current_text("product_category_option_id"))? {
        return Err(sample_invalid("Choose an active product type."));
    }
    for (key, kind, message) in [
        ("sample_kind_option_id", "SAMPLE_KIND", "Choose an active sample kind."),
        ("formulation_type_option_id", "FORMULATION_TYPE", "Choose an active formulation type."),
        ("registration_category_option_id", "REGISTRATION_CATEGORY", "Choose an active registration category."),
    ] {
        let id = draft[key].as_str().unwrap_or_default();
        if !id.is_empty() && !option_usable(connection, id, kind, current_text(key))? {
            return Err(sample_invalid(message));
        }
    }
    if let Some(pic) = draft["pic_crm_id"].as_i64() {
        let unchanged = current.and_then(|row| row["pic_crm_id"].as_i64()) == Some(pic);
        let crm: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM master_operator WHERE id = ? AND COALESCE(status, 'Active') = 'Active' AND role = 'crm';",
                [pic],
                |row| row.get(0),
            )
            .map_err(|_| CommandError::internal())?;
        if crm == 0 && !unchanged {
            return Err(sample_invalid("Choose an active CRM operator."));
        }
    }
    Ok(())
}

/// Bentuk draft dari baris tiket, untuk menggabungkan field yang terkunci.
fn sample_draft_from_row(row: &Value) -> Value {
    let special = row["special_requests_json"]
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .unwrap_or_else(|| json!({}));
    json!({
        "product_category_option_id": row["product_category_option_id"],
        "sample_kind_option_id": row["sample_kind_option_id"],
        "formulation_type_option_id": row["formulation_type_option_id"],
        "registration_category_option_id": row["registration_category_option_id"],
        "pic_crm_id": row["pic_crm_id"],
        "sample_qty": row["sample_qty"],
        "brand_name": row["brand_name"],
        "bpom_product_name": row["bpom_product_name"],
        "claims": row["claims"],
        "packaging": row["packaging"],
        "reference_notes": row["reference_notes"],
        "client_budget_idr": row["client_budget_idr"],
        "special_requests": special,
        "deadline_at": row["deadline_at"],
        "ship_to_address": row["ship_to_address"],
        "is_dummy_required": row["is_dummy_required"].as_i64() == Some(1),
        "is_paid_sample": row["is_paid_sample"].as_i64() == Some(1),
    })
}

/// Payload sinkronisasi dari draft yang sudah divalidasi. `special_requests`
/// ikut dikirim dalam bentuk objek supaya cloud bisa memvalidasinya ulang.
fn sample_payload(draft: &Value, extra: Value) -> Value {
    let mut payload = draft.clone();
    payload["special_requests"] = draft["special_requests_json"]
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .unwrap_or_else(|| json!({}));
    if let (Some(target), Value::Object(extra)) = (payload.as_object_mut(), extra) {
        target.extend(extra);
    }
    payload
}

fn flag(value: &Value) -> i64 {
    i64::from(value.as_bool() == Some(true))
}

/// Buat tiket sampel untuk satu klien (PRD FR-06.1). Tiket pertama mengubah
/// klien `LEAD` menjadi `FIRST_ORDER_ACTIVE` (D-09). Cermin `createSampleRequest`.
#[tauri::command]
pub async fn desktop_create_sample_request(
    state: State<'_, DesktopState>,
    request: Value,
) -> Result<Value, CommandError> {
    use rusqlite::OptionalExtension;
    let operator = require_permission(&state, "samples.manage")?;
    let client_id = draft_text(&request, "client_id");
    let now = clients::utc_timestamp(storage::now_epoch_seconds());
    let id = clients::new_uuid();
    let (draft, client_code, lead_id) = {
        let connection = storage::database(&state.data_dir)?;
        let (client_code, lead_id) = connection
            .query_row(
                "SELECT c.client_code, COALESCE(l.id, '') FROM clients c LEFT JOIN leads l ON l.client_id = c.id WHERE c.id = ? LIMIT 1;",
                [&client_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|_| CommandError::internal())?
            .ok_or_else(|| CommandError::new("CLIENT_NOT_FOUND", "Client not found."))?;
        let mode = business_settings(&connection).sample_fee_mode;
        let draft = samples::validate_sample_draft(&request, mode).map_err(sample_invalid)?;
        check_sample_references(&connection, &draft, None)?;
        (draft, client_code, lead_id)
    };

    let payload = sample_payload(
        &draft,
        json!({
            "id": id,
            "client_id": client_id,
            "lead_id": lead_id,
            "created_by": operator.id,
            "updated_at": now,
        }),
    );
    let paid = draft["is_paid_sample"].as_bool() == Some(true);
    let audit = AuditEntry {
        actor: &operator,
        action: "sample.create",
        entity_type: "sample",
        entity_id: &id,
        // Tiket gratis ditandai di audit (OQ-28): sampel gratis adalah biaya
        // perusahaan.
        summary: json!({
            "client_code": client_code,
            "brand_name": draft["brand_name"],
            "is_paid_sample": paid,
        }),
        on_behalf_of: None,
    };
    commit_with_outbox(&state, "sample", "create", &id, payload, Some(audit), |transaction| {
        transaction
            .execute(
                samples::SAMPLE_INSERT_SQL,
                rusqlite::params![
                    &id,
                    &client_id,
                    &lead_id,
                    draft["sample_kind_option_id"].as_str(),
                    draft["formulation_type_option_id"].as_str(),
                    draft["registration_category_option_id"].as_str(),
                    draft["product_category_option_id"].as_str(),
                    draft["pic_crm_id"].as_i64(),
                    draft["sample_qty"].as_i64(),
                    draft["brand_name"].as_str(),
                    draft["bpom_product_name"].as_str(),
                    draft["claims"].as_str(),
                    draft["packaging"].as_str(),
                    draft["reference_notes"].as_str(),
                    draft["client_budget_idr"].as_i64(),
                    draft["special_requests_json"].as_str(),
                    draft["deadline_at"].as_str(),
                    draft["ship_to_address"].as_str(),
                    flag(&draft["is_dummy_required"]),
                    flag(&draft["is_paid_sample"]),
                    &now,
                    operator.id,
                ],
            )
            .map_err(|_| CommandError::new("SAMPLE_SAVE_FAILED", "The sample request could not be saved."))?;
        transaction
            .execute(samples::CLIENT_LIFECYCLE_FROM_SAMPLES_SQL, rusqlite::params![&client_id, &now])
            .map_err(|_| CommandError::internal())?;
        Ok(())
    })?;

    let _ = sync::synchronize(&state).await;
    Ok(json!({ "id": id }))
}

/// Ubah tiket. Setelah dikirim ke RnD hanya deadline, alamat, PIC CRM, dan
/// budget yang berubah (keputusan G); field lain diambil dari tiket.
#[tauri::command]
pub async fn desktop_update_sample_request(
    state: State<'_, DesktopState>,
    request: Value,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "samples.manage")?;
    let id = draft_text(&request, "id");
    let now = clients::utc_timestamp(storage::now_epoch_seconds());
    let (draft, current) = {
        let connection = storage::database(&state.data_dir)?;
        let current = query_json(&connection, &format!("{SAMPLE_LIST_SQL} WHERE s.id = ?;"), &[&id])?
            .into_iter()
            .next()
            .ok_or_else(|| CommandError::new("SAMPLE_NOT_FOUND", "Sample request not found."))?;
        let status = current["status"].as_str().unwrap_or_default();
        if samples::SAMPLE_TERMINAL_STATUSES.contains(&status) {
            return Err(sample_invalid("This sample request is closed."));
        }
        let (merged, mode) = if status == "DRAFT" {
            (request.clone(), business_settings(&connection).sample_fee_mode)
        } else {
            let mut merged = sample_draft_from_row(&current);
            for key in samples::SAMPLE_FIELDS_EDITABLE_AFTER_SUBMIT {
                merged[*key] = request.get(*key).cloned().unwrap_or(Value::Null);
            }
            let mode = if current["is_paid_sample"].as_i64() == Some(1) { "PAID" } else { "FREE" };
            (merged, mode)
        };
        let draft = samples::validate_sample_draft(&merged, mode).map_err(sample_invalid)?;
        check_sample_references(&connection, &draft, Some(&current))?;
        (draft, current)
    };

    let payload = sample_payload(
        &draft,
        json!({
            "id": id,
            "base_updated_at": current["updated_at"],
            "updated_at": now,
        }),
    );
    let audit = AuditEntry {
        actor: &operator,
        action: "sample.update",
        entity_type: "sample",
        entity_id: &id,
        summary: json!({
            "client_code": current["client_code"],
            "brand_name": draft["brand_name"],
        }),
        on_behalf_of: None,
    };
    commit_with_outbox(&state, "sample", "update", &id, payload, Some(audit), |transaction| {
        let changed = transaction
            .execute(
                samples::SAMPLE_UPDATE_SQL,
                rusqlite::params![
                    &id,
                    draft["sample_kind_option_id"].as_str(),
                    draft["formulation_type_option_id"].as_str(),
                    draft["registration_category_option_id"].as_str(),
                    draft["product_category_option_id"].as_str(),
                    draft["sample_qty"].as_i64(),
                    draft["brand_name"].as_str(),
                    draft["bpom_product_name"].as_str(),
                    draft["claims"].as_str(),
                    draft["packaging"].as_str(),
                    draft["reference_notes"].as_str(),
                    draft["special_requests_json"].as_str(),
                    flag(&draft["is_dummy_required"]),
                    flag(&draft["is_paid_sample"]),
                    draft["pic_crm_id"].as_i64(),
                    draft["client_budget_idr"].as_i64(),
                    draft["deadline_at"].as_str(),
                    draft["ship_to_address"].as_str(),
                    &now,
                ],
            )
            .map_err(|_| CommandError::new("SAMPLE_SAVE_FAILED", "The sample request could not be saved."))?;
        if changed == 0 {
            return Err(sample_invalid("This sample request is closed."));
        }
        Ok(())
    })?;

    let _ = sync::synchronize(&state).await;
    Ok(json!({ "id": id }))
}

/// Catat satu langkah tiket (FR-06.4). Langkah RnD/Finance dicatat CS atas
/// nama divisi itu (D-23); catatan wajib. Cermin `recordSampleStep`.
#[tauri::command]
pub async fn desktop_record_sample_step(
    state: State<'_, DesktopState>,
    id: String,
    action: String,
    notes: String,
    lead_time_days: Option<i64>,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "samples.manage")?;
    let notes = samples::normalize_sample_notes(&notes)
        .ok_or_else(|| sample_invalid("Notes are required, up to 1000 characters."))?;
    let now = clients::utc_timestamp(storage::now_epoch_seconds());
    let current = {
        let connection = storage::database(&state.data_dir)?;
        query_json(&connection, &format!("{SAMPLE_LIST_SQL} WHERE s.id = ?;"), &[&id])?
            .into_iter()
            .next()
            .ok_or_else(|| CommandError::new("SAMPLE_NOT_FOUND", "Sample request not found."))?
    };
    let base_status = current["status"].as_str().unwrap_or_default().to_owned();
    let base_index = current["revision_index"].as_i64().unwrap_or(0);
    let state_before = samples::SampleActionState {
        status: &base_status,
        is_paid_sample: current["is_paid_sample"].as_i64() == Some(1),
        revision_index: base_index,
        free_revision_limit: current["free_revision_limit"].as_i64().unwrap_or(0),
    };
    let lead_time = if action == "RND_ACCEPT" { lead_time_days } else { None };
    let result = samples::apply_sample_action(&state_before, &action, lead_time).map_err(sample_invalid)?;
    let division = samples::sample_action_division(&action);
    let client_id = current["client_id"].as_str().unwrap_or_default().to_owned();
    let log_id = clients::new_uuid();
    let feedback = result.client_decision.map(|decision| {
        json!({
            "id": clients::new_uuid(),
            "iteration_number": base_index + 1,
            "client_decision": decision,
        })
    });
    let payload = json!({
        "id": id,
        "client_id": client_id,
        "action": action,
        "base_status": base_status,
        "base_revision_index": base_index,
        "status": result.status,
        "revision_index": result.revision_index,
        "is_billable": result.is_billable,
        "rnd_lead_time_days": lead_time,
        "changed_at": now,
        "log": {
            "id": log_id,
            "notes": notes,
            "on_behalf_of_division": division.unwrap_or(&operator.role),
            "recorded_by": operator.id,
        },
        "feedback": feedback,
    });
    let audit = AuditEntry {
        actor: &operator,
        action: "sample.step",
        entity_type: "sample",
        entity_id: &id,
        summary: json!({
            "client_code": current["client_code"],
            "brand_name": current["brand_name"],
            "action": action,
            "from": base_status,
            "to": result.status,
            "revision_index": result.revision_index,
            "notes": notes,
        }),
        on_behalf_of: division,
    };
    commit_with_outbox(&state, "sample", "transition", &id, payload, Some(audit), |transaction| {
        let changed = transaction
            .execute(
                samples::SAMPLE_TRANSITION_SQL,
                rusqlite::params![
                    &id,
                    result.status,
                    result.revision_index,
                    result.is_billable.map(i64::from),
                    lead_time,
                    &now,
                    &base_status,
                    base_index,
                ],
            )
            .map_err(|_| CommandError::internal())?;
        if changed == 0 {
            return Err(sample_invalid(samples::SAMPLE_CHANGED_ELSEWHERE));
        }
        transaction
            .execute(
                samples::SAMPLE_STATUS_LOG_INSERT_SQL,
                rusqlite::params![
                    &log_id,
                    &id,
                    &base_status,
                    result.status,
                    &action,
                    &notes,
                    division.unwrap_or(&operator.role),
                    operator.id,
                    &now,
                ],
            )
            .map_err(|_| CommandError::internal())?;
        if let Some(feedback) = &feedback {
            transaction
                .execute(
                    samples::SAMPLE_FEEDBACK_INSERT_SQL,
                    rusqlite::params![
                        feedback["id"].as_str(),
                        &id,
                        base_index + 1,
                        feedback["client_decision"].as_str(),
                        &notes,
                        operator.id,
                        &now,
                    ],
                )
                .map_err(|_| CommandError::internal())?;
        }
        transaction
            .execute(samples::CLIENT_LIFECYCLE_FROM_SAMPLES_SQL, rusqlite::params![&client_id, &now])
            .map_err(|_| CommandError::internal())?;
        Ok(())
    })?;

    let _ = sync::synchronize(&state).await;
    Ok(json!({ "status": result.status, "revision_index": result.revision_index }))
}

#[cfg(test)]
mod tests_provisioning {
    use super::*;

    fn state_uji(directory: &std::path::Path) -> DesktopState {
        storage::initialize(directory).expect("skema lokal");
        DesktopState {
            server_origin: std::sync::RwLock::new(
                crate::desktop::app_identity::DEFAULT_SERVER_ORIGIN.to_owned(),
            ),
            offline_max_age_hours: 24,
            data_dir: directory.to_path_buf(),
            http: reqwest::Client::new(),
            turso_config: std::sync::RwLock::new(None),
            session: std::sync::Mutex::new(None),
            vault_lock: std::sync::Mutex::new(()),
        }
    }

    /// Regresi: provisioning Mode Database Lokal pernah berhenti dengan
    /// "Alamat database wajib diisi" pada perangkat baru.
    ///
    /// Formulirnya memang tidak menampilkan kolom alamat — mode lokal tidak
    /// punya alamat — sehingga frontend mengirim string kosong. Versi
    /// sebelumnya memeriksa alamat SEBELUM melihat provider, jadi pengguna
    /// diminta mengisi sesuatu yang tidak pernah bisa diisi.
    #[test]
    fn mode_lokal_tidak_menuntut_alamat_saat_provisioning() {
        let directory = tempfile::tempdir().expect("direktori sementara");
        let state = state_uji(directory.path());

        let config = resolve_bootstrap_turso_config(
            &state,
            Some(String::new()),
            Some(String::new()),
            Some(turso::DatabaseProvider::LocalFile),
            Some(false),
        )
        .expect("mode lokal harus diterima tanpa alamat");

        assert!(config.provider.is_local_file());
        assert!(!config.requires_auth_token());
        assert_eq!(
            config.local_file_path().expect("lokasi hub"),
            state.local_hub_path(),
            "lokasi hub bawaan harus sama dengan yang dipakai set_database_config"
        );
    }

    /// Provider selain lokal TETAP menuntut alamat: perangkat yang belum
    /// dikonfigurasi tidak punya database untuk diperiksa.
    #[test]
    fn provider_remote_tetap_menuntut_alamat() {
        let directory = tempfile::tempdir().expect("direktori sementara");
        let state = state_uji(directory.path());

        let error = resolve_bootstrap_turso_config(
            &state,
            Some(String::new()),
            None,
            Some(turso::DatabaseProvider::Turso),
            None,
        )
        .expect_err("Turso tanpa alamat harus ditolak");
        assert_eq!(error.code, "TURSO_NOT_CONFIGURED");
    }
}

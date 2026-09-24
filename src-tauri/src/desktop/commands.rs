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

                storage::audit(
                    &state.data_dir,
                    Some(operator.id),
                    "login-online-turso-success",
                    None,
                );

                *state.session.lock().map_err(|_| CommandError::internal())? =
                    Some(DesktopSession {
                        operator: operator.clone(),
                        mode: SessionMode::Online,
                        license: license_grant,
                    });

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
    *state.session.lock().map_err(|_| CommandError::internal())? = Some(DesktopSession {
        operator: credential.operator.clone(),
        mode: SessionMode::Offline,
        license: license_grant,
    });
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
    if let Some(session) = previous {
        storage::audit(&state.data_dir, Some(session.operator.id), "logout", None);
        // Sesi 2-tier tidak memegang token server: `token` hanya penanda
        // internal. Tidak ada endpoint logout yang perlu dihubungi.
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

/// Tulis satu mutasi lokal beserta event outbox-nya dalam satu transaksi.
fn commit_with_outbox(
    state: &DesktopState,
    domain: &str,
    operation: &str,
    entity_key: &str,
    payload: Value,
    apply: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<(), CommandError>,
) -> Result<(), CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    apply(&transaction)?;
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
// DOMAIN CONTOH — GANTI DENGAN DOMAIN APLIKASI ANDA
//
// Pola yang wajib dipertahankan pada setiap mutasi:
//
//   1. Tulis perubahan ke SQLite lokal DAN daftarkan event outbox dalam SATU
//      transaksi. Kalau outbox ditulis di transaksi terpisah dan proses mati di
//      antaranya, perubahan itu hidup di perangkat tetapi tidak pernah sampai
//      ke cloud — dan tidak ada yang menyadarinya.
//   2. Pakai pasangan (domain, operation) yang terdaftar di
//      `CANONICAL_SYNC_ROUTES`. Pasangan lain ditolak batas cloud.
//   3. `entity_key` adalah identitas resmi baris; pilih kunci bisnis yang stabil
//      lintas perangkat.
//   4. Picu sinkronisasi latar setelah commit, jangan sebelum.
// ===========================================================================

#[tauri::command]
pub fn desktop_list_items(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    require_permission(&state, "items.view")?;
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT kode_item, nama, kategori, harga, satuan, catatan, status_aktif, update_terakhir
             FROM master_item ORDER BY nama;",
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "kode_item": row.get::<_, String>(0)?,
                "nama": row.get::<_, String>(1)?,
                "kategori": row.get::<_, Option<String>>(2)?,
                "harga": row.get::<_, i64>(3)?,
                "satuan": row.get::<_, Option<String>>(4)?,
                "catatan": row.get::<_, Option<String>>(5)?,
                "status_aktif": row.get::<_, String>(6)?,
                "update_terakhir": row.get::<_, String>(7)?,
            }))
        })
        .map_err(|_| CommandError::internal())?;
    Ok(Value::Array(
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?,
    ))
}

#[tauri::command]
pub async fn desktop_save_item(
    state: State<'_, DesktopState>,
    item: Value,
) -> Result<Value, CommandError> {
    require_permission(&state, "items.manage")?;
    let kode_item = item
        .get("kode_item")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CommandError::new("ITEM_INVALID", "Kode item wajib diisi.")
        })?
        .to_owned();
    let nama = item
        .get("nama")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| value.chars().count() >= 2)
        .ok_or_else(|| {
            CommandError::new("ITEM_INVALID", "Nama item minimal dua karakter.")
        })?
        .to_owned();
    let kategori = item
        .get("kategori")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let harga = item.get("harga").and_then(Value::as_i64).unwrap_or(0);
    if harga < 0 {
        return Err(CommandError::new(
            "ITEM_INVALID",
            "Harga tidak boleh negatif.",
        ));
    }
    let satuan = item
        .get("satuan")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let catatan = item
        .get("catatan")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    // Nilai asing ditolak, tidak pernah dinormalkan menjadi "Active" — aturan
    // yang sama dieja `saveItem` di `src/lib/server/example-domain.ts`.
    let status = match item.get("status_aktif").and_then(Value::as_str) {
        None | Some("Active") => "Active",
        Some("Inactive") => "Inactive",
        Some(_) => {
            return Err(CommandError::new(
                "ITEM_INVALID",
                "Status item harus Aktif atau Nonaktif.",
            ))
        }
    };
    let updated = storage::now_epoch_seconds().to_string();

    let payload = json!({
        "kode_item": kode_item,
        "nama": nama,
        "kategori": kategori,
        "harga": harga,
        "satuan": satuan,
        "catatan": catatan,
        "status_aktif": status,
    });

    let exists = {
        let connection = storage::database(&state.data_dir)?;
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM master_item WHERE kode_item = ?);",
                [&kode_item],
                |row| row.get::<_, bool>(0),
            )
            .unwrap_or(false)
    };

    commit_with_outbox(
        &state,
        "item",
        if exists { "update" } else { "create" },
        &kode_item,
        payload,
        |transaction| {
            transaction
                .execute(
                    r#"INSERT INTO master_item
                        (kode_item, nama, kategori, harga, satuan, catatan, status_aktif, update_terakhir)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(kode_item) DO UPDATE SET
                         nama = excluded.nama,
                         kategori = excluded.kategori,
                         harga = excluded.harga,
                         satuan = excluded.satuan,
                         catatan = excluded.catatan,
                         status_aktif = excluded.status_aktif,
                         update_terakhir = excluded.update_terakhir;"#,
                    rusqlite::params![
                        &kode_item, &nama, &kategori, harga, &satuan, &catatan, status, &updated
                    ],
                )
                .map_err(|_| {
                    CommandError::new("ITEM_SAVE_FAILED", "Item tidak dapat disimpan.")
                })?;
            Ok(())
        },
    )?;

    let _ = sync::synchronize(&state).await;
    Ok(json!({ "sukses": true, "kode_item": kode_item }))
}

#[tauri::command]
pub async fn desktop_delete_item(
    state: State<'_, DesktopState>,
    kode_item: String,
) -> Result<Value, CommandError> {
    require_permission(&state, "items.manage")?;
    let kode_item = kode_item.trim().to_owned();
    if kode_item.is_empty() {
        return Err(CommandError::new("ITEM_INVALID", "Kode item wajib diisi."));
    }
    commit_with_outbox(
        &state,
        "item",
        "delete",
        &kode_item,
        json!({ "kode_item": kode_item }),
        |transaction| {
            transaction
                .execute(
                    "DELETE FROM master_item WHERE kode_item = ?;",
                    [&kode_item],
                )
                .map_err(|_| CommandError::internal())?;
            Ok(())
        },
    )?;
    let _ = sync::synchronize(&state).await;
    Ok(json!({ "sukses": true }))
}

#[tauri::command]
pub fn desktop_list_activities(
    state: State<'_, DesktopState>,
    limit: Option<i64>,
) -> Result<Value, CommandError> {
    require_permission(&state, "activity.view")?;
    let limit = limit.unwrap_or(200).clamp(1, 1000);
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT event_key, kode_item, jenis, jumlah, keterangan, kode_operator, waktu
             FROM log_aktivitas ORDER BY waktu DESC LIMIT ?;",
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([limit], |row| {
            Ok(json!({
                "event_key": row.get::<_, String>(0)?,
                "kode_item": row.get::<_, String>(1)?,
                "jenis": row.get::<_, String>(2)?,
                "jumlah": row.get::<_, i64>(3)?,
                "keterangan": row.get::<_, Option<String>>(4)?,
                "kode_operator": row.get::<_, Option<String>>(5)?,
                "waktu": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|_| CommandError::internal())?;
    Ok(Value::Array(
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?,
    ))
}

#[tauri::command]
pub async fn desktop_record_activity(
    state: State<'_, DesktopState>,
    activity: Value,
) -> Result<Value, CommandError> {
    let operator = require_permission(&state, "activity.record")?;
    let kode_item = activity
        .get("kode_item")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CommandError::new("ACTIVITY_INVALID", "Kode item wajib diisi."))?
        .to_owned();
    let jenis = activity
        .get("jenis")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CommandError::new("ACTIVITY_INVALID", "Jenis aktivitas wajib diisi."))?
        .to_owned();
    let jumlah = activity.get("jumlah").and_then(Value::as_i64).unwrap_or(0);
    let keterangan = activity
        .get("keterangan")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    // `event_key` dibuat di perangkat dan menjadi kunci idempotensi baris. Karena
    // dipakai sebagai `ON CONFLICT`, pengiriman ulang event yang sama tidak
    // pernah menggandakan barisnya.
    let client_id = sync::ensure_client_id(&state)?;
    let event_key = sync::new_event_id(&client_id, "activity", "record");
    let waktu = storage::now_epoch_seconds().to_string();
    let local_id = sync::new_local_id();

    let payload = json!({
        "event_key": event_key,
        "kode_item": kode_item,
        "jenis": jenis,
        "jumlah": jumlah,
        "keterangan": keterangan,
        "kode_operator": operator.kode_operator,
        "waktu": waktu,
    });

    commit_with_outbox(
        &state,
        "activity",
        "record",
        &event_key,
        payload,
        |transaction| {
            transaction
                .execute(
                    r#"INSERT INTO log_aktivitas
                        (id_log, event_key, kode_item, jenis, jumlah, keterangan, kode_operator, waktu)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?);"#,
                    rusqlite::params![
                        local_id,
                        &event_key,
                        &kode_item,
                        &jenis,
                        jumlah,
                        &keterangan,
                        &operator.kode_operator,
                        &waktu
                    ],
                )
                .map_err(|_| {
                    CommandError::new(
                        "ACTIVITY_SAVE_FAILED",
                        "Aktivitas tidak dapat dicatat.",
                    )
                })?;
            Ok(())
        },
    )?;

    let _ = sync::synchronize(&state).await;
    Ok(json!({ "sukses": true, "event_key": event_key }))
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

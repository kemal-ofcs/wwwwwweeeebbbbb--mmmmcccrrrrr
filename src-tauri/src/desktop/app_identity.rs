//! Identitas produk — SATU-SATUNYA tempat yang diganti saat template dipakai.
//!
//! Nilai di sini bukan label. [`APP_SLUG`] ikut membentuk **pemisah domain
//! kriptografi**: ia masuk ke turunan kunci vault dan ke kunci identitas
//! offline. Dua produk yang berbagi nilai ini berbagi ruang nama kriptografi
//! yang justru seharusnya memisahkan mereka.
//!
//! Versi sebelumnya menyebar nilai-nilai ini sebagai literal `"contoh-..."` di
//! beberapa berkas, dan `rename-project.ts` tidak menyentuhnya — sehingga
//! setiap produk turunan membawa pemisah domain milik produk lain.
//!
//! Padanan sisi TypeScript-nya ada di `src/lib/constants/app-identity.ts`, dan
//! `bun run rename` mengganti keduanya sekaligus.

/// Nama mesin produk: huruf kecil, angka, dan tanda hubung.
pub const APP_SLUG: &str = "app-template";

/// Nama yang dilihat pengguna.
#[allow(dead_code)]
pub const APP_DISPLAY_NAME: &str = "App Template";

/// Alamat server aplikasi bawaan.
///
/// SENGAJA kosong pada template. Mengisinya dengan alamat nyata berarti setiap
/// produk turunan diam-diam menunjuk deployment milik orang lain sampai
/// seseorang menyadarinya.
pub const DEFAULT_SERVER_ORIGIN: &str = "";

/// Pengenal klien vault Stronghold.
pub fn vault_client_id() -> Vec<u8> {
    format!("{APP_SLUG}-desktop-auth-v1").into_bytes()
}

/// Pemisah domain untuk kunci identitas offline.
///
/// Diakhiri titik dua supaya bagian yang menyusul tidak pernah bisa dibaca
/// sebagai kelanjutan slug — dua produk bernama `pos` dan `pos-lite` harus
/// menghasilkan hash yang berbeda meskipun sisa masukannya sama.
pub fn offline_identity_domain() -> String {
    format!("{APP_SLUG}-offline-identity-v2:")
}

/// Pemisah domain untuk frasa sandi vault konfigurasi database.
pub fn vault_master_domain() -> String {
    format!("{APP_SLUG}-vault-master-turso-v2:")
}

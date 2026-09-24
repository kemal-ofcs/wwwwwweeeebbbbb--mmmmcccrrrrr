/**
 * Identitas produk — SATU-SATUNYA tempat yang diganti saat template dipakai.
 *
 * Nilai di berkas ini bukan sekadar label. `APP_SLUG` ikut membentuk nama
 * cookie sesi dan kunci penyimpanan peramban, sehingga dua produk turunan yang
 * kebetulan dipasang pada host yang sama tidak saling menimpa sesinya. Versi
 * sebelumnya menyebar nilai-nilai ini sebagai literal di banyak berkas, dan
 * `rename-project.ts` tidak menyentuhnya — akibatnya setiap produk baru
 * membawa identitas produk lain tanpa ada yang menyadarinya.
 *
 * Padanan sisi Rust-nya ada di `src-tauri/src/desktop/app_identity.rs`, dan
 * `bun run rename` mengganti keduanya sekaligus.
 */

/**
 * Nama mesin produk: huruf kecil, angka, dan tanda hubung.
 *
 * Dipakai membentuk pengenal yang harus unik antar produk, bukan untuk
 * ditampilkan kepada pengguna.
 */
export const APP_SLUG = "app-template";

/** Nama yang dilihat pengguna. */
export const APP_DISPLAY_NAME = "App Template";

/**
 * Alamat server aplikasi bawaan, dipakai sebelum pengguna mengonfigurasinya.
 *
 * SENGAJA kosong pada template. Mengisinya dengan alamat nyata berarti setiap
 * produk turunan diam-diam menunjuk deployment milik orang lain sampai
 * seseorang menyadarinya.
 */
export const DEFAULT_SERVER_ORIGIN = "";

/** Nama cookie sesi Web. Wajib berbeda antar produk pada host yang sama. */
export const WEB_SESSION_COOKIE = `${APP_SLUG.replace(/-/g, "_")}_session`;

/** Awalan kunci `localStorage`, dengan alasan yang sama seperti cookie. */
export const STORAGE_PREFIX = APP_SLUG;

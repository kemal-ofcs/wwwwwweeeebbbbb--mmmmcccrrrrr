/**
 * SQL sesi tunggal (PRD FR-03, FR-10.4). Setiap konstanta WAJIB identik dengan
 * padanannya di `src-tauri/src/desktop/clients.rs`: satu database dilayani Web
 * dan perangkat, dan waktu di `app_session` bercampur bentuk ISO (Web) dengan
 * `datetime('now')` (perangkat), jadi setiap perbandingan waktu memakai
 * `julianday()`, tidak pernah perbandingan teks.
 */

/** Login online terakhir menang: cabut sesi lain milik operator ini (?1). */
export const SESSION_SUPERSEDE_SQL =
  "UPDATE app_session SET revoked_at = datetime('now'), revoked_reason = 'SUPERSEDED' WHERE operator_id = ?1 AND revoked_at IS NULL;";

/**
 * Buang sesi kedaluwarsa dan sesi yang dicabut lebih dari 30 hari lalu. Sesi
 * yang baru dicabut disimpan: perangkat yang lama offline membandingkannya, dan
 * layar login membaca alasan pencabutannya.
 */
export const SESSION_PURGE_SQL =
  "DELETE FROM app_session WHERE julianday(expires_at) <= julianday('now') OR (revoked_at IS NOT NULL AND julianday(revoked_at) < julianday('now') - 30);";

/** Dipakai perangkat; di sini hanya untuk diuji terhadap SQLite nyata. */
export const OFFLINE_SESSION_SUPERSEDED_SQL =
  "SELECT datetime('now') AS now, (SELECT COUNT(*) FROM app_session WHERE operator_id = ?1 AND ((?2 IS NULL AND revoked_at IS NULL) OR julianday(created_at) > julianday(?2))) AS total;";

/** Sesi aktif semua operator, terakhir terlihat dulu. */
export const ACTIVE_SESSION_LIST_SQL =
  "SELECT s.session_id, s.operator_id, o.nama_operator AS operator_name, s.client_kind, s.device_label, s.created_at, s.last_seen_at FROM app_session s LEFT JOIN master_operator o ON o.id = s.operator_id WHERE s.revoked_at IS NULL AND julianday(s.expires_at) > julianday('now') ORDER BY julianday(s.last_seen_at) DESC, s.rowid DESC LIMIT 500;";

/** Akhiri satu sesi. ?1 id sesi, ?2 alasan tersimpan. */
export const SESSION_END_SQL =
  "UPDATE app_session SET revoked_at = datetime('now'), revoked_reason = ?2 WHERE session_id = ?1 AND revoked_at IS NULL;";

/** Akhiri semua sesi seorang operator. ?1 id operator, ?2 alasan. */
export const SESSION_END_OPERATOR_SQL =
  "UPDATE app_session SET revoked_at = datetime('now'), revoked_reason = ?2 WHERE operator_id = ?1 AND revoked_at IS NULL;";

/** Alasan tersimpan saat pemegang `sessions.manage` mengakhiri sesi. */
export const SESSION_ENDED_BY_ADMIN = "ENDED_BY_ADMIN";

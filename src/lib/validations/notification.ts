/**
 * Notifikasi divisi (PRD FR-08): satu kejadian tampil di lonceng aplikasi dan,
 * bila bot aktif dan chat ID divisinya terisi, dikirim ke grup Telegram.
 *
 * WAJIB identik dengan `src-tauri/src/desktop/notifications.rs`. Kedua sisi
 * diuji dengan vektor yang sama (`notification.test.ts` dan `mod tests` di
 * sana), dan setiap konstanta SQL di bawah dites ada per karakter di Rust:
 * baris yang sama diklaim dan dikirim Web maupun perangkat.
 */

import {
  companyDayBoundsUtc,
  parseStoredTimestamp,
  timezoneOffsetHours,
  utcTimestamp,
} from "./client";

export const NOTIFICATION_DIVISIONS = ["CS", "RND", "FINANCE"] as const;
export type NotificationDivision = (typeof NOTIFICATION_DIVISIONS)[number];

/** Izin per divisi: siapa melihat kejadian divisi itu di lonceng. */
export const NOTIFICATION_PERMISSIONS = {
  CS: "notifications_cs.view",
  RND: "notifications_rnd.view",
  FINANCE: "notifications_finance.view",
} as const satisfies Record<NotificationDivision, string>;

export const NOTIFICATION_EVENT_TYPES = [
  "LEAD_NEW",
  "COLD_DIGEST",
  "SAMPLE_RND_REVIEW",
  "SAMPLE_WAITING_PAYMENT",
  "SAMPLE_PENDING_FEE",
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export const NOTIFICATION_MAX_ATTEMPTS = 5;
/** Ringkasan Cold dikirim pada siklus pengirim pertama sejak jam ini (waktu perusahaan). */
export const COLD_DIGEST_HOUR = 8;
/** Ringkasan mengejar hari yang terlewat paling banyak sejauh ini. */
export const COLD_DIGEST_MAX_CATCH_UP_DAYS = 7;

/**
 * Jeda sebelum percobaan berikutnya, setelah `attempts` percobaan gagal.
 * `null` = berhenti, baris menjadi `FAILED`.
 */
export function retryDelayMinutes(attempts: number): number | null {
  if (attempts >= NOTIFICATION_MAX_ATTEMPTS) return null;
  return [1, 5, 15, 60][Math.max(0, attempts - 1)] ?? 60;
}

/** Token dari @BotFather: `<angka>:<rahasia>`. */
export function isTelegramBotToken(value: string): boolean {
  return /^\d{3,20}:[A-Za-z0-9_-]{30,64}$/.test(value.trim());
}

export const TELEGRAM_TOKEN_REQUIRED =
  "Enter the bot token from @BotFather to turn notifications on.";
export const TELEGRAM_TOKEN_INVALID =
  "The bot token looks wrong. Copy it from @BotFather, for example 123456789:AAH...";

// ---------------------------------------------------------------------------
// Waktu perusahaan
// ---------------------------------------------------------------------------

function zoneLabel(timezone: string) {
  const offset = timezoneOffsetHours(timezone);
  return offset === 8 ? "WITA" : offset === 9 ? "WIT" : "WIB";
}

/** `YYYY-MM-DD HH:MM WIB` dari stempel UTC tersimpan; teks apa adanya bila rusak. */
export function formatCompanyTime(stored: string, timezone: string) {
  const epoch = parseStoredTimestamp(stored);
  if (epoch === null) return stored;
  const local = utcTimestamp(epoch + timezoneOffsetHours(timezone) * 3600);
  return `${local.slice(0, 16)} ${zoneLabel(timezone)}`;
}

/** Tanggal (`YYYY-MM-DD`) dan jam perusahaan dari epoch detik UTC. */
export function companyClock(epochSeconds: number, timezone: string) {
  const local = utcTimestamp(
    epochSeconds + timezoneOffsetHours(timezone) * 3600,
  );
  return { date: local.slice(0, 10), hour: Number(local.slice(11, 13)) };
}

function shiftDate(date: string, days: number) {
  const midnight = parseStoredTimestamp(`${date} 00:00:00`);
  return midnight === null
    ? null
    : utcTimestamp(midnight + days * 86_400).slice(0, 10);
}

/**
 * Rentang UTC `[dari, sampai)` untuk `last_client_response_at` lead yang
 * menjadi Cold sejak ringkasan sebelumnya. Lead menjadi Cold pada hari ke
 * `warm + 1` setelah respons terakhirnya (`leadSegment`), jadi hari menjadi
 * Cold `d` berarti respons di hari `d - warm - 1`. Tanpa ringkasan sebelumnya
 * hanya hari ini; hari yang terlewat dikejar paling banyak 7 hari.
 */
export function coldDigestWindow(
  today: string,
  lastDigestDate: string | null,
  warmMaxDays: number,
  timezone: string,
): [string, string] | null {
  const earliest = shiftDate(today, 1 - COLD_DIGEST_MAX_CATCH_UP_DAYS);
  const afterLast = lastDigestDate ? shiftDate(lastDigestDate, 1) : today;
  if (!earliest || !afterLast) return null;
  const firstDay = afterLast > earliest ? afterLast : earliest;
  if (firstDay > today) return null;
  const fromDate = shiftDate(firstDay, -warmMaxDays - 1);
  const toDate = shiftDate(today, -warmMaxDays);
  if (!fromDate || !toDate) return null;
  const from = companyDayBoundsUtc(fromDate, timezone);
  const to = companyDayBoundsUtc(toDate, timezone);
  return from && to ? [from[0], to[0]] : null;
}

// ---------------------------------------------------------------------------
// Teks pesan (teks polos: tanpa parse_mode, jadi nama klien tidak perlu di-escape)
// ---------------------------------------------------------------------------

type Payload = Record<string, unknown>;

function text(payload: Payload, key: string) {
  const value = payload[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function orDash(value: string) {
  return value.trim() === "" ? "-" : value;
}

export function renderNotification(
  eventType: string,
  payload: Payload,
  occurredAt: string,
  timezone: string,
): string {
  const when = formatCompanyTime(occurredAt, timezone);
  const client = `${text(payload, "client_name")} (${text(payload, "client_code")})`;
  const sample = `${text(payload, "brand_name")} for ${client}`;
  switch (eventType) {
    case "LEAD_NEW":
      return [
        `New lead: ${client}`,
        `Channel: ${orDash(text(payload, "channel"))}, category: ${orDash(text(payload, "category"))}`,
        `PIC: ${orDash(text(payload, "pic"))}`,
        `Registered ${when}`,
      ].join("\n");
    case "SAMPLE_RND_REVIEW":
      return [
        `Sample request waiting for RnD review: ${sample}`,
        `Deadline: ${orDash(text(payload, "deadline_at"))}`,
        `Submitted ${when}`,
      ].join("\n");
    case "SAMPLE_WAITING_PAYMENT":
      return [`Sample fee payment awaited: ${sample}`, `Since ${when}`].join(
        "\n",
      );
    case "SAMPLE_PENDING_FEE":
      return [
        `Revision ${text(payload, "revision_index")} is over the free quota and needs a fee decision: ${sample}`,
        `Since ${when}`,
      ].join("\n");
    case "COLD_DIGEST": {
      const leads = Array.isArray(payload.leads)
        ? (payload.leads as Payload[])
        : [];
      return [
        `Leads that went Cold (${text(payload, "date")}): ${leads.length}`,
        ...leads.map(
          (lead) =>
            `- ${text(lead, "client_name")} (${text(lead, "client_code")}), PIC ${orDash(text(lead, "pic"))}`,
        ),
      ].join("\n");
    }
    default:
      return eventType;
  }
}

/** Pesan uji kirim dari Pengaturan. */
export function testMessage(division: NotificationDivision) {
  return `Company OS test message for the ${division} group. Notifications are working.`;
}

// ---------------------------------------------------------------------------
// SQL. Setiap konstanta WAJIB identik dengan padanannya di `notifications.rs`.
//
// `id` sekaligus kunci dedupe (`lead-new:<client>`, `sample:<log>`,
// `cold-digest:<tanggal>`): push ulang dan dua pengirim yang berlomba tidak
// pernah menggandakan baris. Tabelnya cloud-only, jadi PK cukup.
// Status Telegram dihitung saat baris lahir: `SKIPPED` bila bot mati atau chat
// ID divisinya kosong, supaya menyalakan bot nanti tidak membanjiri grup.
// ---------------------------------------------------------------------------

/** ?1 = client id. Dipanggil di transaksi registrasi, sesudah baris klien dan lead ada. */
export const NOTIFY_LEAD_NEW_SQL =
  "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) SELECT 'lead-new:' || c.id, 'LEAD_NEW', 'CS', json_object('client_id', c.id, 'client_code', c.client_code, 'client_name', c.name, 'channel', COALESCE(ch.label, ''), 'category', COALESCE(cat.label, ''), 'pic', COALESCE(o.nama_operator, '')), c.created_at, CASE WHEN EXISTS (SELECT 1 FROM telegram_config t WHERE t.id = 'default' AND t.is_active = 1 AND TRIM(COALESCE(t.bot_token, '')) <> '') AND TRIM(COALESCE((SELECT g.value FROM setting_gex_system g WHERE g.key = 'telegram_chat_id_cs'), '')) <> '' THEN 'PENDING' ELSE 'SKIPPED' END, 0, datetime('now'), datetime('now') FROM clients c JOIN leads l ON l.client_id = c.id LEFT JOIN master_option ch ON ch.id = l.channel_option_id LEFT JOIN master_option cat ON cat.id = l.product_category_option_id LEFT JOIN master_operator o ON o.id = l.pic_cs_id WHERE c.id = ?1 LIMIT 1 ON CONFLICT(id) DO NOTHING;";

/**
 * ?1 = id baris `sample_status_log` langkah ini, ?2 = sample id. Aman dipanggil
 * setelah setiap langkah: status di luar tiga status target tidak menulis apa pun.
 */
export const NOTIFY_SAMPLE_STATUS_SQL =
  "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) SELECT 'sample:' || ?1, CASE s.status WHEN 'RND_REVIEW' THEN 'SAMPLE_RND_REVIEW' WHEN 'WAITING_SAMPLE_PAYMENT' THEN 'SAMPLE_WAITING_PAYMENT' ELSE 'SAMPLE_PENDING_FEE' END, CASE s.status WHEN 'RND_REVIEW' THEN 'RND' ELSE 'FINANCE' END, json_object('sample_id', s.id, 'client_code', COALESCE(c.client_code, ''), 'client_name', COALESCE(c.name, ''), 'brand_name', s.brand_name, 'revision_index', s.revision_index, 'deadline_at', s.deadline_at), s.status_changed_at, CASE WHEN EXISTS (SELECT 1 FROM telegram_config t WHERE t.id = 'default' AND t.is_active = 1 AND TRIM(COALESCE(t.bot_token, '')) <> '') AND TRIM(COALESCE((SELECT g.value FROM setting_gex_system g WHERE g.key = CASE s.status WHEN 'RND_REVIEW' THEN 'telegram_chat_id_rnd' ELSE 'telegram_chat_id_finance' END), '')) <> '' THEN 'PENDING' ELSE 'SKIPPED' END, 0, datetime('now'), datetime('now') FROM sample_requests s LEFT JOIN clients c ON c.id = s.client_id WHERE s.id = ?2 AND s.status IN ('RND_REVIEW', 'WAITING_SAMPLE_PAYMENT', 'PENDING_FEE_ASSESSMENT') LIMIT 1 ON CONFLICT(id) DO NOTHING;";

/** Ringkasan Cold yang sudah ada untuk satu tanggal, dan tanggal ringkasan terakhir. */
export const COLD_DIGEST_STATE_SQL =
  "SELECT (SELECT COUNT(*) FROM notification_outbox WHERE id = ?1) AS done, COALESCE((SELECT MAX(id) FROM notification_outbox WHERE id LIKE 'cold-digest:%'), '') AS last_id;";

/** ?1/?2 = rentang `coldDigestWindow`. */
export const COLD_DIGEST_LEADS_SQL =
  "SELECT c.client_code, c.name AS client_name, COALESCE(o.nama_operator, '') AS pic FROM clients c JOIN leads l ON l.client_id = c.id LEFT JOIN master_operator o ON o.id = l.pic_cs_id WHERE c.lifecycle_status = 'LEAD' AND l.last_client_response_at >= ?1 AND l.last_client_response_at < ?2 ORDER BY l.last_client_response_at, c.client_code LIMIT 50;";

/** ?1 = id, ?2 = payload, ?3 = status (`PENDING`/`SKIPPED`). */
export const COLD_DIGEST_INSERT_SQL =
  "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) VALUES (?1, 'COLD_DIGEST', 'CS', ?2, datetime('now'), ?3, 0, datetime('now'), datetime('now')) ON CONFLICT(id) DO NOTHING;";

export const NOTIFICATION_DUE_SQL =
  "SELECT id, event_type, target_division, payload_json, occurred_at, attempts FROM notification_outbox WHERE status = 'PENDING' AND next_attempt_at <= datetime('now') AND (claimed_at IS NULL OR claimed_at < datetime('now', '-10 minutes')) ORDER BY created_at, rowid LIMIT 10;";

/** Satu pemenang per baris: dua pengirim yang berlomba hanya satu yang mendapat rowsAffected = 1. */
export const NOTIFICATION_CLAIM_SQL =
  "UPDATE notification_outbox SET claimed_at = datetime('now'), attempts = attempts + 1 WHERE id = ?1 AND status = 'PENDING' AND (claimed_at IS NULL OR claimed_at < datetime('now', '-10 minutes'));";

export const NOTIFICATION_SENT_SQL =
  "UPDATE notification_outbox SET status = 'SENT', sent_at = datetime('now'), claimed_at = NULL, last_error = '' WHERE id = ?1;";

/** Chat ID divisinya dikosongkan setelah baris lahir. */
export const NOTIFICATION_SKIP_SQL =
  "UPDATE notification_outbox SET status = 'SKIPPED', claimed_at = NULL WHERE id = ?1;";

/** ?2 = error dari Telegram, ?3 = jeda menit (`null` = berhenti, `FAILED`). */
export const NOTIFICATION_FAILED_SQL =
  "UPDATE notification_outbox SET status = CASE WHEN ?3 IS NULL THEN 'FAILED' ELSE status END, claimed_at = NULL, last_error = ?2, next_attempt_at = CASE WHEN ?3 IS NULL THEN next_attempt_at ELSE datetime('now', '+' || ?3 || ' minutes') END WHERE id = ?1;";

export const NOTIFICATION_RETRY_FAILED_SQL =
  "UPDATE notification_outbox SET status = 'PENDING', attempts = 0, claimed_at = NULL, next_attempt_at = datetime('now') WHERE status = 'FAILED';";

export const NOTIFICATION_FAILED_LIST_SQL =
  "SELECT id, event_type, target_division, occurred_at, attempts, last_error FROM notification_outbox WHERE status = 'FAILED' ORDER BY created_at DESC, rowid DESC LIMIT 50;";

export const NOTIFICATION_PENDING_COUNT_SQL =
  "SELECT COUNT(*) AS total FROM notification_outbox WHERE status = 'PENDING';";

/**
 * Lonceng: ?1/?2/?3 = boleh melihat CS/RnD/Finance (0/1). Ringkasan Cold
 * kosong hanya penanda tanggal, tidak pernah ditampilkan.
 */
export const NOTIFICATION_BELL_LIST_SQL =
  "SELECT id, event_type, target_division, payload_json, occurred_at, created_at FROM notification_outbox WHERE ((?1 = 1 AND target_division = 'CS') OR (?2 = 1 AND target_division = 'RND') OR (?3 = 1 AND target_division = 'FINANCE')) AND NOT (event_type = 'COLD_DIGEST' AND json_array_length(payload_json, '$.leads') = 0) ORDER BY created_at DESC, rowid DESC LIMIT 30;";

/** ?4 = operator id. Belum dibaca = lahir sesudah operator terakhir membuka lonceng. */
export const NOTIFICATION_UNREAD_COUNT_SQL =
  "SELECT COUNT(*) AS total FROM notification_outbox WHERE ((?1 = 1 AND target_division = 'CS') OR (?2 = 1 AND target_division = 'RND') OR (?3 = 1 AND target_division = 'FINANCE')) AND NOT (event_type = 'COLD_DIGEST' AND json_array_length(payload_json, '$.leads') = 0) AND created_at > COALESCE((SELECT seen_at FROM notification_seen WHERE operator_id = ?4), '');";

/** Waktu database, zona perusahaan, dan konfigurasi bot dalam satu baris. */
export const NOTIFICATION_CONTEXT_SQL =
  "SELECT CAST(strftime('%s', 'now') AS INTEGER) AS now_epoch, COALESCE((SELECT timezone FROM company_profile WHERE id = 'default_company'), '') AS timezone, COALESCE((SELECT is_active FROM telegram_config WHERE id = 'default'), 0) AS is_active, COALESCE((SELECT bot_token FROM telegram_config WHERE id = 'default'), '') AS bot_token, COALESCE((SELECT updated_at FROM telegram_config WHERE id = 'default'), '') AS updated_at, COALESCE((SELECT updated_by FROM telegram_config WHERE id = 'default'), '') AS updated_by;";

/** Kunci setelan bisnis yang dibutuhkan pengirim (dibaca lewat `readBusinessSettings`). */
export const NOTIFICATION_SETTINGS_SQL =
  "SELECT key, value FROM setting_gex_system WHERE key IN ('lead_hot_max_days', 'lead_warm_max_days', 'telegram_chat_id_cs', 'telegram_chat_id_rnd', 'telegram_chat_id_finance');";

/** ?1 = token baru (kosong = pertahankan yang lama, aturan 11), ?2 = aktif, ?3 = pelaku. */
export const TELEGRAM_CONFIG_SAVE_SQL =
  "INSERT INTO telegram_config (id, bot_token, is_active, updated_at, updated_by) VALUES ('default', ?1, ?2, datetime('now'), ?3) ON CONFLICT(id) DO UPDATE SET bot_token = CASE WHEN excluded.bot_token = '' THEN telegram_config.bot_token ELSE excluded.bot_token END, is_active = excluded.is_active, updated_at = excluded.updated_at, updated_by = excluded.updated_by;";

export const NOTIFICATION_MARK_SEEN_SQL =
  "INSERT INTO notification_seen (operator_id, seen_at) VALUES (?1, datetime('now')) ON CONFLICT(operator_id) DO UPDATE SET seen_at = excluded.seen_at;";

/**
 * Aturan domain klien yang WAJIB identik dengan `src-tauri/src/desktop/clients.rs`.
 * Kedua sisi diuji dengan vektor yang sama (`client.test.ts` dan `mod tests`
 * di `clients.rs`): kode klien yang dibuat Web dan perangkat harus mengikuti
 * aturan yang persis sama, dan nomor WhatsApp yang sama harus menghasilkan
 * bentuk normal yang sama supaya pemeriksaan duplikat tidak bisa diakali.
 */

/** Awalan kode klien bawaan. Bisa disetel per perusahaan (`client_code_prefix`). */
export const DEFAULT_CLIENT_CODE_PREFIX = "KLN";
/** Tag perangkat untuk klien yang dibuat lewat Web (`client_code_web_tag`). */
export const DEFAULT_CLIENT_CODE_WEB_TAG = "WB";

export const CLIENT_CODE_PREFIX_SETTING = "client_code_prefix";
export const CLIENT_CODE_WEB_TAG_SETTING = "client_code_web_tag";

/** Siklus hidup klien (PRD D-09). Divalidasi aplikasi, bukan CHECK (keputusan G). */
export const CLIENT_LIFECYCLE_STATUSES = [
  "LEAD",
  "FIRST_ORDER_ACTIVE",
  "EXISTING_CLIENT",
] as const;
export type ClientLifecycleStatus = (typeof CLIENT_LIFECYCLE_STATUSES)[number];

export const MASTER_OPTION_KINDS = [
  "LEAD_CHANNEL",
  "PRODUCT_CATEGORY",
] as const;
export type MasterOptionKind = (typeof MASTER_OPTION_KINDS)[number];

export function isMasterOptionKind(value: unknown): value is MasterOptionKind {
  return (
    typeof value === "string" &&
    (MASTER_OPTION_KINDS as readonly string[]).includes(value)
  );
}

const BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Dua digit basis-36 tanpa nol = 1..1295 kode per tag per tanggal. */
export const MAX_CLIENT_SEQUENCE = 36 * 36 - 1;

/**
 * Bentuk normal nomor WhatsApp: `62` + digit, 10-15 digit total.
 * Spasi, tanda hubung, titik, dan kurung dibuang; `+` di depan dibuang;
 * awalan `0` menjadi `62`. Nomor yang tidak diawali `0` atau `62` ditolak,
 * karena menebak kode negaranya bisa menggabungkan dua klien berbeda.
 */
export function normalizeWhatsapp(raw: string): string | null {
  let value = raw.replace(/[\s\-.()]/g, "");
  if (value.startsWith("+")) value = value.slice(1);
  if (value.startsWith("0")) value = `62${value.slice(1)}`;
  if (!/^62\d+$/.test(value)) return null;
  if (value.length < 10 || value.length > 15) return null;
  return value;
}

/** `KLN` / `CUS`: 2-5 huruf kapital. Masukan dirapikan dulu (trim + kapital). */
export function normalizeCodePrefix(raw: string): string | null {
  const value = raw.trim().toUpperCase();
  return /^[A-Z]{2,5}$/.test(value) ? value : null;
}

/** Tag perangkat / tag Web: tepat 2 karakter A-Z atau 0-9. */
export function normalizeDeviceTag(raw: string): string | null {
  const value = raw.trim().toUpperCase();
  return /^[A-Z0-9]{2}$/.test(value) ? value : null;
}

function base36Pair(value: number) {
  return `${BASE36[Math.floor(value / 36)]}${BASE36[value % 36]}`;
}

/** `KLN-20260925-A101`. `null` bila urutannya di luar 1..1295. */
export function formatClientCode(
  prefix: string,
  dateStamp: string,
  tag: string,
  sequence: number,
): string | null {
  if (!Number.isInteger(sequence) || sequence < 1) return null;
  if (sequence > MAX_CLIENT_SEQUENCE) return null;
  return `${prefix}-${dateStamp}-${tag}${base36Pair(sequence)}`;
}

/**
 * Urutan berikutnya untuk satu tag pada satu tanggal, dibaca dari kode yang
 * sudah ada (awalan apa pun ikut dihitung, supaya mengganti awalan di tengah
 * hari tidak membuat urutan mundur). `null` bila 1295 kode hari itu habis.
 */
export function nextClientSequence(
  codes: readonly string[],
  dateStamp: string,
  tag: string,
): number | null {
  const marker = `-${dateStamp}-${tag}`;
  let highest = 0;
  for (const code of codes) {
    const at = code.lastIndexOf(marker);
    if (at < 0 || code.length !== at + marker.length + 2) continue;
    const pair = code.slice(-2);
    const high = BASE36.indexOf(pair[0] ?? "");
    const low = BASE36.indexOf(pair[1] ?? "");
    if (high < 0 || low < 0) continue;
    highest = Math.max(highest, high * 36 + low);
  }
  return highest >= MAX_CLIENT_SEQUENCE ? null : highest + 1;
}

/**
 * Selisih jam zona waktu Indonesia (keputusan C). Zona lain dianggap WIB:
 * tanpa basis data zona waktu, menebak zona asing lebih berbahaya daripada
 * memakai zona kantor pusat.
 */
export function timezoneOffsetHours(timezone: string): number {
  switch (timezone.trim()) {
    case "Asia/Makassar":
      return 8;
    case "Asia/Jayapura":
      return 9;
    default:
      return 7;
  }
}

/** Tanggal perusahaan `YYYYMMDD` dari epoch detik UTC. */
export function companyDateStamp(epochSeconds: number, timezone: string) {
  const shifted = new Date(
    (epochSeconds + timezoneOffsetHours(timezone) * 3600) * 1000,
  );
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

/** Kode opsi Master Data: 1-20 karakter A-Z, 0-9, `_` atau `-`. */
export function normalizeOptionCode(raw: string): string | null {
  const value = raw.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,20}$/.test(value) ? value : null;
}

export const CLIENT_NAME_MIN = 2;
export const CLIENT_NAME_MAX = 120;
export const CLIENT_TEXT_MAX = 300;
export const CLIENT_NOTES_MAX = 2000;
export const OPTION_LABEL_MAX = 80;

// ── Interaksi lead & segmentasi (PRD FR-05) ─────────────────────────────────
// Padanan Rust ada di `clients.rs`, diuji dengan vektor yang sama.

/** `OUTBOUND` = follow up oleh CS, `INBOUND` = respons klien (FR-05.1). */
export const LEAD_INTERACTION_DIRECTIONS = ["OUTBOUND", "INBOUND"] as const;
export type LeadInteractionDirection =
  (typeof LEAD_INTERACTION_DIRECTIONS)[number];

/** Chat WA, Telepon, Kunjungan, Kirim Materi, Lainnya (FR-05.1). */
export const LEAD_INTERACTION_KINDS = [
  "WHATSAPP",
  "CALL",
  "VISIT",
  "MATERIAL",
  "OTHER",
] as const;
export type LeadInteractionKind = (typeof LEAD_INTERACTION_KINDS)[number];

export const INTERACTION_NOTES_MAX = 1000;
/** Batas mundur waktu interaksi: catatan lebih tua dari ini hampir pasti salah ketik. */
export const INTERACTION_MAX_AGE_SECONDS = 366 * 86_400;
/** Toleransi jam perangkat yang sedikit lebih cepat daripada jam database. */
export const INTERACTION_FUTURE_TOLERANCE_SECONDS = 300;

/** Batas segmen dalam hari kalender (FR-05.3): HOT ≤ 3, WARM 4-7, COLD > 7. */
export const HOT_MAX_DAYS = 3;
export const WARM_MAX_DAYS = 7;
export type LeadSegment = "HOT" | "WARM" | "COLD";

export function isLeadInteractionDirection(
  value: unknown,
): value is LeadInteractionDirection {
  return (
    typeof value === "string" &&
    (LEAD_INTERACTION_DIRECTIONS as readonly string[]).includes(value)
  );
}

export function isLeadInteractionKind(
  value: unknown,
): value is LeadInteractionKind {
  return (
    typeof value === "string" &&
    (LEAD_INTERACTION_KINDS as readonly string[]).includes(value)
  );
}

/** Bentuk `datetime('now')`: `YYYY-MM-DD HH:MM:SS` UTC. Padanan `utc_timestamp`. */
export function utcTimestamp(epochSeconds: number) {
  return new Date(epochSeconds * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

/**
 * Epoch detik dari stempel waktu tersimpan (`YYYY-MM-DD HH:MM:SS`, boleh
 * dengan `T` dan akhiran `Z`), selalu dibaca sebagai UTC. `null` bila bentuknya
 * lain — `new Date(...)` tidak dipakai karena menebak zona lokal (aturan 19).
 */
export function parseStoredTimestamp(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})Z?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
}

function companyDayNumber(epochSeconds: number, timezone: string) {
  return Math.floor(
    (epochSeconds + timezoneOffsetHours(timezone) * 3600) / 86_400,
  );
}

/**
 * Hari kalender perusahaan sejak respons terakhir klien. Respons "di masa
 * depan" (jam perangkat lain lebih cepat) dihitung 0, bukan negatif.
 */
export function daysSinceResponse(
  lastResponseAt: string,
  nowEpochSeconds: number,
  timezone: string,
): number | null {
  const last = parseStoredTimestamp(lastResponseAt);
  if (last === null) return null;
  return Math.max(
    0,
    companyDayNumber(nowEpochSeconds, timezone) -
      companyDayNumber(last, timezone),
  );
}

/** Segmen hanya untuk klien `LEAD` (D-09); selain itu `null`. */
export function leadSegment(
  lifecycleStatus: string,
  days: number | null,
): LeadSegment | null {
  if (lifecycleStatus !== "LEAD" || days === null) return null;
  if (days <= HOT_MAX_DAYS) return "HOT";
  if (days <= WARM_MAX_DAYS) return "WARM";
  return "COLD";
}

/**
 * Waktu interaksi yang diminta (epoch detik) atau sekarang bila kosong.
 * Mengembalikan pesan penolakan sebagai string supaya Rust dan TS memakai
 * teks yang sama persis.
 */
export function resolveInteractionTime(
  requested: unknown,
  nowEpochSeconds: number,
): { epoch: number } | { error: string } {
  if (requested === undefined || requested === null) {
    return { epoch: nowEpochSeconds };
  }
  if (typeof requested !== "number" || !Number.isSafeInteger(requested)) {
    return { error: "The interaction time is not valid." };
  }
  if (requested > nowEpochSeconds + INTERACTION_FUTURE_TOLERANCE_SECONDS) {
    return { error: "The interaction time cannot be in the future." };
  }
  if (requested < nowEpochSeconds - INTERACTION_MAX_AGE_SECONDS) {
    return { error: "The interaction time cannot be more than a year ago." };
  }
  return { epoch: requested };
}

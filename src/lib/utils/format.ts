/**
 * Format tampilan untuk antarmuka berbahasa Inggris dengan konvensi Indonesia
 * (keputusan pemilik produk): `25/09/2026 14:30 WIB`.
 *
 * Stempel waktu dari database berbentuk `YYYY-MM-DD HH:MM:SS` tanpa zona dan
 * SELALU UTC (`datetime('now')`). `new Date()` membacanya sebagai waktu lokal,
 * jadi bentuk itu diberi akhiran `Z` lebih dulu. Hanya untuk TAMPILAN; setiap
 * perbandingan kedaluwarsa tetap dihitung database (aturan 19).
 */
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

function parseTimestamp(value: string): Date | null {
  const trimmed = value.trim();
  const iso = SQLITE_DATETIME.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(
  value: string | null | undefined,
  timeZone?: string,
): string {
  if (!value) return "-";
  const date = parseTimestamp(value);
  if (!date) return value;
  const parts = new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
    timeZone,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const zone = part("timeZoneName");
  return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}${zone ? ` ${zone}` : ""}`;
}

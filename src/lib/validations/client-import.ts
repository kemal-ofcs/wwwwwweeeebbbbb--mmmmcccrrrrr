/**
 * Impor CSV Sheet Database CS per PIC dan Sheet Database Klien (PRD FR-09).
 *
 * Dua bagian:
 * - Khusus layar (tanpa padanan Rust): membaca CSV, menebak pemetaan header,
 *   menebak urutan tanggal. Hasilnya hanya saran yang dibetulkan admin.
 * - Kembar dengan `clients.rs` (vektor sama di `client-import.test.ts` dan
 *   `mod tests` di sana): `parseSheetDate`, `normalizeImportPhone`,
 *   `validateImportRow`. Backend memanggilnya untuk pratinjau DAN simpan,
 *   jadi baris yang lolos pratinjau adalah baris yang tersimpan.
 */

import {
  CLIENT_NAME_MAX,
  CLIENT_NAME_MIN,
  CLIENT_NOTES_MAX,
  CLIENT_TEXT_MAX,
  INTERACTION_NOTES_MAX,
  normalizeWhatsapp,
  parseStoredTimestamp,
  timezoneOffsetHours,
  utcTimestamp,
} from "./client";

export const IMPORT_MAX_ROWS = 5000;
export const IMPORT_FOLLOWUPS_MAX = 10_000;
export const IMPORT_NOTE_PREFIX = "Imported from sheet: ";

export const DATE_ORDERS = ["DMY", "MDY"] as const;
export type DateOrder = (typeof DATE_ORDERS)[number];

/** Kolom sheet menurut `Alur Maklon.pdf`, dalam urutan aslinya. */
export const IMPORT_FIELDS = [
  { key: "lead_created_at", header: "Timelapse Input Data Lead" },
  { key: "channel", header: "Kode Asal Lead" },
  { key: "pic", header: "PIC Customer Service" },
  { key: "client_code", header: "Kode Klien" },
  { key: "name", header: "Nama Klien" },
  { key: "phone", header: "Nomor Klien" },
  { key: "address", header: "Alamat Klien" },
  { key: "city", header: "Kota / Kabupaten" },
  { key: "province", header: "Provinsi" },
  { key: "needs_notes", header: "Kebutuhan" },
  { key: "category", header: "Kategori Produk" },
  { key: "last_update", header: "Tanggal Terakhir Update" },
  { key: "total_followups", header: "Jumlah FU" },
  { key: "pic_answer", header: "Jawaban PIC" },
] as const;
export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]["key"];

// ---------------------------------------------------------------------------
// Khusus layar
// ---------------------------------------------------------------------------

/** CSV RFC 4180 (ekspor Google Sheets): koma, kutip ganda, baris CRLF/LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^﻿/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

function headerKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function editDistance(a: string, b: string) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j] ?? 0;
      previous[j] = Math.min(
        above + 1,
        (previous[j - 1] ?? 0) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[b.length] ?? 0;
}

/**
 * Tebakan kolom per field: nama header yang sama setelah huruf kecil dan
 * tanpa tanda baca, atau beda paling banyak 2 huruf (`omor Klien`).
 * `-1` = tidak ditemukan. Setiap kolom dipakai paling banyak sekali.
 */
export function suggestHeaderMapping(
  headers: readonly string[],
): Record<ImportFieldKey, number> {
  const keys = headers.map(headerKey);
  const used = new Set<number>();
  const mapping = {} as Record<ImportFieldKey, number>;
  for (const field of IMPORT_FIELDS) {
    const target = headerKey(field.header);
    let best = -1;
    let bestDistance = 3;
    keys.forEach((key, index) => {
      if (used.has(index)) return;
      const distance = key === target ? 0 : editDistance(key, target);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    if (best >= 0) used.add(best);
    mapping[field.key] = best;
  }
  return mapping;
}

/**
 * Urutan tanggal yang pasti dari nilai yang ada: angka pertama > 12 hanya
 * masuk akal sebagai tanggal (DMY), angka kedua > 12 hanya sebagai MDY.
 * `null` = semua nilai ambigu atau saling bertentangan; admin memilih.
 */
export function detectDateOrder(values: readonly string[]): DateOrder | null {
  let dmy = false;
  let mdy = false;
  for (const value of values) {
    const match = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{4}/.exec(value.trim());
    if (!match) continue;
    if (Number(match[1]) > 12) dmy = true;
    if (Number(match[2]) > 12) mdy = true;
  }
  if (dmy === mdy) return null;
  return dmy ? "DMY" : "MDY";
}

// ---------------------------------------------------------------------------
// Kembar dengan `clients.rs`
// ---------------------------------------------------------------------------

export type SheetDate = { value: string } | { empty: true } | { error: string };

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Tanggal sheet (waktu perusahaan) → stempel UTC kanonik. Menerima
 * `D/M/YYYY`, `M/D/YYYY` (menurut `order`, pemisah `/`, `-`, atau `.`) dan
 * `YYYY-MM-DD`, masing-masing boleh diikuti `H:MM` atau `H:MM:SS`.
 */
export function parseSheetDate(
  raw: string,
  order: DateOrder,
  timezone: string,
): SheetDate {
  const text = raw.trim();
  if (text === "") return { empty: true };
  const time = "(?:[ T](\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?$";
  let year: number;
  let month: number;
  let day: number;
  let rest: (string | undefined)[];
  const iso = new RegExp(`^(\\d{4})-(\\d{1,2})-(\\d{1,2})${time}`).exec(text);
  const local = new RegExp(
    `^(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4})${time}`,
  ).exec(text);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
    rest = iso.slice(4);
  } else if (local) {
    const first = Number(local[1]);
    const second = Number(local[2]);
    year = Number(local[3]);
    [day, month] = order === "DMY" ? [first, second] : [second, first];
    rest = local.slice(4);
  } else {
    return { error: `The date "${text}" could not be read.` };
  }
  const hour = Number(rest[0] ?? 0);
  const minute = Number(rest[1] ?? 0);
  const second = Number(rest[2] ?? 0);
  if (
    year < 2000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return { error: `The date "${text}" could not be read.` };
  }
  const epoch =
    Date.UTC(year, month - 1, day, hour, minute, second) / 1000 -
    timezoneOffsetHours(timezone) * 3600;
  return { value: utcTimestamp(epoch) };
}

/**
 * Nomor dari sheet: aturan `normalizeWhatsapp`, ditambah nomor yang kehilangan
 * angka 0 di depan karena kolom sheet berformat angka (`812…` → `62812…`).
 */
export function normalizeImportPhone(raw: string): string | null {
  const direct = normalizeWhatsapp(raw);
  if (direct) return direct;
  const digits = raw.replace(/[\s.()-]/g, "");
  return /^8\d{8,11}$/.test(digits) ? normalizeWhatsapp(`62${digits}`) : null;
}

/** Satu baris yang sudah dipetakan layar: teks mentah + id hasil pemetaan nilai. */
export interface ImportRowInput {
  line: number;
  client_code: string;
  name: string;
  phone: string;
  address: string;
  city: string;
  province: string;
  needs_notes: string;
  /** Id Master Data hasil pemetaan nilai/bawaan; kosong = tidak ada. */
  channel_option_id: string;
  product_category_option_id: string;
  /** Id operator hasil pemetaan; `null` = pengimpor (keputusan C). */
  pic_cs_id: number | null;
  lead_created_at: string;
  last_update: string;
  total_followups: string;
  pic_answer: string;
}

export interface ImportContext {
  date_order: DateOrder;
  timezone: string;
  now_epoch: number;
  warm_max_days: number;
}

export interface ImportRow {
  line: number;
  /** Kosong = dibuatkan kode baru (keputusan D). */
  client_code: string;
  name: string;
  phone: string;
  address: string;
  city: string;
  province: string;
  needs_notes: string;
  channel_option_id: string;
  product_category_option_id: string;
  pic_cs_id: number | null;
  created_at: string;
  last_client_response_at: string;
  total_followups: number;
  /** Catatan interaksi `INBOUND`/`OTHER`; kosong = tanpa interaksi (keputusan E). */
  interaction_note: string;
  note_truncated: boolean;
}

const FUTURE_DATE =
  "is in the future. Check the date order (day/month or month/day).";

function sheetTimestamp(
  raw: string,
  label: string,
  context: ImportContext,
  fallback: string,
): { value: string } | { error: string } {
  const parsed = parseSheetDate(raw, context.date_order, context.timezone);
  if ("error" in parsed) return { error: `${label}: ${parsed.error}` };
  if ("empty" in parsed) return { value: fallback };
  const epoch = parseStoredTimestamp(parsed.value) ?? 0;
  if (epoch > context.now_epoch) return { error: `${label} ${FUTURE_DATE}` };
  return parsed;
}

export function validateImportRow(
  input: ImportRowInput,
  context: ImportContext,
): { row: ImportRow } | { error: string } {
  const code = input.client_code.trim();
  if (code !== "" && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/.test(code)) {
    return {
      error:
        "Kode Klien may only use letters, digits, and . _ / - (up to 40 characters).",
    };
  }
  const name = input.name.trim();
  const length = [...name].length;
  if (length < CLIENT_NAME_MIN || length > CLIENT_NAME_MAX) {
    return { error: "The client name must be 2-120 characters." };
  }
  const phone = normalizeImportPhone(input.phone);
  if (!phone) {
    return {
      error: "Enter a valid WhatsApp number that starts with 0 or 62.",
    };
  }
  const address = input.address.trim();
  const city = input.city.trim();
  const province = input.province.trim();
  if (
    [address, city, province].some(
      (value) => [...value].length > CLIENT_TEXT_MAX,
    )
  ) {
    return {
      error: "Address, city, and province can be at most 300 characters each.",
    };
  }
  const needs = input.needs_notes.trim();
  if ([...needs].length > CLIENT_NOTES_MAX) {
    return { error: "Client needs can be at most 2000 characters." };
  }
  if (input.channel_option_id.trim() === "") {
    return {
      error:
        "Kode Asal Lead is empty or not matched, and no default was chosen.",
    };
  }
  if (input.product_category_option_id.trim() === "") {
    return {
      error:
        "Kategori Produk is empty or not matched, and no default was chosen.",
    };
  }
  const now = utcTimestamp(context.now_epoch);
  const created = sheetTimestamp(
    input.lead_created_at,
    "Timelapse Input Data Lead",
    context,
    now,
  );
  if ("error" in created) return created;
  // D-14: tanpa tanggal = sudah Cold menurut setelan perusahaan (keputusan F).
  const cold = utcTimestamp(
    context.now_epoch - (context.warm_max_days + 1) * 86_400,
  );
  const lastUpdate = sheetTimestamp(
    input.last_update,
    "Tanggal Terakhir Update",
    context,
    cold,
  );
  if ("error" in lastUpdate) return lastUpdate;
  const followupsText = input.total_followups.trim();
  const followups = followupsText === "" ? 0 : Number(followupsText);
  if (
    !/^\d*$/.test(followupsText) ||
    !Number.isSafeInteger(followups) ||
    followups > IMPORT_FOLLOWUPS_MAX
  ) {
    return { error: "Jumlah FU must be a whole number from 0 to 10000." };
  }
  const answer = input.pic_answer.trim();
  const room = INTERACTION_NOTES_MAX - [...IMPORT_NOTE_PREFIX].length;
  const answerChars = [...answer];
  return {
    row: {
      line: input.line,
      client_code: code,
      name,
      phone,
      address,
      city,
      province,
      needs_notes: needs,
      channel_option_id: input.channel_option_id.trim(),
      product_category_option_id: input.product_category_option_id.trim(),
      pic_cs_id: input.pic_cs_id,
      created_at: created.value,
      last_client_response_at: lastUpdate.value,
      total_followups: followups,
      interaction_note:
        answer === ""
          ? ""
          : IMPORT_NOTE_PREFIX + answerChars.slice(0, room).join(""),
      note_truncated: answerChars.length > room,
    },
  };
}

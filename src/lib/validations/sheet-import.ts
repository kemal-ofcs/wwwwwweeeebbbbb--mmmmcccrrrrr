/**
 * Impor CSV Data Uang Masuk, Database Formulasi, dan Database Desain (PRD
 * F-22, v2.7, D-40). Uang masuk menjadi `incoming_funds`; formulasi dan
 * desain menjadi arsip hanya-baca `imported_records` di detail klien.
 *
 * Membaca CSV, menebak header, dan menebak urutan tanggal memakai helper
 * impor klien (`client-import.ts`). Bagian di bawah garis "Kembar" WAJIB
 * identik dengan `sheet_import.rs` (vektor sama di `sheet-import.test.ts`
 * dan `mod tests` di sana); backend memanggil `planSheetImport` untuk
 * pratinjau DAN simpan, jadi yang lolos pratinjau adalah yang tersimpan.
 */

import { parseStoredTimestamp, utcTimestamp } from "./client";
import { type DateOrder, parseSheetDate } from "./client-import";
import { FUND_DESCRIPTION_MAX, INVOICE_AMOUNT_MAX } from "./finance";

export const SHEET_KINDS = ["FUNDS", "FORMULA", "DESIGN"] as const;
export type SheetKind = (typeof SHEET_KINDS)[number];

export const ARCHIVE_CODE_MAX = 100;
export const ARCHIVE_TITLE_MAX = 200;
export const ARCHIVE_NOTES_MAX = 1000;

/**
 * Kolom bawaan per sheet; admin membetulkan pemetaannya di layar (OQ-24).
 * `rule` dan `example` hanya untuk tabel kolom dan template (v2.8).
 */
export const SHEET_FIELDS: Record<
  SheetKind,
  readonly {
    key: SheetFieldKey;
    header: string;
    rule: string;
    example: string;
  }[]
> = {
  FUNDS: [
    {
      key: "date",
      header: "Tanggal",
      rule: "Required. The day the money arrived.",
      example: "5/10/2026",
    },
    {
      key: "amount",
      header: "Nominal",
      rule: "Required. Whole rupiah; Rp, dots, and commas are fine.",
      example: "Rp 1.500.000",
    },
    {
      key: "notes",
      header: "Keterangan",
      rule: "Optional, up to 300 characters.",
      example: "Transfer BCA Aura Cosmetics",
    },
    {
      key: "client_code",
      header: "Kode Klien",
      rule: "Optional. Must match a client in the app.",
      example: "KLN-20261005-0101",
    },
  ],
  FORMULA: [
    {
      key: "date",
      header: "Tanggal",
      rule: "Optional.",
      example: "1/9/2026",
    },
    {
      key: "client_code",
      header: "Kode Klien",
      rule: "Required. Must match a client in the app.",
      example: "KLN-20261005-0101",
    },
    {
      key: "code",
      header: "Kode Formula",
      rule: "Optional, up to 100 characters.",
      example: "F-SER-01",
    },
    {
      key: "title",
      header: "Nama Produk",
      rule: "Required, up to 200 characters.",
      example: "Brightening serum",
    },
    {
      key: "amount",
      header: "Harga Jual",
      rule: "Optional. Whole rupiah per unit.",
      example: "32.500",
    },
    {
      key: "notes",
      header: "Catatan",
      rule: "Optional, up to 1000 characters.",
      example: "Niacinamide 5%",
    },
  ],
  DESIGN: [
    {
      key: "date",
      header: "Tanggal",
      rule: "Optional.",
      example: "1/9/2026",
    },
    {
      key: "client_code",
      header: "Kode Klien",
      rule: "Required. Must match a client in the app.",
      example: "KLN-20261005-0101",
    },
    {
      key: "code",
      header: "Kode Desain",
      rule: "Optional, up to 100 characters.",
      example: "D-AURA-01",
    },
    {
      key: "title",
      header: "Brand",
      rule: "Required, up to 200 characters.",
      example: "Aura",
    },
    {
      key: "notes",
      header: "Catatan",
      rule: "Optional, up to 1000 characters.",
      example: "Box 30 ml, matte",
    },
  ],
};
export type SheetFieldKey =
  | "date"
  | "client_code"
  | "code"
  | "title"
  | "amount"
  | "notes";

// ---------------------------------------------------------------------------
// Kembar dengan `sheet_import.rs`
// ---------------------------------------------------------------------------

/** Izin per jenis sheet (keputusan G); `null` = jenis tidak dikenal. */
export function sheetImportPermission(
  kind: string,
): "finance.manage" | "rnd.manage" | "design.manage" | null {
  switch (kind) {
    case "FUNDS":
      return "finance.manage";
    case "FORMULA":
      return "rnd.manage";
    case "DESIGN":
      return "design.manage";
    default:
      return null;
  }
}

export type SheetValue<T> = { value: T } | { empty: true } | { error: string };

/**
 * Nominal rupiah dari sheet: "Rp 1.500.000", "1,500,000", "1500000,00".
 * Titik dan koma dibaca sebagai pemisah ribuan; dua angka terakhir setelah
 * pemisah dibaca sebagai sen dan hanya boleh `00`; akhiran `,-` dibuang.
 */
export function parseSheetAmount(raw: string): SheetValue<number> {
  const text = raw.trim();
  if (text === "") return { empty: true };
  let digits = text
    .replace(/^rp\.?/i, "")
    .replace(/\s/g, "")
    .replace(/[.,]-$/, "");
  const cents = /[.,](\d{2})$/.exec(digits);
  if (cents) {
    if (cents[1] !== "00") {
      return { error: `The amount "${text}" has cents. Use whole rupiah.` };
    }
    digits = digits.slice(0, -3);
  }
  if (!/^\d+$/.test(digits) && !/^\d{1,3}([.,]\d{3})+$/.test(digits)) {
    return { error: `The amount "${text}" could not be read.` };
  }
  digits = digits.replace(/[.,]/g, "").replace(/^0+(?=\d)/, "");
  const value = digits.length > 12 ? Number.POSITIVE_INFINITY : Number(digits);
  if (value < 1 || value > INVOICE_AMOUNT_MAX) {
    return { error: `The amount "${text}" is out of range.` };
  }
  return { value };
}

/** Tanggal sheet → `YYYY-MM-DD` (tanggal saja, jam diabaikan). */
export function parseSheetDay(
  raw: string,
  order: DateOrder,
): SheetValue<string> {
  const parsed = parseSheetDate(raw, order, "Asia/Jakarta");
  if (!("value" in parsed)) return parsed;
  const epoch = parseStoredTimestamp(parsed.value);
  if (epoch === null)
    return { error: `The date "${raw.trim()}" could not be read.` };
  return { value: utcTimestamp(epoch + 7 * 3600).slice(0, 10) };
}

export interface SheetRowInput {
  line: number;
  date: string;
  client_code: string;
  code: string;
  title: string;
  amount: string;
  notes: string;
}

export interface SheetRow {
  line: number;
  /** `YYYY-MM-DD`, atau '' pada arsip tanpa tanggal. */
  date: string;
  client_code: string;
  code: string;
  title: string;
  amount_idr: number | null;
  notes: string;
}

function length(value: string) {
  return [...value].length;
}

/** Baris dari klien tidak dipercaya: selain string dibaca kosong. */
export function sheetRowInput(value: unknown): SheetRowInput {
  const source = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const field = (key: string) =>
    typeof source[key] === "string" ? (source[key] as string) : "";
  return {
    line: Number.isSafeInteger(source.line) ? (source.line as number) : 0,
    date: field("date"),
    client_code: field("client_code"),
    code: field("code"),
    title: field("title"),
    amount: field("amount"),
    notes: field("notes"),
  };
}

/** Aturan satu baris, tanpa melihat database. Pesan memakai header bawaan. */
export function validateSheetRow(
  kind: SheetKind,
  input: SheetRowInput,
  order: DateOrder,
): { row: SheetRow } | { error: string } {
  const funds = kind === "FUNDS";
  const date = parseSheetDay(input.date, order);
  if ("error" in date) return date;
  if (funds && "empty" in date) return { error: "Tanggal is empty." };
  const clientCode = input.client_code.trim();
  if (!funds && clientCode === "") return { error: "Kode Klien is empty." };
  const code = funds ? "" : input.code.trim();
  if (length(code) > ARCHIVE_CODE_MAX) {
    return { error: `The code is longer than ${ARCHIVE_CODE_MAX} characters.` };
  }
  const title = funds ? "" : input.title.trim();
  if (!funds && title === "") {
    return {
      error: kind === "FORMULA" ? "Nama Produk is empty." : "Brand is empty.",
    };
  }
  if (length(title) > ARCHIVE_TITLE_MAX) {
    return {
      error: `The name is longer than ${ARCHIVE_TITLE_MAX} characters.`,
    };
  }
  const amount =
    kind === "DESIGN"
      ? { empty: true as const }
      : parseSheetAmount(input.amount);
  if ("error" in amount) return amount;
  if (funds && "empty" in amount) return { error: "Nominal is empty." };
  const notes = input.notes.trim();
  const notesMax = funds ? FUND_DESCRIPTION_MAX : ARCHIVE_NOTES_MAX;
  if (length(notes) > notesMax) {
    return { error: `The notes are longer than ${notesMax} characters.` };
  }
  return {
    row: {
      line: input.line,
      date: "value" in date ? date.value : "",
      client_code: clientCode,
      code,
      title,
      amount_idr: "value" in amount ? amount.value : null,
      notes,
    },
  };
}

/**
 * Kunci "sudah ada" (keputusan E): uang masuk per (tanggal, nominal,
 * keterangan), arsip per (jenis, klien, kode, judul, tanggal); tanpa
 * membedakan huruf besar-kecil.
 */
export function sheetRowKey(
  kind: SheetKind,
  row: {
    client_id: string;
    date: string;
    code: string;
    title: string;
    amount_idr: number | null;
    notes: string;
  },
): string {
  const fold = (value: string) => value.trim().toLowerCase();
  return kind === "FUNDS"
    ? `FUNDS|${row.date}|${row.amount_idr ?? ""}|${fold(row.notes)}`
    : `${kind}|${row.client_id}|${fold(row.code)}|${fold(row.title)}|${row.date}`;
}

export interface SheetPlanContext {
  date_order: DateOrder;
  /** Kode klien huruf kecil → id. */
  clients: ReadonlyMap<string, string>;
  /** Kunci `sheetRowKey` yang sudah ada di database. */
  existing: ReadonlySet<string>;
}

export interface SheetResult {
  line: number;
  status: "skipped" | "invalid";
  message: string;
}

export interface SheetPlan {
  valid: (SheetRow & { client_id: string })[];
  results: SheetResult[];
}

/**
 * Pemeriksaan seluruh berkas. Duplikat di DALAM berkas sengaja tidak
 * dilewati: dua mutasi sama di hari yang sama bisa sah, dan impor ulang
 * tetap menambah nol karena keduanya sudah ada.
 */
export function planSheetImport(
  kind: SheetKind,
  rows: readonly SheetRowInput[],
  context: SheetPlanContext,
): SheetPlan {
  const plan: SheetPlan = { valid: [], results: [] };
  for (const input of rows) {
    const checked = validateSheetRow(kind, input, context.date_order);
    if ("error" in checked) {
      plan.results.push({
        line: input.line,
        status: "invalid",
        message: checked.error,
      });
      continue;
    }
    const row = checked.row;
    let clientId = "";
    if (row.client_code !== "") {
      const found = context.clients.get(row.client_code.toLowerCase());
      if (found === undefined) {
        plan.results.push({
          line: row.line,
          status: "invalid",
          message: `Kode Klien ${row.client_code} is not registered.`,
        });
        continue;
      }
      clientId = found;
    }
    if (
      context.existing.has(sheetRowKey(kind, { ...row, client_id: clientId }))
    ) {
      plan.results.push({
        line: row.line,
        status: "skipped",
        message: "Already in the app.",
      });
      continue;
    }
    plan.valid.push({ ...row, client_id: clientId });
  }
  return plan;
}

export const SHEET_CLIENTS_SQL = "SELECT client_code, id FROM clients;";

export const SHEET_FUND_KEYS_SQL =
  "SELECT received_on, amount_idr, description FROM incoming_funds;";

export const SHEET_ARCHIVE_KEYS_SQL =
  "SELECT kind, client_id, code, title, record_date FROM imported_records;";

/** ?1 id, ?2 jenis, ?3 klien, ?4 tanggal, ?5 kode, ?6 judul, ?7 harga, ?8 catatan, ?9 berkas, ?10 pengimpor, ?11 waktu. */
export const IMPORTED_RECORD_INSERT_SQL =
  "INSERT INTO imported_records (id, kind, client_id, record_date, code, title, amount_idr, notes, source_file, imported_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT(id) DO NOTHING;";

export const IMPORTED_RECORD_LIST_SQL =
  "SELECT id, kind, client_id, record_date, code, title, amount_idr, notes, source_file, created_at FROM imported_records WHERE client_id = ?1 ORDER BY record_date DESC, created_at DESC, rowid DESC;";

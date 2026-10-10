/**
 * Tagihan, uang masuk, dan alokasinya (PRD F-17, v2.3a; D-28 s/d D-30).
 *
 * WAJIB identik dengan `src-tauri/src/desktop/finance.rs`. Kedua sisi diuji
 * dengan vektor yang sama (`finance.test.ts` dan `mod tests` di sana), dan
 * setiap konstanta SQL di bawah dites ada per karakter di Rust: tagihan yang
 * sama dihitung dan diperiksa Web, perangkat, dan cloud.
 */

import { timezoneOffsetHours, utcTimestamp } from "./client";
import { formatRupiah, isCalendarDate } from "./sample";

// ---------------------------------------------------------------------------
// Daftar pajak, diskon (D-28), dan paket cicilan (D-29, v2.3b).
// ---------------------------------------------------------------------------

export const FINANCE_OPTION_KINDS = [
  "TAX",
  "DISCOUNT",
  "INSTALLMENT_PLAN",
] as const;
export type FinanceOptionKind = (typeof FINANCE_OPTION_KINDS)[number];
export const FINANCE_LABEL_MAX = 80;
/** 10000 basis poin = 100%. */
export const RATE_BP_MAX = 10_000;
/** Paket cicilan paling lama 24 bulan (keputusan C v2.3b). */
export const INSTALLMENT_COUNT_MAX = 24;

export interface FinanceOption {
  kind: FinanceOptionKind;
  label: string;
  /** Pajak/diskon: tarif. Paket cicilan: bunga sekali atas sisa (boleh 0). */
  rate_bp: number;
  /** Hanya paket cicilan: jumlah cicilan bulanan; selain itu null. */
  installment_count: number | null;
  is_active: boolean;
}

function text(raw: Record<string, unknown>, key: string) {
  const value = raw[key];
  return typeof value === "string" ? value.trim() : "";
}

function length(value: string) {
  return [...value].length;
}

/** Bilangan bulat JSON saja; teks angka dari form ditolak, bukan ditebak. */
function strictInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Pesan identik dengan `validate_finance_option`. */
export function validateFinanceOption(
  input: unknown,
): { option: FinanceOption } | { error: string } {
  const raw = record(input);
  const kind = text(raw, "kind");
  if (!(FINANCE_OPTION_KINDS as readonly string[]).includes(kind)) {
    return { error: "Unknown finance option type." };
  }
  const label = text(raw, "label");
  if (!label || length(label) > FINANCE_LABEL_MAX) {
    return { error: "The name must be 1-80 characters." };
  }
  const rate = strictInt(raw.rate_bp);
  if (rate === null || rate < 0 || rate > RATE_BP_MAX) {
    return { error: "The rate must be from 0% to 100%." };
  }
  let installments: number | null = null;
  if (kind === "INSTALLMENT_PLAN") {
    installments = strictInt(raw.installment_count);
    if (
      installments === null ||
      installments < 1 ||
      installments > INSTALLMENT_COUNT_MAX
    ) {
      return { error: "Choose 1-24 monthly installments." };
    }
  }
  const active = raw.is_active;
  if (active !== undefined && typeof active !== "boolean") {
    return { error: "Choose whether the option is active." };
  }
  return {
    option: {
      kind: kind as FinanceOptionKind,
      label,
      rate_bp: rate,
      installment_count: installments,
      is_active: active !== false,
    },
  };
}

// ---------------------------------------------------------------------------
// Hitungan tagihan (keputusan E): diskon dipotong sebelum pajak, pajak dari
// subtotal setelah diskon, setiap nominal dibulatkan ke rupiah terdekat.
// ---------------------------------------------------------------------------

/** Batas nominal: hasil kali dengan 10000 basis poin tetap di bawah 2^53. */
export const INVOICE_AMOUNT_MAX = 100_000_000_000;
export const INVOICE_TAXES_MAX = 10;

export interface RateLine {
  label: string;
  rate_bp: number;
}

export interface InvoiceTotals {
  subtotal_idr: number;
  discount_label: string;
  discount_bp: number;
  discount_idr: number;
  /** JSON tetap `[{"amount_idr":..,"label":..,"rate_bp":..}]`, kunci urut abjad. */
  taxes_json: string;
  tax_idr: number;
  total_idr: number;
}

/** Nominal × basis poin, dibulatkan ke rupiah terdekat (setengah ke atas). */
export function applyRate(amount: number, rateBp: number): number {
  return Math.floor((amount * rateBp + 5000) / 10_000);
}

function rateLine(value: unknown): RateLine | null {
  const raw = record(value);
  const label = text(raw, "label");
  const rate = strictInt(raw.rate_bp);
  return label &&
    length(label) <= FINANCE_LABEL_MAX &&
    rate !== null &&
    rate >= 0 &&
    rate <= RATE_BP_MAX
    ? { label, rate_bp: rate }
    : null;
}

/**
 * `discount` = `{ label, rate_bp }` atau null; `taxes` = daftar yang sama.
 * Tarifnya salinan dari `finance_options` saat tagihan dibuat, jadi mengubah
 * setelan tidak mengubah tagihan lama. Padanan `compute_invoice`.
 */
export function computeInvoice(
  input: unknown,
): { totals: InvoiceTotals } | { error: string } {
  const raw = record(input);
  const subtotal = strictInt(raw.subtotal_idr);
  if (subtotal === null || subtotal < 1 || subtotal > INVOICE_AMOUNT_MAX) {
    return { error: "Enter the amount in whole rupiah." };
  }
  let discount: RateLine | null = null;
  if (raw.discount !== null && raw.discount !== undefined) {
    discount = rateLine(raw.discount);
    if (!discount) return { error: "The discount is invalid." };
  }
  const rawTaxes = Array.isArray(raw.taxes) ? raw.taxes : [];
  if (!Array.isArray(raw.taxes) && raw.taxes !== undefined) {
    return { error: "A tax is invalid." };
  }
  if (rawTaxes.length > INVOICE_TAXES_MAX) {
    return { error: "An invoice can carry at most 10 taxes." };
  }
  const taxes: RateLine[] = [];
  for (const value of rawTaxes) {
    const line = rateLine(value);
    if (!line) return { error: "A tax is invalid." };
    taxes.push(line);
  }
  const discountIdr = discount ? applyRate(subtotal, discount.rate_bp) : 0;
  const taxable = subtotal - discountIdr;
  const taxLines = taxes.map((tax) => ({
    amount_idr: applyRate(taxable, tax.rate_bp),
    label: tax.label,
    rate_bp: tax.rate_bp,
  }));
  const taxIdr = taxLines.reduce((sum, line) => sum + line.amount_idr, 0);
  return {
    totals: {
      subtotal_idr: subtotal,
      discount_label: discount?.label ?? "",
      discount_bp: discount?.rate_bp ?? 0,
      discount_idr: discountIdr,
      taxes_json: JSON.stringify(taxLines),
      tax_idr: taxIdr,
      total_idr: taxable + taxIdr,
    },
  };
}

// ---------------------------------------------------------------------------
// Jenis tagihan dan tiketnya (keputusan B, C, I).
// ---------------------------------------------------------------------------

export const INVOICE_REF_TYPES = [
  "SAMPLE_FEE",
  "REVISION_FEE",
  "TEST_FEE",
  // Cetak dummy kemasan (v2.4, PRD F-19); `revision_index` = putaran dummy.
  "DUMMY_FEE",
  // DP Produksi & Legal dari MoU yang disetujui klien (v2.5a, PRD F-20).
  "DP_PRODUCTION_LEGAL",
  // Pelunasan, ongkir, dan biaya titip (v3.3, PRD F-26/F-31, D-46).
  "SETTLEMENT",
  "SHIPPING",
  "STORAGE_FEE",
  "OTHER",
] as const;
export type InvoiceRefType = (typeof INVOICE_REF_TYPES)[number];
export const INVOICE_DESCRIPTION_MAX = 300;

export interface InvoiceTicket {
  is_paid_sample: boolean;
  is_test_requested: boolean;
  revision_fee_idr: number | null;
  /** Putaran dummy tiket desain aktif (`dummy_round`); null = tanpa tiket desain. */
  dummy_round: number | null;
  /** MoU aktif tiket itu sudah disetujui klien (v2.5a). */
  mou_accepted: boolean;
  /** Work order tiket itu sudah selesai Packing (v3.3). */
  batch_packed: boolean;
  /** Tagihan pelunasan ada dan lunas seluruhnya, termasuk cicilannya. */
  settlement_cleared: boolean;
  /** Biaya titip berjalan (`storageFeeDue`); 0 = tidak ada. */
  storage_fee_idr: number;
}

/**
 * Jenis tagihan yang sah untuk tiket itu; `null` = sah. Tagihan `OTHER`
 * boleh tanpa tiket. Duplikat diperiksa pemanggil (`INVOICE_DUPLICATE_SQL`).
 */
export function invoiceTypeError(
  refType: string,
  ticket: InvoiceTicket | null,
): string | null {
  if (!(INVOICE_REF_TYPES as readonly string[]).includes(refType)) {
    return "Choose what the invoice is for.";
  }
  if (refType === "OTHER") return null;
  if (!ticket) return "Choose the sample request this invoice is for.";
  if (refType === "SAMPLE_FEE" && !ticket.is_paid_sample) {
    return "This sample is free, so it has no sample fee.";
  }
  if (refType === "TEST_FEE" && !ticket.is_test_requested) {
    return "This sample was not requested with testing.";
  }
  if (
    refType === "REVISION_FEE" &&
    (ticket.revision_fee_idr === null || ticket.revision_fee_idr < 1)
  ) {
    return "Finance has not set a fee for this revision.";
  }
  if (refType === "DUMMY_FEE" && ticket.dummy_round === null) {
    return "Request a design for this sample first.";
  }
  if (refType === "DP_PRODUCTION_LEGAL" && !ticket.mou_accepted) {
    return "The client has not accepted the MoU yet.";
  }
  if (
    (refType === "SETTLEMENT" || refType === "SHIPPING") &&
    !ticket.batch_packed
  ) {
    return "Production is not packed yet.";
  }
  if (refType === "STORAGE_FEE") {
    if (!ticket.settlement_cleared)
      return "The settlement invoice is not paid yet.";
    if (ticket.storage_fee_idr < 1)
      return "There is no storage fee for this order.";
  }
  return null;
}

/**
 * `revision_index` tagihan: iterasi revisi untuk tarif revisi, putaran dummy
 * untuk tagihan dummy, 0 untuk lainnya. Padanan `invoice_revision_index`.
 */
export function invoiceRevisionIndex(
  refType: string,
  revisionIndex: number,
  dummyRound: number | null,
) {
  if (refType === "REVISION_FEE") return revisionIndex;
  return refType === "DUMMY_FEE" ? (dummyRound ?? 0) : 0;
}

export const INVOICE_DUPLICATE =
  "This sample already has an open invoice of this type.";

// ---------------------------------------------------------------------------
// Pembayaran sebagian dan cicilan (D-29, v2.3b). Sisa tagihan dijadwal ulang
// menjadi tagihan `INSTALLMENT`; tagihan asal menjadi `RESCHEDULED`.
// ---------------------------------------------------------------------------

export const INSTALLMENT_REF_TYPE = "INSTALLMENT";

export interface InstallmentLine {
  installment_no: number;
  amount_idr: number;
  due_on: string;
}

/**
 * `YYYY-MM-DD` + `months` bulan kalender; tanggal yang tidak ada di bulan
 * tujuan jatuh ke akhir bulan (31 Jan + 1 = 28/29 Feb). Padanan `add_months`.
 */
export function addMonths(date: string, months: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  const leap =
    (targetYear % 4 === 0 && targetYear % 100 !== 0) || targetYear % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const lastDay = days[targetMonth - 1] ?? 31;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, lastDay))}`;
}

/**
 * Bunga sekali atas sisa (dibulatkan ke rupiah terdekat), lalu dibagi rata
 * per bulan; sisa pembulatan masuk cicilan terakhir. Jatuh tempo cicilan ke-k
 * = `startOn` + k bulan. Padanan `compute_installments`.
 */
export function computeInstallments(
  remainingIdr: number,
  rateBp: number,
  count: number,
  startOn: string,
): { interest_idr: number; total_idr: number; lines: InstallmentLine[] } {
  const interest = applyRate(remainingIdr, rateBp);
  const total = remainingIdr + interest;
  const share = Math.floor(total / count);
  const lines: InstallmentLine[] = [];
  for (let no = 1; no <= count; no += 1) {
    lines.push({
      installment_no: no,
      amount_idr: no === count ? total - share * (count - 1) : share,
      due_on: addMonths(startOn, no),
    });
  }
  return { interest_idr: interest, total_idr: total, lines };
}

/** Nomor dan keterangan tagihan cicilan (keputusan F). Padanan Rust sama. */
export function installmentNumber(parentNumber: string, no: number) {
  return `${parentNumber}-${no}`;
}

export function installmentDescription(
  no: number,
  count: number,
  parentNumber: string,
  planLabel: string,
) {
  return `Installment ${no} of ${count} for ${parentNumber} (${planLabel})`;
}

/**
 * Pembayaran sebagian: nominal lebih kecil dari sisa tagihan dan tidak lebih
 * dari sisa uang masuk; tagihan cicilan tidak dijadwal ulang lagi (keputusan
 * H). `null` = sah. Padanan `partial_payment_error`.
 */
export function partialPaymentError(
  amount: unknown,
  refType: string,
  invoiceRemaining: number,
  fundUnallocated: number,
): string | null {
  if (refType === INSTALLMENT_REF_TYPE) {
    return "An installment cannot be rescheduled again. Cancel it and create a new invoice instead.";
  }
  const value = strictInt(amount);
  if (value === null || value < 1) return "Enter the amount in whole rupiah.";
  if (value >= invoiceRemaining) {
    return `A partial payment must be less than the unpaid ${formatRupiah(invoiceRemaining)}. Use Allocate for a full payment.`;
  }
  if (value > fundUnallocated) {
    return `This incoming payment only has ${formatRupiah(fundUnallocated)} left to allocate.`;
  }
  return null;
}

/** Deposit dari lebih bayar (keputusan I). `null` = sah. */
export function depositError(
  fundStatus: unknown,
  confirmedAt: unknown,
  clientId: string,
  unallocated: number,
): string | null {
  if (fundStatus !== "ACTIVE") {
    return "This incoming payment is void or does not exist.";
  }
  if (typeof confirmedAt === "string" && confirmedAt !== "") {
    return "This payment is already kept as a deposit.";
  }
  if (!clientId) return "Choose the client this deposit belongs to.";
  if (unallocated < 1) {
    return "Nothing is left on this payment to keep as a deposit.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Alokasi uang masuk (keputusan G): v2.3a hanya pelunasan penuh (E-26).
// ---------------------------------------------------------------------------

export const FUND_DESCRIPTION_MAX = 300;
export const CANCEL_REASON_MAX = 300;

export interface FundDraft {
  received_on: string;
  amount_idr: number;
  /** '' = mutasi yang belum diketahui pemiliknya (keputusan F). */
  client_id: string;
  description: string;
}

/**
 * Isian uang masuk. Keberadaan klien diperiksa pemanggil; foto bukti
 * diperiksa `validateMediaUpload`. Padanan `validate_fund_draft`.
 */
export function validateFundDraft(
  input: unknown,
): { fund: FundDraft } | { error: string } {
  const raw = record(input);
  const receivedOn = text(raw, "received_on");
  if (!isCalendarDate(receivedOn)) {
    return { error: "Enter the date the money arrived." };
  }
  const amount = strictInt(raw.amount_idr);
  if (amount === null || amount < 1 || amount > INVOICE_AMOUNT_MAX) {
    return { error: "Enter the amount in whole rupiah." };
  }
  const description = text(raw, "description");
  if (length(description) > FUND_DESCRIPTION_MAX) {
    return { error: "The description is up to 300 characters." };
  }
  return {
    fund: {
      received_on: receivedOn,
      amount_idr: amount,
      client_id: text(raw, "client_id"),
      description,
    },
  };
}

/** `null` = sah. Padanan `allocation_error`; pesan identik. */
export function allocationError(
  amount: unknown,
  invoiceRemaining: number,
  fundUnallocated: number,
): string | null {
  const value = strictInt(amount);
  if (value === null || value < 1) return "Enter the amount in whole rupiah.";
  if (invoiceRemaining < 1) return "This invoice is already paid.";
  if (value !== invoiceRemaining) {
    return `The amount must equal the unpaid ${formatRupiah(invoiceRemaining)} of this invoice (difference ${formatRupiah(value - invoiceRemaining)}).`;
  }
  if (value > fundUnallocated) {
    return `This incoming payment only has ${formatRupiah(fundUnallocated)} left to allocate.`;
  }
  return null;
}

/**
 * Baris `ALLOCATION_STATE_SQL` + nominal → pesan, atau `null` bila sah.
 * Padanan `allocation_check` (dipakai Web, perangkat, dan guard cloud).
 */
export function allocationCheck(
  stateRow: Record<string, unknown> | undefined,
  amount: unknown,
): string | null {
  if (stateRow?.invoice_status !== "OPEN") {
    return "This invoice is cancelled or does not exist.";
  }
  if (stateRow.fund_status !== "ACTIVE") {
    return "This incoming payment is void or does not exist.";
  }
  return allocationError(
    amount,
    Number(stateRow.invoice_remaining ?? 0),
    Number(stateRow.fund_unallocated ?? 0),
  );
}

/** Alasan wajib saat membatalkan tagihan atau uang masuk (keputusan N). */
export function normalizeCancelReason(value: unknown): string | null {
  const reason = typeof value === "string" ? value.trim() : "";
  return reason && length(reason) <= CANCEL_REASON_MAX ? reason : null;
}

export const CANCEL_REASON_INVALID = "Give a reason, up to 300 characters.";

// ---------------------------------------------------------------------------
// Tanggal dan nomor tagihan (keputusan J, L).
// ---------------------------------------------------------------------------

export const INVOICE_NUMBER_PREFIX = "INV";

/**
 * Tanggal terbit dan jatuh tempo (`YYYY-MM-DD`) menurut zona perusahaan, dari
 * epoch database/perangkat. Padanan `invoice_dates`.
 */
export function invoiceDates(
  epochSeconds: number,
  timezone: string,
  dueDays: number,
): { issued_on: string; due_on: string } {
  const local = epochSeconds + timezoneOffsetHours(timezone) * 3600;
  return {
    issued_on: utcTimestamp(local).slice(0, 10),
    due_on: utcTimestamp(local + dueDays * 86_400).slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// SQL. Setiap konstanta WAJIB identik dengan padanannya di `finance.rs`.
// ---------------------------------------------------------------------------

/** `kind` tidak pernah berubah setelah dibuat. ?1 id ... ?7 waktu, ?8 cicilan. */
export const FINANCE_OPTION_UPSERT_SQL =
  "INSERT INTO finance_options (id, kind, label, rate_bp, is_active, sort_order, updated_at, installment_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(id) DO UPDATE SET label = excluded.label, rate_bp = excluded.rate_bp, is_active = excluded.is_active, sort_order = excluded.sort_order, updated_at = excluded.updated_at, installment_count = excluded.installment_count;";

export const FINANCE_OPTIONS_SQL =
  "SELECT id, kind, label, rate_bp, installment_count, is_active, sort_order, updated_at FROM finance_options ORDER BY kind, sort_order, label;";

/**
 * ?1 id, ?2 nomor, ?3 klien, ?4 tiket ('' = tanpa tiket), ?5 jenis, ?6 revisi,
 * ?7 keterangan, ?8 subtotal, ?9 nama diskon, ?10 diskon bp, ?11 diskon,
 * ?12 pajak JSON, ?13 pajak, ?14 total, ?15 terbit, ?16 jatuh tempo,
 * ?17 pembuat, ?18 waktu.
 */
export const INVOICE_INSERT_SQL =
  "INSERT INTO invoices (id, invoice_number, client_id, sample_request_id, ref_type, revision_index, description, subtotal_idr, discount_label, discount_bp, discount_idr, taxes_json, tax_idr, total_idr, issued_on, due_on, status, cancel_reason, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 'OPEN', '', ?17, ?18, ?18) ON CONFLICT(id) DO NOTHING;";

/** Hanya selama belum ada alokasi (keputusan N). ?1 id, ?2 alasan, ?3 waktu. */
export const INVOICE_CANCEL_SQL =
  "UPDATE invoices SET status = 'CANCELLED', cancel_reason = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'OPEN' AND NOT EXISTS (SELECT 1 FROM fund_allocations a WHERE a.invoice_id = ?1);";

/** Tagihan terbuka lain dengan jenis dan revisi yang sama untuk satu tiket. */
export const INVOICE_DUPLICATE_SQL =
  "SELECT COUNT(*) AS total FROM invoices WHERE sample_request_id = ?1 AND ref_type = ?2 AND revision_index = ?3 AND status IN ('OPEN', 'RESCHEDULED') AND id <> ?4;";

/**
 * Tagihan cicilan (v2.3b). ?1 id, ?2 nomor, ?3 klien, ?4 tiket, ?5 revisi,
 * ?6 keterangan, ?7 nominal, ?8 terbit, ?9 jatuh tempo, ?10 tagihan asal,
 * ?11 urutan cicilan, ?12 pembuat, ?13 waktu.
 */
export const INSTALLMENT_INSERT_SQL =
  "INSERT INTO invoices (id, invoice_number, client_id, sample_request_id, ref_type, revision_index, description, subtotal_idr, discount_label, discount_bp, discount_idr, taxes_json, tax_idr, total_idr, issued_on, due_on, status, cancel_reason, created_by, created_at, updated_at, parent_invoice_id, installment_no) VALUES (?1, ?2, ?3, ?4, 'INSTALLMENT', ?5, ?6, ?7, '', 0, 0, '[]', 0, ?7, ?8, ?9, 'OPEN', '', ?12, ?13, ?13, ?10, ?11) ON CONFLICT(id) DO NOTHING;";

/** Tagihan asal yang sisanya dijadwal ulang. ?1 id, ?2 waktu. */
export const INVOICE_RESCHEDULE_SQL =
  "UPDATE invoices SET status = 'RESCHEDULED', updated_at = ?2 WHERE id = ?1 AND status = 'OPEN';";

/** Tagihan untuk pembayaran sebagian, dibaca perangkat, Web, dan guard cloud. */
export const RESCHEDULE_STATE_SQL =
  "SELECT i.invoice_number, i.client_id, i.sample_request_id, i.revision_index, i.ref_type, i.status, i.total_idr - (SELECT COALESCE(SUM(amount_idr), 0) FROM fund_allocations WHERE invoice_id = i.id) AS invoice_remaining, (SELECT status FROM incoming_funds WHERE id = ?2) AS fund_status, (SELECT amount_idr - (SELECT COALESCE(SUM(amount_idr), 0) FROM fund_allocations WHERE fund_id = ?2) FROM incoming_funds WHERE id = ?2) AS fund_unallocated FROM invoices i WHERE i.id = ?1;";

export const INVOICE_LIST_SQL =
  "SELECT i.*, c.client_code, c.name AS client_name, c.address AS client_address, c.city AS client_city, c.province AS client_province, s.brand_name, (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) AS paid_idr FROM invoices i LEFT JOIN clients c ON c.id = i.client_id LEFT JOIN sample_requests s ON s.id = i.sample_request_id";

/**
 * ?1 id, ?2 klien ('' = belum diketahui), ?3 tanggal terima, ?4 nominal,
 * ?5 keterangan, ?6 foto bukti ('' = tanpa), ?7 pencatat, ?8 waktu.
 */
export const FUND_INSERT_SQL =
  "INSERT INTO incoming_funds (id, client_id, received_on, amount_idr, description, proof_media_id, status, void_reason, recorded_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ACTIVE', '', ?7, ?8, ?8) ON CONFLICT(id) DO NOTHING;";

export const FUND_VOID_SQL =
  "UPDATE incoming_funds SET status = 'VOID', void_reason = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM fund_allocations a WHERE a.fund_id = ?1);";

/**
 * Sisa uang masuk disimpan sebagai deposit klien (keputusan I). ?1 id,
 * ?2 klien, ?3 penyetuju, ?4 waktu.
 */
export const FUND_DEPOSIT_SQL =
  "UPDATE incoming_funds SET client_id = ?2, deposit_confirmed_by = ?3, deposit_confirmed_at = ?4, updated_at = ?4 WHERE id = ?1 AND status = 'ACTIVE' AND deposit_confirmed_at = '' AND (client_id = '' OR client_id = ?2);";

export const FUND_DEPOSIT_STATE_SQL =
  "SELECT status, client_id, deposit_confirmed_at, amount_idr - (SELECT COALESCE(SUM(amount_idr), 0) FROM fund_allocations WHERE fund_id = ?1) AS unallocated FROM incoming_funds WHERE id = ?1;";

export const FUND_LIST_SQL =
  "SELECT f.*, c.client_code, c.name AS client_name, (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.fund_id = f.id) AS allocated_idr FROM incoming_funds f LEFT JOIN clients c ON c.id = f.client_id";

/** Foto bukti transfer milik satu uang masuk (keputusan F). */
export const FUND_MEDIA_INSERT_SQL =
  "INSERT INTO media_asset (id, owner_type, owner_id, purpose, mime, byte_size, data_base64, created_by, created_at) VALUES (?1, 'fund', ?2, 'PAYMENT_PROOF', 'image/webp', ?3, ?4, ?5, ?6) ON CONFLICT(id) DO NOTHING;";

/** ?1 id, ?2 uang masuk, ?3 tagihan, ?4 nominal, ?5 pencatat, ?6 waktu. */
export const ALLOCATION_INSERT_SQL =
  "INSERT INTO fund_allocations (id, fund_id, invoice_id, amount_idr, recorded_by, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id) DO NOTHING;";

export const ALLOCATION_LIST_SQL =
  "SELECT a.*, i.invoice_number, o.nama_operator AS recorded_by_name FROM fund_allocations a LEFT JOIN invoices i ON i.id = a.invoice_id LEFT JOIN master_operator o ON o.id = a.recorded_by ORDER BY a.recorded_at DESC, a.id;";

/**
 * Sisa tagihan dan sisa uang masuk, dibaca dalam satu query di perangkat,
 * Web, dan guard cloud. ?1 tagihan, ?2 uang masuk.
 */
export const ALLOCATION_STATE_SQL =
  "SELECT (SELECT status FROM invoices WHERE id = ?1) AS invoice_status, (SELECT total_idr - (SELECT COALESCE(SUM(amount_idr), 0) FROM fund_allocations WHERE invoice_id = ?1) FROM invoices WHERE id = ?1) AS invoice_remaining, (SELECT status FROM incoming_funds WHERE id = ?2) AS fund_status, (SELECT amount_idr - (SELECT COALESCE(SUM(amount_idr), 0) FROM fund_allocations WHERE fund_id = ?2) FROM incoming_funds WHERE id = ?2) AS fund_unallocated;";

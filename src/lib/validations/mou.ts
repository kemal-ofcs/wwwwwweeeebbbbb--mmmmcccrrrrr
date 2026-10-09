/**
 * MoU produksi, lead time, persen DP, dan jalur regulasi (PRD F-20, v2.5a,
 * D-37). Satu MoU aktif per tiket sampel yang sudah disetujui klien;
 * langkahnya ditulis ke `sample_status_log` sehingga tampil di linimasa
 * tiket sampel yang sama.
 *
 * WAJIB identik dengan `src-tauri/src/desktop/mou.rs`. Kedua sisi diuji
 * dengan vektor yang sama (`mou.test.ts` dan `mod tests` di sana), dan setiap
 * konstanta SQL di bawah dites ada per karakter di Rust.
 */

import { applyRate, INVOICE_AMOUNT_MAX } from "./finance";
import { DP_PERCENTAGE_INVALID } from "./sample";

export const MOU_STATUSES = [
  "DRAFT",
  "SENT",
  "ACCEPTED",
  "REJECTED",
  "CANCELLED",
] as const;
export type MouStatus = (typeof MOU_STATUSES)[number];

export const MOU_ACTIONS = [
  "SEND_MOU",
  "MOU_ACCEPT",
  "MOU_REVISE",
  "MOU_REJECT",
  "CANCEL_MOU",
] as const;
export type MouAction = (typeof MOU_ACTIONS)[number];

/** Aksi linimasa saat MoU dibuat (bukan langkah `applyMouAction`). */
export const MOU_CREATE_ACTION = "CREATE_MOU";
export const MOU_NUMBER_PREFIX = "MOU";

export const REGULATORY_PATHS = ["WHITE_LABEL", "WITH_BPOM"] as const;
export type RegulatoryPath = (typeof REGULATORY_PATHS)[number];

export const MOU_UNITS_MAX = 10_000_000;
export const MOU_LEAD_TIME_MAX_DAYS = 365;
export const MOU_NOTES_MAX = 1000;

export interface MouTerms {
  total_units: number;
  unit_price_idr: number;
  total_production_cost_idr: number;
  production_lead_time_days: number;
  regulatory_path: RegulatoryPath;
  dp_bp: number;
  dp_amount_required_idr: number;
  notes: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Bilangan bulat JSON saja; teks angka dari form ditolak, bukan ditebak. */
function strictInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

export const MOU_VALUE_TOO_LARGE = "The contract value is too large.";

/**
 * Isi MoU: unit, harga satuan sebelum pajak (D-28), lead time produksi,
 * jalur regulasi, dan persen DP. Total dan DP SELALU dihitung di sini, tidak
 * dipercaya dari payload. Padanan `validate_mou_terms`.
 */
export function validateMouTerms(
  input: unknown,
): { terms: MouTerms } | { error: string } {
  const raw = record(input);
  const units = strictInt(raw.total_units);
  if (units === null || units < 1 || units > MOU_UNITS_MAX) {
    return { error: "Enter the number of units (1 to 10,000,000)." };
  }
  const price = strictInt(raw.unit_price_idr);
  if (price === null || price < 1 || price > INVOICE_AMOUNT_MAX) {
    return { error: "Enter the unit price in whole rupiah." };
  }
  // Dibandingkan sebelum dikali supaya tidak melewati bilangan bulat aman.
  if (price > Math.floor(INVOICE_AMOUNT_MAX / units)) {
    return { error: MOU_VALUE_TOO_LARGE };
  }
  const lead = strictInt(raw.production_lead_time_days);
  if (lead === null || lead < 1 || lead > MOU_LEAD_TIME_MAX_DAYS) {
    return { error: "Enter the production lead time in days (1-365)." };
  }
  const path = raw.regulatory_path;
  if (
    typeof path !== "string" ||
    !(REGULATORY_PATHS as readonly string[]).includes(path)
  ) {
    return { error: "Choose White Label or With BPOM." };
  }
  const dp = strictInt(raw.dp_bp);
  if (dp === null || dp < 1 || dp > 10_000) {
    return { error: DP_PERCENTAGE_INVALID };
  }
  const notes =
    raw.notes === undefined || raw.notes === null
      ? ""
      : typeof raw.notes === "string"
        ? raw.notes.trim()
        : null;
  if (notes === null || [...notes].length > MOU_NOTES_MAX) {
    return { error: "Notes are up to 1000 characters." };
  }
  const total = units * price;
  return {
    terms: {
      total_units: units,
      unit_price_idr: price,
      total_production_cost_idr: total,
      production_lead_time_days: lead,
      regulatory_path: path as RegulatoryPath,
      dp_bp: dp,
      dp_amount_required_idr: applyRate(total, dp),
      notes,
    },
  };
}

/** `null` = MoU boleh dibuat untuk tiket itu (keputusan C). Padanan `mou_request_error`. */
export function mouRequestError(
  sampleStatus: string,
  activeMous: number,
): string | null {
  if (sampleStatus !== "CLIENT_ACC") {
    return "The client has not approved the sample yet.";
  }
  return activeMous > 0 ? "This sample request already has a MoU." : null;
}

export interface MouState {
  status: string;
  /** Tiket tidak meminta dummy, atau dummy sudah di-ACC (E-20). */
  dummy_ready: boolean;
}

export const MOU_DUMMY_PENDING =
  "The client has not approved the packaging dummy yet.";

/** Satu langkah MoU (keputusan E). Padanan `apply_mou_action`. */
export function applyMouAction(
  state: MouState,
  action: string,
): { result: { status: MouStatus } } | { error: string } {
  const from = (allowed: MouStatus[], to: MouStatus) =>
    (allowed as string[]).includes(state.status)
      ? { result: { status: to } }
      : { error: "This step is not available for the MoU's current status." };
  switch (action) {
    case "SEND_MOU": {
      const step = from(["DRAFT"], "SENT");
      if ("error" in step) return step;
      return state.dummy_ready ? step : { error: MOU_DUMMY_PENDING };
    }
    case "MOU_ACCEPT":
      return from(["SENT"], "ACCEPTED");
    case "MOU_REVISE":
      return from(["SENT"], "DRAFT");
    case "MOU_REJECT":
      return from(["SENT"], "REJECTED");
    case "CANCEL_MOU":
      return from(["DRAFT", "SENT"], "CANCELLED");
    default:
      return { error: "This MoU step does not exist." };
  }
}

export const MOU_NOT_EDITABLE = "Only a draft MoU can be changed.";
export const MOU_CHANGED_ELSEWHERE =
  "This MoU was changed on another device first. Open it again to see the latest version.";

// ---------------------------------------------------------------------------
// SQL. Setiap konstanta WAJIB identik dengan padanannya di `mou.rs`.
// ---------------------------------------------------------------------------

/**
 * MoU beserta tiket sampel, klien, dan dua penanda: `dummy_ready` (E-20) dan
 * `dp_cleared` = tagihan `DP_PRODUCTION_LEGAL` tiket itu lunas atau sisanya
 * dijadwal ulang (keputusan F; gerbang F-21 memakainya). Pemanggil menambah
 * `WHERE` dan `ORDER BY`.
 */
export const MOU_LIST_SQL =
  "SELECT m.*, s.brand_name, s.is_dummy_required, c.client_code, c.name AS client_name, c.address AS client_address, c.city AS client_city, c.province AS client_province, (s.is_dummy_required = 0 OR EXISTS (SELECT 1 FROM design_tickets d WHERE d.sample_request_id = m.sample_request_id AND d.status = 'DUMMY_ACC')) AS dummy_ready, EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = m.sample_request_id AND i.ref_type = 'DP_PRODUCTION_LEGAL' AND i.status IN ('OPEN', 'RESCHEDULED')) AS dp_invoiced, EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = m.sample_request_id AND i.ref_type = 'DP_PRODUCTION_LEGAL' AND (i.status = 'RESCHEDULED' OR (i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) >= i.total_idr))) AS dp_cleared FROM production_mou m JOIN sample_requests s ON s.id = m.sample_request_id LEFT JOIN clients c ON c.id = m.client_id";

/** ?1 = sample id, ?2 = id yang dikecualikan. Tanpa UNIQUE: keunikan dijaga di sini. */
export const MOU_ACTIVE_SQL =
  "SELECT COUNT(*) AS total FROM production_mou WHERE sample_request_id = ?1 AND status NOT IN ('CANCELLED', 'REJECTED') AND id <> ?2;";

/** ?1 id, ?2 nomor, ?3 sample, ?4 klien, ?5-?12 isi MoU, ?13 waktu, ?14 pembuat. */
export const MOU_INSERT_SQL =
  "INSERT INTO production_mou (id, mou_number, sample_request_id, client_id, total_units, unit_price_idr, total_production_cost_idr, production_lead_time_days, regulatory_path, dp_bp, dp_amount_required_idr, notes, status, revision_notes, status_changed_at, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'DRAFT', '', ?13, ?14, ?13, ?13) ON CONFLICT(id) DO NOTHING;";

/** ?2-?9 isi MoU, ?10 waktu, ?11 `updated_at` yang dilihat penyunting. Hanya draf. */
export const MOU_UPDATE_SQL =
  "UPDATE production_mou SET total_units = ?2, unit_price_idr = ?3, total_production_cost_idr = ?4, production_lead_time_days = ?5, regulatory_path = ?6, dp_bp = ?7, dp_amount_required_idr = ?8, notes = ?9, updated_at = ?10 WHERE id = ?1 AND status = 'DRAFT' AND updated_at = ?11;";

/** ?2 status baru, ?3 catatan revisi (NULL = tetap), ?4 waktu, ?5 status yang dilihat pencatat. */
export const MOU_TRANSITION_SQL =
  "UPDATE production_mou SET status = ?2, revision_notes = COALESCE(?3, revision_notes), status_changed_at = ?4, updated_at = ?4 WHERE id = ?1 AND status = ?5;";

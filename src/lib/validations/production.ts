/**
 * Work order produksi: cek bahan, PO, dan jadwal SPV (PRD F-23/F-24, v3.1,
 * D-44). Satu work order per MoU yang disetujui dan DP-nya lunas
 * (`production_batches`, tanpa UNIQUE); PO banyak per work order
 * (`batch_purchase_orders`). Langkahnya ditulis ke `sample_status_log` tiket
 * sampel sehingga tampil di linimasa yang sama.
 *
 * WAJIB identik dengan `src-tauri/src/desktop/production.rs`. Kedua sisi
 * diuji dengan vektor yang sama (`production.test.ts` dan `mod tests` di
 * sana), dan setiap konstanta SQL di bawah dites ada per karakter di Rust.
 */

import { LEGAL_DP_PENDING } from "./legal";
import { isCalendarDate } from "./sample";

export const MATERIAL_STATUSES = ["UNCHECKED", "WAITING_PO", "READY"] as const;
export type MaterialStatus = (typeof MATERIAL_STATUSES)[number];

export const PO_STATUSES = ["OPEN", "ARRIVED", "CANCELLED"] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const PO_ACTIONS = [
  "PO_ADD",
  "PO_ARRIVED",
  "PO_LATE",
  "PO_CANCEL",
] as const;
export type PoAction = (typeof PO_ACTIONS)[number];

/** Aksi linimasa di luar langkah PO. */
export const BATCH_CREATE_ACTION = "BATCH_CREATE";
export const MATERIALS_READY_ACTION = "MATERIALS_READY";
export const BATCH_SCHEDULE_ACTION = "BATCH_SCHEDULE";

/** Awalan bawaan kode work order; disetel lewat `batch_code_prefix` (D-43). */
export const DEFAULT_BATCH_CODE_PREFIX = "BAT";

export const PO_NUMBER_MAX = 60;
export const PRODUCTION_REASON_MAX = 500;

/** `null` = work order boleh dibuat untuk MoU itu. Padanan `batch_request_error`. */
export function batchRequestError(
  mouStatus: string,
  dpCleared: boolean,
  activeBatches: number,
): string | null {
  if (mouStatus !== "ACCEPTED")
    return "The client has not accepted the MoU yet.";
  if (!dpCleared) return LEGAL_DP_PENDING;
  return activeBatches > 0 ? "This MoU already has a work order." : null;
}

/** Satu langkah PO. `''` = PO belum ada. Padanan `apply_po_action`. */
export function applyPoAction(
  status: string,
  action: string,
): { status: PoStatus } | { error: string } {
  const from = (allowed: string, to: PoStatus) =>
    status === allowed
      ? { status: to }
      : {
          error:
            "This step is not available for the purchase order's current status.",
        };
  switch (action) {
    case "PO_ADD":
      return from("", "OPEN");
    case "PO_ARRIVED":
      return from("OPEN", "ARRIVED");
    case "PO_LATE":
      return from("OPEN", "OPEN");
    case "PO_CANCEL":
      return from("OPEN", "CANCELLED");
    default:
      return { error: "This purchase order step does not exist." };
  }
}

/** `null` = bahan boleh dinyatakan siap. Padanan `materials_ready_error`. */
export function materialsReadyError(
  materialStatus: string,
  openOrders: number,
): string | null {
  if (materialStatus === "READY") return "The materials are already ready.";
  return openOrders > 0
    ? "Mark every open purchase order as arrived or cancelled first."
    : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value.trim() : null;
}

export interface PurchaseOrderInput {
  po_number: string;
  supplier_option_id: string;
  eta_on: string;
}

/** Isian PO baru. Keberadaan supplier dicek pemanggil. Padanan `validate_purchase_order`. */
export function validatePurchaseOrder(
  input: unknown,
): { order: PurchaseOrderInput } | { error: string } {
  const raw = record(input);
  const number = text(raw, "po_number");
  if (!number || [...number].length > PO_NUMBER_MAX) {
    return { error: "Enter the purchase order number, up to 60 characters." };
  }
  const supplier = text(raw, "supplier_option_id");
  if (!supplier) return { error: "Choose the supplier." };
  const eta = text(raw, "eta_on");
  if (!eta || !isCalendarDate(eta)) {
    return { error: "Enter the expected arrival date." };
  }
  return {
    order: { po_number: number, supplier_option_id: supplier, eta_on: eta },
  };
}

export interface PoDelayInput {
  eta_on: string;
  reason: string;
}

/** Laporan PO terlambat: ETA baru wajib lebih lambat. Padanan `validate_po_delay`. */
export function validatePoDelay(
  input: unknown,
  currentEta: string,
): { delay: PoDelayInput } | { error: string } {
  const raw = record(input);
  const eta = text(raw, "eta_on");
  if (!eta || !isCalendarDate(eta)) {
    return { error: "Enter the new expected arrival date." };
  }
  if (eta <= currentEta) {
    return { error: "The new arrival date must be after the current one." };
  }
  const reason = text(raw, "reason");
  if (!reason || [...reason].length > PRODUCTION_REASON_MAX) {
    return { error: "Write why the order is late, up to 500 characters." };
  }
  return { delay: { eta_on: eta, reason } };
}

export interface BatchScheduleInput {
  weighing_on: string;
  mixing_on: string;
  filling_on: string;
  packing_on: string;
  reason: string;
}

export const SCHEDULE_STAGES = [
  ["weighing_on", "weighing"],
  ["mixing_on", "mixing"],
  ["filling_on", "filling"],
  ["packing_on", "packing"],
] as const;

/**
 * Jadwal 4 tahap, berurutan tanpa mundur. Mengubah jadwal yang sudah ada
 * wajib beralasan (keputusan K). Padanan `validate_batch_schedule`.
 */
export function validateBatchSchedule(
  input: unknown,
  hasSchedule: boolean,
): { schedule: BatchScheduleInput } | { error: string } {
  const raw = record(input);
  const dates: string[] = [];
  for (const [key, label] of SCHEDULE_STAGES) {
    const value = text(raw, key);
    if (!value || !isCalendarDate(value)) {
      return { error: `Enter the ${label} date.` };
    }
    const previous = dates[dates.length - 1];
    if (previous !== undefined && value < previous) {
      return {
        error: `The ${label} date cannot be before the stage before it.`,
      };
    }
    dates.push(value);
  }
  const reason = text(raw, "reason");
  if (reason === null || [...reason].length > PRODUCTION_REASON_MAX) {
    return { error: "The reason is up to 500 characters." };
  }
  if (hasSchedule && !reason) {
    return { error: "Write why the schedule changes." };
  }
  const [weighing, mixing, filling, packing] = dates as [
    string,
    string,
    string,
    string,
  ];
  return {
    schedule: {
      weighing_on: weighing,
      mixing_on: mixing,
      filling_on: filling,
      packing_on: packing,
      reason,
    },
  };
}

/** Catatan linimasa satu langkah PO. Padanan `po_log_notes`. */
export function poLogNotes(
  action: string,
  poNumber: string,
  supplier: string,
  etaOn: string,
  reason: string,
) {
  switch (action) {
    case "PO_ADD":
      return `PO ${poNumber} from ${supplier}, arriving ${etaOn}`;
    case "PO_ARRIVED":
      return `PO ${poNumber} arrived`;
    case "PO_LATE":
      return `PO ${poNumber} is late, now arriving ${etaOn}: ${reason}`;
    default:
      return `PO ${poNumber} cancelled`;
  }
}

/** Catatan linimasa jadwal. Padanan `schedule_log_notes`. */
export function scheduleLogNotes(schedule: BatchScheduleInput) {
  const dates = `Weighing ${schedule.weighing_on}, mixing ${schedule.mixing_on}, filling ${schedule.filling_on}, packing ${schedule.packing_on}`;
  return schedule.reason ? `${dates} - ${schedule.reason}` : dates;
}

export const BATCH_CHANGED_ELSEWHERE =
  "This work order was changed on another device first. Open it again to see the latest version.";

// ---------------------------------------------------------------------------
// SQL. Setiap konstanta WAJIB identik dengan padanannya di `production.rs`.
// ---------------------------------------------------------------------------

/**
 * Work order beserta MoU, tiket, klien, jumlah PO terbuka, dan ETA terdekat.
 * Pemanggil menambah `WHERE` dan `ORDER BY`.
 */
export const BATCH_LIST_SQL =
  "SELECT b.*, m.mou_number, m.total_units, m.regulatory_path, m.production_lead_time_days, s.brand_name, c.client_code, c.name AS client_name, (SELECT COUNT(*) FROM batch_purchase_orders p WHERE p.batch_id = b.id AND p.status = 'OPEN') AS open_orders, (SELECT MIN(p.eta_on) FROM batch_purchase_orders p WHERE p.batch_id = b.id AND p.status = 'OPEN') AS next_eta_on FROM production_batches b JOIN production_mou m ON m.id = b.mou_id JOIN sample_requests s ON s.id = b.sample_request_id LEFT JOIN clients c ON c.id = b.client_id";

/** PO beserta nama supplier; pemanggil menambah `WHERE` dan `ORDER BY`. */
export const PO_LIST_SQL =
  "SELECT p.*, COALESCE(o.label, '') AS supplier_label FROM batch_purchase_orders p LEFT JOIN master_option o ON o.id = p.supplier_option_id";

/** Pilihan Master Data supplier untuk form PO. */
export const SUPPLIER_LIST_SQL =
  "SELECT id, code, label, is_active FROM master_option WHERE kind = 'SUPPLIER' ORDER BY sort_order, label;";

/** Ditambahkan ke `MOU_LIST_SQL`: MoU disetujui yang belum punya work order. */
export const MOU_WITHOUT_BATCH_WHERE =
  " WHERE m.status = 'ACCEPTED' AND NOT EXISTS (SELECT 1 FROM production_batches b WHERE b.mou_id = m.id)";

/** ?1 = MoU, ?2 = id yang dikecualikan. Tanpa UNIQUE: keunikan dijaga di sini. */
export const BATCH_ACTIVE_SQL =
  "SELECT COUNT(*) AS total FROM production_batches WHERE mou_id = ?1 AND id <> ?2;";

/** ?1 id, ?2 kode, ?3 MoU, ?4 tiket, ?5 klien, ?6 pembuat, ?7 waktu. */
export const BATCH_INSERT_SQL =
  "INSERT INTO production_batches (id, batch_code, mou_id, sample_request_id, client_id, material_status, sched_weighing_on, sched_mixing_on, sched_filling_on, sched_packing_on, needs_reschedule, schedule_updated_at, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'UNCHECKED', '', '', '', '', 0, '', ?6, ?7, ?7) ON CONFLICT(id) DO NOTHING;";

/** ?1 id, ?2 work order, ?3 nomor, ?4 supplier, ?5 ETA, ?6 pembuat, ?7 waktu. */
export const PO_INSERT_SQL =
  "INSERT INTO batch_purchase_orders (id, batch_id, po_number, supplier_option_id, eta_on, status, late_reason, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'OPEN', '', ?6, ?7, ?7) ON CONFLICT(id) DO NOTHING;";

/** Tiba atau batal. ?2 status baru, ?3 waktu. Hanya PO yang masih terbuka. */
export const PO_STATUS_SQL =
  "UPDATE batch_purchase_orders SET status = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'OPEN';";

/** Terlambat. ?2 ETA baru, ?3 alasan, ?4 waktu, ?5 ETA yang dilihat pelapor. */
export const PO_DELAY_SQL =
  "UPDATE batch_purchase_orders SET eta_on = ?2, late_reason = ?3, updated_at = ?4 WHERE id = ?1 AND status = 'OPEN' AND eta_on = ?5;";

/** PO baru: bahan menunggu PO lagi. ?2 waktu. Aman diulang. */
export const BATCH_WAITING_PO_SQL =
  "UPDATE production_batches SET material_status = 'WAITING_PO', updated_at = ?2 WHERE id = ?1;";

/** PO terlambat: jadwal yang sudah ada perlu diulang. ?2 waktu. Aman diulang. */
export const BATCH_NEEDS_RESCHEDULE_SQL =
  "UPDATE production_batches SET needs_reschedule = CASE WHEN sched_packing_on <> '' THEN 1 ELSE needs_reschedule END, updated_at = ?2 WHERE id = ?1;";

/** Bahan siap, hanya bila tidak ada PO terbuka. ?2 waktu. Aman diulang. */
export const BATCH_READY_SQL =
  "UPDATE production_batches SET material_status = 'READY', updated_at = ?2 WHERE id = ?1 AND material_status <> 'READY' AND NOT EXISTS (SELECT 1 FROM batch_purchase_orders p WHERE p.batch_id = ?1 AND p.status = 'OPEN');";

/**
 * ?2-?5 tanggal tahap, ?6 waktu, ?7 `schedule_updated_at` yang dilihat SPV
 * ('' = jadwal pertama). Jadwal basi dari perangkat lain tidak menimpa.
 */
export const BATCH_SCHEDULE_SQL =
  "UPDATE production_batches SET sched_weighing_on = ?2, sched_mixing_on = ?3, sched_filling_on = ?4, sched_packing_on = ?5, needs_reschedule = 0, schedule_updated_at = ?6, updated_at = ?6 WHERE id = ?1 AND schedule_updated_at = ?7;";

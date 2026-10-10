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
import { MOU_UNITS_MAX } from "./mou";
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

// ---------------------------------------------------------------------------
// Tahap lantai produksi (v3.2, PRD F-25, D-45).
// ---------------------------------------------------------------------------

/** 4 tahap berurutan; `stages_done` = jumlah tahap yang sudah selesai. */
export const PRODUCTION_STAGES = [
  "WEIGHING",
  "MIXING",
  "FILLING",
  "PACKING",
] as const;
export type ProductionStage = (typeof PRODUCTION_STAGES)[number];

export const STAGE_LABEL: Record<ProductionStage, string> = {
  WEIGHING: "Weighing",
  MIXING: "Mixing",
  FILLING: "Filling",
  PACKING: "Packing",
};

export const CARTON_COUNT_MAX = 100_000;

export const PRODUCTION_STARTED =
  "Production has started, so purchase orders and materials can no longer change.";
export const PRODUCTION_PACKED = "Production is already packed.";
export const LEGAL_PENDING_FOR_PRODUCTION =
  "Waiting for every required legal document to be issued or marked not required.";

export interface StageGateState {
  stages_done: number;
  material_status: string;
  has_schedule: boolean;
  /** Dokumen legal wajib yang belum final (`legal_open` di `BATCH_LIST_SQL`). */
  legal_open: number;
}

/**
 * `null` = tahap berikutnya boleh ditandai selesai (keputusan B). Tahap 1
 * menunggu bahan, jadwal, dan dokumen legal (OQ-22); tahap 2-4 hanya
 * menunggu tahap sebelumnya. Padanan `stage_gate_error`.
 */
export function stageGateError(state: StageGateState): string | null {
  if (state.stages_done >= PRODUCTION_STAGES.length) return PRODUCTION_PACKED;
  if (state.stages_done > 0) return null;
  if (state.material_status !== "READY") {
    return "Mark the materials as ready first.";
  }
  if (!state.has_schedule) return "Set the production schedule first.";
  return state.legal_open > 0 ? LEGAL_PENDING_FOR_PRODUCTION : null;
}

export interface PackingInput {
  carton_count: number;
  produced_units: number;
}

export interface StageRecord {
  notes: string;
  /** Hanya saat Packing (keputusan D); `null` di tahap lain. */
  packing: PackingInput | null;
}

/** Bilangan bulat JSON saja; teks angka dari form ditolak. */
function strictInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

/** Isian penanda selesai satu tahap. Padanan `validate_stage_record`. */
export function validateStageRecord(
  input: unknown,
  stagesDone: number,
): { record: StageRecord } | { error: string } {
  const raw = record(input);
  const notes = text(raw, "notes");
  if (notes === null || [...notes].length > PRODUCTION_REASON_MAX) {
    return { error: "Notes are up to 500 characters." };
  }
  if (stagesDone !== PRODUCTION_STAGES.length - 1) {
    return { record: { notes, packing: null } };
  }
  const cartons = strictInt(raw.carton_count);
  if (cartons === null || cartons < 1 || cartons > CARTON_COUNT_MAX) {
    return { error: "Enter the number of cartons (1 to 100,000)." };
  }
  const units = strictInt(raw.produced_units);
  if (units === null || units < 1 || units > MOU_UNITS_MAX) {
    return { error: "Enter the number of finished units (1 to 10,000,000)." };
  }
  return {
    record: {
      notes,
      packing: { carton_count: cartons, produced_units: units },
    },
  };
}

/** Catatan linimasa satu tahap. Padanan `stage_log_notes`. */
export function stageLogNotes(stage: ProductionStage, record: StageRecord) {
  const packing = record.packing
    ? `: ${record.packing.carton_count} cartons, ${record.packing.produced_units} units`
    : "";
  const done = `${STAGE_LABEL[stage]} done${packing}`;
  return record.notes ? `${done} - ${record.notes}` : done;
}

/**
 * Jadwal tahap yang sudah selesai tidak berubah, dan seluruh jadwal terkunci
 * setelah Packing (keputusan G). `current`/`next` urut sesuai
 * `SCHEDULE_STAGES`. Padanan `schedule_lock_error`.
 */
export function scheduleLockError(
  stagesDone: number,
  current: readonly string[],
  next: readonly string[],
): string | null {
  if (stagesDone >= PRODUCTION_STAGES.length) return PRODUCTION_PACKED;
  for (let index = 0; index < stagesDone; index += 1) {
    if (current[index] !== next[index]) {
      return "The dates of finished stages cannot change.";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pelunasan, biaya titip, dan siap kirim (v3.3, PRD F-26/F-31, D-46).
// ---------------------------------------------------------------------------

/** Kolom `BATCH_LIST_SQL` yang menentukan siap kirim. */
export interface ShipState {
  stages_done: number;
  settlement_count: number;
  ship_unpaid: number;
  storage_count: number;
  storage_days: number;
  carton_count: number;
  storage_rate_idr: number;
}

/**
 * Biaya titip berjalan: koli × hari ditagih × tarif (OQ-30). Hari ditagih
 * dihitung database (`storage_days`). Padanan `storage_fee_due`.
 */
export function storageFeeDue(state: ShipState) {
  return state.storage_days * state.carton_count * state.storage_rate_idr;
}

export const PRODUCTION_NOT_PACKED = "Production is not packed yet.";
export const SHIP_NO_SETTLEMENT =
  "Finance has not issued the settlement invoice yet.";
export const SHIP_UNPAID =
  "Waiting for the settlement, shipping, and storage invoices to be paid.";
export const SHIP_STORAGE_UNBILLED =
  "Finance must issue the storage fee invoice first.";

/**
 * `null` = order boleh dikirim (keputusan F v3.3, D-43): ada pelunasan,
 * semua tagihan pelunasan/ongkir/biaya titip lunas (cicilan dihitung per
 * cicilan), dan biaya titip > 0 sudah ditagih. Padanan `ship_gate_error`.
 */
export function shipGateError(state: ShipState): string | null {
  if (state.stages_done < PRODUCTION_STAGES.length) {
    return PRODUCTION_NOT_PACKED;
  }
  if (state.settlement_count < 1) {
    return SHIP_NO_SETTLEMENT;
  }
  if (state.ship_unpaid > 0) {
    return SHIP_UNPAID;
  }
  if (storageFeeDue(state) > 0 && state.storage_count < 1) {
    return SHIP_STORAGE_UNBILLED;
  }
  return null;
}

/** Satu baris `BATCH_LIST_SQL` sebagai `ShipState`. Padanan `ShipState::from_row`. */
export function shipStateFromRow(row: Record<string, unknown>): ShipState {
  const int = (key: string) => {
    const value = Number(row[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    stages_done: int("stages_done"),
    settlement_count: int("settlement_count"),
    ship_unpaid: int("ship_unpaid"),
    storage_count: int("storage_count"),
    storage_days: int("storage_days"),
    carton_count: int("carton_count"),
    storage_rate_idr: int("storage_rate_idr"),
  };
}

/**
 * Ringkasan kirim satu work order untuk baris tiket sampel (v3.3): gerbang
 * kirim, nominal bawaan pelunasan (total MoU − DP, keputusan B), biaya titip
 * berjalan, dan pelunasan sudah lunas. Padanan `ship_summary`.
 */
export function shipSummary(row: Record<string, unknown>) {
  const state = shipStateFromRow(row);
  return {
    ship_block: shipGateError(state),
    settlement_default_idr: Math.max(
      0,
      Number(row.total_production_cost_idr ?? 0) -
        Number(row.dp_amount_required_idr ?? 0),
    ),
    storage_fee_idr: storageFeeDue(state),
    settlement_cleared:
      state.settlement_count > 0 && Number(row.settlement_unpaid ?? 0) === 0
        ? 1
        : 0,
  };
}

// ---------------------------------------------------------------------------
// Pengiriman dan Surat Jalan (v3.4, PRD F-27, D-47).
// ---------------------------------------------------------------------------

export const SHIPMENT_STATUSES = [
  "PREPARED",
  "SHIPPED",
  "FORWARDED",
  "CANCELLED",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_ACTIONS = [
  "SHIP_UPDATE",
  "SHIP_CANCEL",
  "SHIP_DISPATCH",
  "SHIP_TRACKING",
  "SHIP_FORWARD",
] as const;
export type ShipmentAction = (typeof SHIPMENT_ACTIONS)[number];

/** Aksi linimasa saat Surat Jalan diterbitkan. */
export const SHIPMENT_CREATE_ACTION = "SHIP_PREPARE";
export const DELIVERY_METHODS = ["CARRIER", "FLEET"] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];
/** Awalan bawaan nomor Surat Jalan; disetel lewat `delivery_note_prefix`. */
export const DEFAULT_DELIVERY_NOTE_PREFIX = "SJ";
export const TRACKING_NO_MAX = 60;
export const SHIP_ADDRESS_MAX = 500;

export interface ShipmentInput {
  method: DeliveryMethod;
  carrier_option_id: string;
  driver_name: string;
  driver_phone: string;
  vehicle_plate: string;
  carton_count: number;
  unit_count: number;
  ship_on: string;
  ship_to_address: string;
  notes: string;
}

/** Isian pengiriman (keputusan B). Padanan `validate_shipment`. */
export function validateShipment(
  input: unknown,
): { shipment: ShipmentInput } | { error: string } {
  const raw = record(input);
  const method = raw.method;
  if (
    typeof method !== "string" ||
    !(DELIVERY_METHODS as readonly string[]).includes(method)
  ) {
    return { error: "Choose how the goods are shipped." };
  }
  const carrier = text(raw, "carrier_option_id") ?? "";
  const driver = text(raw, "driver_name");
  const phone = text(raw, "driver_phone");
  const plate = text(raw, "vehicle_plate");
  if (method === "CARRIER" && !carrier) {
    return { error: "Choose the shipping company." };
  }
  if (method === "FLEET") {
    if (!driver || [...driver].length > 100) {
      return { error: "Enter the driver's name, up to 100 characters." };
    }
    if (!plate || [...plate].length > 20) {
      return { error: "Enter the vehicle plate number, up to 20 characters." };
    }
    if (phone === null || [...phone].length > 30) {
      return { error: "The driver's phone is up to 30 characters." };
    }
  }
  const cartons = strictInt(raw.carton_count);
  if (cartons === null || cartons < 1 || cartons > CARTON_COUNT_MAX) {
    return { error: "Enter the number of cartons (1 to 100,000)." };
  }
  const units = strictInt(raw.unit_count);
  if (units === null || units < 1 || units > MOU_UNITS_MAX) {
    return { error: "Enter the number of units (1 to 10,000,000)." };
  }
  const shipOn = text(raw, "ship_on");
  if (!shipOn || !isCalendarDate(shipOn)) {
    return { error: "Enter the shipping date." };
  }
  const address = text(raw, "ship_to_address");
  if (!address || [...address].length > SHIP_ADDRESS_MAX) {
    return { error: "Enter the delivery address, up to 500 characters." };
  }
  const notes = text(raw, "notes");
  if (notes === null || [...notes].length > PRODUCTION_REASON_MAX) {
    return { error: "Notes are up to 500 characters." };
  }
  const fleet = method === "FLEET";
  return {
    shipment: {
      method: method as DeliveryMethod,
      carrier_option_id: fleet ? "" : carrier,
      driver_name: fleet ? (driver ?? "") : "",
      driver_phone: fleet ? (phone ?? "") : "",
      vehicle_plate: fleet ? (plate ?? "") : "",
      carton_count: cartons,
      unit_count: units,
      ship_on: shipOn,
      ship_to_address: address,
      notes,
    },
  };
}

/** `null` = Surat Jalan boleh diterbitkan (keputusan G). Padanan `shipment_request_error`. */
export function shipmentRequestError(
  shipBlock: string | null,
  activeShipments: number,
): string | null {
  if (shipBlock) return shipBlock;
  return activeShipments > 0 ? "This work order already has a shipment." : null;
}

export interface ShipmentState {
  status: string;
  method: string;
  tracking_no: string;
}

/** Satu langkah pengiriman (keputusan A). Padanan `apply_shipment_action`. */
export function applyShipmentAction(
  state: ShipmentState,
  action: string,
): { status: ShipmentStatus } | { error: string } {
  const wrong = {
    error: "This step is not available for the shipment's current status.",
  };
  switch (action) {
    case "SHIP_UPDATE":
      return state.status === "PREPARED" ? { status: "PREPARED" } : wrong;
    case "SHIP_CANCEL":
      return state.status === "PREPARED" ? { status: "CANCELLED" } : wrong;
    case "SHIP_DISPATCH":
      return state.status === "PREPARED" ? { status: "SHIPPED" } : wrong;
    case "SHIP_TRACKING":
      if (state.status !== "SHIPPED" && state.status !== "FORWARDED") {
        return wrong;
      }
      return state.tracking_no
        ? { error: "The tracking number is already recorded." }
        : { status: state.status };
    case "SHIP_FORWARD":
      if (state.status !== "SHIPPED") return wrong;
      return state.method === "CARRIER" && !state.tracking_no
        ? { error: "Record the tracking number before forwarding it." }
        : { status: "FORWARDED" };
    default:
      return { error: "This shipment step does not exist." };
  }
}

/** Forwarded milik CS, sisanya Logistik (keputusan D). Padanan `shipment_action_permission`. */
export function shipmentActionPermission(action: unknown) {
  return action === "SHIP_FORWARD" ? "samples.manage" : "shipping.manage";
}

/** Resi; wajib hanya untuk langkah `SHIP_TRACKING`. Padanan `normalize_tracking`. */
export function normalizeTracking(value: unknown, required: boolean) {
  if (value !== undefined && value !== null && typeof value !== "string") {
    return null;
  }
  const tracking = (value ?? "").trim();
  if ([...tracking].length > TRACKING_NO_MAX) return null;
  return required && !tracking ? null : tracking;
}

export const TRACKING_INVALID =
  "Enter the tracking number, up to 60 characters.";
export const SHIPMENT_CANCEL_REASON_INVALID =
  "Write why the shipment is cancelled, up to 500 characters.";

export interface ShipmentLogInput {
  delivery_note_no: string;
  method: string;
  carrier_label: string;
  tracking_no: string;
  driver_name: string;
  vehicle_plate: string;
  reason: string;
}

/** Catatan linimasa satu langkah pengiriman. Padanan `shipment_log_notes`. */
export function shipmentLogNotes(action: string, input: ShipmentLogInput) {
  switch (action) {
    case "SHIP_PREPARE":
      return `Delivery note ${input.delivery_note_no}`;
    case "SHIP_UPDATE":
      return `Delivery note ${input.delivery_note_no} corrected`;
    case "SHIP_CANCEL":
      return `Delivery note ${input.delivery_note_no} cancelled: ${input.reason}`;
    case "SHIP_DISPATCH": {
      if (input.method === "FLEET") {
        return `Shipped by ${input.driver_name} (${input.vehicle_plate})`;
      }
      const tracking = input.tracking_no
        ? `, tracking ${input.tracking_no}`
        : "";
      return `Shipped by ${input.carrier_label}${tracking}`;
    }
    case "SHIP_TRACKING":
      return `Tracking number ${input.tracking_no}`;
    default:
      return "Tracking number and delivery note sent to the client";
  }
}

export const SHIPMENT_CHANGED_ELSEWHERE =
  "This shipment was changed on another device first. Open it again to see the latest version.";

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
  "SELECT b.*, CASE WHEN b.stages_done < 4 OR b.packed_at = '' THEN 0 ELSE MAX(0, CAST(julianday(CASE WHEN b.settlement_count > 0 AND b.settlement_unpaid = 0 AND b.settlement_paid_on <> '' THEN b.settlement_paid_on ELSE date('now', b.tz_shift) END) - julianday(date(b.packed_at, b.tz_shift)) AS INTEGER) - b.storage_grace_days) END AS storage_days FROM (SELECT b.*, m.mou_number, m.total_units, m.regulatory_path, m.production_lead_time_days, s.brand_name, c.client_code, c.name AS client_name, (SELECT COUNT(*) FROM batch_purchase_orders p WHERE p.batch_id = b.id AND p.status = 'OPEN') AS open_orders, (SELECT MIN(p.eta_on) FROM batch_purchase_orders p WHERE p.batch_id = b.id AND p.status = 'OPEN') AS next_eta_on, CASE m.regulatory_path WHEN 'WITH_BPOM' THEN 4 ELSE 1 END - (SELECT COUNT(DISTINCT l.kind) FROM legal_documents l WHERE l.mou_id = b.mou_id AND l.status IN ('ISSUED', 'NOT_REQUIRED') AND (m.regulatory_path = 'WITH_BPOM' OR l.kind = 'HALAL')) AS legal_open, s.ship_to_address, m.total_production_cost_idr, m.dp_amount_required_idr, (SELECT COUNT(*) FROM invoices i WHERE i.sample_request_id = b.sample_request_id AND i.ref_type = 'SETTLEMENT' AND i.status <> 'CANCELLED') AS settlement_count, (SELECT COUNT(*) FROM invoices i WHERE i.sample_request_id = b.sample_request_id AND i.ref_type = 'STORAGE_FEE' AND i.status <> 'CANCELLED') AS storage_count, (SELECT COUNT(*) FROM invoices i WHERE i.sample_request_id = b.sample_request_id AND i.status = 'OPEN' AND COALESCE((SELECT p.ref_type FROM invoices p WHERE p.id = i.parent_invoice_id), i.ref_type) = 'SETTLEMENT' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) < i.total_idr) AS settlement_unpaid, (SELECT COUNT(*) FROM invoices i WHERE i.sample_request_id = b.sample_request_id AND i.status = 'OPEN' AND COALESCE((SELECT p.ref_type FROM invoices p WHERE p.id = i.parent_invoice_id), i.ref_type) IN ('SETTLEMENT', 'SHIPPING', 'STORAGE_FEE') AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) < i.total_idr) AS ship_unpaid, COALESCE((SELECT MAX(f.received_on) FROM invoices i JOIN fund_allocations a ON a.invoice_id = i.id JOIN incoming_funds f ON f.id = a.fund_id WHERE i.sample_request_id = b.sample_request_id AND COALESCE((SELECT p.ref_type FROM invoices p WHERE p.id = i.parent_invoice_id), i.ref_type) = 'SETTLEMENT'), '') AS settlement_paid_on, COALESCE((SELECT CAST(g.value AS INTEGER) FROM setting_gex_system g WHERE g.key = 'storage_grace_days'), 14) AS storage_grace_days, COALESCE((SELECT CAST(g.value AS INTEGER) FROM setting_gex_system g WHERE g.key = 'storage_fee_idr'), 0) AS storage_rate_idr, CASE COALESCE((SELECT z.timezone FROM company_profile z WHERE z.id = 'default_company'), '') WHEN 'Asia/Makassar' THEN '+8 hours' WHEN 'Asia/Jayapura' THEN '+9 hours' ELSE '+7 hours' END AS tz_shift FROM production_batches b JOIN production_mou m ON m.id = b.mou_id JOIN sample_requests s ON s.id = b.sample_request_id LEFT JOIN clients c ON c.id = b.client_id) b";

/** PO beserta nama supplier; pemanggil menambah `WHERE` dan `ORDER BY`. */
export const PO_LIST_SQL =
  "SELECT p.*, COALESCE(o.label, '') AS supplier_label FROM batch_purchase_orders p LEFT JOIN master_option o ON o.id = p.supplier_option_id";

/** Pilihan Master Data supplier untuk form PO. */
export const SUPPLIER_LIST_SQL =
  "SELECT id, code, label, is_active FROM master_option WHERE kind = 'SUPPLIER' ORDER BY sort_order, label;";

/** Pilihan Master Data ekspedisi untuk form pengiriman (v3.4). */
export const CARRIER_LIST_SQL =
  "SELECT id, code, label, is_active FROM master_option WHERE kind = 'CARRIER' ORDER BY sort_order, label;";

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

/**
 * Tandai satu tahap selesai. ?2 jumlah tahap selesai yang baru, ?3 waktu,
 * ?4 koli, ?5 unit jadi (hanya dipakai saat ?2 = 4). Hanya bila cloud masih
 * di tahap sebelumnya, jadi aman diulang (E-34).
 */
export const BATCH_STAGE_SQL =
  "UPDATE production_batches SET stages_done = ?2, packed_at = CASE WHEN ?2 = 4 THEN ?3 ELSE packed_at END, carton_count = CASE WHEN ?2 = 4 THEN ?4 ELSE carton_count END, produced_units = CASE WHEN ?2 = 4 THEN ?5 ELSE produced_units END, updated_at = ?3 WHERE id = ?1 AND stages_done = ?2 - 1;";

/** Penanda tahap di linimasa semua work order, untuk panel Production. */
export const STAGE_LOG_SQL =
  "SELECT l.sample_request_id, l.action, l.notes, l.recorded_at, o.nama_operator AS recorded_by_name FROM sample_status_log l LEFT JOIN master_operator o ON o.id = l.recorded_by WHERE l.action LIKE 'STAGE_%' AND l.sample_request_id IN (SELECT sample_request_id FROM production_batches) ORDER BY l.recorded_at, l.rowid;";

/** Pengiriman beserta work order, MoU, tiket, klien, dan nama ekspedisi. */
export const SHIPMENT_LIST_SQL =
  "SELECT h.*, COALESCE(o.label, '') AS carrier_label, b.batch_code, m.mou_number, s.brand_name, c.client_code, c.name AS client_name FROM shipments h JOIN production_batches b ON b.id = h.batch_id JOIN production_mou m ON m.id = b.mou_id JOIN sample_requests s ON s.id = h.sample_request_id LEFT JOIN clients c ON c.id = h.client_id LEFT JOIN master_option o ON o.id = h.carrier_option_id";

/** ?1 = work order, ?2 = id yang dikecualikan. Tanpa UNIQUE: satu aktif dijaga di sini. */
export const SHIPMENT_ACTIVE_SQL =
  "SELECT COUNT(*) AS total FROM shipments WHERE batch_id = ?1 AND status <> 'CANCELLED' AND id <> ?2;";

/** ?1 id, ?2 work order, ?3 tiket, ?4 klien, ?5 nomor Surat Jalan, ?6-?15 isian, ?16 pembuat, ?17 waktu. */
export const SHIPMENT_INSERT_SQL =
  "INSERT INTO shipments (id, batch_id, sample_request_id, client_id, delivery_note_no, method, carrier_option_id, tracking_no, driver_name, driver_phone, vehicle_plate, carton_count, unit_count, ship_on, ship_to_address, notes, status, cancel_reason, shipped_at, forwarded_at, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'PREPARED', '', '', '', ?16, ?17, ?17) ON CONFLICT(id) DO NOTHING;";

/** Koreksi selama `PREPARED`. ?2-?11 isian, ?12 waktu, ?13 `updated_at` yang dilihat penyunting. */
export const SHIPMENT_UPDATE_SQL =
  "UPDATE shipments SET method = ?2, carrier_option_id = ?3, driver_name = ?4, driver_phone = ?5, vehicle_plate = ?6, carton_count = ?7, unit_count = ?8, ship_on = ?9, ship_to_address = ?10, notes = ?11, updated_at = ?12 WHERE id = ?1 AND status = 'PREPARED' AND updated_at = ?13;";

/** Satu langkah. ?2 status baru, ?3 resi ('' = tetap), ?4 alasan batal, ?5 waktu, ?6 status dan ?7 `updated_at` yang dilihat pencatat. */
export const SHIPMENT_STEP_SQL =
  "UPDATE shipments SET status = ?2, tracking_no = CASE WHEN ?3 <> '' THEN ?3 ELSE tracking_no END, cancel_reason = CASE WHEN ?2 = 'CANCELLED' THEN ?4 ELSE cancel_reason END, shipped_at = CASE WHEN ?2 = 'SHIPPED' AND shipped_at = '' THEN ?5 ELSE shipped_at END, forwarded_at = CASE WHEN ?2 = 'FORWARDED' AND forwarded_at = '' THEN ?5 ELSE forwarded_at END, updated_at = ?5 WHERE id = ?1 AND status = ?6 AND updated_at = ?7;";

"use client";

import { requestWebApi } from "@/lib/client/api-client";
import type { MouRecord } from "@/lib/gateways/samples";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type {
  BatchScheduleInput,
  DeliveryMethod,
  MaterialStatus,
  PoAction,
  PoDelayInput,
  PoStatus,
  PurchaseOrderInput,
  ShipmentAction,
  ShipmentInput,
  ShipmentStatus,
} from "@/lib/validations/production";

/**
 * Gateway produksi (v3.1, PRD F-23/F-24). Tauri: `desktop_*` di
 * `commands.rs` membaca SQLite lokal dan mengantre outbox. Web:
 * `/api/production/*`.
 */

/** Satu baris `BATCH_LIST_SQL`. */
export interface BatchRecord {
  id: string;
  batch_code: string;
  mou_id: string;
  sample_request_id: string;
  client_id: string;
  material_status: MaterialStatus;
  sched_weighing_on: string;
  sched_mixing_on: string;
  sched_filling_on: string;
  sched_packing_on: string;
  needs_reschedule: number;
  schedule_updated_at: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  mou_number: string;
  total_units: number;
  regulatory_path: string;
  production_lead_time_days: number;
  brand_name: string;
  client_code: string | null;
  client_name: string | null;
  open_orders: number;
  next_eta_on: string | null;
  /** Tahap lantai produksi yang sudah selesai, 0-4 (v3.2). */
  stages_done: number;
  packed_at: string;
  carton_count: number;
  produced_units: number;
  /** Dokumen legal wajib yang belum final; 0 = tahap 1 boleh mulai. */
  legal_open: number;
  /** Alamat kirim tiket sampel, isian bawaan Surat Jalan (v3.4). */
  ship_to_address: string;
  /** Pelunasan dan biaya titip (v3.3, dihitung `BATCH_LIST_SQL`). */
  total_production_cost_idr: number;
  dp_amount_required_idr: number;
  settlement_count: number;
  storage_count: number;
  settlement_unpaid: number;
  ship_unpaid: number;
  settlement_paid_on: string;
  storage_grace_days: number;
  storage_rate_idr: number;
  storage_days: number;
}

/** Satu baris `STAGE_LOG_SQL`: siapa dan kapan sebuah tahap ditandai. */
export interface StageLogEntry {
  sample_request_id: string;
  action: string;
  notes: string;
  recorded_at: string;
  recorded_by_name: string | null;
}

/** Satu baris `PO_LIST_SQL`. */
export interface PurchaseOrderRecord {
  id: string;
  batch_id: string;
  po_number: string;
  supplier_option_id: string;
  supplier_label: string;
  eta_on: string;
  status: PoStatus;
  late_reason: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface SupplierOption {
  id: string;
  code: string;
  label: string;
  is_active: number;
}

export interface ProductionOverview {
  /** MoU disetujui yang DP-nya lunas dan belum punya work order. */
  ready: MouRecord[];
  batches: BatchRecord[];
  purchase_orders: PurchaseOrderRecord[];
  suppliers: SupplierOption[];
  stage_log: StageLogEntry[];
  /** Pengiriman (v3.4), termasuk yang dibatalkan. */
  shipments: ShipmentRecord[];
  /** Teks SOP Penyimpanan; kosong = tanpa PDF SOP. */
  storage_sop_text: string;
  carriers: SupplierOption[];
}

/** Satu langkah PO; `po_id` kosong untuk PO baru. */
export interface PurchaseOrderStep {
  action: PoAction;
  po_id: string;
  order: PurchaseOrderInput | null;
  delay: PoDelayInput | null;
}

export async function getProductionOverview(): Promise<ProductionOverview> {
  if (isDesktopRuntime()) return invokeDesktop("desktop_list_production");
  return requestWebApi("/api/production/query", "POST", {});
}

export async function createBatch(
  mouId: string,
): Promise<{ id: string; batch_code: string }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_create_batch", { mouId });
  }
  return requestWebApi("/api/production/batch", "POST", { mou_id: mouId });
}

export async function recordPurchaseOrder(
  batchId: string,
  step: PurchaseOrderStep,
): Promise<{ id: string; status: PoStatus }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_record_purchase_order", { batchId, step });
  }
  return requestWebApi("/api/production/purchase-order", "POST", {
    batch_id: batchId,
    step,
  });
}

export async function markMaterialsReady(batchId: string): Promise<unknown> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_mark_materials_ready", { batchId });
  }
  return requestWebApi("/api/production/ready", "POST", { batch_id: batchId });
}

/** Isian penanda tahap; koli dan unit jadi hanya dibaca saat Packing. */
export interface BatchStageInput {
  notes: string;
  carton_count: number | null;
  produced_units: number | null;
}

export async function recordBatchStage(
  batchId: string,
  stage: BatchStageInput,
): Promise<{ id: string; stages_done: number }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_record_batch_stage", { batchId, stage });
  }
  return requestWebApi("/api/production/stage", "POST", {
    batch_id: batchId,
    stage,
  });
}

/** Satu baris `SHIPMENT_LIST_SQL` (v3.4). */
export interface ShipmentRecord {
  id: string;
  batch_id: string;
  sample_request_id: string;
  client_id: string;
  delivery_note_no: string;
  method: DeliveryMethod;
  carrier_option_id: string;
  carrier_label: string;
  tracking_no: string;
  driver_name: string;
  driver_phone: string;
  vehicle_plate: string;
  carton_count: number;
  unit_count: number;
  ship_on: string;
  ship_to_address: string;
  notes: string;
  status: ShipmentStatus;
  cancel_reason: string;
  shipped_at: string;
  forwarded_at: string;
  created_at: string;
  updated_at: string;
  batch_code: string;
  mou_number: string;
  brand_name: string;
  client_code: string | null;
  client_name: string | null;
}

/** Satu langkah pengiriman; isian yang tidak dipakai langkah itu diabaikan. */
export interface ShipmentStep {
  action: ShipmentAction;
  shipment: ShipmentInput | null;
  tracking_no: string;
  reason: string;
  evidence_base64: string;
}

export async function createShipment(
  batchId: string,
  shipment: ShipmentInput,
): Promise<{ id: string; delivery_note_no: string }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_create_shipment", { batchId, shipment });
  }
  return requestWebApi("/api/production/shipment", "POST", {
    batch_id: batchId,
    shipment,
  });
}

export async function recordShipmentStep(
  shipmentId: string,
  step: ShipmentStep,
): Promise<{ id: string; status: ShipmentStatus }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_record_shipment_step", { shipmentId, step });
  }
  return requestWebApi("/api/production/shipment/step", "POST", {
    shipment_id: shipmentId,
    step,
  });
}

export async function saveBatchSchedule(
  batchId: string,
  schedule: BatchScheduleInput,
): Promise<unknown> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_save_batch_schedule", { batchId, schedule });
  }
  return requestWebApi("/api/production/schedule", "POST", {
    batch_id: batchId,
    schedule,
  });
}

"use client";

import { requestWebApi } from "@/lib/client/api-client";
import type { MouRecord } from "@/lib/gateways/samples";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type {
  BatchScheduleInput,
  MaterialStatus,
  PoAction,
  PoDelayInput,
  PoStatus,
  PurchaseOrderInput,
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

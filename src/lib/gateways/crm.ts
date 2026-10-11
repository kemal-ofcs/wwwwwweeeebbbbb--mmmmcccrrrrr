"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

/**
 * Gateway CRM (v3.6a, PRD F-29, D-49): antrean klien yang sudah diserahkan,
 * pindah PIC CRM, dan Forward to CRM dari CS. Desktop memanggil
 * `desktop_*_crm`, Web memanggil `/api/crm/*`.
 */

/** Satu baris `CRM_CLIENT_LIST_SQL`. */
export interface CrmClientRecord {
  id: string;
  client_code: string;
  client_name: string;
  city: string;
  assigned_crm_id: number | null;
  crm_name: string;
  last_completed_at: string;
  last_sample_id: string;
  brand_name: string;
  packaging: string;
  last_units: number;
  last_formula_code: string;
  last_contact_at: string;
  reorder_days: number;
  /** Perkiraan repeat order, tanggal perusahaan; '' = belum ada order selesai. */
  reorder_on: string;
  today: string;
  /** Tiket baru sesudah order terakhir selesai, yang belum ditutup. */
  open_tickets: number;
}

export interface CrmOperator {
  id: number;
  nama_operator: string;
}

export interface CrmOverview {
  clients: CrmClientRecord[];
  operators: CrmOperator[];
}

export async function getCrmOverview(): Promise<CrmOverview> {
  if (isDesktopRuntime()) return invokeDesktop("desktop_list_crm");
  return requestWebApi("/api/crm/query", "POST", {});
}

export async function assignCrm(
  clientId: string,
  operatorId: number,
): Promise<{ id: string }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_assign_crm", { clientId, operatorId });
  }
  return requestWebApi("/api/crm/assign", "POST", {
    client_id: clientId,
    operator_id: operatorId,
  });
}

/** Repeat order dari tiket yang ordernya selesai; hasilnya id tiket baru. */
export async function repeatSampleOrder(
  sourceId: string,
): Promise<{ id: string }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_repeat_sample_order", { sourceId });
  }
  return requestWebApi("/api/crm/repeat", "POST", { source_id: sourceId });
}

export async function forwardToCrm(
  clientId: string,
  notes: string,
): Promise<{ id: string }> {
  const forward = { notes };
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_forward_to_crm", { clientId, forward });
  }
  return requestWebApi("/api/crm/forward", "POST", {
    client_id: clientId,
    forward,
  });
}

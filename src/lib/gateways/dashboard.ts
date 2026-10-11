"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

/**
 * Gateway dashboard (F-40a, D-52). Desktop/Android menghitung dari data
 * perangkat (`desktop_get_dashboard`), Web dari database (`/api/dashboard/query`).
 * Bagian yang izinnya tidak dipegang tidak ada di `sections`.
 */

export interface SalesFigures {
  leads_new: number;
  leads_open: number;
  leads_without_pic: number;
  leads_hot: number;
  leads_warm: number;
  leads_cold: number;
  avg_lead_to_sample_days: number | null;
}

export interface SampleFigures {
  samples_new: number;
  samples_sent: number;
  samples_approved: number;
  mou_accepted: number;
  samples_in_progress: number;
  avg_rnd_days: number | null;
}

export interface FinanceFigures {
  invoices_issued: number;
  invoiced_idr: number;
  received_idr: number;
  outstanding_idr: number;
  overdue_idr: number;
  overdue_count: number;
  unallocated_idr: number;
}

export interface ProductionFigures {
  wo_waiting: number;
  wo_floor: number;
  wo_packed: number;
  packed: number;
  packed_on_time: number;
  behind_schedule: number;
  late_purchase_orders: number;
  shipped: number;
  received_ok: number;
  complaints: number;
  claims_open: number;
  claims_decided: number;
  claims_internal: number;
  avg_qc_hours: number | null;
}

export interface CrmFigures {
  crm_clients: number;
  crm_unassigned: number;
  crm_due: number;
  orders_completed: number;
  repeat_started: number;
}

export interface DashboardData {
  from: string;
  to: string;
  sections: {
    sales?: SalesFigures;
    samples?: SampleFigures;
    finance?: FinanceFigures;
    production?: ProductionFigures;
    crm?: CrmFigures;
  };
}

export async function getDashboard(
  from: string,
  to: string,
): Promise<DashboardData> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_get_dashboard", { from, to });
  }
  return requestWebApi("/api/dashboard/query", "POST", { from, to });
}

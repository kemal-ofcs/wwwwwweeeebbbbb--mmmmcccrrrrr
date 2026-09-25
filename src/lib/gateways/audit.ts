"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

/**
 * Gateway log audit domain (PRD F-10). Tauri: `desktop_list_audit_log`, yang
 * membaca cloud saat online dan catatan perangkat ini saat offline. Web:
 * `/api/audit/query`, selalu cloud.
 */

export interface AuditEntry {
  id: string;
  actor_operator_id: number | null;
  actor_name: string | null;
  on_behalf_of_division: string;
  action: string;
  entity_type: string;
  entity_id: string;
  summary_json: string;
  occurred_at: string;
}

export interface AuditFilter {
  /** `""` = semua jenis. */
  entity_type: string;
  /** `0` = semua pelaku. */
  actor_operator_id: number;
  /** `YYYY-MM-DD` dalam zona waktu perusahaan, `""` = tanpa batas. */
  from: string;
  to: string;
}

export interface AuditPage {
  /** `device` = offline, hanya catatan yang ditulis perangkat ini. */
  source: "cloud" | "device";
  entries: AuditEntry[];
}

export async function listAuditLog(filter: AuditFilter): Promise<AuditPage> {
  if (isDesktopRuntime()) {
    return invokeDesktop<AuditPage>("desktop_list_audit_log", { filter });
  }
  const result = await requestWebApi<AuditPage>("/api/audit/query", "POST", {
    filter,
  });
  return { source: result.source ?? "cloud", entries: result.entries ?? [] };
}

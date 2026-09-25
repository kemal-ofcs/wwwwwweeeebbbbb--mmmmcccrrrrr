"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { MasterOptionKind } from "@/lib/validations/client";

/**
 * Gateway domain klien, lead, dan Master Data.
 *
 * Satu fungsi, dua cabang: Tauri memanggil command `desktop_*` di
 * `commands.rs`, Web memanggil route `/api/clients`, `/api/master-data`, dan
 * `/api/settings/client-code`. Kunci di dalam objek dikirim snake_case persis
 * seperti yang dibaca Rust (`draft_text(&client, "channel_option_id")`) —
 * Tauri hanya mengubah nama ARGUMEN, bukan isi objeknya.
 */

export interface ClientRecord {
  id: string;
  client_code: string;
  name: string;
  phone_normalized: string;
  address: string;
  city: string;
  province: string;
  lifecycle_status: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  lead_id: string | null;
  pic_cs_id: number | null;
  channel_option_id: string;
  product_category_option_id: string;
  needs_notes: string;
  last_client_response_at: string;
  total_followups: number;
}

/** Isi form intake. Nomor dikirim apa adanya; backend yang menormalkan. */
export interface ClientDraft {
  name: string;
  phone: string;
  address: string;
  city: string;
  province: string;
  channel_option_id: string;
  product_category_option_id: string;
  needs_notes: string;
}

export interface MasterOptionRecord {
  id: string;
  kind: string;
  code: string;
  label: string;
  is_active: boolean;
  sort_order: number;
  updated_at: string;
}

/** `id` kosong = pilihan baru; `kind` hanya dibaca untuk pilihan baru. */
export interface MasterOptionDraft {
  id: string;
  kind: MasterOptionKind;
  code: string;
  label: string;
  is_active: boolean;
}

export interface ClientCodeSettings {
  client_code_prefix: string;
  client_code_web_tag: string;
  /** Tag perangkat ini. Selalu `null` di Web; `null` di perangkat yang belum pernah tersambung. */
  device_tag: string | null;
}

export async function listClients(): Promise<ClientRecord[]> {
  if (isDesktopRuntime()) {
    return invokeDesktop<ClientRecord[]>("desktop_list_clients");
  }
  const result = await requestWebApi<{ clients: ClientRecord[] }>(
    "/api/clients/query",
    "POST",
    {},
  );
  return result.clients ?? [];
}

export async function registerClient(
  client: ClientDraft,
): Promise<{ id: string; client_code: string }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_register_client", { client });
  }
  return requestWebApi("/api/clients", "POST", { client });
}

export async function updateClient(
  id: string,
  draft: ClientDraft,
): Promise<void> {
  const client = { ...draft, id };
  if (isDesktopRuntime()) {
    await invokeDesktop("desktop_update_client", { client });
    return;
  }
  await requestWebApi("/api/clients", "PUT", { client });
}

export async function listMasterOptions(): Promise<MasterOptionRecord[]> {
  if (isDesktopRuntime()) {
    return invokeDesktop<MasterOptionRecord[]>("desktop_list_master_options");
  }
  const result = await requestWebApi<{ options: MasterOptionRecord[] }>(
    "/api/master-data/query",
    "POST",
    {},
  );
  return result.options ?? [];
}

export async function saveMasterOption(
  option: MasterOptionDraft,
): Promise<MasterOptionRecord> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_save_master_option", { option });
  }
  const result = await requestWebApi<{ option: MasterOptionRecord }>(
    "/api/master-data",
    "POST",
    { option },
  );
  return result.option;
}

export async function getClientCodeSettings(): Promise<ClientCodeSettings> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_get_client_code_settings");
  }
  const result = await requestWebApi<{ settings: ClientCodeSettings }>(
    "/api/settings/client-code/query",
    "POST",
    {},
  );
  return result.settings;
}

export async function saveClientCodeSettings(settings: {
  client_code_prefix: string;
  client_code_web_tag: string;
}): Promise<ClientCodeSettings> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_save_client_code_settings", { settings });
  }
  const result = await requestWebApi<{ settings: ClientCodeSettings }>(
    "/api/settings/client-code",
    "PUT",
    { settings },
  );
  return result.settings;
}

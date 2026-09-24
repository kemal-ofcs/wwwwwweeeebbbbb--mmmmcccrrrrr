"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

/**
 * Gateway domain contoh.
 *
 * Komponen UI TIDAK BOLEH memanggil `invoke()` atau `fetch("/api/...")`
 * langsung. Setiap operasi data melewati modul seperti ini, yang bercabang pada
 * `isDesktopRuntime()`: Tauri memakai IPC Rust, Web memakai route handler
 * Next.js. Pola inilah yang membuat satu halaman berjalan di tiga target tanpa
 * kode bercabang di dalam komponen.
 */
export interface ItemRecord {
  kode_item: string;
  nama: string;
  kategori: string | null;
  harga: number;
  satuan: string | null;
  catatan: string | null;
  status_aktif: "Active" | "Inactive";
  update_terakhir: string;
}

export type ItemDraft = Omit<ItemRecord, "update_terakhir">;

export async function listItems(): Promise<ItemRecord[]> {
  if (isDesktopRuntime()) {
    return invokeDesktop<ItemRecord[]>("desktop_list_items");
  }
  // Route handler Web wajib POST: build Desktop/Mobile memakai
  // `output: "export"` yang tidak dapat melayani GET dinamis.
  const result = await requestWebApi<{ items: ItemRecord[] }>(
    "/api/items/query",
    "POST",
    {},
  );
  return result.items ?? [];
}

export async function saveItem(item: ItemDraft): Promise<void> {
  if (isDesktopRuntime()) {
    await invokeDesktop("desktop_save_item", { item });
    return;
  }
  await requestWebApi("/api/items", "POST", item);
}

export async function deleteItem(kodeItem: string): Promise<void> {
  if (isDesktopRuntime()) {
    await invokeDesktop("desktop_delete_item", { kodeItem });
    return;
  }
  await requestWebApi("/api/items", "DELETE", { kode_item: kodeItem });
}

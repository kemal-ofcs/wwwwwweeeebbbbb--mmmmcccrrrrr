"use client";

import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

export interface SyncStatus {
  /**
   * Perangkat ini memakai Mode Database Lokal.
   *
   * Dipakai `AutoSyncRunner` untuk memutuskan apakah `navigator.onLine` boleh
   * dipakai sebagai alasan melewatkan siklus. Di mode lokal tidak boleh: push
   * di sana adalah operasi berkas, bukan jaringan.
   */
  localMode?: boolean;
  clientId: string;
  pending: number;
  synced: number;
  failed: number;
  conflict: number;
  lastRevision: number;
  lastSyncAt: number | null;
  /**
   * Jumlah baris per tabel snapshot, mengikuti `table_counts` di
   * `sync.rs::status`. Tambahkan entri di sini setiap kali Anda menambah tabel
   * snapshot baru supaya UI diagnostik ikut menampilkannya.
   */
  tableCounts: {
    items: number;
    activities: number;
  };
  /**
   * Terisi bila push gagal tetapi pull tetap berhasil pada siklus yang sama.
   * Kegagalan push tidak lagi membatalkan pull, jadi siklus bisa "berhasil
   * sebagian" — antrean outbox menunggu retry sementara data cloud tetap masuk.
   */
  pushError?: string;
  /**
   * Jumlah baris lokal yang benar-benar berubah pada siklus pull terakhir.
   * Nol berarti data lokal sudah identik dengan cloud — UI tidak perlu memuat
   * ulang apa pun, dan `app:sync-completed` tidak dipancarkan.
   */
  changedRows: number;
}

/** Siklus sinkronisasi selesai; `detail` berisi {@link SyncStatus}. */
export const SYNC_COMPLETED_EVENT = "app:sync-completed";
/** Siklus gagal (atau push gagal sebagian); `detail` berisi `{ message }`. */
export const SYNC_FAILED_EVENT = "app:sync-failed";
/**
 * Minta `AutoSyncRunner` menjalankan siklus sekarang, tanpa menunggu jadwal.
 * Dipakai setelah mutasi lokal supaya data langsung terkirim ke cloud.
 */
export const SYNC_REQUEST_EVENT = "app:sync-request";

/**
 * Membangunkan auto-sync setelah mutasi lokal.
 *
 * Aman dipanggil dari mana saja: no-op di luar runtime Tauri dan saat SSR.
 */
export function requestSyncNow() {
  if (typeof window === "undefined" || !isDesktopRuntime()) return;
  window.dispatchEvent(new CustomEvent(SYNC_REQUEST_EVENT));
}

export interface SyncConflict {
  eventId: string;
  domain: string;
  entityKey: string;
  reason: string;
  createdAt: number;
}

export function isDesktopSyncAvailable() {
  return isDesktopRuntime();
}

export async function getSyncStatus() {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<SyncStatus>("desktop_get_sync_status");
}

export async function syncNow() {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<SyncStatus>("desktop_sync_now");
}

export async function getSyncConflicts() {
  if (!isDesktopRuntime()) return [];
  return invokeDesktop<SyncConflict[]>("desktop_get_sync_conflicts");
}

export async function retryFailedSync(eventId?: string) {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<SyncStatus>("desktop_retry_failed_sync", { eventId });
}

export async function resolveSyncConflicts(eventId?: string) {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<SyncStatus>("desktop_resolve_sync_conflicts", {
    eventId,
  });
}

export async function resolveSyncConflictsLocal(eventId?: string) {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<SyncStatus>("desktop_resolve_sync_conflicts_local", {
    eventId,
  });
}

export async function clearFailedSync(eventId?: string) {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<SyncStatus>("desktop_clear_failed_sync", { eventId });
}

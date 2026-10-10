"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime, isMobileRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

/**
 * Simpan dokumen buatan webview (invoice PDF, v2.3c).
 *
 * - Android: dialog "Simpan ke…" Storage Access Framework (aturan 28);
 *   `savedToDevice: false` = pengguna menutup dialog, bukan kegagalan.
 * - Desktop: langsung ke folder Downloads, nama unik `(2)`, `(3)`, ….
 * - Web: unduhan biasa dari browser.
 */
export interface SavedDocument {
  /** Lokasi berkas di Desktop; null di Android dan Web. */
  path: string | null;
  savedToDevice: boolean;
}

export async function saveDocument(
  fileName: string,
  bytes: Uint8Array,
): Promise<SavedDocument> {
  // Guard POSITIF: bentuk yang dikenali `audit:contract` (aturan 27).
  if (isMobileRuntime()) {
    const result = await invokeDesktop<{ savedToDevice: boolean }>(
      "mobile_save_document",
      { fileName, dataBase64: toBase64(bytes) },
    );
    return { path: null, savedToDevice: result.savedToDevice };
  }
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ path: string }>(
      "desktop_save_document",
      { fileName, dataBase64: toBase64(bytes) },
    );
    return { path: result.path, savedToDevice: true };
  }
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: "application/pdf" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { path: null, savedToDevice: true };
}

export type ExportSubject = "clients" | "samples" | "invoices" | "funds";

/**
 * Simpan .xlsx (v2.8, PRD D-41) lewat jalur yang sama dengan PDF. `export`
 * menuntut `data.export` dan tercatat di log audit (Web: route
 * `/api/export/record` sebelum unduhan); `template` dibatasi 16 KB oleh
 * backend, jadi tidak bisa membawa daftar data keluar.
 */
export async function saveXlsx(
  fileName: string,
  bytes: Uint8Array,
  purpose: "export" | "template",
  subject: ExportSubject | "template",
  rows: number,
): Promise<SavedDocument> {
  const args = {
    fileName,
    dataBase64: toBase64(bytes),
    purpose,
    subject,
    rows,
  };
  // Guard POSITIF: bentuk yang dikenali `audit:contract` (aturan 27).
  if (isMobileRuntime()) {
    const result = await invokeDesktop<{ savedToDevice: boolean }>(
      "mobile_save_xlsx",
      args,
    );
    return { path: null, savedToDevice: result.savedToDevice };
  }
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ path: string }>(
      "desktop_save_xlsx",
      args,
    );
    return { path: result.path, savedToDevice: true };
  }
  if (purpose === "export") {
    await requestWebApi("/api/export/record", "POST", {
      subject,
      file_name: fileName,
      rows,
    });
  }
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { path: null, savedToDevice: true };
}

/** Dipotong per blok: `String.fromCharCode(...besar)` melempar RangeError. */
function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

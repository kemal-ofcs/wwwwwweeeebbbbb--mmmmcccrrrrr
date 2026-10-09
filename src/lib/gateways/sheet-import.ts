"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { DateOrder } from "@/lib/validations/client-import";
import type { SheetKind, SheetRowInput } from "@/lib/validations/sheet-import";

/**
 * Gateway impor sheet (v2.7, PRD F-22): Data Uang Masuk, Database Formulasi,
 * Database Desain, dan arsip impor per klien. Objek dikirim utuh di kedua
 * cabang, jadi tidak ada field yang bisa terlewat (aturan 41).
 */

export interface SheetImportRequest {
  kind: SheetKind;
  file_name: string;
  date_order: DateOrder;
  /** `true` = pratinjau tanpa menulis apa pun. */
  dry_run: boolean;
  rows: SheetRowInput[];
}

export interface SheetImportReport {
  dry_run: boolean;
  total: number;
  added: number;
  skipped: number;
  invalid: number;
  results: { line: number; status: "skipped" | "invalid"; message: string }[];
}

export interface ImportedRecord {
  id: string;
  kind: "FORMULA" | "DESIGN";
  client_id: string;
  /** `YYYY-MM-DD`, atau '' bila sheet tidak mencatatnya. */
  record_date: string;
  code: string;
  title: string;
  amount_idr: number | null;
  notes: string;
  source_file: string;
  created_at: string;
}

export async function importSheet(
  request: SheetImportRequest,
): Promise<SheetImportReport> {
  if (isDesktopRuntime()) {
    return invokeDesktop<SheetImportReport>("desktop_import_sheet", {
      import: request,
    });
  }
  return requestWebApi<SheetImportReport>("/api/import/sheet", "POST", request);
}

export async function listImportedRecords(
  clientId: string,
): Promise<ImportedRecord[]> {
  if (isDesktopRuntime()) {
    return invokeDesktop<ImportedRecord[]>("desktop_list_imported_records", {
      clientId,
    });
  }
  const result = await requestWebApi<{ records: ImportedRecord[] }>(
    "/api/import/records",
    "POST",
    { client_id: clientId },
  );
  return result.records ?? [];
}

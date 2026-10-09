import "server-only";

import type { Client } from "@libsql/client";
import { type AuditActor, writeAudit } from "@/lib/server/audit";
import { ApiRequestError } from "@/lib/server/http/api-response";
import { DATE_ORDERS, IMPORT_MAX_ROWS } from "@/lib/validations/client-import";
import { FUND_INSERT_SQL } from "@/lib/validations/finance";
import {
  IMPORTED_RECORD_INSERT_SQL,
  IMPORTED_RECORD_LIST_SQL,
  planSheetImport,
  SHEET_ARCHIVE_KEYS_SQL,
  SHEET_CLIENTS_SQL,
  SHEET_FUND_KEYS_SQL,
  type SheetKind,
  type SheetPlan,
  sheetImportPermission,
  sheetRowInput,
  sheetRowKey,
} from "@/lib/validations/sheet-import";

/**
 * Impor CSV Data Uang Masuk / Database Formulasi / Database Desain (PRD F-22,
 * v2.7) — jalur Web. Cermin `desktop_import_sheet`: pratinjau (`dry_run`) dan
 * simpan memakai `planSheetImport` yang sama. Izin per jenis diperiksa route
 * lewat `sheetImportPermission`.
 */

export interface SheetImportReport {
  dry_run: boolean;
  total: number;
  added: number;
  skipped: number;
  invalid: number;
  results: SheetPlan["results"];
}

/** Jenis sheet dan izinnya dari body, atau galat 400. Dipakai route sebelum cek izin. */
export function sheetKind(body: Record<string, unknown>) {
  const kind = typeof body.kind === "string" ? body.kind : "";
  const permission = sheetImportPermission(kind);
  if (permission === null) {
    throw new ApiRequestError("Choose which sheet to import.", 400);
  }
  return { kind: kind as SheetKind, permission };
}

function report(plan: SheetPlan, dryRun: boolean, total: number) {
  return {
    dry_run: dryRun,
    total,
    added: plan.valid.length,
    skipped: plan.results.filter((result) => result.status === "skipped")
      .length,
    invalid: plan.results.filter((result) => result.status === "invalid")
      .length,
    results: plan.results,
  };
}

const text = (row: Record<string, unknown>, key: string) =>
  typeof row[key] === "string" ? (row[key] as string) : "";

export async function importSheet(
  client: Client,
  body: Record<string, unknown>,
  actor: AuditActor,
): Promise<SheetImportReport> {
  const invalid = (message: string) => new ApiRequestError(message, 400);
  const { kind } = sheetKind(body);
  const dryRun = body.dry_run !== false;
  const dateOrder = body.date_order;
  if (
    typeof dateOrder !== "string" ||
    !(DATE_ORDERS as readonly string[]).includes(dateOrder)
  ) {
    throw invalid("Choose the date order used in the sheet.");
  }
  const fileName = [
    ...(typeof body.file_name === "string" ? body.file_name : ""),
  ]
    .slice(0, 200)
    .join("");
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    throw invalid("The file has no data rows.");
  }
  if (body.rows.length > IMPORT_MAX_ROWS) {
    throw invalid(
      "One import can hold at most 5000 rows. Split the file and import each part.",
    );
  }
  const rows = body.rows.map(sheetRowInput);

  const transaction = await client.transaction(dryRun ? "read" : "write");
  try {
    const clients = new Map(
      (await transaction.execute(SHEET_CLIENTS_SQL)).rows.map((row) => [
        String(row.client_code).toLowerCase(),
        String(row.id),
      ]),
    );
    const existing = new Set(
      kind === "FUNDS"
        ? (await transaction.execute(SHEET_FUND_KEYS_SQL)).rows.map((row) =>
            sheetRowKey("FUNDS", {
              client_id: "",
              date: text(row, "received_on"),
              code: "",
              title: "",
              amount_idr: Number(row.amount_idr),
              notes: text(row, "description"),
            }),
          )
        : (await transaction.execute(SHEET_ARCHIVE_KEYS_SQL)).rows.map((row) =>
            sheetRowKey(text(row, "kind") as SheetKind, {
              client_id: text(row, "client_id"),
              date: text(row, "record_date"),
              code: text(row, "code"),
              title: text(row, "title"),
              amount_idr: null,
              notes: "",
            }),
          ),
    );
    const plan = planSheetImport(kind, rows, {
      date_order: dateOrder as (typeof DATE_ORDERS)[number],
      clients,
      existing,
    });
    if (dryRun || plan.valid.length === 0) {
      return report(plan, dryRun, rows.length);
    }

    const clock = await transaction.execute("SELECT datetime('now') AS stamp;");
    const stamp = String(clock.rows[0]?.stamp);
    for (const row of plan.valid) {
      await transaction.execute(
        kind === "FUNDS"
          ? {
              sql: FUND_INSERT_SQL,
              args: [
                crypto.randomUUID(),
                row.client_id,
                row.date,
                row.amount_idr,
                row.notes,
                "",
                actor.id,
                stamp,
              ],
            }
          : {
              sql: IMPORTED_RECORD_INSERT_SQL,
              args: [
                crypto.randomUUID(),
                kind,
                row.client_id,
                row.date,
                row.code,
                row.title,
                row.amount_idr,
                row.notes,
                fileName,
                actor.id,
                stamp,
              ],
            },
      );
    }
    const result = report(plan, false, rows.length);
    await writeAudit(
      transaction,
      actor,
      "sheet.import",
      kind === "FUNDS" ? "fund" : "imported_record",
      "import",
      {
        kind,
        file_name: fileName,
        added: result.added,
        skipped: result.skipped,
        invalid: result.invalid,
      },
    );
    await transaction.commit();
    return result;
  } finally {
    transaction.close();
  }
}

/** Arsip impor satu klien, terbaru dulu. Cermin `desktop_list_imported_records`. */
export async function listImportedRecords(client: Client, clientId: unknown) {
  const result = await client.execute({
    sql: IMPORTED_RECORD_LIST_SQL,
    args: [typeof clientId === "string" ? clientId.trim() : ""],
  });
  return result.rows.map((row) => ({ ...row }));
}

"use client";

import { useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { PageHeader } from "@/components/ui/PageHeader";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  importSheet,
  type SheetImportReport,
} from "@/lib/gateways/sheet-import";
import {
  type DateOrder,
  detectDateOrder,
  IMPORT_MAX_ROWS,
  matchHeaders,
  parseCsv,
} from "@/lib/validations/client-import";
import {
  SHEET_FIELDS,
  SHEET_KINDS,
  type SheetFieldKey,
  type SheetKind,
  type SheetRowInput,
  sheetImportPermission,
} from "@/lib/validations/sheet-import";

/**
 * Impor CSV Data Uang Masuk, Database Formulasi, dan Database Desain (PRD
 * F-22, v2.7). Layar hanya membaca berkas dan menebak pemetaan; backend
 * (`importSheet`) memutuskan validitasnya, dipanggil dua kali dengan
 * pemeriksaan yang sama: pratinjau lalu simpan.
 */

const KIND_LABEL: Record<SheetKind, { title: string; hint: string }> = {
  FUNDS: {
    title: "Incoming payments (Data Uang Masuk)",
    hint: "Becomes incoming payments that can be allocated to invoices. Only include transfers that were not yet matched to an invoice in the sheet: everything imported shows as unallocated.",
  },
  FORMULA: {
    title: "Formulas (Database Formulasi)",
    hint: "Kept as read-only history on each client. Cost breakdowns (HPP, margin) are not imported.",
  },
  DESIGN: {
    title: "Designs (Database Desain)",
    hint: "Kept as read-only history on each client.",
  },
};

const DATE_ORDER_LABEL: Record<DateOrder, string> = {
  DMY: "Day/Month/Year (31/12/2026)",
  MDY: "Month/Day/Year (12/31/2026)",
};

interface SheetFile {
  name: string;
  headers: string[];
  rows: string[][];
}

export function SheetImport() {
  const { user } = useAuth();
  const allowed = SHEET_KINDS.filter((kind) => {
    const permission = sheetImportPermission(kind);
    return permission !== null && hasPermission(user, permission);
  });
  const [kind, setKind] = useState<SheetKind>(allowed[0] ?? "FUNDS");
  const [sheet, setSheet] = useState<SheetFile | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [dateOrder, setDateOrder] = useState<DateOrder | "">("");
  const [preview, setPreview] = useState<SheetImportReport | null>(null);
  const [saved, setSaved] = useState<SheetImportReport | null>(null);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [error, setError] = useState("");
  const isSubmittingRef = useRef(false);

  const fields = SHEET_FIELDS[kind];
  const reset = () => {
    setPreview(null);
    setSaved(null);
    setError("");
  };
  const cell = (key: SheetFieldKey, cells: string[]) => {
    const index = mapping[key] ?? -1;
    return index >= 0 ? (cells[index] ?? "") : "";
  };

  const load = (next: SheetKind, file: SheetFile | null) => {
    reset();
    setKind(next);
    setSheet(file);
    if (!file) return;
    const suggested = matchHeaders(file.headers, SHEET_FIELDS[next]);
    setMapping(suggested);
    setDateOrder(
      detectDateOrder(
        file.rows.map((cells) => cells[suggested.date ?? -1] ?? ""),
      ) ?? "",
    );
  };

  const chooseFile = async (file: File | undefined) => {
    load(kind, null);
    if (!file) return;
    const [headers, ...rows] = parseCsv(await file.text());
    if (!headers || rows.length === 0) {
      setError(
        "The file has no data rows. Export the sheet with File › Download › CSV.",
      );
      return;
    }
    if (rows.length > IMPORT_MAX_ROWS) {
      setError(
        `The file has ${rows.length} rows. One import can hold at most ${IMPORT_MAX_ROWS}; split the file and import each part.`,
      );
      return;
    }
    load(kind, { name: file.name, headers, rows });
  };

  const run = async (dryRun: boolean) => {
    if (!sheet || !dateOrder || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(dryRun ? "check" : "save");
    setError("");
    try {
      const rows: SheetRowInput[] = sheet.rows.map((cells, index) => ({
        // Baris 1 adalah header.
        line: index + 2,
        date: cell("date", cells),
        client_code: cell("client_code", cells),
        code: cell("code", cells),
        title: cell("title", cells),
        amount: cell("amount", cells),
        notes: cell("notes", cells),
      }));
      const result = await importSheet({
        kind,
        file_name: sheet.name,
        date_order: dateOrder,
        dry_run: dryRun,
        rows,
      });
      if (dryRun) {
        setPreview(result);
      } else {
        setSaved(result);
        setPreview(null);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The file could not be checked.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(null);
    }
  };

  const report = saved ?? preview;
  const columns = (sheet?.headers ?? []).map((header, index) => ({
    header,
    index,
  }));
  const sampleDates = (sheet?.rows ?? [])
    .map((cells) => cell("date", cells).trim())
    .filter(Boolean)
    .slice(0, 3);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Import sheets from CSV"
        description="Bring in incoming payments, formulas, or designs from the old sheets. Nothing is saved until you confirm, and rows already in the app are skipped."
      />

      {error ? (
        <FeedbackBanner tone="error" onDismiss={() => setError("")}>
          {error}
        </FeedbackBanner>
      ) : null}

      <section className="app-panel p-4 sm:p-5">
        <h2 className="text-headline-md text-on-surface">
          1. Choose the sheet and file
        </h2>
        <fieldset className="mt-3 grid gap-2">
          <legend className="app-label">Sheet</legend>
          {allowed.map((option) => (
            <label
              key={option}
              className="flex min-h-11 items-start gap-3 text-body-md text-on-surface"
            >
              <input
                type="radio"
                name="sheet-kind"
                checked={kind === option}
                onChange={() => load(option, sheet)}
                className="mt-1 size-4 accent-secondary"
              />
              <span>
                {KIND_LABEL[option].title}
                <span className="block text-body-sm text-on-surface-variant">
                  {KIND_LABEL[option].hint}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="app-label mt-3 grid gap-1.5">
          CSV file (File › Download › Comma-separated values, at most{" "}
          {IMPORT_MAX_ROWS} rows)
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => void chooseFile(event.target.files?.[0])}
            className="app-input font-normal"
          />
        </label>
        {sheet ? (
          <p className="mt-2 text-body-sm text-on-surface-variant">
            {sheet.name}: {sheet.rows.length} data rows, {sheet.headers.length}{" "}
            columns.
          </p>
        ) : null}
      </section>

      {sheet ? (
        <section className="app-panel p-4 sm:p-5">
          <h2 className="text-headline-md text-on-surface">
            2. Match the columns
          </h2>
          <p className="mt-1 text-body-md text-on-surface-variant">
            Columns were matched by their headers. Fix any that are wrong.
            {kind === "FUNDS"
              ? " Kode Klien is optional; payments without it stay unassigned."
              : " Kode Klien must match a client already in the app."}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {fields.map((field) => (
              <label key={field.key} className="app-label grid gap-1.5">
                {field.header}
                <select
                  value={mapping[field.key] ?? -1}
                  onChange={(event) => {
                    reset();
                    setMapping({
                      ...mapping,
                      [field.key]: Number(event.target.value),
                    });
                  }}
                  className="app-input font-normal"
                >
                  <option value={-1}>Not in this file</option>
                  {columns.map((column) => (
                    <option key={column.index} value={column.index}>
                      {column.header || `Column ${column.index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <fieldset className="mt-4">
            <legend className="app-label">Date order in this sheet</legend>
            <p className="mt-1 text-body-sm text-on-surface-variant">
              Sample values: {sampleDates.join(", ") || "none"}.{" "}
              {dateOrder
                ? "Chosen from the values in the file. Change it if it is wrong."
                : "The values fit both orders. Choose the one your sheet uses."}
            </p>
            <div className="mt-2 grid gap-2">
              {(Object.keys(DATE_ORDER_LABEL) as DateOrder[]).map((order) => (
                <label
                  key={order}
                  className="flex min-h-11 items-center gap-3 text-body-md text-on-surface"
                >
                  <input
                    type="radio"
                    name="sheet-date-order"
                    checked={dateOrder === order}
                    onChange={() => {
                      reset();
                      setDateOrder(order);
                    }}
                    className="size-4 accent-secondary"
                  />
                  {DATE_ORDER_LABEL[order]}
                </label>
              ))}
            </div>
          </fieldset>
        </section>
      ) : null}

      {sheet ? (
        <section className="app-panel p-4 sm:p-5">
          <h2 className="text-headline-md text-on-surface">
            3. Check and import
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void run(true)}
              disabled={busy !== null || !dateOrder}
              className="app-btn app-btn-secondary"
            >
              {busy === "check" ? "Checking..." : "Check file"}
            </button>
            <button
              type="button"
              onClick={() => void run(false)}
              disabled={busy !== null || !preview || preview.added === 0}
              className="app-btn app-btn-primary"
            >
              {busy === "save"
                ? "Importing..."
                : `Import ${preview?.added ?? 0} rows`}
            </button>
          </div>
          {!dateOrder ? (
            <p className="mt-2 text-body-sm text-on-surface-variant">
              Choose the date order first.
            </p>
          ) : null}

          {report ? (
            <div className="mt-4 space-y-3">
              <output
                className={`block rounded-md border p-3 text-body-md ${
                  saved
                    ? "border-success/30 bg-success-container text-on-success-container"
                    : "border-surface-container bg-surface-container-low text-on-surface"
                }`}
              >
                {saved
                  ? `Imported ${saved.added} rows.`
                  : `${report.added} of ${report.total} rows are ready to import.`}{" "}
                Skipped (already in the app): {report.skipped}. Rejected:{" "}
                {report.invalid}.
              </output>
              {report.results.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-left text-body-sm">
                    <thead className="text-label-caps text-on-surface-variant">
                      <tr>
                        <th className="py-2 pr-3">Row</th>
                        <th className="py-2 pr-3">Result</th>
                        <th className="py-2">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.results.slice(0, 500).map((row, index) => (
                        <tr
                          key={`${row.line}-${index}`}
                          className="border-t border-surface-container align-top"
                        >
                          <td className="py-2 pr-3 font-mono">{row.line}</td>
                          <td className="py-2 pr-3">
                            {row.status === "invalid" ? "Rejected" : "Skipped"}
                          </td>
                          <td className="py-2">{row.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {report.results.length > 500 ? (
                    <p className="mt-2 text-body-sm text-on-surface-variant">
                      Showing the first 500 rows with a problem.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

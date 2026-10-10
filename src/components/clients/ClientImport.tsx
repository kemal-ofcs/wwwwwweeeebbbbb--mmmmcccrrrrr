"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ImportColumnGuide } from "@/components/imports/ImportColumnGuide";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { readXlsx } from "@/lib/documents/xlsx";
import {
  type ClientImportReport,
  importClients,
  listMasterOptions,
  listOperatorDirectory,
  type MasterOptionRecord,
  type OperatorDirectoryEntry,
} from "@/lib/gateways/clients";
import {
  type DateOrder,
  detectDateOrder,
  IMPORT_FIELDS,
  IMPORT_MAX_ROWS,
  type ImportFieldKey,
  type ImportRowInput,
  parseCsv,
  suggestHeaderMapping,
} from "@/lib/validations/client-import";

/**
 * Impor CSV Sheet Database CS per PIC / Database Klien (PRD FR-09).
 * Layar hanya membaca berkas dan memetakan; seluruh pemeriksaan ada di
 * backend (`importClients`), dipanggil dua kali: pratinjau lalu simpan.
 */

interface SheetFile {
  name: string;
  headers: string[];
  rows: string[][];
}

type ValueKind = "channel" | "category" | "pic";

const VALUE_FIELD: Record<ValueKind, ImportFieldKey> = {
  channel: "channel",
  category: "category",
  pic: "pic",
};

const VALUE_TITLE: Record<ValueKind, string> = {
  channel: "Kode Asal Lead → lead channel",
  category: "Kategori Produk → product category",
  pic: "PIC Customer Service → operator",
};

const DATE_ORDER_LABEL: Record<DateOrder, string> = {
  DMY: "Day / Month / Year (3/10/2026 = 3 October)",
  MDY: "Month / Day / Year (10/3/2026 = 3 October)",
};

function same(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Tebakan pemetaan nilai; admin membetulkan lewat dropdown (keputusan B). */
function suggestValue(
  kind: ValueKind,
  raw: string,
  options: MasterOptionRecord[],
  operators: OperatorDirectoryEntry[],
): string {
  if (kind === "pic") {
    const exact = operators.find(
      (operator) =>
        same(operator.nama_operator, raw) || same(operator.kode_operator, raw),
    );
    if (exact) return String(exact.id);
    const byFirstName = operators.filter((operator) =>
      operator.nama_operator
        .toLowerCase()
        .startsWith(`${raw.trim().toLowerCase()} `),
    );
    return byFirstName.length === 1 ? String(byFirstName[0]?.id) : "";
  }
  const optionKind = kind === "channel" ? "LEAD_CHANNEL" : "PRODUCT_CATEGORY";
  const match = options.find(
    (option) =>
      option.kind === optionKind &&
      (same(option.code, raw) || same(option.label, raw)),
  );
  return match?.id ?? "";
}

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

/** Berkas impor → baris teks: .xlsx (Excel) atau .csv (v2.8). */
async function readSheetFile(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx")) {
    return readXlsx(new Uint8Array(await file.arrayBuffer()));
  }
  if (name.endsWith(".xls")) {
    throw new Error(
      "Old .xls files are not supported. In Excel, use Save As › Excel Workbook (.xlsx).",
    );
  }
  return parseCsv(await file.text());
}

export function ClientImport() {
  const [options, setOptions] = useState<MasterOptionRecord[]>([]);
  const [operators, setOperators] = useState<OperatorDirectoryEntry[]>([]);
  const [sheet, setSheet] = useState<SheetFile | null>(null);
  const [mapping, setMapping] = useState<Record<ImportFieldKey, number> | null>(
    null,
  );
  const [dateOrder, setDateOrder] = useState<DateOrder | "">("");
  const [valueMaps, setValueMaps] = useState<
    Record<ValueKind, Record<string, string>>
  >({ channel: {}, category: {}, pic: {} });
  const [defaults, setDefaults] = useState({ channel: "", category: "" });
  const [preview, setPreview] = useState<ClientImportReport | null>(null);
  const [saved, setSaved] = useState<ClientImportReport | null>(null);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [error, setError] = useState("");
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    void listMasterOptions()
      .then((rows) => setOptions(rows.filter((option) => option.is_active)))
      .catch(() => setOptions([]));
    void listOperatorDirectory()
      .then(setOperators)
      .catch(() => setOperators([]));
  }, []);

  const column = (field: ImportFieldKey, cells: string[]) => {
    const index = mapping?.[field] ?? -1;
    return index >= 0 ? (cells[index] ?? "") : "";
  };

  const distinct = useMemo(() => {
    const result: Record<ValueKind, string[]> = {
      channel: [],
      category: [],
      pic: [],
    };
    if (!sheet || !mapping) return result;
    for (const kind of Object.keys(VALUE_FIELD) as ValueKind[]) {
      const index = mapping[VALUE_FIELD[kind]];
      if (index < 0) continue;
      const values = new Set(
        sheet.rows.map((cells) => (cells[index] ?? "").trim()).filter(Boolean),
      );
      result[kind] = [...values].sort((a, b) => a.localeCompare(b));
    }
    return result;
  }, [sheet, mapping]);

  // Isi tebakan untuk nilai yang belum dipetakan setiap kali daftar berubah.
  useEffect(() => {
    setValueMaps((current) => {
      const next = { ...current };
      for (const kind of Object.keys(distinct) as ValueKind[]) {
        const map = { ...next[kind] };
        for (const raw of distinct[kind]) {
          if (map[raw] === undefined) {
            map[raw] = suggestValue(kind, raw, options, operators);
          }
        }
        next[kind] = map;
      }
      return next;
    });
  }, [distinct, options, operators]);

  const sampleDates: string[] = [];
  for (const cells of sheet?.rows ?? []) {
    for (const field of ["lead_created_at", "last_update"] as const) {
      const value = column(field, cells).trim();
      if (value && sampleDates.length < 3) sampleDates.push(value);
    }
    if (sampleDates.length >= 3) break;
  }

  const reset = () => {
    setPreview(null);
    setSaved(null);
    setError("");
  };

  const chooseFile = async (file: File | undefined) => {
    reset();
    setSheet(null);
    setMapping(null);
    if (!file) return;
    let table: string[][];
    try {
      table = await readSheetFile(file);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The file could not be read.",
      );
      return;
    }
    const [headers, ...rows] = table;
    if (!headers || rows.length === 0) {
      setError(
        "The file has no data rows. Put the headers in row 1 of the first sheet.",
      );
      return;
    }
    if (rows.length > IMPORT_MAX_ROWS) {
      setError(
        `The file has ${rows.length} rows. One import can hold at most ${IMPORT_MAX_ROWS}; split the file and import each part.`,
      );
      return;
    }
    const suggested = suggestHeaderMapping(headers);
    const dates = rows.flatMap((cells) => [
      cells[suggested.lead_created_at] ?? "",
      cells[suggested.last_update] ?? "",
    ]);
    setSheet({ name: file.name, headers, rows });
    setMapping(suggested);
    setDateOrder(detectDateOrder(dates) ?? "");
    setValueMaps({ channel: {}, category: {}, pic: {} });
  };

  const buildRows = (): ImportRowInput[] =>
    (sheet?.rows ?? []).map((cells, index) => {
      const resolve = (kind: "channel" | "category") => {
        const raw = column(VALUE_FIELD[kind], cells).trim();
        return (raw ? valueMaps[kind][raw] : "") || defaults[kind];
      };
      const picRaw = column("pic", cells).trim();
      const pic = picRaw ? valueMaps.pic[picRaw] : "";
      return {
        // Baris 1 adalah header.
        line: index + 2,
        client_code: column("client_code", cells),
        name: column("name", cells),
        phone: column("phone", cells),
        address: column("address", cells),
        city: column("city", cells),
        province: column("province", cells),
        needs_notes: column("needs_notes", cells),
        channel_option_id: resolve("channel"),
        product_category_option_id: resolve("category"),
        // Kosong atau tidak dipetakan = pengimpor (keputusan C).
        pic_cs_id: pic ? Number(pic) : null,
        lead_created_at: column("lead_created_at", cells),
        last_update: column("last_update", cells),
        total_followups: column("total_followups", cells),
        pic_answer: column("pic_answer", cells),
      };
    });

  const run = async (dryRun: boolean) => {
    if (!sheet || !dateOrder || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(dryRun ? "check" : "save");
    setError("");
    try {
      const result = await importClients({
        file_name: sheet.name,
        date_order: dateOrder,
        dry_run: dryRun,
        rows: buildRows(),
      });
      if (dryRun) {
        setPreview(result);
      } else {
        setSaved(result);
        setPreview(null);
      }
    } catch (cause) {
      setError(message(cause, "The file could not be checked."));
    } finally {
      isSubmittingRef.current = false;
      setBusy(null);
    }
  };

  const channelOptions = options.filter(
    (option) => option.kind === "LEAD_CHANNEL",
  );
  const categoryOptions = options.filter(
    (option) => option.kind === "PRODUCT_CATEGORY",
  );
  const choices = (kind: ValueKind) =>
    kind === "pic"
      ? operators.map((operator) => ({
          value: String(operator.id),
          label: `${operator.nama_operator} (${operator.kode_operator})`,
        }))
      : (kind === "channel" ? channelOptions : categoryOptions).map(
          (option) => ({
            value: option.id,
            label: `${option.label} (${option.code})`,
          }),
        );

  const report = saved ?? preview;
  const columns = (sheet?.headers ?? []).map((header, index) => ({
    header,
    index,
  }));
  const problems = report?.results ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Import clients from CSV"
        description="Bring in the CS sheet per PIC or the Client Database sheet. Nothing is saved until you confirm, and existing clients are never overwritten."
        actions={
          <Link
            href="/clients"
            className="app-btn app-btn-secondary w-full sm:w-auto"
          >
            <Icon name="arrow-left" className="size-4" />
            Back to clients
          </Link>
        }
      />

      {error ? (
        <FeedbackBanner tone="error" onDismiss={() => setError("")}>
          {error}
        </FeedbackBanner>
      ) : null}

      <section className="app-panel p-4 sm:p-5">
        <h2 className="text-headline-md text-on-surface">1. Choose the file</h2>
        <p className="mt-1 text-body-md text-on-surface-variant">
          An Excel workbook (.xlsx) or a CSV file; only the first sheet is read.
          One file holds at most {IMPORT_MAX_ROWS} rows.
        </p>
        <ImportColumnGuide
          fields={IMPORT_FIELDS}
          templateName="template-clients.xlsx"
        />
        <label className="app-label mt-3 grid gap-1.5">
          Excel or CSV file
          <input
            type="file"
            accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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

      {sheet && mapping ? (
        <section className="app-panel p-4 sm:p-5">
          <h2 className="text-headline-md text-on-surface">
            2. Match the columns
          </h2>
          <p className="mt-1 text-body-md text-on-surface-variant">
            Columns were matched by their headers. Fix any that are wrong.
            Status Lead is not imported: the segment is calculated from the last
            response date.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {IMPORT_FIELDS.map((field) => (
              <label key={field.key} className="app-label grid gap-1.5">
                {field.header}
                <select
                  value={mapping[field.key]}
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
                    name="date-order"
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

      {sheet && mapping ? (
        <section className="app-panel p-4 sm:p-5">
          <h2 className="text-headline-md text-on-surface">
            3. Match the values
          </h2>
          <p className="mt-1 text-body-md text-on-surface-variant">
            Each value found in the file is matched to Master Data or an
            operator. Rows with an empty or unmatched PIC go to you.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="app-label grid gap-1.5">
              When Kode Asal Lead is empty or unmatched
              <select
                value={defaults.channel}
                onChange={(event) => {
                  reset();
                  setDefaults({ ...defaults, channel: event.target.value });
                }}
                className="app-input font-normal"
              >
                <option value="">Reject the row</option>
                {choices("channel").map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="app-label grid gap-1.5">
              When Kategori Produk is empty or unmatched
              <select
                value={defaults.category}
                onChange={(event) => {
                  reset();
                  setDefaults({ ...defaults, category: event.target.value });
                }}
                className="app-input font-normal"
              >
                <option value="">Reject the row</option>
                {choices("category").map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(Object.keys(VALUE_FIELD) as ValueKind[]).map((kind) =>
            distinct[kind].length > 0 ? (
              <div key={kind} className="mt-4">
                <h3 className="text-body-md font-semibold text-on-surface">
                  {VALUE_TITLE[kind]}
                </h3>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {distinct[kind].map((raw) => (
                    <label key={raw} className="app-label grid gap-1.5">
                      <span className="font-mono">{raw}</span>
                      <select
                        value={valueMaps[kind][raw] ?? ""}
                        onChange={(event) => {
                          reset();
                          setValueMaps({
                            ...valueMaps,
                            [kind]: {
                              ...valueMaps[kind],
                              [raw]: event.target.value,
                            },
                          });
                        }}
                        className="app-input font-normal"
                      >
                        <option value="">
                          {kind === "pic"
                            ? "Not matched (you)"
                            : "Not matched (use default)"}
                        </option>
                        {choices(kind).map((choice) => (
                          <option key={choice.value} value={choice.value}>
                            {choice.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            ) : null,
          )}
          {channelOptions.length === 0 || categoryOptions.length === 0 ? (
            <p className="mt-3 text-body-sm text-on-surface-variant">
              Master Data has no active lead channel or product category yet.
              Add them in Settings › Master data first.
            </p>
          ) : null}
        </section>
      ) : null}

      {sheet && mapping ? (
        <section className="app-panel p-4 sm:p-5">
          <h2 className="text-headline-md text-on-surface">
            4. Check and import
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
                : `Import ${preview?.added ?? 0} clients`}
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
                  ? `Imported ${saved.added} clients.`
                  : `${report.added} of ${report.total} rows are ready to import.`}{" "}
                Skipped (already exist): {report.skipped}. Rejected:{" "}
                {report.invalid}.
              </output>
              {problems.length > 0 || report.warnings.length > 0 ? (
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
                      {[
                        ...problems,
                        ...report.warnings.map((warning) => ({
                          ...warning,
                          status: "warning" as const,
                        })),
                      ]
                        .slice(0, 500)
                        .map((row) => (
                          <tr
                            key={`${row.line}-${row.status}`}
                            className="border-t border-surface-container align-top"
                          >
                            <td className="py-2 pr-3 font-mono">{row.line}</td>
                            <td className="py-2 pr-3">
                              {row.status === "invalid"
                                ? "Rejected"
                                : row.status === "skipped"
                                  ? "Skipped"
                                  : "Imported, note shortened"}
                            </td>
                            <td className="py-2">{row.message}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  {problems.length + report.warnings.length > 500 ? (
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

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as rules from "./sheet-import";
import {
  parseSheetAmount,
  parseSheetDay,
  planSheetImport,
  type SheetKind,
  sheetImportPermission,
  sheetRowInput,
  sheetRowKey,
  validateSheetRow,
} from "./sheet-import";

// Vektor kembar: `mod tests` di `src-tauri/src/desktop/sheet_import.rs`
// memakai masukan dan keluaran yang persis sama. Ubah keduanya bersamaan.

test("nominal rupiah dibaca (nominal_rupiah_dibaca)", () => {
  const cases: [string, unknown][] = [
    ["Rp 1.500.000", { value: 1_500_000 }],
    ["rp.1,500,000", { value: 1_500_000 }],
    ["1500000,00", { value: 1_500_000 }],
    ["Rp 15.000,-", { value: 15_000 }],
    ["1.500", { value: 1500 }],
    ["007", { value: 7 }],
    ["  ", { empty: true }],
    ["1,50", { error: 'The amount "1,50" has cents. Use whole rupiah.' }],
    ["12.34.567", { error: 'The amount "12.34.567" could not be read.' }],
    ["-500", { error: 'The amount "-500" could not be read.' }],
    ["0", { error: 'The amount "0" is out of range.' }],
    [
      "100.000.000.001",
      { error: 'The amount "100.000.000.001" is out of range.' },
    ],
    [
      "9999999999999999",
      { error: 'The amount "9999999999999999" is out of range.' },
    ],
  ];
  for (const [raw, expected] of cases) {
    expect(parseSheetAmount(raw), raw).toEqual(expected as never);
  }
});

test("tanggal sheet menjadi hari (tanggal_sheet_menjadi_hari)", () => {
  expect(parseSheetDay("5/10/2026 23:30", "DMY")).toEqual({
    value: "2026-10-05",
  });
  expect(parseSheetDay("10/5/2026", "MDY")).toEqual({ value: "2026-10-05" });
  expect(parseSheetDay("2026-01-01 00:15:00", "DMY")).toEqual({
    value: "2026-01-01",
  });
  expect(parseSheetDay("", "DMY")).toEqual({ empty: true });
  expect(parseSheetDay("31/2/2026", "DMY")).toEqual({
    error: 'The date "31/2/2026" could not be read.',
  });
});

const input = (
  date: string,
  client_code: string,
  code: string,
  title: string,
  amount: string,
  notes: string,
) => sheetRowInput({ line: 2, date, client_code, code, title, amount, notes });

describe("baris sheet divalidasi (baris_sheet_divalidasi)", () => {
  test("sah", () => {
    const funds = validateSheetRow(
      "FUNDS",
      input("5/10/2026", " KP-1 ", "X", "Y", "Rp 2.000.000", " Transfer BCA "),
      "DMY",
    );
    expect(funds).toEqual({
      row: {
        line: 2,
        date: "2026-10-05",
        client_code: "KP-1",
        code: "",
        title: "",
        amount_idr: 2_000_000,
        notes: "Transfer BCA",
      },
    });
    const design = validateSheetRow(
      "DESIGN",
      input("", "KP-1", "D-01", "Aura", "abc", ""),
      "DMY",
    );
    expect(
      "row" in design ? [design.row.date, design.row.amount_idr] : design,
    ).toEqual(["", null]);
  });

  test("ditolak", () => {
    const errors: [SheetKind, ReturnType<typeof input>, string][] = [
      ["FUNDS", input("", "", "", "", "1000", ""), "Tanggal is empty."],
      ["FUNDS", input("1/1/2026", "", "", "", "", ""), "Nominal is empty."],
      [
        "FUNDS",
        input("1/1/2026", "", "", "", "1000", "a".repeat(301)),
        "The notes are longer than 300 characters.",
      ],
      [
        "FORMULA",
        input("", "", "F-1", "Serum", "", ""),
        "Kode Klien is empty.",
      ],
      [
        "FORMULA",
        input("", "KP-1", "F-1", " ", "", ""),
        "Nama Produk is empty.",
      ],
      ["DESIGN", input("", "KP-1", "", "", "", ""), "Brand is empty."],
      [
        "FORMULA",
        input("", "KP-1", "c".repeat(101), "Serum", "", ""),
        "The code is longer than 100 characters.",
      ],
      [
        "FORMULA",
        input("", "KP-1", "", "t".repeat(201), "", ""),
        "The name is longer than 200 characters.",
      ],
      [
        "FORMULA",
        input("", "KP-1", "", "Serum", "", "n".repeat(1001)),
        "The notes are longer than 1000 characters.",
      ],
      [
        "FORMULA",
        input("", "KP-1", "", "Serum", "1,5", ""),
        'The amount "1,5" could not be read.',
      ],
    ];
    for (const [kind, raw, error] of errors) {
      expect(validateSheetRow(kind, raw, "DMY"), error).toEqual({ error });
    }
  });
});

test("rencana impor melewati yang sudah ada (rencana_impor_melewati_yang_sudah_ada)", () => {
  const clients = new Map([["kp-1", "c1"]]);
  const key = { client_id: "", code: "", title: "", notes: "" };
  const existing = new Set([
    sheetRowKey("FUNDS", {
      ...key,
      date: "2026-10-05",
      amount_idr: 2_000_000,
      notes: "transfer bca",
    }),
    sheetRowKey("FORMULA", {
      ...key,
      client_id: "c1",
      date: "",
      code: "f-1",
      title: "serum",
      amount_idr: null,
    }),
  ]);
  const plan = planSheetImport(
    "FUNDS",
    [
      input("5/10/2026", "", "", "", "2.000.000", "Transfer BCA"),
      input("6/10/2026", "kp-1", "", "", "500.000", ""),
      input("6/10/2026", "KP-9", "", "", "500.000", ""),
      input("6/10/2026", "", "", "", "500.000", ""),
      input("6/10/2026", "", "", "", "500.000", ""),
    ],
    { date_order: "DMY", clients, existing },
  );
  expect(plan.valid.map((row) => [row.amount_idr, row.client_id])).toEqual([
    [500_000, "c1"],
    [500_000, ""],
    [500_000, ""],
  ]);
  expect(plan.results).toEqual([
    { line: 2, status: "skipped", message: "Already in the app." },
    {
      line: 2,
      status: "invalid",
      message: "Kode Klien KP-9 is not registered.",
    },
  ]);
  const archive = planSheetImport(
    "FORMULA",
    [
      input("", "KP-1", "F-1", "SERUM", "", ""),
      input("", "KP-1", "F-2", "Serum", "", ""),
    ],
    { date_order: "DMY", clients, existing },
  );
  expect(archive.valid.length).toBe(1);
  expect(archive.results[0]?.status).toBe("skipped");
  expect(sheetImportPermission("DESIGN")).toBe("design.manage");
  expect(sheetImportPermission("CLIENTS")).toBeNull();
});

test("setiap SQL identik dengan Rust", () => {
  const path = ["desktop", "mobile"]
    .map((dir) =>
      join(import.meta.dir, `../../../src-tauri/src/${dir}/sheet_import.rs`),
    )
    .find(existsSync);
  expect(path).toBeDefined();
  const rust = readFileSync(path as string, "utf8");
  const shared = Object.entries(rules).filter(
    ([name, value]) => typeof value === "string" && name.endsWith("_SQL"),
  );
  expect(shared.length).toBe(5);
  for (const [name, value] of shared) {
    expect(rust, name).toContain(`"${value}"`);
  }
});

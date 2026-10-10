import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { utcTimestamp } from "./client";
import * as rules from "./finance";

// Vektor kembar: `mod tests` di `src-tauri/src/desktop/finance.rs` memakai
// masukan dan keluaran yang persis sama. Ubah keduanya bersamaan.

describe("opsi keuangan (opsi_keuangan_divalidasi)", () => {
  test("sah", () => {
    expect(
      rules.validateFinanceOption({
        kind: "TAX",
        label: " PPN ",
        rate_bp: 1100,
      }),
    ).toEqual({
      option: {
        kind: "TAX",
        label: "PPN",
        rate_bp: 1100,
        installment_count: null,
        is_active: true,
      },
    });
    expect(
      rules.validateFinanceOption({
        kind: "DISCOUNT",
        label: "Lebaran",
        rate_bp: 2000,
        is_active: false,
      }),
    ).toEqual({
      option: {
        kind: "DISCOUNT",
        label: "Lebaran",
        rate_bp: 2000,
        installment_count: null,
        is_active: false,
      },
    });
    expect(
      rules.validateFinanceOption({
        kind: "INSTALLMENT_PLAN",
        label: "3x",
        rate_bp: 1000,
        installment_count: 3,
      }),
    ).toEqual({
      option: {
        kind: "INSTALLMENT_PLAN",
        label: "3x",
        rate_bp: 1000,
        installment_count: 3,
        is_active: true,
      },
    });
  });
  const cases: [unknown, string][] = [
    [
      { kind: "BONUS", label: "3x", rate_bp: 1000 },
      "Unknown finance option type.",
    ],
    [
      { kind: "INSTALLMENT_PLAN", label: "3x", rate_bp: 1000 },
      "Choose 1-24 monthly installments.",
    ],
    [
      {
        kind: "INSTALLMENT_PLAN",
        label: "x",
        rate_bp: 0,
        installment_count: 25,
      },
      "Choose 1-24 monthly installments.",
    ],
    [
      { kind: "TAX", label: "", rate_bp: 1100 },
      "The name must be 1-80 characters.",
    ],
    [
      { kind: "TAX", label: "PPN", rate_bp: 10001 },
      "The rate must be from 0% to 100%.",
    ],
    [
      { kind: "TAX", label: "PPN", rate_bp: "1100" },
      "The rate must be from 0% to 100%.",
    ],
    [
      { kind: "TAX", label: "PPN", rate_bp: 1100, is_active: "yes" },
      "Choose whether the option is active.",
    ],
  ];
  for (const [input, message] of cases) {
    test(message, () => {
      expect(rules.validateFinanceOption(input)).toEqual({ error: message });
    });
  }
});

describe("hitungan tagihan (hitungan_tagihan)", () => {
  test("diskon sebelum pajak, pajak dari subtotal setelah diskon", () => {
    expect(
      rules.computeInvoice({
        subtotal_idr: 1_000_000,
        discount: { label: "Lebaran", rate_bp: 2000 },
        taxes: [
          { label: "PPN", rate_bp: 1100 },
          { label: "Local", rate_bp: 150 },
        ],
      }),
    ).toEqual({
      totals: {
        subtotal_idr: 1_000_000,
        discount_label: "Lebaran",
        discount_bp: 2000,
        discount_idr: 200_000,
        taxes_json:
          '[{"amount_idr":88000,"label":"PPN","rate_bp":1100},{"amount_idr":12000,"label":"Local","rate_bp":150}]',
        tax_idr: 100_000,
        total_idr: 900_000,
      },
    });
  });
  test("pembulatan setengah ke atas", () => {
    const rounded = rules.computeInvoice({
      subtotal_idr: 333,
      taxes: [{ label: "PPN", rate_bp: 1100 }],
    });
    expect(
      "totals" in rounded
        ? [
            rounded.totals.tax_idr,
            rounded.totals.total_idr,
            rounded.totals.taxes_json,
          ]
        : rounded,
    ).toEqual([37, 370, '[{"amount_idr":37,"label":"PPN","rate_bp":1100}]']);
    expect(rules.applyRate(5, 1000)).toBe(1);
    expect(rules.applyRate(4, 1000)).toBe(0);
    const plain = rules.computeInvoice({ subtotal_idr: 500_000 });
    expect(
      "totals" in plain
        ? [
            plain.totals.discount_idr,
            plain.totals.tax_idr,
            plain.totals.total_idr,
            plain.totals.taxes_json,
          ]
        : plain,
    ).toEqual([0, 0, 500_000, "[]"]);
  });
  const cases: [unknown, string][] = [
    [{ subtotal_idr: 0 }, "Enter the amount in whole rupiah."],
    [{ subtotal_idr: 1.5 }, "Enter the amount in whole rupiah."],
    [{ subtotal_idr: 100_000_000_001 }, "Enter the amount in whole rupiah."],
    [
      { subtotal_idr: 100, discount: { label: "", rate_bp: 10 } },
      "The discount is invalid.",
    ],
    [
      { subtotal_idr: 100, taxes: [{ label: "PPN", rate_bp: -1 }] },
      "A tax is invalid.",
    ],
    [{ subtotal_idr: 100, taxes: "PPN" }, "A tax is invalid."],
    [
      {
        subtotal_idr: 100,
        taxes: Array.from({ length: 11 }, () => ({ label: "T", rate_bp: 1 })),
      },
      "An invoice can carry at most 10 taxes.",
    ],
  ];
  for (const [input, message] of cases) {
    test(message, () => {
      expect(rules.computeInvoice(input)).toEqual({ error: message });
    });
  }
});

describe("jenis tagihan per tiket (jenis_tagihan_per_tiket)", () => {
  const paid = {
    is_paid_sample: true,
    is_test_requested: true,
    revision_fee_idr: 750_000,
    dummy_round: 0,
    mou_accepted: true,
    batch_packed: true,
    settlement_cleared: true,
    storage_fee_idr: 60_000,
  };
  const free = {
    is_paid_sample: false,
    is_test_requested: false,
    revision_fee_idr: null,
    dummy_round: null,
    mou_accepted: false,
    batch_packed: false,
    settlement_cleared: false,
    storage_fee_idr: 0,
  };
  const waived = { ...paid, storage_fee_idr: 0 };
  const cases: [string, typeof paid | typeof free | null, string | null][] = [
    ["SAMPLE_FEE", paid, null],
    ["TEST_FEE", paid, null],
    ["REVISION_FEE", paid, null],
    ["OTHER", null, null],
    ["SAMPLE_FEE", free, "This sample is free, so it has no sample fee."],
    ["TEST_FEE", free, "This sample was not requested with testing."],
    ["REVISION_FEE", free, "Finance has not set a fee for this revision."],
    ["SAMPLE_FEE", null, "Choose the sample request this invoice is for."],
    ["DUMMY_FEE", paid, null],
    ["DUMMY_FEE", free, "Request a design for this sample first."],
    ["DP_PRODUCTION_LEGAL", paid, null],
    ["DP_PRODUCTION_LEGAL", free, "The client has not accepted the MoU yet."],
    ["PRINT_FEE", paid, "Choose what the invoice is for."],
    ["SETTLEMENT", paid, null],
    ["SETTLEMENT", free, "Production is not packed yet."],
    ["SHIPPING", free, "Production is not packed yet."],
    ["STORAGE_FEE", paid, null],
    ["STORAGE_FEE", free, "The settlement invoice is not paid yet."],
    ["STORAGE_FEE", waived, "There is no storage fee for this order."],
  ];
  for (const [refType, ticket, expected] of cases) {
    test(`${refType} ${expected}`, () => {
      expect(rules.invoiceTypeError(refType, ticket)).toBe(expected);
    });
  }
  test("revision_index per jenis", () => {
    expect(rules.invoiceRevisionIndex("REVISION_FEE", 2, 1)).toBe(2);
    expect(rules.invoiceRevisionIndex("DUMMY_FEE", 2, 1)).toBe(1);
    expect(rules.invoiceRevisionIndex("DUMMY_FEE", 2, null)).toBe(0);
    expect(rules.invoiceRevisionIndex("SAMPLE_FEE", 2, 1)).toBe(0);
  });
});

describe("alokasi lunas penuh (alokasi_lunas_penuh)", () => {
  test("pesan identik dengan Rust", () => {
    expect(rules.allocationError(500_000, 500_000, 600_000)).toBeNull();
    expect(rules.allocationError(0, 500_000, 600_000)).toBe(
      "Enter the amount in whole rupiah.",
    );
    expect(rules.allocationError(undefined, 500_000, 600_000)).toBe(
      "Enter the amount in whole rupiah.",
    );
    expect(rules.allocationError(10, 0, 600_000)).toBe(
      "This invoice is already paid.",
    );
    expect(rules.allocationError(450_000, 500_000, 600_000)).toBe(
      "The amount must equal the unpaid Rp 500.000 of this invoice (difference -Rp 50.000).",
    );
    expect(rules.allocationError(500_000, 500_000, 300_000)).toBe(
      "This incoming payment only has Rp 300.000 left to allocate.",
    );
    const row = (
      invoice: string,
      remaining: unknown,
      fund: string,
      unallocated: unknown,
    ) => ({
      invoice_status: invoice,
      invoice_remaining: remaining,
      fund_status: fund,
      fund_unallocated: unallocated,
    });
    expect(
      rules.allocationCheck(row("OPEN", 500_000, "ACTIVE", "600000"), 500_000),
    ).toBeNull();
    expect(
      rules.allocationCheck(
        row("CANCELLED", 500_000, "ACTIVE", 600_000),
        500_000,
      ),
    ).toBe("This invoice is cancelled or does not exist.");
    expect(
      rules.allocationCheck(row("OPEN", 500_000, "VOID", 600_000), 500_000),
    ).toBe("This incoming payment is void or does not exist.");
    expect(rules.allocationCheck(undefined, 1)).toBe(
      "This invoice is cancelled or does not exist.",
    );
    expect(rules.normalizeCancelReason("  Wrong amount ")).toBe("Wrong amount");
    expect(rules.normalizeCancelReason("   ")).toBeNull();
    expect(rules.normalizeCancelReason("x".repeat(301))).toBeNull();
  });
});

describe("isian uang masuk (isian_uang_masuk)", () => {
  test("sah", () => {
    expect(
      rules.validateFundDraft({
        received_on: "2026-10-08",
        amount_idr: 500_000,
        client_id: " c1 ",
        description: " BCA transfer ",
      }),
    ).toEqual({
      fund: {
        received_on: "2026-10-08",
        amount_idr: 500_000,
        client_id: "c1",
        description: "BCA transfer",
      },
    });
  });
  const cases: [unknown, string][] = [
    [
      { received_on: "2026-02-30", amount_idr: 1 },
      "Enter the date the money arrived.",
    ],
    [
      { received_on: "2026-10-08", amount_idr: 0 },
      "Enter the amount in whole rupiah.",
    ],
    [
      { received_on: "2026-10-08", amount_idr: "500000" },
      "Enter the amount in whole rupiah.",
    ],
    [
      {
        received_on: "2026-10-08",
        amount_idr: 1,
        description: "d".repeat(301),
      },
      "The description is up to 300 characters.",
    ],
  ];
  for (const [input, message] of cases) {
    test(message, () => {
      expect(rules.validateFundDraft(input)).toEqual({ error: message });
    });
  }
});

describe("cicilan dan pembayaran sebagian (cicilan_dan_pembayaran_sebagian)", () => {
  test("tambah bulan kalender", () => {
    expect(rules.addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(rules.addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(rules.addMonths("2026-10-08", 3)).toBe("2027-01-08");
    expect(rules.addMonths("2026-12-15", 12)).toBe("2027-12-15");
  });
  test("bunga sekali atas sisa, dibagi rata, sisa pembulatan di cicilan terakhir", () => {
    const line = (
      installment_no: number,
      amount_idr: number,
      due_on: string,
    ) => ({
      installment_no,
      amount_idr,
      due_on,
    });
    expect(rules.computeInstallments(5_000_000, 1000, 3, "2026-10-08")).toEqual(
      {
        interest_idr: 500_000,
        total_idr: 5_500_000,
        lines: [
          line(1, 1_833_333, "2026-11-08"),
          line(2, 1_833_333, "2026-12-08"),
          line(3, 1_833_334, "2027-01-08"),
        ],
      },
    );
    expect(rules.computeInstallments(1_000_000, 500, 1, "2026-01-31")).toEqual({
      interest_idr: 50_000,
      total_idr: 1_050_000,
      lines: [line(1, 1_050_000, "2026-02-28")],
    });
    expect(
      rules.computeInstallments(700_000, 0, 7, "2026-10-08").lines[6],
    ).toEqual(line(7, 100_000, "2027-05-08"));
  });
  test("pembayaran sebagian dan deposit, pesan identik dengan Rust", () => {
    expect(
      rules.partialPaymentError(300_000, "SAMPLE_FEE", 500_000, 300_000),
    ).toBeNull();
    expect(
      rules.partialPaymentError(500_000, "SAMPLE_FEE", 500_000, 600_000),
    ).toBe(
      "A partial payment must be less than the unpaid Rp 500.000. Use Allocate for a full payment.",
    );
    expect(
      rules.partialPaymentError(300_000, "SAMPLE_FEE", 500_000, 200_000),
    ).toBe("This incoming payment only has Rp 200.000 left to allocate.");
    expect(rules.partialPaymentError(0, "OTHER", 500_000, 200_000)).toBe(
      "Enter the amount in whole rupiah.",
    );
    expect(rules.partialPaymentError(1, "INSTALLMENT", 500_000, 200_000)).toBe(
      "An installment cannot be rescheduled again. Cancel it and create a new invoice instead.",
    );
    expect(rules.installmentNumber("INV-20261008-A101", 2)).toBe(
      "INV-20261008-A101-2",
    );
    expect(
      rules.installmentDescription(2, 3, "INV-20261008-A101", "3x 10%"),
    ).toBe("Installment 2 of 3 for INV-20261008-A101 (3x 10%)");
    expect(rules.depositError("ACTIVE", "", "c1", 1)).toBeNull();
    expect(rules.depositError("VOID", "", "c1", 1)).toBe(
      "This incoming payment is void or does not exist.",
    );
    expect(rules.depositError("ACTIVE", "2026-10-08 01:00:00", "c1", 1)).toBe(
      "This payment is already kept as a deposit.",
    );
    expect(rules.depositError("ACTIVE", "", "", 1)).toBe(
      "Choose the client this deposit belongs to.",
    );
    expect(rules.depositError("ACTIVE", "", "c1", 0)).toBe(
      "Nothing is left on this payment to keep as a deposit.",
    );
  });
});

describe("tanggal tagihan (tanggal_tagihan)", () => {
  test("zona perusahaan", () => {
    const epoch = 1_791_489_600;
    expect(utcTimestamp(epoch)).toBe("2026-10-08 20:00:00");
    expect(rules.invoiceDates(epoch, "Asia/Jakarta", 7)).toEqual({
      issued_on: "2026-10-09",
      due_on: "2026-10-16",
    });
    expect(rules.invoiceDates(epoch, "Asia/Jayapura", 0)).toEqual({
      issued_on: "2026-10-09",
      due_on: "2026-10-09",
    });
  });
});

test("setiap SQL dan pesan identik dengan Rust", () => {
  const path = ["desktop", "mobile"]
    .map((dir) =>
      join(import.meta.dir, `../../../src-tauri/src/${dir}/finance.rs`),
    )
    .find(existsSync);
  expect(path).toBeDefined();
  const rust = readFileSync(path as string, "utf8");
  const shared = Object.entries(rules).filter(
    ([name, value]) =>
      typeof value === "string" &&
      (name.endsWith("_SQL") ||
        name === "INVOICE_DUPLICATE" ||
        name === "CANCEL_REASON_INVALID"),
  );
  expect(shared.length).toBeGreaterThan(10);
  for (const [name, value] of shared) {
    expect(rust, name).toContain(`"${value}"`);
  }
});

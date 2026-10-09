import { describe, expect, test } from "bun:test";
import {
  applySampleAction,
  computeUnitPrice,
  formatRupiah,
  isCalendarDate,
  normalizeApprovalWebUrl,
  REVISION_FEE_INVALID,
  type RndStep,
  readBusinessSettings,
  SAMPLE_ACTIONS,
  SAMPLE_FEE_UNPAID,
  SAMPLE_MOCKUP_MISSING,
  SAMPLE_NOT_PRICED,
  SAMPLE_STATUSES,
  SAMPLE_STEP_NOT_ALLOWED,
  SAMPLE_TEST_UNPAID,
  type SampleAction,
  sampleActionPermission,
  TELEGRAM_CHAT_ID_INVALID,
  validateBusinessSettings,
  validateRndStep,
  validateSampleDraft,
} from "./sample";

// Vektor kembar: `mod tests` di `src-tauri/src/desktop/samples.rs` memakai
// masukan dan keluaran yang persis sama. Ubah keduanya bersamaan.

describe("gerbang tagihan lunas (gerbang_tagihan_lunas)", () => {
  const cases: [string, boolean, boolean, SampleAction, string][] = [
    [
      "WAITING_SAMPLE_PAYMENT",
      false,
      true,
      "PAYMENT_RECEIVED",
      SAMPLE_FEE_UNPAID,
    ],
    ["WAITING_SAMPLE_PAYMENT", true, true, "PAYMENT_RECEIVED", "IN_RND"],
    [
      "WAITING_REVISION_PAYMENT",
      false,
      true,
      "PAYMENT_RECEIVED",
      SAMPLE_FEE_UNPAID,
    ],
    ["IN_RND", false, true, "PAYMENT_RECEIVED", SAMPLE_STEP_NOT_ALLOWED],
    ["SAMPLE_READY", true, false, "SAMPLE_SENT", SAMPLE_TEST_UNPAID],
    ["SAMPLE_READY", true, true, "SAMPLE_SENT", "SAMPLE_SENT"],
  ];
  for (const [status, feePaid, testReady, action, expected] of cases) {
    test(`${status} + ${action}`, () => {
      const result = applySampleAction(
        {
          status,
          is_paid_sample: true,
          revision_index: 1,
          free_revision_limit: 0,
          has_price: true,
          fee_paid: feePaid,
          test_ready: testReady,
          mockup_ready: true,
        },
        action,
        null,
        null,
      );
      expect("error" in result ? result.error : result.status).toBe(expected);
    });
  }
  test("mockup wajib sebelum Sample sent (v2.4)", () => {
    const result = applySampleAction(
      {
        status: "SAMPLE_READY",
        is_paid_sample: true,
        revision_index: 1,
        free_revision_limit: 0,
        has_price: true,
        fee_paid: true,
        test_ready: true,
        mockup_ready: false,
      },
      "SAMPLE_SENT",
      null,
      null,
    );
    expect(result).toEqual({ error: SAMPLE_MOCKUP_MISSING });
  });
});

describe("tarif revisi dan gerbang harga (tarif_revisi_dan_gerbang_harga)", () => {
  const cases: [string, boolean, string, number | null, unknown][] = [
    ["SAMPLE_READY", false, "SAMPLE_SENT", null, { error: SAMPLE_NOT_PRICED }],
    ["SAMPLE_READY", true, "SAMPLE_SENT", null, ["SAMPLE_SENT", 2, null]],
    ["DRAFT", false, "SAMPLE_SENT", null, { error: SAMPLE_STEP_NOT_ALLOWED }],
    [
      "PENDING_FEE_ASSESSMENT",
      false,
      "SET_REVISION_FEE",
      750_000,
      ["WAITING_REVISION_PAYMENT", 2, null],
    ],
    [
      "PENDING_FEE_ASSESSMENT",
      false,
      "SET_REVISION_FEE",
      0,
      ["IN_RND", 2, false],
    ],
    [
      "PENDING_FEE_ASSESSMENT",
      false,
      "SET_REVISION_FEE",
      -1,
      { error: REVISION_FEE_INVALID },
    ],
    [
      "PENDING_FEE_ASSESSMENT",
      false,
      "SET_REVISION_FEE",
      null,
      { error: REVISION_FEE_INVALID },
    ],
    [
      "IN_RND",
      false,
      "SET_REVISION_FEE",
      1000,
      { error: SAMPLE_STEP_NOT_ALLOWED },
    ],
  ];
  for (const [status, hasPrice, action, fee, expected] of cases) {
    test(`${status} + ${action} ${fee}`, () => {
      const result = applySampleAction(
        {
          status,
          is_paid_sample: false,
          revision_index: 2,
          free_revision_limit: 1,
          has_price: hasPrice,
          fee_paid: true,
          test_ready: true,
          mockup_ready: true,
        },
        action as SampleAction,
        null,
        fee,
      );
      expect(
        "error" in result
          ? result
          : [result.status, result.revision_index, result.is_billable],
      ).toEqual(expected as never);
    });
  }
});

describe("harga satuan dan format rupiah (harga_satuan_dan_format_rupiah)", () => {
  const price = (
    raw: unknown,
    packaging: unknown,
    operational: unknown,
    regulatory: unknown,
    margin: unknown,
  ) => {
    const result = computeUnitPrice({
      raw_material_cost_idr: raw,
      packaging_cost_idr: packaging,
      operational_cost_idr: operational,
      regulatory_cost_idr: regulatory,
      margin_bp: margin,
      notes: " 10k pcs ",
    });
    return "error" in result
      ? result
      : [
          result.price.hpp_unit_idr,
          result.price.final_unit_price_idr,
          result.price.notes,
        ];
  };
  const costError = {
    error: "Each cost must be a whole rupiah amount per unit.",
  };
  const cases: [unknown[], unknown][] = [
    [
      [8420, 7850, 2450, 780, 4000],
      [19_500, 32_500, "10k pcs"],
    ],
    [
      [100, 0, 0, 0, 3333],
      [100, 150, "10k pcs"],
    ],
    [
      [1, 0, 0, 0, 0],
      [1, 1, "10k pcs"],
    ],
    [
      [19_500, 0, 0, 0, 9500],
      [19_500, 390_000, "10k pcs"],
    ],
    [[-1, 0, 0, 0, 0], costError],
    [[1.5, 0, 0, 0, 0], costError],
    [["100", 0, 0, 0, 0], costError],
    [[1, 0, 0, null, 0], costError],
    [[0, 0, 0, 0, 0], { error: "Enter at least one cost." }],
    [[1, 0, 0, 0, 9501], { error: "The margin must be from 0% to 95%." }],
    [[1, 0, 0, 0, null], { error: "The margin must be from 0% to 95%." }],
  ];
  for (const [args, expected] of cases) {
    test(JSON.stringify(args), () => {
      const [raw, packaging, operational, regulatory, margin] = args;
      expect(price(raw, packaging, operational, regulatory, margin)).toEqual(
        expected as never,
      );
    });
  }
  test("catatan paling banyak 1000 karakter", () => {
    expect(
      computeUnitPrice({
        raw_material_cost_idr: 1,
        packaging_cost_idr: 0,
        operational_cost_idr: 0,
        regulatory_cost_idr: 0,
        margin_bp: 0,
        notes: "n".repeat(1001),
      }),
    ).toEqual({ error: "Notes are up to 1000 characters." });
  });
  test("format rupiah", () => {
    for (const [value, text] of [
      [0, "Rp 0"],
      [500, "Rp 500"],
      [32_500, "Rp 32.500"],
      [1_234_567, "Rp 1.234.567"],
      [-5000, "-Rp 5.000"],
    ] as const) {
      expect(formatRupiah(value)).toBe(text);
    }
  });
});

describe("izin langkah dan isian RnD (izin_langkah_dan_isian_rnd)", () => {
  test("izin per langkah", () => {
    for (const [action, permission] of [
      ["RND_ACCEPT", "rnd.manage"],
      ["RND_REJECT", "rnd.manage"],
      ["SAMPLE_READY", "rnd.manage"],
      ["PAYMENT_RECEIVED", "finance.manage"],
      ["SET_REVISION_FEE", "finance.manage"],
      ["SUBMIT_TO_RND", "samples.manage"],
      ["UNKNOWN", "samples.manage"],
    ]) {
      expect(sampleActionPermission(action)).toBe(permission as never);
    }
  });

  const step = (
    product_class: RndStep["product_class"],
    reject_reason_option_id: string | null,
    formula_code: string | null,
    product_knowledge: string | null,
  ) => ({
    rnd: {
      product_class,
      reject_reason_option_id,
      formula_code,
      product_knowledge,
    },
  });
  const cases: [string, unknown, unknown][] = [
    ["RND_ACCEPT", { product_class: "NEW" }, step("NEW", null, null, null)],
    [
      "RND_ACCEPT",
      { product_class: " EXISTING " },
      step("EXISTING", null, null, null),
    ],
    [
      "RND_ACCEPT",
      { product_class: "new" },
      { error: "Choose whether this is a new or an existing product." },
    ],
    [
      "RND_ACCEPT",
      {},
      { error: "Choose whether this is a new or an existing product." },
    ],
    [
      "RND_REJECT",
      { reject_reason_option_id: "r1" },
      step(null, "r1", null, null),
    ],
    [
      "RND_REJECT",
      { product_class: "NEW", reject_reason_option_id: "r1" },
      step("NEW", "r1", null, null),
    ],
    [
      "RND_REJECT",
      { product_class: "OLD", reject_reason_option_id: "r1" },
      { error: "Choose whether this is a new or an existing product." },
    ],
    [
      "RND_REJECT",
      { product_class: "NEW" },
      { error: "Choose the reason RnD rejected the request." },
    ],
    [
      "SAMPLE_READY",
      { formula_code: " FRM-001 ", product_knowledge: "Gel, pH 5.5" },
      step(null, null, "FRM-001", "Gel, pH 5.5"),
    ],
    [
      "SAMPLE_READY",
      { product_knowledge: "Gel" },
      { error: "Enter the formula code, up to 60 characters." },
    ],
    [
      "SAMPLE_READY",
      { formula_code: "F".repeat(61), product_knowledge: "Gel" },
      { error: "Enter the formula code, up to 60 characters." },
    ],
    [
      "SAMPLE_READY",
      { formula_code: "FRM-001", product_knowledge: "k".repeat(2001) },
      { error: "Enter the product knowledge, up to 2000 characters." },
    ],
    [
      "SAMPLE_SENT",
      { product_class: "NEW", formula_code: "X" },
      step(null, null, null, null),
    ],
    [
      "RND_ACCEPT",
      null,
      { error: "Choose whether this is a new or an existing product." },
    ],
  ];
  for (const [action, input, expected] of cases) {
    test(`${action} ${JSON.stringify(input)}`, () => {
      expect(validateRndStep(action, input)).toEqual(expected as never);
    });
  }
});

describe("alamat Web persetujuan (alamat_web_persetujuan_dinormalkan)", () => {
  const cases: [string, string | null][] = [
    ["", ""],
    ["  ", ""],
    ["https://crm.company.id", "https://crm.company.id"],
    ["https://crm.company.id/", "https://crm.company.id"],
    ["https://10.0.0.5:3000/maklon/", "https://10.0.0.5:3000/maklon"],
    ["http://crm.company.id", null],
    ["https://", null],
    ["https://crm.company.id:abc", null],
    ["https://crm.company.id:1:2", null],
    ["https://crm.company.id/a?b=1", null],
    ["https://user@crm.company.id", null],
    [`https://${"a".repeat(200)}.id`, null],
  ];
  for (const [value, expected] of cases) {
    test(JSON.stringify(value).slice(0, 40), () => {
      expect(normalizeApprovalWebUrl(value)).toBe(expected);
    });
  }
});

describe("readBusinessSettings", () => {
  const defaults = {
    default_free_revision_limit: 1,
    sample_fee_mode: "PER_REQUEST" as const,
    lead_hot_max_days: 3,
    lead_warm_max_days: 7,
    max_photos_per_sample: 10,
    telegram_chat_id_cs: "",
    telegram_chat_id_rnd: "",
    telegram_chat_id_finance: "",
    offline_login_max_days: 7,
    default_sample_fee_idr: 0,
    default_test_fee_idr: 0,
    invoice_due_days: 7,
    invoice_payment_instructions: "",
    telegram_chat_id_design: "",
    default_dummy_fee_idr: 0,
    max_dummy_rejections: 0,
    dp_percentage_bp: 5000,
    approval_web_url: "",
    approval_token_ttl_days: 3,
  };
  test("kosong = bawaan", () => {
    expect(readBusinessSettings({})).toEqual(defaults);
  });
  test("nilai sah dipakai, nilai rusak jatuh ke bawaan satu per satu", () => {
    expect(
      readBusinessSettings({
        default_free_revision_limit: "2",
        sample_fee_mode: "PAID",
        lead_hot_max_days: "5",
        lead_warm_max_days: "14",
        max_photos_per_sample: "5",
        telegram_chat_id_cs: " -1001234567890 ",
        telegram_chat_id_rnd: "@maklon_rnd",
        telegram_chat_id_finance: "finance group",
        offline_login_max_days: "3",
        default_sample_fee_idr: "150000",
        default_test_fee_idr: "1500000000",
        invoice_due_days: "14",
        invoice_payment_instructions: " BCA 123 a.n. Company ",
        telegram_chat_id_design: "@maklon_design",
        default_dummy_fee_idr: "75000",
        max_dummy_rejections: "3",
        dp_percentage_bp: "3000",
        approval_web_url: " https://crm.company.id/ ",
        approval_token_ttl_days: "7",
      }),
    ).toEqual({
      default_free_revision_limit: 2,
      sample_fee_mode: "PAID",
      lead_hot_max_days: 5,
      lead_warm_max_days: 14,
      max_photos_per_sample: 5,
      telegram_chat_id_cs: "-1001234567890",
      telegram_chat_id_rnd: "@maklon_rnd",
      telegram_chat_id_finance: "",
      offline_login_max_days: 3,
      default_sample_fee_idr: 150_000,
      default_test_fee_idr: 1_500_000_000,
      invoice_due_days: 14,
      invoice_payment_instructions: "BCA 123 a.n. Company",
      telegram_chat_id_design: "@maklon_design",
      default_dummy_fee_idr: 75_000,
      max_dummy_rejections: 3,
      dp_percentage_bp: 3000,
      approval_web_url: "https://crm.company.id",
      approval_token_ttl_days: 7,
    });
    expect(
      readBusinessSettings({
        default_free_revision_limit: "99",
        sample_fee_mode: "paid",
        lead_hot_max_days: "9",
        lead_warm_max_days: "9",
        max_photos_per_sample: "0",
        offline_login_max_days: "9",
        max_dummy_rejections: "21",
        dp_percentage_bp: "0",
        approval_web_url: "http://crm.company.id",
        approval_token_ttl_days: "31",
      }),
    ).toEqual(defaults);
  });
});

describe("validateBusinessSettings", () => {
  const valid = {
    default_free_revision_limit: 0,
    sample_fee_mode: "FREE",
    lead_hot_max_days: 0,
    lead_warm_max_days: 1,
    max_photos_per_sample: 1,
    telegram_chat_id_cs: "",
    telegram_chat_id_rnd: "12345",
    telegram_chat_id_finance: "@finance_team",
    offline_login_max_days: 1,
    default_sample_fee_idr: 0,
    default_test_fee_idr: 250_000,
    invoice_due_days: 0,
    invoice_payment_instructions: " Transfer to BCA ",
    telegram_chat_id_design: "",
    default_dummy_fee_idr: 50_000,
    max_dummy_rejections: 2,
    dp_percentage_bp: 10_000,
    approval_web_url: "",
    approval_token_ttl_days: 30,
  };
  test("sah", () => {
    expect(validateBusinessSettings(valid)).toEqual({
      settings: {
        ...valid,
        invoice_payment_instructions: "Transfer to BCA",
      } as never,
    });
  });
  const cases: [Record<string, unknown>, string][] = [
    [
      { ...valid, default_free_revision_limit: 21 },
      "Free revisions must be a whole number from 0 to 20.",
    ],
    [
      { ...valid, default_free_revision_limit: 1.5 },
      "Free revisions must be a whole number from 0 to 20.",
    ],
    [
      { ...valid, sample_fee_mode: "SOMETIMES" },
      "Choose how sample fees are charged.",
    ],
    [
      { ...valid, default_sample_fee_idr: -1 },
      "Default fees must be whole rupiah amounts.",
    ],
    [
      { ...valid, default_test_fee_idr: null },
      "Default fees must be whole rupiah amounts.",
    ],
    [
      { ...valid, default_dummy_fee_idr: -5 },
      "Default fees must be whole rupiah amounts.",
    ],
    [{ ...valid, telegram_chat_id_design: null }, TELEGRAM_CHAT_ID_INVALID],
    ...[21, -1, "2"].map(
      (limit) =>
        [
          { ...valid, max_dummy_rejections: limit },
          "The dummy rejection limit must be a whole number from 0 to 20.",
        ] as [Record<string, unknown>, string],
    ),
    ...["http://crm.company.id", null, "https://crm company.id"].map(
      (url) =>
        [
          { ...valid, approval_web_url: url },
          "Enter the approval web address as https://..., or leave it empty.",
        ] as [Record<string, unknown>, string],
    ),
    ...[0, 31, "3"].map(
      (ttl) =>
        [
          { ...valid, approval_token_ttl_days: ttl },
          "Approval links must last a whole number of days from 1 to 30.",
        ] as [Record<string, unknown>, string],
    ),
    ...[0, 10_001, "50"].map(
      (dp) =>
        [
          { ...valid, dp_percentage_bp: dp },
          "The down payment must be from 0.01% to 100%.",
        ] as [Record<string, unknown>, string],
    ),
    [
      { ...valid, invoice_payment_instructions: null },
      "Payment instructions are up to 1000 characters.",
    ],
    [
      { ...valid, invoice_payment_instructions: "x".repeat(1001) },
      "Payment instructions are up to 1000 characters.",
    ],
    [
      { ...valid, invoice_due_days: 91 },
      "The invoice due period must be a whole number of days from 0 to 90.",
    ],
    [
      { ...valid, lead_hot_max_days: 61 },
      "The Hot limit must be a whole number of days from 0 to 60.",
    ],
    [
      { ...valid, lead_hot_max_days: 5, lead_warm_max_days: 5 },
      "The Warm limit must be more days than the Hot limit, up to 180.",
    ],
    [
      { ...valid, lead_warm_max_days: 181 },
      "The Warm limit must be more days than the Hot limit, up to 180.",
    ],
    [
      { ...valid, max_photos_per_sample: 51 },
      "Photos per sample request must be a whole number from 1 to 50.",
    ],
    [
      { ...valid, max_photos_per_sample: 0 },
      "Photos per sample request must be a whole number from 1 to 50.",
    ],
    [{ ...valid, telegram_chat_id_cs: "@abc" }, TELEGRAM_CHAT_ID_INVALID],
    [{ ...valid, telegram_chat_id_rnd: "12-34" }, TELEGRAM_CHAT_ID_INVALID],
    [{ ...valid, telegram_chat_id_finance: null }, TELEGRAM_CHAT_ID_INVALID],
    ...[0, 8, "3"].map(
      (days) =>
        [
          { ...valid, offline_login_max_days: days },
          "The offline sign-in period must be a whole number of days from 1 to 7.",
        ] as [Record<string, unknown>, string],
    ),
  ];
  for (const [draft, message] of cases) {
    test(message, () => {
      expect(validateBusinessSettings(draft)).toEqual({ error: message });
    });
  }
});

describe("applySampleAction", () => {
  const base = {
    status: "DRAFT",
    is_paid_sample: false,
    revision_index: 0,
    free_revision_limit: 1,
    has_price: true,
    fee_paid: true,
    test_ready: true,
    mockup_ready: true,
  };
  // [status, paid, revision_index, limit, action, lead time] → [status, index, billable, decision] | error
  const cases: [
    string,
    boolean,
    number,
    number,
    SampleAction,
    number | null,
    [string, number, boolean | null, string | null] | string,
  ][] = [
    [
      "DRAFT",
      false,
      0,
      1,
      "SUBMIT_TO_RND",
      null,
      ["RND_REVIEW", 0, null, null],
    ],
    [
      "RND_REVIEW",
      false,
      0,
      1,
      "RND_ACCEPT",
      14,
      ["RND_ACCEPTED", 0, null, null],
    ],
    [
      "RND_REVIEW",
      false,
      0,
      1,
      "RND_ACCEPT",
      null,
      "Enter the RnD lead time in days (1-365).",
    ],
    [
      "RND_REVIEW",
      false,
      0,
      1,
      "RND_ACCEPT",
      366,
      "Enter the RnD lead time in days (1-365).",
    ],
    [
      "RND_REVIEW",
      false,
      0,
      1,
      "RND_REJECT",
      null,
      ["RND_REJECTED", 0, null, null],
    ],
    [
      "RND_ACCEPTED",
      true,
      0,
      1,
      "PROCEED",
      null,
      ["WAITING_SAMPLE_PAYMENT", 0, null, null],
    ],
    ["RND_ACCEPTED", false, 0, 1, "PROCEED", null, ["IN_RND", 0, null, null]],
    [
      "WAITING_SAMPLE_PAYMENT",
      true,
      0,
      1,
      "PAYMENT_RECEIVED",
      null,
      ["IN_RND", 0, null, null],
    ],
    [
      "WAITING_REVISION_PAYMENT",
      true,
      2,
      1,
      "PAYMENT_RECEIVED",
      null,
      ["IN_RND", 2, null, null],
    ],
    [
      "IN_RND",
      false,
      0,
      1,
      "SAMPLE_READY",
      null,
      ["SAMPLE_READY", 0, null, null],
    ],
    [
      "SAMPLE_READY",
      false,
      0,
      1,
      "SAMPLE_SENT",
      null,
      ["SAMPLE_SENT", 0, null, null],
    ],
    [
      "SAMPLE_SENT",
      false,
      0,
      1,
      "CLIENT_ACC",
      null,
      ["CLIENT_ACC", 0, null, "ACC"],
    ],
    [
      "SAMPLE_SENT",
      false,
      0,
      1,
      "CLIENT_REJECT",
      null,
      ["CLIENT_REJECT", 0, null, "REJECT"],
    ],
    // Kriteria terima FR-06: kuota 1 → revisi pertama gratis, kedua menunggu Finance.
    [
      "SAMPLE_SENT",
      false,
      0,
      1,
      "CLIENT_REVISE",
      null,
      ["IN_RND", 1, false, "REVISE"],
    ],
    [
      "SAMPLE_SENT",
      false,
      1,
      1,
      "CLIENT_REVISE",
      null,
      ["PENDING_FEE_ASSESSMENT", 2, true, "REVISE"],
    ],
    [
      "SAMPLE_SENT",
      false,
      0,
      0,
      "CLIENT_REVISE",
      null,
      ["PENDING_FEE_ASSESSMENT", 1, true, "REVISE"],
    ],
    [
      "PENDING_FEE_ASSESSMENT",
      false,
      2,
      1,
      "CANCEL",
      null,
      ["CANCELLED", 2, null, null],
    ],
    ["DRAFT", false, 0, 1, "CANCEL", null, ["CANCELLED", 0, null, null]],
    // Langkah di luar diagram.
    [
      "DRAFT",
      false,
      0,
      1,
      "SAMPLE_SENT",
      null,
      "This step is not allowed from the current status.",
    ],
    [
      "IN_RND",
      false,
      0,
      1,
      "CLIENT_REVISE",
      null,
      "This step is not allowed from the current status.",
    ],
    [
      "PENDING_FEE_ASSESSMENT",
      false,
      2,
      1,
      "PAYMENT_RECEIVED",
      null,
      "This step is not allowed from the current status.",
    ],
    [
      "CLIENT_ACC",
      false,
      0,
      1,
      "CANCEL",
      null,
      "This step is not allowed from the current status.",
    ],
    [
      "CANCELLED",
      false,
      0,
      1,
      "CANCEL",
      null,
      "This step is not allowed from the current status.",
    ],
    [
      "UNKNOWN",
      false,
      0,
      1,
      "CANCEL",
      null,
      "This step is not allowed from the current status.",
    ],
  ];
  for (const [status, paid, index, limit, action, lead, expected] of cases) {
    test(`${status} + ${action}`, () => {
      const result = applySampleAction(
        {
          ...base,
          status,
          is_paid_sample: paid,
          revision_index: index,
          free_revision_limit: limit,
        },
        action,
        lead,
      );
      if (typeof expected === "string") {
        expect(result).toEqual({ error: expected });
      } else {
        expect(result).toEqual({
          status: expected[0] as never,
          revision_index: expected[1],
          is_billable: expected[2],
          client_decision: expected[3] as never,
        });
      }
    });
  }

  test("setiap pasangan status × aksi punya jawaban, tidak pernah melempar", () => {
    for (const status of SAMPLE_STATUSES) {
      for (const action of SAMPLE_ACTIONS) {
        expect(() =>
          applySampleAction({ ...base, status }, action, 7),
        ).not.toThrow();
      }
    }
  });
});

describe("validateSampleDraft", () => {
  const draft = {
    product_category_option_id: "cat-1",
    sample_qty: 3,
    brand_name: " Aura Glow ",
    packaging: "Amber dropper 30 ml",
    deadline_at: "2026-10-31",
    ship_to_address: "Jl. Merdeka 1, Bandung",
    is_dummy_required: false,
    is_paid_sample: true,
    special_requests: { color: "Clear", aroma: "Rose", extra: "ignored" },
    client_budget_idr: 2500000,
  };
  test("rapi dan lengkap", () => {
    expect(validateSampleDraft(draft, "PER_REQUEST")).toEqual({
      draft: {
        product_category_option_id: "cat-1",
        sample_kind_option_id: "",
        formulation_type_option_id: "",
        registration_category_option_id: "",
        pic_crm_id: null,
        sample_qty: 3,
        brand_name: "Aura Glow",
        bpom_product_name: "",
        claims: "",
        packaging: "Amber dropper 30 ml",
        reference_notes: "",
        client_budget_idr: 2500000,
        special_requests_json:
          '{"color":"Clear","texture":"","size":"","aroma":"Rose"}',
        deadline_at: "2026-10-31",
        ship_to_address: "Jl. Merdeka 1, Bandung",
        is_dummy_required: false,
        is_paid_sample: true,
        is_test_requested: false,
      },
    });
  });
  test("uji opsional, bila dikirim harus boolean", () => {
    const testing = validateSampleDraft(
      { ...draft, is_test_requested: true },
      "PER_REQUEST",
    );
    expect("draft" in testing && testing.draft.is_test_requested).toBe(true);
    expect(
      validateSampleDraft(
        { ...draft, is_test_requested: "yes" },
        "PER_REQUEST",
      ),
    ).toEqual({ error: "Choose whether the sample is tested." });
  });
  test("mode FREE/PAID menentukan biaya; pilihan yang berbeda ditolak", () => {
    const { is_paid_sample: _paid, ...unset } = draft;
    const free = validateSampleDraft(unset, "FREE");
    expect("draft" in free && free.draft.is_paid_sample).toBe(false);
    const paid = validateSampleDraft(unset, "PAID");
    expect("draft" in paid && paid.draft.is_paid_sample).toBe(true);
    expect(validateSampleDraft(draft, "FREE")).toEqual({
      error: "Company settings make every sample free.",
    });
  });
  const cases: [Record<string, unknown>, string][] = [
    [{ product_category_option_id: "" }, "Choose the product type."],
    [{ sample_qty: 0 }, "Enter the sample quantity (1-10000)."],
    [{ sample_qty: "3" }, "Enter the sample quantity (1-10000)."],
    [{ brand_name: "  " }, "The brand name is required, up to 120 characters."],
    [{ packaging: "" }, "The packaging is required, up to 300 characters."],
    [
      { deadline_at: "2026-02-30" },
      "Enter the date the sample must reach the client.",
    ],
    [
      { ship_to_address: "" },
      "The shipping address is required, up to 300 characters.",
    ],
    [
      { is_dummy_required: "no" },
      "Choose whether a packaging dummy is needed.",
    ],
    [
      { client_budget_idr: 10.5 },
      "The client budget must be a whole rupiah amount.",
    ],
    [
      { client_budget_idr: -1 },
      "The client budget must be a whole rupiah amount.",
    ],
    [{ pic_crm_id: -4 }, "Choose an active CRM operator."],
    [{ is_paid_sample: null }, "Choose whether this sample is paid."],
  ];
  for (const [override, message] of cases) {
    test(message + JSON.stringify(override), () => {
      expect(
        validateSampleDraft({ ...draft, ...override }, "PER_REQUEST"),
      ).toEqual({ error: message });
    });
  }
});

test("isCalendarDate", () => {
  expect(isCalendarDate("2028-02-29")).toBe(true);
  expect(isCalendarDate("2026-02-29")).toBe(false);
  expect(isCalendarDate("2026-13-01")).toBe(false);
  expect(isCalendarDate("26-01-01")).toBe(false);
});

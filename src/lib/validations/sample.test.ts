import { describe, expect, test } from "bun:test";
import {
  applySampleAction,
  isCalendarDate,
  readBusinessSettings,
  SAMPLE_ACTIONS,
  SAMPLE_STATUSES,
  type SampleAction,
  validateBusinessSettings,
  validateSampleDraft,
} from "./sample";

// Vektor kembar: `mod tests` di `src-tauri/src/desktop/samples.rs` memakai
// masukan dan keluaran yang persis sama. Ubah keduanya bersamaan.

describe("readBusinessSettings", () => {
  test("kosong = bawaan", () => {
    expect(readBusinessSettings({})).toEqual({
      default_free_revision_limit: 1,
      sample_fee_mode: "PER_REQUEST",
      lead_hot_max_days: 3,
      lead_warm_max_days: 7,
      max_photos_per_sample: 10,
    });
  });
  test("nilai sah dipakai, nilai rusak jatuh ke bawaan satu per satu", () => {
    expect(
      readBusinessSettings({
        default_free_revision_limit: "2",
        sample_fee_mode: "PAID",
        lead_hot_max_days: "5",
        lead_warm_max_days: "14",
        max_photos_per_sample: "5",
      }),
    ).toEqual({
      default_free_revision_limit: 2,
      sample_fee_mode: "PAID",
      lead_hot_max_days: 5,
      lead_warm_max_days: 14,
      max_photos_per_sample: 5,
    });
    expect(
      readBusinessSettings({
        default_free_revision_limit: "99",
        sample_fee_mode: "paid",
        lead_hot_max_days: "9",
        lead_warm_max_days: "9",
        max_photos_per_sample: "0",
      }),
    ).toEqual({
      default_free_revision_limit: 1,
      sample_fee_mode: "PER_REQUEST",
      lead_hot_max_days: 3,
      lead_warm_max_days: 7,
      max_photos_per_sample: 10,
    });
  });
});

describe("validateBusinessSettings", () => {
  const valid = {
    default_free_revision_limit: 0,
    sample_fee_mode: "FREE",
    lead_hot_max_days: 0,
    lead_warm_max_days: 1,
    max_photos_per_sample: 1,
  };
  test("sah", () => {
    expect(validateBusinessSettings(valid)).toEqual({
      settings: valid as never,
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
      },
    });
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

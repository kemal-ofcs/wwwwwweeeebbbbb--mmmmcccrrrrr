import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as rules from "./mou";
import {
  applyMouAction,
  MOU_DUMMY_PENDING,
  MOU_VALUE_TOO_LARGE,
  mouRequestError,
  validateMouTerms,
} from "./mou";
import { DP_PERCENTAGE_INVALID } from "./sample";

// Vektor kembar: `mod tests` di `src-tauri/src/desktop/mou.rs` memakai
// masukan dan keluaran yang persis sama. Ubah keduanya bersamaan.

const terms = {
  total_units: 10_000,
  unit_price_idr: 32_500,
  production_lead_time_days: 45,
  regulatory_path: "WITH_BPOM",
  dp_bp: 5000,
  notes: " Box 30 ml ",
};

describe("isi MoU (isi_mou_dihitung_dan_divalidasi)", () => {
  test("total dan DP dihitung", () => {
    expect(validateMouTerms(terms)).toEqual({
      terms: {
        total_units: 10_000,
        unit_price_idr: 32_500,
        total_production_cost_idr: 325_000_000,
        production_lead_time_days: 45,
        regulatory_path: "WITH_BPOM",
        dp_bp: 5000,
        dp_amount_required_idr: 162_500_000,
        notes: "Box 30 ml",
      },
    });
    const odd = validateMouTerms({
      ...terms,
      total_units: 3,
      unit_price_idr: 333,
      dp_bp: 3333,
    });
    expect(
      "terms" in odd
        ? [
            odd.terms.total_production_cost_idr,
            odd.terms.dp_amount_required_idr,
          ]
        : odd,
    ).toEqual([999, 333]);
    const { notes: _notes, ...bare } = terms;
    const noNotes = validateMouTerms(bare);
    expect("terms" in noNotes ? noNotes.terms.notes : noNotes).toBe("");
  });
  const cases: [Record<string, unknown>, string][] = [
    [{ total_units: 0 }, "Enter the number of units (1 to 10,000,000)."],
    [{ total_units: "10" }, "Enter the number of units (1 to 10,000,000)."],
    [{ unit_price_idr: 0 }, "Enter the unit price in whole rupiah."],
    [{ unit_price_idr: 10_000_001 }, MOU_VALUE_TOO_LARGE],
    [
      { production_lead_time_days: 366 },
      "Enter the production lead time in days (1-365).",
    ],
    [{ regulatory_path: "BPOM" }, "Choose White Label or With BPOM."],
    [{ dp_bp: 0 }, DP_PERCENTAGE_INVALID],
    [{ notes: "x".repeat(1001) }, "Notes are up to 1000 characters."],
    [{ notes: 5 }, "Notes are up to 1000 characters."],
  ];
  for (const [change, message] of cases) {
    test(`${JSON.stringify(change).slice(0, 40)} → ${message}`, () => {
      expect(validateMouTerms({ ...terms, ...change })).toEqual({
        error: message,
      });
    });
  }
});

test("langkah MoU (langkah_mou_mengikuti_diagram)", () => {
  const step = (status: string, ready: boolean, action: string) => {
    const result = applyMouAction({ status, dummy_ready: ready }, action);
    return "error" in result ? result.error : result.result.status;
  };
  expect(step("DRAFT", true, "SEND_MOU")).toBe("SENT");
  expect(step("DRAFT", false, "SEND_MOU")).toBe(MOU_DUMMY_PENDING);
  expect(step("SENT", false, "MOU_ACCEPT")).toBe("ACCEPTED");
  expect(step("SENT", true, "MOU_REVISE")).toBe("DRAFT");
  expect(step("SENT", true, "MOU_REJECT")).toBe("REJECTED");
  expect(step("DRAFT", true, "CANCEL_MOU")).toBe("CANCELLED");
  const wrong = "This step is not available for the MoU's current status.";
  expect(step("ACCEPTED", true, "CANCEL_MOU")).toBe(wrong);
  expect(step("DRAFT", true, "MOU_ACCEPT")).toBe(wrong);
  expect(step("SENT", true, "SEND_MOU")).toBe(wrong);
  expect(step("DRAFT", true, "SIGN")).toBe("This MoU step does not exist.");
  expect(mouRequestError("CLIENT_ACC", 0)).toBeNull();
  expect(mouRequestError("SAMPLE_SENT", 0)).toBe(
    "The client has not approved the sample yet.",
  );
  expect(mouRequestError("CLIENT_ACC", 1)).toBe(
    "This sample request already has a MoU.",
  );
});

test("setiap SQL dan pesan identik dengan Rust", () => {
  const path = ["desktop", "mobile"]
    .map((dir) => join(import.meta.dir, `../../../src-tauri/src/${dir}/mou.rs`))
    .find(existsSync);
  expect(path).toBeDefined();
  const rust = readFileSync(path as string, "utf8");
  const shared = Object.entries(rules).filter(
    ([name, value]) =>
      typeof value === "string" &&
      (name.endsWith("_SQL") ||
        name.startsWith("MOU_") ||
        name === "MOU_CREATE_ACTION"),
  );
  expect(shared.length).toBe(11);
  for (const [name, value] of shared) {
    expect(rust, name).toContain(`"${value}"`);
  }
});

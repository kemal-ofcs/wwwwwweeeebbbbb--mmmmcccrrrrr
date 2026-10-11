import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as rules from "./crm";
import {
  CRM_FORWARD_INVALID,
  crmOwnerError,
  reorderDue,
  repeatOrderError,
  validateCrmForward,
} from "./crm";

// Vektor kembar: `mod tests` di `src-tauri/src/desktop/crm.rs`.

test("gerbang CS dan forward (gerbang_cs_dan_forward)", () => {
  expect(crmOwnerError("FIRST_ORDER_ACTIVE", false, "")).toBeNull();
  expect(crmOwnerError("EXISTING_CLIENT", true, "Rendi")).toBeNull();
  expect(crmOwnerError("EXISTING_CLIENT", false, " Rendi ")).toBe(
    "This client is managed by CRM (PIC: Rendi).",
  );
  expect(crmOwnerError("EXISTING_CLIENT", false, "")).toBe(
    "This client is managed by CRM (PIC: not assigned yet).",
  );
  expect(validateCrmForward({ notes: " Wants 5000 pcs " })).toEqual({
    notes: "Wants 5000 pcs",
  });
  expect(validateCrmForward({ notes: "" })).toEqual({
    error: CRM_FORWARD_INVALID,
  });
  expect(validateCrmForward({ notes: "x".repeat(501) })).toEqual({
    error: CRM_FORWARD_INVALID,
  });
});

test("syarat repeat order (syarat_repeat_order)", () => {
  expect(repeatOrderError("CLIENT_ACC", true)).toBeNull();
  expect(repeatOrderError("CLIENT_ACC", false)).toBe(
    "The order of this sample is not completed yet.",
  );
  expect(repeatOrderError("SAMPLE_SENT", true)).toBe(
    "Only an approved sample can start a repeat order.",
  );
});

test("repeat order jatuh tempo", () => {
  const row = {
    reorder_on: "2026-12-01",
    today: "2026-12-01",
    open_tickets: 0,
  };
  expect(reorderDue(row)).toBe(true);
  expect(reorderDue({ ...row, today: "2026-11-30" })).toBe(false);
  expect(reorderDue({ ...row, open_tickets: 1 })).toBe(false);
  expect(reorderDue({ ...row, reorder_on: "" })).toBe(false);
});

test("SQL identik dengan Rust", () => {
  const path = ["desktop", "mobile"]
    .map((dir) => join(import.meta.dir, `../../../src-tauri/src/${dir}/crm.rs`))
    .find(existsSync);
  expect(path).toBeDefined();
  const rust = readFileSync(path as string, "utf8");
  const shared = Object.entries(rules).filter(
    ([name, value]) =>
      typeof value === "string" &&
      (name.endsWith("_SQL") ||
        name.endsWith("_INVALID") ||
        name.endsWith("_ACTION") ||
        name.endsWith("_NOTES") ||
        name === "CRM_NOT_HANDED_OVER"),
  );
  expect(shared.length).toBe(14);
  for (const [name, value] of shared) {
    expect(rust, name).toContain(`"${value}"`);
  }
});

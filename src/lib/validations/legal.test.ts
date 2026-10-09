import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as rules from "./legal";
import {
  LEGAL_DP_PENDING,
  legalComplete,
  legalGateError,
  legalKindPermission,
  legalLogNotes,
  validateLegalRecord,
} from "./legal";

// Vektor kembar: `mod tests` di `src-tauri/src/desktop/legal.rs` memakai
// masukan dan keluaran yang persis sama. Ubah keduanya bersamaan.

const issued = {
  kind: "BPOM",
  status: "ISSUED",
  reference_no: " REG-1 ",
  certificate_no: "NA18260100001",
  bpom_type: "NA",
  submitted_on: "2026-10-01",
  issued_on: "2026-11-01",
  expires_on: "2029-11-01",
  notes: "",
};

describe("isian dokumen (isian_dokumen_divalidasi)", () => {
  test("sah", () => {
    const record = validateLegalRecord(issued);
    expect(
      "record" in record
        ? [
            record.record.status,
            record.record.reference_no,
            record.record.bpom_type,
            record.record.expires_on,
          ]
        : record,
    ).toEqual(["ISSUED", "REG-1", "NA", "2029-11-01"]);
    const submitted = validateLegalRecord({ ...issued, status: "SUBMITTED" });
    expect(
      "record" in submitted
        ? [submitted.record.certificate_no, submitted.record.issued_on]
        : submitted,
    ).toEqual(["", ""]);
    const skip = validateLegalRecord({
      kind: "HKI",
      status: "NOT_REQUIRED",
      notes: " Client owns the brand ",
      reference_no: "X",
    });
    expect(
      "record" in skip ? [skip.record.notes, skip.record.reference_no] : skip,
    ).toEqual(["Client owns the brand", ""]);
    expect("record" in skip && legalLogNotes(skip.record)).toBe(
      "Not required: Client owns the brand",
    );
    expect(
      validateLegalRecord({ kind: "HKI", status: "NOT_REQUIRED", notes: "" }),
    ).toEqual({ error: "Write why this document is not required." });
    const halal = validateLegalRecord({
      ...issued,
      kind: "HALAL",
      bpom_type: "MD",
    });
    expect("record" in halal && halal.record.bpom_type).toBe("");
    const bpom = validateLegalRecord(issued);
    expect("record" in bpom && legalLogNotes(bpom.record)).toBe(
      "Issued, certificate NA18260100001 (NA)",
    );
  });
  const cases: [Record<string, unknown>, string][] = [
    [{ kind: "PIRT" }, "Choose the document."],
    [{ status: "DONE" }, "Choose what happened to the document."],
    [{ status: "NOT_REQUIRED" }, "BPOM registration cannot be skipped."],
    [
      { reference_no: "" },
      "Enter the submission number, up to 100 characters.",
    ],
    [{ submitted_on: "2026-02-30" }, "Enter the submission date."],
    [{ bpom_type: "ML" }, "Choose MD or NA for the BPOM registration."],
    [
      { certificate_no: "x".repeat(101) },
      "Enter the certificate number, up to 100 characters.",
    ],
    [
      { issued_on: "2026-09-30" },
      "The issue date cannot be before the submission date.",
    ],
    [
      { expires_on: "2026-11-01" },
      "The expiry date must be after the issue date.",
    ],
    [{ expires_on: "soon" }, "Enter a valid expiry date, or leave it empty."],
    [{ notes: "x".repeat(801) }, "Notes are up to 800 characters."],
  ];
  for (const [change, message] of cases) {
    test(message, () => {
      expect(validateLegalRecord({ ...issued, ...change })).toEqual({
        error: message,
      });
    });
  }
});

test("gerbang dokumen legal (gerbang_dokumen_legal)", () => {
  const statuses: Record<string, string> = {};
  const state = (mou: string, dp: boolean) => {
    const gate = {
      mou_status: mou,
      regulatory_path: "WITH_BPOM",
      dp_cleared: dp,
      statuses,
    };
    return [
      legalGateError(gate, "SIG"),
      legalGateError(gate, "BPOM"),
      legalGateError(gate, "HALAL"),
    ];
  };
  expect(state("SENT", true)[0]).toBe(
    "The client has not accepted the MoU yet.",
  );
  expect(state("ACCEPTED", false)[0]).toBe(LEGAL_DP_PENDING);
  expect(state("ACCEPTED", true)).toEqual([
    null,
    "Record the SIG nutrition test first.",
    null,
  ]);
  statuses.SIG = "SUBMITTED";
  expect(state("ACCEPTED", true)[1]).toBe(
    "Record the SIG nutrition test first.",
  );
  statuses.SIG = "NOT_REQUIRED";
  expect(state("ACCEPTED", true)).toEqual([
    "This document is already final.",
    null,
    null,
  ]);
  expect(
    legalGateError(
      {
        mou_status: "ACCEPTED",
        regulatory_path: "WHITE_LABEL",
        dp_cleared: true,
        statuses,
      },
      "BPOM",
    ),
  ).toBe("This document is not needed on this regulatory path.");
  expect(legalComplete("WHITE_LABEL", statuses)).toBe(false);
  statuses.HALAL = "ISSUED";
  expect(legalComplete("WHITE_LABEL", statuses)).toBe(true);
  expect(legalComplete("WITH_BPOM", statuses)).toBe(false);
  statuses.BPOM = "ISSUED";
  statuses.HKI = "NOT_REQUIRED";
  expect(legalComplete("WITH_BPOM", statuses)).toBe(true);
  expect(legalKindPermission("SIG")).toBe("rnd.manage");
  expect(legalKindPermission("HKI")).toBe("legal.manage");
});

test("setiap SQL dan pesan identik dengan Rust", () => {
  const path = ["desktop", "mobile"]
    .map((dir) =>
      join(import.meta.dir, `../../../src-tauri/src/${dir}/legal.rs`),
    )
    .find(existsSync);
  expect(path).toBeDefined();
  const rust = readFileSync(path as string, "utf8");
  const shared = Object.entries(rules).filter(
    ([name, value]) =>
      typeof value === "string" &&
      (name.endsWith("_SQL") ||
        name === "LEGAL_DP_PENDING" ||
        name === "LEGAL_CHANGED_ELSEWHERE"),
  );
  expect(shared.length).toBe(5);
  for (const [name, value] of shared) {
    expect(rust, name).toContain(`"${value}"`);
  }
});

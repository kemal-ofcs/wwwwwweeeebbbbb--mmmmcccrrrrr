import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as rules from "./design";
import {
  applyDesignAction,
  type DesignState,
  type DesignStatus,
  DUMMY_LIMIT_REACHED,
  designActionPermission,
  designRequestError,
  dummyLimitReached,
  normalizeDesignBrief,
  normalizeTrackingNo,
} from "./design";

// Vektor kembar: `mod tests` di `src-tauri/src/desktop/design.rs` memakai
// masukan dan keluaran yang persis sama. Ubah keduanya bersamaan.

const state = (status: string): DesignState => ({
  status,
  sample_status: "CLIENT_ACC",
  has_mockup: true,
  dummy_paid: true,
  rejection_count: 0,
  max_rejections: 0,
  can_override: false,
});

const ok = (status: DesignStatus, rejection_count: number) => ({
  result: { status, rejection_count },
});

describe("langkah desain (langkah_desain_mengikuti_diagram)", () => {
  test("diagram", () => {
    expect(applyDesignAction(state("MOCKUP"), "PRINT_DUMMY")).toEqual(
      ok("DUMMY_PRINTING", 0),
    );
    expect(applyDesignAction(state("DUMMY_PRINTING"), "DUMMY_SENT")).toEqual(
      ok("DUMMY_SENT", 0),
    );
    expect(applyDesignAction(state("DUMMY_SENT"), "DUMMY_ACC")).toEqual(
      ok("DUMMY_ACC", 0),
    );
    expect(applyDesignAction(state("DUMMY_SENT"), "DUMMY_REVISE")).toEqual(
      ok("DUMMY_REVISION", 1),
    );
    expect(
      applyDesignAction(
        { ...state("DUMMY_REVISION"), rejection_count: 1 },
        "PRINT_DUMMY",
      ),
    ).toEqual(ok("DUMMY_PRINTING", 1));
    expect(applyDesignAction(state("DUMMY_SENT"), "CANCEL_DESIGN")).toEqual(
      ok("CANCELLED", 0),
    );
    const wrong = {
      error:
        "This step is not available for the design ticket's current status.",
    };
    expect(applyDesignAction(state("DUMMY_ACC"), "CANCEL_DESIGN")).toEqual(
      wrong,
    );
    expect(applyDesignAction(state("CANCELLED"), "PRINT_DUMMY")).toEqual(wrong);
    expect(applyDesignAction(state("MOCKUP"), "DUMMY_ACC")).toEqual(wrong);
    expect(applyDesignAction(state("DUMMY_PRINTING"), "DUMMY_REVISE")).toEqual(
      wrong,
    );
    expect(applyDesignAction(state("MOCKUP"), "CANCEL")).toEqual({
      error: "This design step does not exist.",
    });
  });
});

describe("gerbang cetak dummy (gerbang_cetak_dummy)", () => {
  const mockup = state("MOCKUP");
  test("sampel, mockup, dan bayar", () => {
    expect(
      applyDesignAction(
        { ...mockup, sample_status: "SAMPLE_SENT" },
        "PRINT_DUMMY",
      ),
    ).toEqual({ error: "The client has not approved the sample yet." });
    expect(
      applyDesignAction({ ...mockup, has_mockup: false }, "PRINT_DUMMY"),
    ).toEqual({ error: "Upload the mockup first." });
    expect(
      applyDesignAction({ ...mockup, dummy_paid: false }, "PRINT_DUMMY"),
    ).toEqual({ error: "The dummy invoice for this round is not paid yet." });
  });
  test("batas penolakan dan override", () => {
    const limit = {
      ...state("DUMMY_REVISION"),
      rejection_count: 2,
      max_rejections: 2,
    };
    expect(applyDesignAction(limit, "PRINT_DUMMY")).toEqual({
      error: DUMMY_LIMIT_REACHED,
    });
    expect(
      applyDesignAction({ ...limit, can_override: true }, "PRINT_DUMMY"),
    ).toEqual(ok("DUMMY_PRINTING", 2));
    expect(
      applyDesignAction({ ...limit, rejection_count: 1 }, "PRINT_DUMMY"),
    ).toEqual(ok("DUMMY_PRINTING", 1));
    expect(
      applyDesignAction(
        { ...limit, max_rejections: 0, rejection_count: 9 },
        "PRINT_DUMMY",
      ),
    ).toEqual(ok("DUMMY_PRINTING", 9));
    expect(dummyLimitReached(5, 0)).toBe(false);
    expect(dummyLimitReached(3, 3)).toBe(true);
    expect(dummyLimitReached(2, 3)).toBe(false);
  });
});

test("izin dan isian desain (izin_dan_isian_desain)", () => {
  expect(designActionPermission("PRINT_DUMMY")).toBe("design.manage");
  expect(designActionPermission("DUMMY_SENT")).toBe("design.manage");
  for (const action of ["DUMMY_ACC", "DUMMY_REVISE", "CANCEL_DESIGN"]) {
    expect(designActionPermission(action)).toBe("samples.manage");
  }
  expect(designRequestError("IN_RND", 0)).toBeNull();
  expect(designRequestError("CLIENT_ACC", 0)).toBeNull();
  expect(designRequestError("CANCELLED", 0)).toBe(
    "A design cannot be requested for a closed sample request.",
  );
  expect(designRequestError("SAMPLE_SENT", 1)).toBe(
    "This sample request already has a design ticket.",
  );
  expect(normalizeDesignBrief(" Box 50 ml, pastel ")).toBe("Box 50 ml, pastel");
  expect(normalizeDesignBrief("  ")).toBeNull();
  expect(normalizeDesignBrief("é".repeat(1001))).toBeNull();
  expect(normalizeDesignBrief(undefined)).toBeNull();
  expect(normalizeTrackingNo(undefined)).toBe("");
  expect(normalizeTrackingNo(null)).toBe("");
  expect(normalizeTrackingNo(" JNE123 ")).toBe("JNE123");
  expect(normalizeTrackingNo("x".repeat(101))).toBeNull();
  expect(normalizeTrackingNo(12)).toBeNull();
});

test("setiap SQL dan pesan identik dengan Rust", () => {
  const path = ["desktop", "mobile"]
    .map((dir) =>
      join(import.meta.dir, `../../../src-tauri/src/${dir}/design.rs`),
    )
    .find(existsSync);
  expect(path).toBeDefined();
  const rust = readFileSync(path as string, "utf8");
  const shared = Object.entries(rules).filter(
    ([name, value]) =>
      typeof value === "string" &&
      (name.endsWith("_SQL") ||
        name.endsWith("_INVALID") ||
        name === "DUMMY_LIMIT_REACHED" ||
        name === "DESIGN_CHANGED_ELSEWHERE" ||
        name === "DESIGN_REQUEST_ACTION"),
  );
  expect(shared.length).toBe(9);
  for (const [name, value] of shared) {
    expect(rust, name).toContain(`"${value}"`);
  }
});

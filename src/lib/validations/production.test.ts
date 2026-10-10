import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGAL_DP_PENDING } from "./legal";
import * as rules from "./production";
import {
  applyPoAction,
  batchRequestError,
  materialsReadyError,
  poLogNotes,
  scheduleLogNotes,
  validateBatchSchedule,
  validatePoDelay,
  validatePurchaseOrder,
} from "./production";

// Vektor kembar: `mod tests` di `src-tauri/src/desktop/production.rs` memakai
// masukan dan keluaran yang persis sama. Ubah keduanya bersamaan.

function error<T>(result: T) {
  return result && typeof result === "object" && "error" in result
    ? (result as { error: string }).error
    : null;
}

test("work order dan langkah PO (work_order_dan_langkah_po_mengikuti_aturan)", () => {
  expect(batchRequestError("ACCEPTED", true, 0)).toBeNull();
  expect(batchRequestError("SENT", true, 0)).toBe(
    "The client has not accepted the MoU yet.",
  );
  expect(batchRequestError("ACCEPTED", false, 0)).toBe(LEGAL_DP_PENDING);
  expect(batchRequestError("ACCEPTED", true, 1)).toBe(
    "This MoU already has a work order.",
  );
  const step = (status: string, action: string) => {
    const result = applyPoAction(status, action);
    return "error" in result ? result.error : result.status;
  };
  expect(step("", "PO_ADD")).toBe("OPEN");
  expect(step("OPEN", "PO_ARRIVED")).toBe("ARRIVED");
  expect(step("OPEN", "PO_LATE")).toBe("OPEN");
  expect(step("OPEN", "PO_CANCEL")).toBe("CANCELLED");
  const wrong =
    "This step is not available for the purchase order's current status.";
  expect(step("ARRIVED", "PO_LATE")).toBe(wrong);
  expect(step("OPEN", "PO_ADD")).toBe(wrong);
  expect(step("CANCELLED", "PO_ARRIVED")).toBe(wrong);
  expect(step("OPEN", "PO_SPLIT")).toBe(
    "This purchase order step does not exist.",
  );
  expect(materialsReadyError("UNCHECKED", 0)).toBeNull();
  expect(materialsReadyError("WAITING_PO", 0)).toBeNull();
  expect(materialsReadyError("WAITING_PO", 2)).toBe(
    "Mark every open purchase order as arrived or cancelled first.",
  );
  expect(materialsReadyError("READY", 0)).toBe(
    "The materials are already ready.",
  );
});

describe("isian PO dan keterlambatan (isian_po_dan_keterlambatan_divalidasi)", () => {
  const order = {
    po_number: " PO-778 ",
    supplier_option_id: "sup-1",
    eta_on: "2026-10-20",
  };
  test("PO sah dirapikan", () => {
    expect(validatePurchaseOrder(order)).toEqual({
      order: {
        po_number: "PO-778",
        supplier_option_id: "sup-1",
        eta_on: "2026-10-20",
      },
    });
  });
  const cases: [Record<string, unknown>, string][] = [
    [
      { po_number: "" },
      "Enter the purchase order number, up to 60 characters.",
    ],
    [
      { po_number: "x".repeat(61) },
      "Enter the purchase order number, up to 60 characters.",
    ],
    [
      { po_number: 778 },
      "Enter the purchase order number, up to 60 characters.",
    ],
    [{ supplier_option_id: "" }, "Choose the supplier."],
    [{ eta_on: "2026-02-30" }, "Enter the expected arrival date."],
  ];
  for (const [change, message] of cases) {
    test(`${JSON.stringify(change).slice(0, 40)} → ${message}`, () => {
      expect(error(validatePurchaseOrder({ ...order, ...change }))).toBe(
        message,
      );
    });
  }
  test("keterlambatan", () => {
    const delay = { eta_on: "2026-10-27", reason: " Supplier stock out " };
    expect(validatePoDelay(delay, "2026-10-20")).toEqual({
      delay: { eta_on: "2026-10-27", reason: "Supplier stock out" },
    });
    expect(error(validatePoDelay(delay, "2026-10-27"))).toBe(
      "The new arrival date must be after the current one.",
    );
    expect(
      error(
        validatePoDelay({ eta_on: "27-10-2026", reason: "x" }, "2026-10-20"),
      ),
    ).toBe("Enter the new expected arrival date.");
    expect(
      error(
        validatePoDelay({ eta_on: "2026-10-27", reason: "" }, "2026-10-20"),
      ),
    ).toBe("Write why the order is late, up to 500 characters.");
  });
});

test("jadwal (jadwal_berurutan_dan_alasan_saat_diubah)", () => {
  const draft = {
    weighing_on: "2026-11-02",
    mixing_on: "2026-11-03",
    filling_on: "2026-11-03",
    packing_on: "2026-11-05",
    reason: "",
  };
  const checked = validateBatchSchedule(draft, false);
  expect(checked).toEqual({ schedule: draft });
  if (!("schedule" in checked)) throw new Error("jadwal sah");
  expect(scheduleLogNotes(checked.schedule)).toBe(
    "Weighing 2026-11-02, mixing 2026-11-03, filling 2026-11-03, packing 2026-11-05",
  );
  expect(error(validateBatchSchedule(draft, true))).toBe(
    "Write why the schedule changes.",
  );
  const moved = validateBatchSchedule({ ...draft, reason: " PO late " }, true);
  if (!("schedule" in moved)) throw new Error("jadwal ulang sah");
  expect(scheduleLogNotes(moved.schedule)).toBe(
    "Weighing 2026-11-02, mixing 2026-11-03, filling 2026-11-03, packing 2026-11-05 - PO late",
  );
  expect(
    error(validateBatchSchedule({ ...draft, filling_on: "2026-11-01" }, false)),
  ).toBe("The filling date cannot be before the stage before it.");
  expect(
    error(validateBatchSchedule({ ...draft, packing_on: "" }, false)),
  ).toBe("Enter the packing date.");
  expect(
    error(validateBatchSchedule({ ...draft, reason: "x".repeat(501) }, true)),
  ).toBe("The reason is up to 500 characters.");
  expect(poLogNotes("PO_ADD", "PO-778", "PT Kimia", "2026-10-20", "")).toBe(
    "PO PO-778 from PT Kimia, arriving 2026-10-20",
  );
  expect(
    poLogNotes("PO_LATE", "PO-778", "PT Kimia", "2026-10-27", "Stock out"),
  ).toBe("PO PO-778 is late, now arriving 2026-10-27: Stock out");
  expect(poLogNotes("PO_ARRIVED", "PO-778", "", "", "")).toBe(
    "PO PO-778 arrived",
  );
  expect(poLogNotes("PO_CANCEL", "PO-778", "", "", "")).toBe(
    "PO PO-778 cancelled",
  );
});

test("setiap SQL dan pesan identik dengan Rust", () => {
  const path = ["desktop", "mobile"]
    .map((dir) =>
      join(import.meta.dir, `../../../src-tauri/src/${dir}/production.rs`),
    )
    .find(existsSync);
  expect(path).toBeDefined();
  const rust = readFileSync(path as string, "utf8");
  const shared = Object.entries(rules).filter(
    ([name, value]) =>
      typeof value === "string" &&
      (name.endsWith("_SQL") ||
        name.endsWith("_WHERE") ||
        name.endsWith("_ACTION") ||
        name.endsWith("_ELSEWHERE")),
  );
  expect(shared.length).toBe(17);
  for (const [name, value] of shared) {
    expect(rust, name).toContain(`"${value}"`);
  }
});

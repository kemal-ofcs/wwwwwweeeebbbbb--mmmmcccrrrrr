import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGAL_DP_PENDING } from "./legal";
import * as rules from "./production";
import {
  applyPoAction,
  applyShipmentAction,
  batchRequestError,
  claimDecideError,
  claimLogNotes,
  claimReportNumber,
  complaintLogNotes,
  LEGAL_PENDING_FOR_PRODUCTION,
  materialsReadyError,
  normalizeTracking,
  orderCompleted,
  PRODUCTION_NOT_PACKED,
  PRODUCTION_PACKED,
  poLogNotes,
  SHIP_UNPAID,
  scheduleLockError,
  scheduleLogNotes,
  shipGateError,
  shipmentActionPermission,
  shipmentLogNotes,
  shipmentRequestError,
  shipSummary,
  stageGateError,
  stageLogNotes,
  storageFeeDue,
  validateBatchSchedule,
  validateClaimDecision,
  validateComplaint,
  validatePoDelay,
  validatePurchaseOrder,
  validateShipment,
  validateStageRecord,
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

test("penerimaan dan klaim QC (penerimaan_dan_klaim_qc)", () => {
  const step = (status: string, action: string) => {
    const result = applyShipmentAction(
      { status, method: "CARRIER", tracking_no: "JNE123" },
      action,
    );
    return "error" in result ? result.error : result.status;
  };
  const notAvailable =
    "This step is not available for the shipment's current status.";
  expect(step("SHIPPED", "SHIP_RECEIVED")).toBe("RECEIVED");
  expect(step("FORWARDED", "SHIP_RECEIVED")).toBe("RECEIVED");
  expect(step("FORWARDED", "SHIP_COMPLAINT")).toBe("COMPLAINED");
  expect(step("PREPARED", "SHIP_RECEIVED")).toBe(notAvailable);
  expect(step("RECEIVED", "SHIP_COMPLAINT")).toBe(notAvailable);
  expect(shipmentActionPermission("SHIP_RECEIVED")).toBe("samples.manage");
  expect(shipmentActionPermission("SHIP_COMPLAINT")).toBe("samples.manage");
  expect(
    shipmentLogNotes("SHIP_RECEIVED", {
      delivery_note_no: "",
      method: "",
      carrier_label: "",
      tracking_no: "",
      driver_name: "",
      vehicle_plate: "",
      reason: "",
    }),
  ).toBe("Received in good condition");

  const complaint = validateComplaint(
    { complaint_notes: " 5 bottles leaked ", affected_units: 5 },
    990,
  );
  expect(complaint).toEqual({
    complaint: { complaint_notes: "5 bottles leaked", affected_units: 5 },
  });
  if (!("complaint" in complaint)) throw new Error("komplain sah");
  expect(complaintLogNotes(complaint.complaint)).toBe(
    "Complaint (5 units): 5 bottles leaked",
  );
  const link = validateComplaint(
    { complaint_notes: "Box crushed", affected_units: 0 },
    990,
  );
  if (!("complaint" in link)) throw new Error("komplain tautan sah");
  expect(complaintLogNotes(link.complaint)).toBe("Complaint: Box crushed");
  expect(
    error(validateComplaint({ complaint_notes: "", affected_units: 1 }, 990)),
  ).toBe("Describe the problem, up to 950 characters.");
  expect(
    error(
      validateComplaint({ complaint_notes: "x", affected_units: 991 }, 990),
    ),
  ).toBe("The affected units cannot be more than the units shipped.");

  const internal = validateClaimDecision({
    fault_type: "INTERNAL",
    findings: " Seal not tight ",
    remedy: "REPLACE",
    remedy_notes: "Ship 5 bottles",
  });
  expect(internal).toEqual({
    decision: {
      fault_type: "INTERNAL",
      decision: "RETURN_APPROVED",
      remedy: "REPLACE",
      remedy_notes: "Ship 5 bottles",
      findings: "Seal not tight",
    },
  });
  if (!("decision" in internal)) throw new Error("keputusan sah");
  expect(claimLogNotes(internal.decision)).toBe(
    "Internal fault, return approved (replace goods): Seal not tight",
  );
  const recipient = validateClaimDecision({
    fault_type: "RECIPIENT",
    findings: "Courier dropped the cartons",
    remedy: "REPLACE",
    remedy_notes: "ignored",
  });
  if (!("decision" in recipient)) throw new Error("keputusan penerima sah");
  expect([recipient.decision.decision, recipient.decision.remedy]).toEqual([
    "RETURN_REJECTED",
    "",
  ]);
  expect(claimLogNotes(recipient.decision)).toBe(
    "Recipient fault, return rejected: Courier dropped the cartons",
  );
  expect(
    error(validateClaimDecision({ fault_type: "CLIENT", findings: "x" })),
  ).toBe("Choose whose fault it is.");
  expect(
    error(validateClaimDecision({ fault_type: "INTERNAL", findings: "x" })),
  ).toBe("Choose how the client is put right.");
  expect(
    error(validateClaimDecision({ fault_type: "RECIPIENT", findings: "" })),
  ).toBe("Write what QC found, up to 900 characters.");
  expect(claimDecideError("OPEN")).toBeNull();
  expect(claimDecideError("DECIDED")).toBe(
    "This complaint is already decided.",
  );
  expect(claimReportNumber("SJ-20261120-A101")).toBe("BA-SJ-20261120-A101");
  expect(orderCompleted("RECEIVED", null)).toBe(true);
  expect(orderCompleted("COMPLAINED", "OPEN")).toBe(false);
  expect(orderCompleted("COMPLAINED", "DECIDED")).toBe(true);
  expect(orderCompleted("FORWARDED", null)).toBe(false);
});

test("pengiriman (pengiriman_mengikuti_aturan)", () => {
  const carrier = {
    method: "CARRIER",
    carrier_option_id: "jne",
    driver_name: "ignored",
    carton_count: 40,
    unit_count: 990,
    ship_on: "2026-11-20",
    ship_to_address: " Jl. Merdeka 1, Bandung ",
    notes: "",
  };
  expect(validateShipment(carrier)).toEqual({
    shipment: {
      method: "CARRIER",
      carrier_option_id: "jne",
      driver_name: "",
      driver_phone: "",
      vehicle_plate: "",
      carton_count: 40,
      unit_count: 990,
      ship_on: "2026-11-20",
      ship_to_address: "Jl. Merdeka 1, Bandung",
      notes: "",
    },
  });
  const wrong = (change: Record<string, unknown>) =>
    error(validateShipment({ ...carrier, ...change }));
  expect(wrong({ method: "PLANE" })).toBe("Choose how the goods are shipped.");
  expect(wrong({ carrier_option_id: "" })).toBe("Choose the shipping company.");
  expect(wrong({ carton_count: 0 })).toBe(
    "Enter the number of cartons (1 to 100,000).",
  );
  expect(wrong({ unit_count: "990" })).toBe(
    "Enter the number of units (1 to 10,000,000).",
  );
  expect(wrong({ ship_on: "2026-13-01" })).toBe("Enter the shipping date.");
  expect(wrong({ ship_to_address: "" })).toBe(
    "Enter the delivery address, up to 500 characters.",
  );
  expect(wrong({ method: "FLEET", driver_name: "" })).toBe(
    "Enter the driver's name, up to 100 characters.",
  );
  expect(wrong({ method: "FLEET", driver_name: "Budi" })).toBe(
    "Enter the vehicle plate number, up to 20 characters.",
  );
  const fleet = validateShipment({
    ...carrier,
    method: "FLEET",
    driver_name: "Budi",
    vehicle_plate: "D 1234 AB",
  });
  expect(fleet).toMatchObject({
    shipment: {
      carrier_option_id: "",
      driver_name: "Budi",
      vehicle_plate: "D 1234 AB",
    },
  });

  expect(shipmentRequestError(null, 0)).toBeNull();
  expect(shipmentRequestError(SHIP_UNPAID, 0)).toBe(SHIP_UNPAID);
  expect(shipmentRequestError(null, 1)).toBe(
    "This work order already has a shipment.",
  );
  const step = (
    status: string,
    method: string,
    tracking_no: string,
    action: string,
  ) => {
    const result = applyShipmentAction({ status, method, tracking_no }, action);
    return "error" in result ? result.error : result.status;
  };
  const notAvailable =
    "This step is not available for the shipment's current status.";
  expect(step("PREPARED", "CARRIER", "", "SHIP_UPDATE")).toBe("PREPARED");
  expect(step("PREPARED", "CARRIER", "", "SHIP_CANCEL")).toBe("CANCELLED");
  expect(step("PREPARED", "CARRIER", "", "SHIP_DISPATCH")).toBe("SHIPPED");
  expect(step("SHIPPED", "CARRIER", "", "SHIP_CANCEL")).toBe(notAvailable);
  expect(step("SHIPPED", "CARRIER", "", "SHIP_TRACKING")).toBe("SHIPPED");
  expect(step("SHIPPED", "CARRIER", "JNE123", "SHIP_TRACKING")).toBe(
    "The tracking number is already recorded.",
  );
  expect(step("PREPARED", "CARRIER", "", "SHIP_TRACKING")).toBe(notAvailable);
  expect(step("SHIPPED", "CARRIER", "", "SHIP_FORWARD")).toBe(
    "Record the tracking number before forwarding it.",
  );
  expect(step("SHIPPED", "CARRIER", "JNE123", "SHIP_FORWARD")).toBe(
    "FORWARDED",
  );
  expect(step("SHIPPED", "FLEET", "", "SHIP_FORWARD")).toBe("FORWARDED");
  expect(step("FORWARDED", "FLEET", "", "SHIP_TRACKING")).toBe("FORWARDED");
  expect(step("PREPARED", "FLEET", "", "SHIP_FLY")).toBe(
    "This shipment step does not exist.",
  );
  expect(shipmentActionPermission("SHIP_FORWARD")).toBe("samples.manage");
  expect(shipmentActionPermission("SHIP_DISPATCH")).toBe("shipping.manage");
  expect(normalizeTracking(" JNE123 ", true)).toBe("JNE123");
  expect(normalizeTracking(undefined, false)).toBe("");
  expect(normalizeTracking(undefined, true)).toBeNull();
  expect(normalizeTracking("x".repeat(61), false)).toBeNull();
  const log = {
    delivery_note_no: "SJ-20261120-A101",
    method: "CARRIER",
    carrier_label: "JNE",
    tracking_no: "JNE123",
    driver_name: "",
    vehicle_plate: "",
    reason: "Wrong address",
  };
  expect(shipmentLogNotes("SHIP_PREPARE", log)).toBe(
    "Delivery note SJ-20261120-A101",
  );
  expect(shipmentLogNotes("SHIP_CANCEL", log)).toBe(
    "Delivery note SJ-20261120-A101 cancelled: Wrong address",
  );
  expect(shipmentLogNotes("SHIP_DISPATCH", log)).toBe(
    "Shipped by JNE, tracking JNE123",
  );
  const fleetLog = {
    ...log,
    method: "FLEET",
    driver_name: "Budi",
    vehicle_plate: "D 1234 AB",
  };
  expect(shipmentLogNotes("SHIP_DISPATCH", fleetLog)).toBe(
    "Shipped by Budi (D 1234 AB)",
  );
  expect(shipmentLogNotes("SHIP_FORWARD", fleetLog)).toBe(
    "Tracking number and delivery note sent to the client",
  );
});

test("siap kirim (siap_kirim_dan_biaya_titip)", () => {
  const packed = {
    stages_done: 4,
    settlement_count: 1,
    ship_unpaid: 0,
    storage_count: 0,
    storage_days: 0,
    carton_count: 40,
    storage_rate_idr: 500,
  };
  expect(shipGateError(packed)).toBeNull();
  expect(shipGateError({ ...packed, stages_done: 3 })).toBe(
    PRODUCTION_NOT_PACKED,
  );
  expect(shipGateError({ ...packed, settlement_count: 0 })).toBe(
    "Finance has not issued the settlement invoice yet.",
  );
  expect(shipGateError({ ...packed, ship_unpaid: 2 })).toBe(
    "Waiting for the settlement, shipping, and storage invoices to be paid.",
  );
  const late = { ...packed, storage_days: 3 };
  expect(storageFeeDue(late)).toBe(60_000);
  expect(shipGateError(late)).toBe(
    "Finance must issue the storage fee invoice first.",
  );
  expect(shipGateError({ ...late, storage_count: 1 })).toBeNull();
  expect(shipGateError({ ...late, storage_rate_idr: 0 })).toBeNull();
  expect(
    shipSummary({
      stages_done: 4,
      settlement_count: 1,
      settlement_unpaid: 0,
      storage_days: 3,
      carton_count: 40,
      storage_rate_idr: 500,
      total_production_cost_idr: 325_000,
      dp_amount_required_idr: 162_500,
    }),
  ).toEqual({
    ship_block: "Finance must issue the storage fee invoice first.",
    settlement_default_idr: 162_500,
    storage_fee_idr: 60_000,
    settlement_cleared: 1,
  });
});

test("tahap produksi (tahap_produksi_berurutan_dan_terkunci)", () => {
  const gate = (
    stages_done: number,
    material_status: string,
    has_schedule: boolean,
    legal_open: number,
  ) =>
    stageGateError({ stages_done, material_status, has_schedule, legal_open });
  expect(gate(0, "READY", true, 0)).toBeNull();
  expect(gate(0, "WAITING_PO", true, 0)).toBe(
    "Mark the materials as ready first.",
  );
  expect(gate(0, "READY", false, 0)).toBe("Set the production schedule first.");
  expect(gate(0, "READY", true, 2)).toBe(LEGAL_PENDING_FOR_PRODUCTION);
  expect(gate(2, "READY", true, 2)).toBeNull();
  expect(gate(4, "READY", true, 0)).toBe(PRODUCTION_PACKED);

  const mixing = validateStageRecord({ notes: " Crew A " }, 1);
  expect(mixing).toEqual({ record: { notes: "Crew A", packing: null } });
  if (!("record" in mixing)) throw new Error("tahap sah");
  expect(stageLogNotes("MIXING", mixing.record)).toBe("Mixing done - Crew A");
  const packing = validateStageRecord(
    { carton_count: 120, produced_units: 9_950 },
    3,
  );
  expect(packing).toEqual({
    record: {
      notes: "",
      packing: { carton_count: 120, produced_units: 9_950 },
    },
  });
  if (!("record" in packing)) throw new Error("packing sah");
  expect(stageLogNotes("PACKING", packing.record)).toBe(
    "Packing done: 120 cartons, 9950 units",
  );
  const wrong = (raw: Record<string, unknown>) =>
    error(validateStageRecord(raw, 3));
  expect(wrong({ produced_units: 10 })).toBe(
    "Enter the number of cartons (1 to 100,000).",
  );
  expect(wrong({ carton_count: "12", produced_units: 10 })).toBe(
    "Enter the number of cartons (1 to 100,000).",
  );
  expect(wrong({ carton_count: 12, produced_units: 0 })).toBe(
    "Enter the number of finished units (1 to 10,000,000).",
  );
  expect(error(validateStageRecord({ notes: "x".repeat(501) }, 0))).toBe(
    "Notes are up to 500 characters.",
  );

  const current = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];
  const moved = ["2026-11-02", "2026-11-03", "2026-11-06", "2026-11-07"];
  expect(scheduleLockError(2, current, moved)).toBeNull();
  expect(scheduleLockError(3, current, moved)).toBe(
    "The dates of finished stages cannot change.",
  );
  expect(scheduleLockError(4, current, current)).toBe(PRODUCTION_PACKED);
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
  expect(shared.length).toBe(32);
  for (const [name, value] of shared) {
    expect(rust, name).toContain(`"${value}"`);
  }
});

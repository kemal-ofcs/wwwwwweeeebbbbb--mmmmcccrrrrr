import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as rules from "./approval";
import {
  approvalPermission,
  approvalStepAction,
  approvalUrl,
  isClientDecisionAction,
  validateApprovalResponse,
} from "./approval";

// Vektor kembar: `mod tests` di `src-tauri/src/desktop/approval.rs` memakai
// masukan dan keluaran yang persis sama. Ubah keduanya bersamaan.

test("izin dan jawaban klien (izin_dan_jawaban_klien)", () => {
  expect(approvalPermission("SAMPLE")).toBe("samples.manage");
  expect(approvalPermission("DUMMY")).toBe("samples.manage");
  expect(approvalPermission("MOU")).toBe("mou.manage");
  for (const action of ["CLIENT_ACC", "DUMMY_REVISE", "MOU_REJECT"]) {
    expect(isClientDecisionAction(action)).toBe(true);
  }
  for (const action of ["SAMPLE_SENT", "PRINT_DUMMY", "SEND_MOU", "CANCEL"]) {
    expect(isClientDecisionAction(action)).toBe(false);
  }
  expect(approvalUrl("https://crm.company.id", "abc_DEF-123")).toBe(
    "https://crm.company.id/approve?t=abc_DEF-123",
  );
});

test("pilihan jawaban per jenis", () => {
  expect(approvalStepAction("SAMPLE", "APPROVE")).toBe("CLIENT_ACC");
  expect(approvalStepAction("SAMPLE", "REJECT")).toBe("CLIENT_REJECT");
  expect(approvalStepAction("DUMMY", "REVISE")).toBe("DUMMY_REVISE");
  expect(approvalStepAction("DUMMY", "REJECT")).toBeNull();
  expect(approvalStepAction("MOU", "APPROVE")).toBe("MOU_ACCEPT");
});

describe("jawaban dari halaman klien", () => {
  test("sah", () => {
    expect(
      validateApprovalResponse({
        decision: "REVISE",
        responder_name: " Rina ",
        notes: " Logo bigger ",
      }),
    ).toEqual({
      response: {
        decision: "REVISE",
        responder_name: "Rina",
        notes: "Logo bigger",
      },
    });
  });
  const cases: [Record<string, unknown>, string][] = [
    [{ decision: "MAYBE", responder_name: "Rina" }, "Choose your answer."],
    [
      { decision: "APPROVE", responder_name: " " },
      "Enter your name, up to 100 characters.",
    ],
    [
      { decision: "APPROVE", responder_name: "x".repeat(101) },
      "Enter your name, up to 100 characters.",
    ],
    [
      { decision: "REVISE", responder_name: "Rina", notes: "" },
      "Tell us what to change.",
    ],
    [
      { decision: "APPROVE", responder_name: "Rina", notes: "x".repeat(801) },
      "Notes are up to 800 characters.",
    ],
  ];
  for (const [input, message] of cases) {
    test(message, () => {
      expect(validateApprovalResponse(input)).toEqual({ error: message });
    });
  }
});

test("konstanta yang dipakai Rust identik", () => {
  const path = ["desktop", "mobile"]
    .map((dir) =>
      join(import.meta.dir, `../../../src-tauri/src/${dir}/approval.rs`),
    )
    .find(existsSync);
  expect(path).toBeDefined();
  const rust = readFileSync(path as string, "utf8");
  const shared = new Set([
    "APPROVAL_INSERT_SQL",
    "APPROVAL_REVOKE_OTHERS_SQL",
    "CLIENT_EVIDENCE_REQUIRED",
    "APPROVAL_LINK_UNAVAILABLE",
    "APPROVAL_LINK_DISABLED",
  ]);
  const checked = Object.entries(rules).filter(([name]) => shared.has(name));
  expect(checked.length).toBe(shared.size);
  for (const [name, value] of checked) {
    expect(rust, name).toContain(`"${value}"`);
  }
  for (const action of rules.CLIENT_DECISION_ACTIONS) {
    expect(rust).toContain(`"${action}"`);
  }
});

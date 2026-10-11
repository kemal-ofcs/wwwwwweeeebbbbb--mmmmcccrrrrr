import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CRM_CLIENT_LIST_SQL } from "./crm";
import * as rules from "./dashboard";
import {
  DASHBOARD_RANGE_INVALID,
  dashboardPeriod,
  validateDashboardRange,
} from "./dashboard";

// Vektor kembar: `mod tests` di `src-tauri/src/desktop/dashboard.rs`.

test("periode dashboard (periode_dashboard)", () => {
  expect(validateDashboardRange("2026-10-01", "2026-10-31")).toEqual({
    from: "2026-10-01",
    to: "2026-10-31",
  });
  expect(validateDashboardRange("2026-10-01", "2026-10-01")).toEqual({
    from: "2026-10-01",
    to: "2026-10-01",
  });
  expect(validateDashboardRange("2025-01-01", "2026-12-31")).toEqual({
    from: "2025-01-01",
    to: "2026-12-31",
  });
  for (const [from, to] of [
    ["2026-10-31", "2026-10-01"],
    ["2026-02-30", "2026-03-01"],
    ["2024-12-30", "2026-12-31"],
    ["", "2026-10-01"],
  ]) {
    expect(validateDashboardRange(from, to)).toEqual({
      error: DASHBOARD_RANGE_INVALID,
    });
  }
});

test("preset periode", () => {
  expect(dashboardPeriod("month", "2026-02-11")).toEqual({
    from: "2026-02-01",
    to: "2026-02-28",
  });
  expect(dashboardPeriod("last_month", "2026-01-11")).toEqual({
    from: "2025-12-01",
    to: "2025-12-31",
  });
  expect(dashboardPeriod("quarter", "2026-11-05")).toEqual({
    from: "2026-10-01",
    to: "2026-12-31",
  });
  expect(dashboardPeriod("year", "2028-06-30")).toEqual({
    from: "2028-01-01",
    to: "2028-12-31",
  });
});

test("SQL identik dengan Rust; CRM memakai aturan yang sama", () => {
  const path = ["desktop", "mobile"]
    .map((dir) =>
      join(import.meta.dir, `../../../src-tauri/src/${dir}/dashboard.rs`),
    )
    .find(existsSync);
  expect(path).toBeDefined();
  const rust = readFileSync(path as string, "utf8");
  const shared = Object.entries(rules).filter(
    ([name, value]) =>
      typeof value === "string" &&
      (name.endsWith("_SQL") || name.endsWith("_INVALID")),
  );
  expect(shared.length).toBe(6);
  for (const [name, value] of shared) {
    expect(rust, name).toContain(`"${value}"`);
  }
  expect(rules.DASHBOARD_CRM_SQL).toContain(`FROM (${CRM_CLIENT_LIST_SQL}) z`);
});

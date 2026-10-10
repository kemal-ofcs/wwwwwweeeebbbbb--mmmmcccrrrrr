import { expect, test } from "bun:test";
import {
  INVOICE_FILTERS,
  matchesFundFilter,
  matchesInvoiceFilter,
  matchesSearch,
} from "./labels";

test("setiap tagihan masuk tepat satu tab status selain All", () => {
  const today = "2026-10-10";
  const invoices = [
    { status: "OPEN", paid_idr: 0, total_idr: 100, due_on: "2026-10-01" },
    { status: "OPEN", paid_idr: 40, total_idr: 100, due_on: "2026-10-20" },
    { status: "OPEN", paid_idr: 100, total_idr: 100, due_on: "2026-10-01" },
    {
      status: "RESCHEDULED",
      paid_idr: 40,
      total_idr: 100,
      due_on: "2026-10-01",
    },
    { status: "CANCELLED", paid_idr: 0, total_idr: 100, due_on: "2026-10-01" },
  ];
  const tabs = (invoice: (typeof invoices)[number]) =>
    INVOICE_FILTERS.filter(
      ([filter]) =>
        filter !== "ALL" &&
        filter !== "OVERDUE" &&
        matchesInvoiceFilter(filter, invoice, today),
    ).map(([filter]) => filter);
  expect(invoices.map(tabs)).toEqual([
    ["UNPAID"],
    ["UNPAID"],
    ["PAID"],
    ["RESCHEDULED"],
    ["CANCELLED"],
  ]);
  // Overdue adalah bagian dari Unpaid yang lewat jatuh tempo.
  expect(
    invoices.map((invoice) => matchesInvoiceFilter("OVERDUE", invoice, today)),
  ).toEqual([true, false, false, false, false]);
});

test("uang masuk: sisa, deposit, teralokasi, void", () => {
  const fund = (status: string, allocated: number, deposit = "") => ({
    status,
    amount_idr: 100,
    allocated_idr: allocated,
    deposit_confirmed_at: deposit,
  });
  expect(matchesFundFilter("UNALLOCATED", fund("ACTIVE", 40))).toBe(true);
  expect(matchesFundFilter("UNALLOCATED", fund("ACTIVE", 40, "x"))).toBe(false);
  expect(matchesFundFilter("DEPOSIT", fund("ACTIVE", 40, "x"))).toBe(true);
  expect(matchesFundFilter("ALLOCATED", fund("ACTIVE", 100))).toBe(true);
  expect(matchesFundFilter("VOID", fund("VOID", 0))).toBe(true);
});

test("pencarian: setiap kata, tanpa membedakan huruf", () => {
  const texts = ["INV-20261010-0602", "KLN-20261010-0601", "Aura", null];
  expect(matchesSearch("  ", texts)).toBe(true);
  expect(matchesSearch("aura 0602", texts)).toBe(true);
  expect(matchesSearch("aura 0999", texts)).toBe(false);
});

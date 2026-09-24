import { describe, expect, test } from "bun:test";
import { formatDateTime } from "./format";

describe("formatDateTime", () => {
  test("stempel waktu database dibaca sebagai UTC, bukan waktu lokal", () => {
    // 10:15 UTC = 17:15 WIB. Tanpa akhiran Z hasilnya bergeser 7 jam.
    expect(formatDateTime("2026-08-29 10:15:00", "Asia/Jakarta")).toBe(
      "29/08/2026 17:15 WIB",
    );
  });

  test("ISO dengan zona tetap dihormati", () => {
    expect(formatDateTime("2026-08-29T10:15:00Z", "Asia/Jakarta")).toBe(
      "29/08/2026 17:15 WIB",
    );
  });

  test("kosong menjadi tanda hubung, nilai tak terbaca dikembalikan apa adanya", () => {
    expect(formatDateTime(null)).toBe("-");
    expect(formatDateTime("")).toBe("-");
    expect(formatDateTime("bukan tanggal")).toBe("bukan tanggal");
  });
});

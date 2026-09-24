import { describe, expect, test } from "bun:test";
import {
  companyDateStamp,
  formatClientCode,
  nextClientSequence,
  normalizeCodePrefix,
  normalizeDeviceTag,
  normalizeOptionCode,
  normalizeWhatsapp,
} from "./client";

// Vektor kembar: `mod tests` di `src-tauri/src/desktop/clients.rs` memakai
// masukan dan keluaran yang persis sama. Ubah keduanya bersamaan.

describe("normalizeWhatsapp", () => {
  const cases: [string, string | null][] = [
    ["0812-3456-7890", "6281234567890"],
    ["+62 812 3456 7890", "6281234567890"],
    ["62812.3456.789", "628123456789"],
    ["(0812) 345 678", "62812345678"],
    ["812345678", null],
    ["0812abc", null],
    ["08123", null],
    ["", null],
    ["+6281234567890123", null],
  ];
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => {
      expect(normalizeWhatsapp(input)).toBe(expected);
    });
  }
});

describe("formatClientCode", () => {
  test("dua digit basis-36", () => {
    expect(formatClientCode("KLN", "20260925", "A1", 1)).toBe(
      "KLN-20260925-A101",
    );
    expect(formatClientCode("KLN", "20260925", "A1", 35)).toBe(
      "KLN-20260925-A10Z",
    );
    expect(formatClientCode("KLN", "20260925", "A1", 36)).toBe(
      "KLN-20260925-A110",
    );
    expect(formatClientCode("CUS", "20260925", "WB", 1295)).toBe(
      "CUS-20260925-WBZZ",
    );
  });
  test("di luar 1..1295 ditolak", () => {
    expect(formatClientCode("KLN", "20260925", "A1", 0)).toBeNull();
    expect(formatClientCode("KLN", "20260925", "A1", 1296)).toBeNull();
  });
});

describe("nextClientSequence", () => {
  test("kosong mulai dari 1", () => {
    expect(nextClientSequence([], "20260925", "A1")).toBe(1);
  });
  test("awalan apa pun ikut dihitung, tanggal dan tag lain tidak", () => {
    expect(
      nextClientSequence(
        [
          "KLN-20260925-A101",
          "KLN-20260925-A10Z",
          "CUS-20260925-A103",
          "KLN-20260924-A1ZZ",
          "KLN-20260925-B105",
          "KLN-20260925-A1??",
        ],
        "20260925",
        "A1",
      ),
    ).toBe(36);
  });
  test("habis setelah ZZ", () => {
    expect(nextClientSequence(["KLN-20260925-A1ZZ"], "20260925", "A1")).toBe(
      null,
    );
  });
});

describe("companyDateStamp", () => {
  const cases: [number, string, string][] = [
    [1790269200, "Asia/Jakarta", "20260925"],
    [1790269199, "Asia/Jakarta", "20260924"],
    [1790269199, "Asia/Makassar", "20260925"],
    [1790262000, "Asia/Makassar", "20260924"],
    [1790262000, "Asia/Jayapura", "20260925"],
    [1790269200, "Europe/London", "20260925"],
    [1798759800, "Asia/Jakarta", "20270101"],
  ];
  for (const [epoch, zone, expected] of cases) {
    test(`${epoch} ${zone}`, () => {
      expect(companyDateStamp(epoch, zone)).toBe(expected);
    });
  }
});

describe("normalisasi kode", () => {
  test("awalan", () => {
    expect(normalizeCodePrefix(" kln ")).toBe("KLN");
    expect(normalizeCodePrefix("K")).toBeNull();
    expect(normalizeCodePrefix("KLNMKL")).toBeNull();
    expect(normalizeCodePrefix("KL1")).toBeNull();
  });
  test("tag", () => {
    expect(normalizeDeviceTag("wb")).toBe("WB");
    expect(normalizeDeviceTag("A1")).toBe("A1");
    expect(normalizeDeviceTag("A")).toBeNull();
    expect(normalizeDeviceTag("A-")).toBeNull();
  });
  test("kode opsi", () => {
    expect(normalizeOptionCode(" ig-ads ")).toBe("IG-ADS");
    expect(normalizeOptionCode("")).toBeNull();
    expect(normalizeOptionCode("A B")).toBeNull();
  });
});

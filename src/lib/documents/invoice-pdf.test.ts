import { describe, expect, test } from "bun:test";
import {
  buildInvoicePdf,
  buildMouPdf,
  type InvoicePdfData,
  textWidth,
  toPdfText,
  wrapText,
} from "./invoice-pdf";

const data: InvoicePdfData = {
  company: { name: "Company Name", lines: ["Jl. Merdeka 1, Bandung", "0812"] },
  logo: null,
  invoice_number: "INV-20261008-WB01",
  issued_on: "2026-10-08",
  due_on: "2026-10-15",
  stamp: "PAID",
  stamp_note: "",
  bill_to: ["KLN-20261008-WB01 · Café (Aura)", "Bandung"],
  items: [{ label: "Sample fee - Aura Glow", amount_idr: 1_000_000 }],
  summary: [
    { label: "Subtotal", amount_idr: 1_000_000 },
    { label: "Lebaran (20%)", amount_idr: -200_000 },
    { label: "PPN (11%)", amount_idr: 88_000 },
  ],
  total_idr: 888_000,
  paid_idr: 888_000,
  payment_instructions: "Transfer to BCA 123456 a.n. Company Name",
};

/** Berkas sebagai teks Latin-1, satu karakter per byte. */
function latin1(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

/** Setiap offset di tabel xref menunjuk tepat ke `N 0 obj`. */
function expectValidXref(pdf: string) {
  expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
  expect(pdf.endsWith("%%EOF\n")).toBe(true);
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)?.[1]);
  expect(pdf.slice(startxref, startxref + 4)).toBe("xref");
  const table = pdf.slice(startxref).split("\n");
  const count = Number(table[1]?.split(" ")[1]);
  for (let object = 1; object < count; object += 1) {
    const entry = table[2 + object] ?? "";
    expect(entry.length).toBe(19); // 20 byte termasuk "\n"
    const offset = Number(entry.slice(0, 10));
    expect(pdf.slice(offset, offset + `${object} 0 obj`.length)).toBe(
      `${object} 0 obj`,
    );
  }
}

describe("invoice PDF", () => {
  test("struktur sah dan isi penting tercetak", () => {
    const pdf = latin1(buildInvoicePdf(data));
    expectValidXref(pdf);
    for (const text of [
      "(INVOICE)",
      "(INV-20261008-WB01)",
      "(PAID)",
      "(Rp 888.000)",
      "(-Rp 200.000)",
      "(Payment instructions)",
      // Kurung di teks di-escape; "·" dan "é" ada di Latin-1.
      "(KLN-20261008-WB01 · Café \\(Aura\\))",
    ]) {
      expect(pdf).toContain(text);
    }
    expect(pdf).toContain("/BaseFont /Helvetica-Bold");
    expect(pdf).not.toContain("/XObject");
  });

  test("logo JPEG ditanam apa adanya", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const pdf = latin1(
      buildInvoicePdf({ ...data, logo: { jpeg, width: 280, height: 112 } }),
    );
    expectValidXref(pdf);
    expect(pdf).toContain("/Filter /DCTDecode /Length 4");
    expect(pdf).toContain("/Im1 Do");
    expect(pdf).toContain("ÿØÿÙ");
  });

  test("huruf di luar Latin menjadi tanda tanya", () => {
    expect(toPdfText("Café – “x” 日本\n…")).toBe('Café - "x" ?? ...');
  });

  test("pemotongan baris memakai lebar Helvetica", () => {
    // R 722 + p 556 + spasi 278 + 3 x 556 + titik 278 + 3 x 556 = 5170.
    expect(textWidth("Rp 888.000", 10)).toBeCloseTo(51.7, 2);
    const lines = wrapText("word ".repeat(40), 10, 100);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines)
      expect(textWidth(line, 10)).toBeLessThanOrEqual(100);
    expect(
      wrapText("x".repeat(60), 10, 50).every((line) => line.length > 0),
    ).toBe(true);
  });
});

test("MoU PDF: struktur sah, isi dan tanda tangan tercetak", () => {
  const pdf = latin1(
    buildMouPdf({
      company: data.company,
      logo: null,
      mou_number: "MOU-20261009-WB01",
      issued_on: "2026-10-09",
      stamp: "ACCEPTED",
      client: ["KLN-20261008-WB01 · Aura Beauty", "Bandung"],
      terms: [
        { label: "Units", value: "10.000" },
        { label: "Contract value", value: "Rp 325.000.000" },
        { label: "Down payment (50%)", value: "Rp 162.500.000" },
      ],
      notes: "Box 30 ml",
      footer: "The down payment is invoiced separately.",
      signatures: ["For Company Name", "For Aura Beauty"],
    }),
  );
  expectValidXref(pdf);
  for (const text of [
    "(PRODUCTION MOU)",
    "(MOU-20261009-WB01)",
    "(ACCEPTED)",
    "(Rp 162.500.000)",
    "(For Aura Beauty)",
  ]) {
    expect(pdf).toContain(text);
  }
});

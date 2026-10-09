/**
 * Invoice PDF (PRD F-17 US-36, v2.3c). Penulis PDF kecil tanpa dependensi:
 * satu halaman A4, font standar Helvetica (WinAnsi), garis, dan logo JPEG
 * opsional. Dibuat di webview untuk Web, Desktop, dan Android sehingga tidak
 * butuh padanan Rust (seperti kompresi foto, aturan 38).
 *
 * Batasan yang disengaja: hanya huruf Latin (ASCII + Latin-1); karakter lain
 * dicetak "?". Font standar tidak perlu ditanam, jadi berkasnya kecil dan
 * tidak ada berkas font yang dibundel.
 */

export interface PdfLogo {
  /** JPEG baseline, ditanam apa adanya (`DCTDecode`). */
  jpeg: Uint8Array;
  width: number;
  height: number;
}

export interface PdfAmountLine {
  label: string;
  amount_idr: number;
}

export interface InvoicePdfData {
  company: {
    name: string;
    lines: string[];
  };
  logo: PdfLogo | null;
  invoice_number: string;
  issued_on: string;
  due_on: string;
  /** Cap besar di bawah judul: "PAID", "CANCELLED", "IN INSTALLMENTS", atau "". */
  stamp: string;
  /** Baris kecil di bawah cap, mis. alasan pembatalan. */
  stamp_note: string;
  bill_to: string[];
  items: PdfAmountLine[];
  /** Baris ringkasan rata kanan: subtotal, diskon, pajak, ... */
  summary: PdfAmountLine[];
  total_idr: number;
  paid_idr: number;
  payment_instructions: string;
}

// Lebar glif Helvetica dan Helvetica-Bold (AFM Adobe), satuan 1/1000 em,
// untuk ASCII 32-126; huruf lain dihitung 556.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];
const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
  556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584,
];

const PUNCTUATION: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "•": "-",
  "…": "...",
  " ": " ",
};

/**
 * Teks ke huruf yang dikenal WinAnsi: ASCII cetak dan Latin-1 (A0-FF), tanda
 * baca tipografis diganti padanan ASCII, sisanya "?". Pindah baris jadi spasi.
 */
export function toPdfText(value: string): string {
  let out = "";
  for (const char of value.replace(/\s+/g, " ")) {
    const mapped = PUNCTUATION[char] ?? char;
    for (const part of mapped) {
      const code = part.codePointAt(0) ?? 63;
      out +=
        (code >= 32 && code <= 126) || (code >= 0xa1 && code <= 0xff)
          ? part
          : "?";
    }
  }
  return out;
}

/** Lebar teks dalam point untuk ukuran huruf `size`. */
export function textWidth(text: string, size: number, bold = false): number {
  const widths = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let units = 0;
  for (const char of text) {
    units += widths[char.charCodeAt(0) - 32] ?? 556;
  }
  return (units * size) / 1000;
}

/** Potong kalimat menjadi baris selebar `maxWidth`; kata terlalu panjang dipecah. */
export function wrapText(text: string, size: number, maxWidth: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of toPdfText(text).split(" ").filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    while (textWidth(line, size) > maxWidth && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && textWidth(line.slice(0, cut), size) > maxWidth)
        cut -= 1;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line) lines.push(line);
  return lines;
}

function escapePdf(text: string) {
  return text.replace(/[\\()]/g, (char) => `\\${char}`);
}

/** Rp 32.500 versi PDF (titik ribuan, sama dengan `formatRupiah`). */
function rupiah(value: number) {
  const digits = String(Math.trunc(Math.abs(value))).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ".",
  );
  return `${value < 0 ? "-" : ""}Rp ${digits}`;
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 50;
const RIGHT = PAGE_WIDTH - MARGIN;

/** Perintah konten halaman; teks sudah lewat `toPdfText`. */
class Page {
  readonly ops: string[] = [];

  text(x: number, y: number, value: string, size = 10, bold = false) {
    this.ops.push(
      `BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escapePdf(toPdfText(value))}) Tj ET`,
    );
  }

  textRight(x: number, y: number, value: string, size = 10, bold = false) {
    this.text(
      x - textWidth(toPdfText(value), size, bold),
      y,
      value,
      size,
      bold,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number) {
    this.ops.push(
      `${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`,
    );
  }

  color(r: number, g: number, b: number) {
    this.ops.push(`${r} ${g} ${b} rg`);
  }
}

function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
}

/** Rakit objek PDF menjadi berkas, dengan tabel xref berbasis offset byte. */
function assemble(objects: (string | Uint8Array[])[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (part: Uint8Array) => {
    parts.push(part);
    length += part.length;
  };
  push(latin1("%PDF-1.4\n%âãÏÓ\n"));
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(length);
    push(latin1(`${index + 1} 0 obj\n`));
    if (typeof body === "string") push(latin1(body));
    else for (const chunk of body) push(chunk);
    push(latin1("\nendobj\n"));
  });
  const xref = length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    table += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  table += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(latin1(table));
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

interface Letterhead {
  company: { name: string; lines: string[] };
  logo: PdfLogo | null;
  stamp: string;
  stamp_note: string;
}

/**
 * Kop dokumen: logo (paling besar 140 x 56) dan identitas perusahaan di kiri,
 * judul, baris identitas dokumen, dan cap di kanan. Mengembalikan posisi
 * baris berikutnya di bawah garis pemisah.
 */
function drawHeader(
  page: Page,
  data: Letterhead,
  title: string,
  meta: string[],
): number {
  let top = PAGE_HEIGHT - MARGIN;
  let headerX = MARGIN;
  if (data.logo && data.logo.width > 0 && data.logo.height > 0) {
    const scale = Math.min(140 / data.logo.width, 56 / data.logo.height, 1);
    const width = data.logo.width * scale;
    const height = data.logo.height * scale;
    page.ops.push(
      `q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${MARGIN} ${(top - height).toFixed(2)} cm /Im1 Do Q`,
    );
    headerX = MARGIN + width + 12;
  }
  page.text(headerX, top - 14, data.company.name, 14, true);
  let companyY = top - 30;
  for (const line of data.company.lines) {
    for (const part of wrapText(line, 9, RIGHT - 200 - headerX)) {
      page.text(headerX, companyY, part, 9);
      companyY -= 12;
    }
  }

  page.textRight(RIGHT, top - 18, title, 20, true);
  let rightY = top - 36;
  meta.forEach((line, index) => {
    page.textRight(RIGHT, rightY, line, index === 0 ? 10 : 9, index === 0);
    rightY -= index === 0 ? 14 : 12;
  });
  rightY -= 8;
  if (data.stamp) {
    page.color(0.75, 0.1, 0.1);
    page.textRight(RIGHT, rightY, data.stamp, 14, true);
    page.color(0, 0, 0);
    rightY -= 14;
    for (const part of wrapText(data.stamp_note, 8, 220)) {
      page.textRight(RIGHT, rightY, part, 8);
      rightY -= 10;
    }
  }

  top = Math.min(companyY, rightY, top - 70) - 16;
  page.line(MARGIN, top, RIGHT, top);
  return top - 18;
}

/** Satu halaman A4 + font standar + logo opsional menjadi berkas PDF. */
function finishPage(page: Page, logo: PdfLogo | null): Uint8Array {
  const content = latin1(page.ops.join("\n"));
  const resources = logo
    ? "/Font << /F1 4 0 R /F2 5 0 R >> /XObject << /Im1 7 0 R >>"
    : "/Font << /F1 4 0 R /F2 5 0 R >>";
  const objects: (string | Uint8Array[])[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << ${resources} >> /Contents 6 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    [
      latin1(`<< /Length ${content.length} >>\nstream\n`),
      content,
      latin1("\nendstream"),
    ],
  ];
  if (logo) {
    objects.push([
      latin1(
        `<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.jpeg.length} >>\nstream\n`,
      ),
      logo.jpeg,
      latin1("\nendstream"),
    ]);
  }
  return assemble(objects);
}
export function buildInvoicePdf(data: InvoicePdfData): Uint8Array {
  const page = new Page();
  let top = drawHeader(page, data, "INVOICE", [
    data.invoice_number,
    `Issued ${data.issued_on}`,
    `Due ${data.due_on}`,
  ]);

  page.text(MARGIN, top, "Bill to", 9, true);
  top -= 14;
  for (const line of data.bill_to) {
    for (const part of wrapText(line, 10, RIGHT - MARGIN)) {
      page.text(MARGIN, top, part, 10);
      top -= 13;
    }
  }
  top -= 12;

  // Tabel baris tagihan.
  page.text(MARGIN, top, "Description", 9, true);
  page.textRight(RIGHT, top, "Amount", 9, true);
  top -= 6;
  page.line(MARGIN, top, RIGHT, top);
  top -= 14;
  for (const item of data.items) {
    const parts = wrapText(item.label, 10, RIGHT - MARGIN - 130);
    page.textRight(RIGHT, top, rupiah(item.amount_idr), 10);
    for (const part of parts) {
      page.text(MARGIN, top, part, 10);
      top -= 13;
    }
  }
  top -= 2;
  page.line(MARGIN, top, RIGHT, top);
  top -= 16;

  // Ringkasan rata kanan.
  const labelX = RIGHT - 150;
  for (const line of data.summary) {
    page.textRight(labelX, top, line.label, 9);
    page.textRight(RIGHT, top, rupiah(line.amount_idr), 9);
    top -= 13;
  }
  top -= 2;
  page.textRight(labelX, top, "Total", 11, true);
  page.textRight(RIGHT, top, rupiah(data.total_idr), 11, true);
  top -= 15;
  page.textRight(labelX, top, "Paid", 9);
  page.textRight(RIGHT, top, rupiah(data.paid_idr), 9);
  top -= 13;
  page.textRight(labelX, top, "Balance due", 10, true);
  page.textRight(
    RIGHT,
    top,
    rupiah(Math.max(0, data.total_idr - data.paid_idr)),
    10,
    true,
  );
  top -= 28;

  if (data.payment_instructions.trim()) {
    page.text(MARGIN, top, "Payment instructions", 9, true);
    top -= 14;
    for (const part of wrapText(data.payment_instructions, 9, RIGHT - MARGIN)) {
      if (top < MARGIN) break;
      page.text(MARGIN, top, part, 9);
      top -= 12;
    }
  }

  return finishPage(page, data.logo);
}

export interface MouPdfData {
  company: { name: string; lines: string[] };
  logo: PdfLogo | null;
  mou_number: string;
  issued_on: string;
  /** "DRAFT", "ACCEPTED", "REJECTED", "CANCELLED", atau "". */
  stamp: string;
  client: string[];
  /** Baris isi MoU: label di kiri, nilai rata kanan. */
  terms: { label: string; value: string }[];
  notes: string;
  /** Kalimat penutup, mis. DP ditagih terpisah. */
  footer: string;
  signatures: [string, string];
}

/**
 * MoU produksi satu halaman (v2.5a, PRD F-20): kop yang sama dengan invoice,
 * isi MoU, catatan, dan dua kotak tanda tangan.
 */
export function buildMouPdf(data: MouPdfData): Uint8Array {
  const page = new Page();
  let top = drawHeader(
    page,
    { ...data, stamp_note: "" },
    "PRODUCTION MOU",
    [data.mou_number, `Date ${data.issued_on}`],
  );

  page.text(MARGIN, top, "Client", 9, true);
  top -= 14;
  for (const line of data.client) {
    for (const part of wrapText(line, 10, RIGHT - MARGIN)) {
      page.text(MARGIN, top, part, 10);
      top -= 13;
    }
  }
  top -= 12;

  page.text(MARGIN, top, "Terms", 9, true);
  top -= 6;
  page.line(MARGIN, top, RIGHT, top);
  top -= 14;
  for (const row of data.terms) {
    page.text(MARGIN, top, row.label, 10);
    const parts = wrapText(row.value, 10, 260);
    for (const part of parts) {
      page.textRight(RIGHT, top, part, 10, true);
      top -= 13;
    }
    top -= 3;
  }
  page.line(MARGIN, top + 4, RIGHT, top + 4);
  top -= 14;

  if (data.notes.trim()) {
    page.text(MARGIN, top, "Notes", 9, true);
    top -= 14;
    for (const part of wrapText(data.notes, 9, RIGHT - MARGIN)) {
      page.text(MARGIN, top, part, 9);
      top -= 12;
    }
    top -= 8;
  }
  for (const part of wrapText(data.footer, 9, RIGHT - MARGIN)) {
    page.text(MARGIN, top, part, 9);
    top -= 12;
  }

  // Dua kotak tanda tangan di bawah halaman.
  const signY = Math.min(top - 40, 170);
  const half = (RIGHT - MARGIN) / 2;
  data.signatures.forEach((label, index) => {
    const x = MARGIN + index * half;
    page.text(x, signY, label, 9, true);
    page.line(x, signY - 60, x + half - 30, signY - 60);
    page.text(x, signY - 72, "Name and date", 8);
  });
  return finishPage(page, data.logo);
}

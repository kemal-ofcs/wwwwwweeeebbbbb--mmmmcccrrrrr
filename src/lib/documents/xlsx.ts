import { parseStoredTimestamp } from "@/lib/validations/client";

/**
 * Penulis dan pembaca Excel .xlsx untuk ekspor daftar, template impor, dan
 * impor (v2.8, PRD D-41). Tanpa dependensi, seperti penulis PDF invoice:
 * .xlsx adalah zip berisi beberapa XML. Penulis menyimpan zip tanpa kompresi
 * (sah untuk Excel); pembaca membongkar deflate dengan `DecompressionStream`
 * bawaan webview. XML dibaca dengan pola sederhana, bukan `DOMParser`, supaya
 * modul ini juga teruji di Bun.
 */

/** Sel tanggal: nomor seri Excel (hari sejak 1899-12-30, waktu lokal). */
export interface XlsxDate {
  serial: number;
  time: boolean;
}
export type XlsxCell = string | number | XlsxDate | null | undefined;

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// ---------------------------------------------------------------------------
// Tanggal
// ---------------------------------------------------------------------------

const EXCEL_EPOCH_DAYS = 25569; // 1970-01-01 sebagai nomor seri Excel.

/** Stempel UTC tersimpan → sel tanggal-jam waktu perangkat. */
export function excelDateTime(value: string | null | undefined): XlsxCell {
  const epoch = value ? parseStoredTimestamp(value) : null;
  if (epoch === null) return "";
  const date = new Date(epoch * 1000);
  const wall = Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
  );
  return { serial: EXCEL_EPOCH_DAYS + wall / 86_400_000, time: true };
}

/** `YYYY-MM-DD` → sel tanggal; selain itu teks apa adanya. */
export function excelDay(value: string | null | undefined): XlsxCell {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return value ?? "";
  const wall = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return { serial: EXCEL_EPOCH_DAYS + wall / 86_400_000, time: false };
}

/** Nomor seri Excel → `YYYY-MM-DD` atau `YYYY-MM-DD HH:MM` (dibaca `parseSheetDate`). */
export function serialToText(serial: number): string {
  const date = new Date(
    Math.round((serial - EXCEL_EPOCH_DAYS) * 86_400) * 1000,
  );
  const pad = (part: number) => String(part).padStart(2, "0");
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return minutes === 0
    ? day
    : `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** `clients-20261010.xlsx` dengan tanggal perangkat. */
export function exportFileName(subject: string) {
  const now = new Date();
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${subject}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.xlsx`;
}

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Zip tanpa kompresi (metode 0). */
function zip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(10, 0, true); // jam DOS 00:00
    local.setUint16(12, 0x21, true); // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, file.data.length, true);
    local.setUint32(22, file.data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, file.data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(14, 0x21, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, file.data.length, true);
    entry.setUint32(24, file.data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + file.data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Isi zip per nama berkas (metode 0 dan 8). */
async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (
    let at = bytes.length - 22;
    at >= Math.max(0, bytes.length - 65_557);
    at -= 1
  ) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("The file is not a valid .xlsx file.");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) {
      throw new Error("The file is not a valid .xlsx file.");
    }
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const dataAt =
      localAt +
      30 +
      view.getUint16(localAt + 26, true) +
      view.getUint16(localAt + 28, true);
    const raw = bytes.subarray(dataAt, dataAt + size);
    if (method === 0) {
      files.set(name, raw);
    } else if (method === 8) {
      const inflated = await new Response(
        new Blob([raw as BlobPart])
          .stream()
          .pipeThrough(new DecompressionStream("deflate-raw")),
      ).arrayBuffer();
      files.set(name, new Uint8Array(inflated));
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

// ---------------------------------------------------------------------------
// Tulis
// ---------------------------------------------------------------------------

/** Karakter kontrol selain tab dan baris baru tidak sah di XML. */
function stripControl(value: string) {
  return [...value]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
    .join("");
}

function escapeXml(value: string) {
  return stripControl(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnName(index: number) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

// Gaya sel: 0 biasa, 1 header tebal, 2 angka ribuan, 3 tanggal, 4 tanggal-jam.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;

/**
 * Satu sheet: baris pertama header tebal dan dibekukan, teks tetap teks
 * (nomor WhatsApp tidak menjadi `6.28E+12`), angka dengan pemisah ribuan,
 * tanggal sebagai tanggal Excel asli.
 */
export function buildXlsx(
  rows: readonly (readonly XlsxCell[])[],
  sheetName = "Data",
): Uint8Array {
  const widths: number[] = [];
  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
          let text = "";
          let xml = "";
          if (value === null || value === undefined || value === "") {
            return "";
          }
          if (typeof value === "number") {
            text = value.toLocaleString("en-US");
            xml = `<c r="${ref}" s="${rowIndex === 0 ? 1 : 2}"><v>${value}</v></c>`;
          } else if (typeof value === "object") {
            text = value.time ? "0000-00-00 00:00" : "0000-00-00";
            xml = `<c r="${ref}" s="${value.time ? 4 : 3}"><v>${value.serial}</v></c>`;
          } else {
            text = value;
            xml = `<c r="${ref}" t="inlineStr"${rowIndex === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
          }
          widths[columnIndex] = Math.max(
            widths[columnIndex] ?? 8,
            Math.min(50, text.length + 2),
          );
          return xml;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  const cols = widths.length
    ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width ?? 8}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${sheetRows}</sheetData></worksheet>`;
  const encoder = new TextEncoder();
  const file = (name: string, text: string) => ({
    name,
    data: encoder.encode(text),
  });
  return zip([
    file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    file(
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    file(
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    file(
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    file("xl/styles.xml", STYLES),
    file("xl/worksheets/sheet1.xml", sheet),
  ]);
}

// ---------------------------------------------------------------------------
// Baca
// ---------------------------------------------------------------------------

function decodeXml(value: string) {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower === "amp") return "&";
      if (lower === "lt") return "<";
      if (lower === "gt") return ">";
      if (lower === "quot") return '"';
      if (lower === "apos") return "'";
      return String.fromCodePoint(
        lower.startsWith("#x")
          ? Number.parseInt(lower.slice(2), 16)
          : Number(lower.slice(1)),
      );
    },
  );
}

function attribute(tag: string, name: string) {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/** Semua teks `<t>` di dalam satu potongan XML (teks kaya digabung). */
function texts(xml: string) {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((match) => decodeXml(match[1] ?? ""))
    .join("");
}

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47,
]);

/** Indeks `cellXfs` yang berformat tanggal. */
function dateStyles(styles: string) {
  const custom = new Map<number, string>();
  for (const match of styles.matchAll(/<numFmt\s[^>]*>/g)) {
    const id = Number(attribute(match[0], "numFmtId"));
    custom.set(id, decodeXml(attribute(match[0], "formatCode") ?? ""));
  }
  const isDate = (id: number) => {
    if (BUILTIN_DATE_FORMATS.has(id)) return true;
    const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
    return /[dmyh]/i.test(code);
  };
  const cellXfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  const result = new Set<number>();
  [...cellXfs.matchAll(/<xf\s[^>]*?\/?>/g)].forEach((match, index) => {
    if (isDate(Number(attribute(match[0], "numFmtId") ?? 0))) result.add(index);
  });
  return result;
}

function columnIndex(ref: string) {
  let index = 0;
  for (const char of /^[A-Z]+/.exec(ref)?.[0] ?? "A") {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

/**
 * Sheet pertama sebagai baris teks, bentuk yang sama dengan `parseCsv`:
 * sel tanggal menjadi `YYYY-MM-DD[ HH:MM]`, rumus dibaca nilai hasilnya,
 * baris kosong dibuang.
 */
export async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  const files = await unzip(bytes);
  const decoder = new TextDecoder();
  const text = (name: string) => {
    const data = files.get(name);
    return data ? decoder.decode(data) : "";
  };
  const workbook = text("xl/workbook.xml");
  const firstSheet = /<sheet\s[^>]*>/.exec(workbook)?.[0] ?? "";
  const relationId = attribute(firstSheet, "r:id");
  const relation = [
    ...text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\s[^>]*>/g),
  ]
    .map((match) => match[0])
    .find((tag) => attribute(tag, "Id") === relationId);
  const target = (
    attribute(relation ?? "", "Target") ?? "worksheets/sheet1.xml"
  ).replace(/^\/?(xl\/)?/, "");
  const sheet = text(`xl/${target}`);
  if (!sheet) throw new Error("The file has no worksheet.");
  const shared = [
    ...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((match) => texts(match[1] ?? ""));
  const dates = dateStyles(text("xl/styles.xml"));

  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(
    /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g,
  )) {
    const row: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(
      /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const attrs = ` ${cellMatch[1] ?? ""}`;
      const body = cellMatch[2] ?? "";
      const index = columnIndex(
        attribute(attrs, "r") ?? columnName(row.length),
      );
      const type = attribute(attrs, "t") ?? "n";
      const raw = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
      let value = raw;
      if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = texts(body);
      else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
      else if (
        type === "n" &&
        raw !== "" &&
        dates.has(Number(attribute(attrs, "s") ?? 0))
      ) {
        value = serialToText(Number(raw));
      }
      while (row.length < index) row.push("");
      row[index] = value;
    }
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

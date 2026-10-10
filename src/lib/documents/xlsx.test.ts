import { expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { buildXlsx, excelDay, readXlsx, serialToText } from "./xlsx";

test("ekspor dibaca kembali apa adanya", async () => {
  const bytes = buildXlsx([
    ["Kode Klien", "Nomor Klien", "Nominal", "Tanggal"],
    ["KLN-1", "6281234567890", 1_500_000, excelDay("2026-10-05")],
    ["A & B <x>", "", null, "baris 1\nbaris 2"],
  ]);
  expect(String.fromCharCode(...bytes.subarray(0, 2))).toBe("PK");
  expect(await readXlsx(bytes)).toEqual([
    ["Kode Klien", "Nomor Klien", "Nominal", "Tanggal"],
    ["KLN-1", "6281234567890", "1500000", "2026-10-05"],
    ["A & B <x>", "", "", "baris 1\nbaris 2"],
  ]);
});

test("nomor seri Excel menjadi tanggal yang dibaca parseSheetDate", () => {
  expect(serialToText(46300)).toBe("2026-10-05");
  expect(serialToText(46300.5)).toBe("2026-10-05 12:00");
});

/** Zip terkompresi seperti yang disimpan Excel (metode 8). */
function deflatedZip(files: Record<string, string>) {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(text.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, ...central, end]));
}

test("berkas dari Excel: terkompresi, shared strings, tanggal seri, rumus", async () => {
  const bytes = deflatedZip({
    "xl/workbook.xml":
      '<workbook xmlns:r="r"><sheets><sheet name="Klien" sheetId="1" r:id="rId3"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships><Relationship Id="rId3" Target="worksheets/sheet7.xml"/></Relationships>',
    "xl/sharedStrings.xml":
      "<sst><si><t>Nama Klien</t></si><si><r><t>Aura </t></r><r><t>Cosmetics</t></r></si><si><t>Tanggal</t></si></sst>",
    "xl/styles.xml":
      '<styleSheet><numFmts><numFmt numFmtId="170" formatCode="dd/mm/yyyy"/><numFmt numFmtId="171" formatCode="&quot;Rp&quot;#,##0"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="170"/><xf numFmtId="171"/></cellXfs></styleSheet>',
    "xl/worksheets/sheet7.xml":
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="3"><v>81234567890</v></c><c r="C2" s="2"><v>46300</v></c><c r="D2" t="str"><f>A2</f><v>Aura Cosmetics</v></c></row><row r="3"/></sheetData></worksheet>',
  });
  expect(await readXlsx(bytes)).toEqual([
    ["Nama Klien", "", "Tanggal"],
    ["Aura Cosmetics", "81234567890", "2026-10-05", "Aura Cosmetics"],
  ]);
});

test("bukan .xlsx ditolak dengan pesan yang jelas", async () => {
  await expect(readXlsx(new TextEncoder().encode("a,b\n1,2"))).rejects.toThrow(
    "The file is not a valid .xlsx file.",
  );
});

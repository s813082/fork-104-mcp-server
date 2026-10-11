import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readResume } from "../dist/resume.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function makePdf(text = "Synthetic Resume Engineer") {
  const content = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeDocx(paragraphs, advertisedExpandedSize) {
  const xml = Buffer.from(
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`,
  );
  const name = Buffer.from("word/document.xml");
  const crc = crc32(xml);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(xml.length, 18);
  local.writeUInt32LE(xml.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localHeader = Buffer.concat([local, name, xml]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(xml.length, 20);
  central.writeUInt32LE(advertisedExpandedSize ?? xml.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralRecord = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(localHeader.length, 16);
  return Buffer.concat([localHeader, centralRecord, eocd]);
}

async function withTempFile(name, buffer, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job104-resume-test-"));
  const file = path.join(directory, name);
  try {
    await writeFile(file, buffer);
    await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("reads TXT and Markdown with line evidence and omits the local path", async () => {
  for (const name of ["resume.txt", "resume.md"]) {
    const result = await readResume(path.join(fixtures, name));
    assert.equal(result.format, name.endsWith(".txt") ? "txt" : "md");
    assert.ok(result.sections.some((section) => section.location.startsWith("第 ") && section.text.includes("TypeScript")));
    assert.equal(JSON.stringify(result).includes(fixtures), false);
  }
});

test("extracts synthetic PDF text with page evidence", async () => {
  await withTempFile("resume.pdf", makePdf(), async (file) => {
    const result = await readResume(file);
    assert.equal(result.format, "pdf");
    assert.match(result.sections[0].location, /第 1 頁/);
    assert.match(result.sections[0].text, /Synthetic Resume Engineer/);
  });
});

test("extracts synthetic DOCX paragraphs with paragraph evidence", async () => {
  await withTempFile("resume.docx", makeDocx(["Synthetic Engineer", "Built TypeScript services"]), async (file) => {
    const result = await readResume(file);
    assert.equal(result.format, "docx");
    assert.deepEqual(result.sections.map((section) => section.location), ["第 1 段", "第 2 段"]);
    assert.match(result.sections[1].text, /TypeScript/);
  });
});

test("rejects DOCX expansion beyond the archive size bound before extraction", async () => {
  await withTempFile("bomb.docx", makeDocx(["Synthetic"], 25 * 1024 * 1024), async (file) => {
    await assert.rejects(() => readResume(file), /解壓後內容過大/);
  });
});

test("scanned or empty PDF gives a paste fallback and makes no network request", async () => {
  await withTempFile("resume.pdf", makePdf(""), async (file) => {
    const result = await readResume(file);
    assert.equal(result.pasteFallback, true);
    assert.match(result.warning, /不會送外部 OCR/);
  });
});

test("rejects unsupported and oversized files without exposing their path", async () => {
  await assert.rejects(() => readResume(path.join(fixtures, "salary-sample.csv")), /只支援/);
  await withTempFile("oversized.txt", Buffer.alloc(8 * 1024 * 1024 + 1), async (file) => {
    await assert.rejects(() => readResume(file), (error) => {
      assert.match(error.message, /8 MiB/);
      assert.equal(error.message.includes(file), false);
      return true;
    });
  });
  const fixtureContents = await readFile(path.join(fixtures, "resume.txt"), "utf8");
  assert.ok(fixtureContents.includes("Synthetic"));
});

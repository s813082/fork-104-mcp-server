import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractRawText } from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DOCX_EXPANDED_BYTES = 24 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const MAX_OUTPUT_CHARS = 120_000;

export type ResumeSection = {
  readonly location: string;
  readonly text: string;
};

export interface ResumeReadResult {
  readonly format: "pdf" | "docx" | "txt" | "md";
  readonly sections: readonly ResumeSection[];
  readonly extractedCharacters: number;
  readonly truncated: boolean;
  readonly pasteFallback: boolean;
  readonly warning?: string;
}

function trimSections(sections: ResumeSection[]): ResumeReadResult["sections"] {
  let remaining = MAX_OUTPUT_CHARS;
  const result: ResumeSection[] = [];
  for (const section of sections) {
    if (remaining <= 0) break;
    const text = section.text.slice(0, remaining);
    if (text.trim()) result.push({ location: section.location, text });
    remaining -= text.length;
  }
  return result;
}

function paragraphSections(text: string): { sections: ResumeSection[]; truncated: boolean } {
  const sections: ResumeSection[] = [];
  let characters = 0;
  let paragraphNumber = 0;
  const paragraphs = text.replace(/\r\n?/g, "\n").matchAll(/[^\n]+/g);
  for (const match of paragraphs) {
    const paragraph = match[0].replace(/[\t ]+/g, " ").trim();
    if (!paragraph) continue;
    paragraphNumber++;
    const bounded = paragraph.slice(0, MAX_OUTPUT_CHARS - characters);
    sections.push({ location: `第 ${paragraphNumber} 段`, text: bounded });
    characters += bounded.length;
    if (characters >= MAX_OUTPUT_CHARS) {
      return { sections, truncated: true };
    }
  }
  return { sections, truncated: false };
}

function lineSections(text: string): { sections: ResumeSection[]; truncated: boolean } {
  const sections: ResumeSection[] = [];
  let offset = 0;
  let lineNumber = 1;
  let characters = 0;
  let truncated = false;
  while (offset < text.length && characters < MAX_OUTPUT_CHARS) {
    const end = text.indexOf("\n", offset);
    const next = end < 0 ? text.length : end;
    const line = text.slice(offset, next).trim();
    if (line) {
      const bounded = line.slice(0, MAX_OUTPUT_CHARS - characters);
      if (bounded.length < line.length) truncated = true;
      sections.push({ location: `第 ${lineNumber} 行`, text: bounded });
      characters += bounded.length;
    }
    if (end < 0) {
      offset = text.length;
      break;
    }
    offset = end + 1;
    lineNumber++;
  }
  return { sections, truncated: truncated || offset < text.length };
}

/** Bound ZIP expansion before Mammoth opens a DOCX archive. */
function assertDocxArchiveBounded(buffer: Buffer): void {
  const minEocdLength = 22;
  const searchStart = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let i = buffer.length - minEocdLength; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("DOCX 壓縮檔結構無效");

  const entries = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (directoryOffset + directorySize > eocd || directorySize > 2 * 1024 * 1024) {
    throw new Error("DOCX 壓縮檔目錄超出允許大小");
  }

  let offset = directoryOffset;
  let expanded = 0;
  let documentXmlBytes = 0;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > directoryOffset + directorySize || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("DOCX 壓縮檔結構無效");
    }
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > directoryOffset + directorySize) throw new Error("DOCX 壓縮檔結構無效");
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    expanded += uncompressed;
    if (name === "word/document.xml") documentXmlBytes = uncompressed;
    if (expanded > MAX_DOCX_EXPANDED_BYTES || documentXmlBytes > MAX_OUTPUT_CHARS * 4) {
      throw new Error("DOCX 解壓後內容過大，請轉成 TXT 或貼上履歷文字");
    }
    offset = recordEnd;
  }
  if (documentXmlBytes === 0) throw new Error("DOCX 缺少主要文件內容");
}

async function readPdf(buffer: Buffer): Promise<ResumeReadResult> {
  const task = getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    standardFontDataUrl: fileURLToPath(import.meta.resolve("pdfjs-dist/standard_fonts/")),
  });
  const pdf = await task.promise;
  try {
    const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
    const sections: ResumeSection[] = [];
    let chars = 0;
    for (let pageNumber = 1; pageNumber <= pageCount && chars < MAX_OUTPUT_CHARS; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) {
        sections.push({ location: `第 ${pageNumber} 頁`, text });
        chars += text.length;
      }
    }
    const trimmed = trimSections(sections);
    const extractedCharacters = trimmed.reduce((sum, section) => sum + section.text.length, 0);
    const pasteFallback = extractedCharacters === 0;
    const truncated = chars > MAX_OUTPUT_CHARS || pdf.numPages > MAX_PDF_PAGES;
    return {
      format: "pdf",
      sections: trimmed,
      extractedCharacters,
      truncated,
      pasteFallback,
      ...(pasteFallback
        ? { warning: "PDF 沒有可抽取的文字，可能是掃描檔；請貼上履歷文字，系統不會送外部 OCR。" }
        : truncated
          ? { warning: pdf.numPages > MAX_PDF_PAGES ? `只讀取前 ${MAX_PDF_PAGES} 頁，並限制輸出長度。` : `履歷文字超過 ${MAX_OUTPUT_CHARS} 字，已截斷。` }
          : {}),
    };
  } finally {
    await pdf.destroy();
  }
}

/** Read only the explicitly supplied local resume; this function never logs or saves its contents. */
export async function readResume(filePath: string): Promise<ResumeReadResult> {
  const extension = path.extname(filePath).toLowerCase();
  if (![".pdf", ".docx", ".txt", ".md", ".markdown"].includes(extension)) {
    throw new Error("只支援 PDF、DOCX、TXT 或 Markdown 履歷");
  }
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw new Error("指定的履歷檔案不存在或不是一般檔案");
  if (info.size > MAX_FILE_BYTES) throw new Error("履歷檔案超過 8 MiB 上限");
  const buffer = await readFile(filePath);
  if (buffer.length > MAX_FILE_BYTES) throw new Error("履歷檔案超過 8 MiB 上限");

  const format = extension === ".pdf" ? "pdf" : extension === ".docx" ? "docx" : extension === ".txt" ? "txt" : "md";
  if (format === "pdf") return readPdf(buffer);

  let text: string;
  if (format === "docx") {
    assertDocxArchiveBounded(buffer);
    text = (await extractRawText({ buffer })).value;
  } else {
    text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }

  const normalized = text.replace(/\r\n?/g, "\n");
  const plainLines = format === "txt" || format === "md" ? lineSections(normalized) : null;
  const docxParagraphs = format === "docx" ? paragraphSections(normalized) : null;
  const sections = plainLines?.sections ?? docxParagraphs?.sections ?? [];
  const trimmed = trimSections(sections);
  const extractedCharacters = trimmed.reduce((sum, section) => sum + section.text.length, 0);
  return {
    format,
    sections: trimmed,
    extractedCharacters,
    truncated: plainLines?.truncated ?? docxParagraphs?.truncated ?? normalized.length > MAX_OUTPUT_CHARS,
    pasteFallback: extractedCharacters === 0,
    ...(extractedCharacters === 0
      ? { warning: "檔案沒有可讀文字，請貼上履歷文字。" }
      : (plainLines?.truncated || docxParagraphs?.truncated || normalized.length > MAX_OUTPUT_CHARS)
        ? { warning: `履歷文字超過 ${MAX_OUTPUT_CHARS} 字，已截斷。` }
        : {}),
  };
}

/**
 * Generate real Office documents (Word .docx, Excel .xlsx, PowerPoint .pptx)
 * from simple structured/markdown specs, and save them into the knowledge base.
 * The .docx/.xlsx/.pptx files open natively in MS Office AND import cleanly into
 * Google Docs / Sheets / Slides.
 */
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
} from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import { kbWriteBinary, type KbMeta } from './kb.js';

// ── Word (.docx) from lightweight markdown ─────────────────
const inlineRuns = (line: string): TextRun[] => {
  const runs: TextRun[] = [];
  const re = /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) runs.push(new TextRun(line.slice(last, m.index)));
    if (m[1]) runs.push(new TextRun({ text: m[1].slice(2, -2), bold: true }));
    else if (m[2]) runs.push(new TextRun({ text: m[2].slice(1, -1), italics: true }));
    else if (m[3]) runs.push(new TextRun({ text: m[3].slice(1, -1), font: 'Consolas' }));
    last = m.index + m[0].length;
  }
  if (last < line.length) runs.push(new TextRun(line.slice(last)));
  return runs.length ? runs : [new TextRun(line)];
};

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-');

function markdownToDocxChildren(md: string): (Paragraph | Table)[] {
  const lines = md.replace(/\r/g, '').split('\n');
  const out: (Paragraph | Table)[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // table
    if (isTableRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const rows: string[][] = [];
      const header = line.split('|').slice(1, -1).map((c) => c.trim());
      rows.push(header);
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
        i++;
      }
      i--;
      const border = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
      out.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: rows.map(
            (r, ri) =>
              new TableRow({
                children: r.map(
                  (c) =>
                    new TableCell({
                      borders: { top: border, bottom: border, left: border, right: border },
                      margins: { top: 60, bottom: 60, left: 100, right: 100 },
                      children: [new Paragraph({ children: [new TextRun({ text: c, bold: ri === 0 })] })],
                    }),
                ),
              }),
          ),
        }),
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)/.exec(line);
    if (h) {
      const lvl = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][h[1].length - 1];
      out.push(new Paragraph({ heading: lvl, children: inlineRuns(h[2]) }));
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      out.push(new Paragraph({ bullet: { level: 0 }, children: inlineRuns(line.replace(/^\s*[-*]\s+/, '')) }));
      continue;
    }
    const num = /^\s*\d+\.\s+/.exec(line);
    if (num) {
      out.push(new Paragraph({ numbering: { reference: 'num', level: 0 }, children: inlineRuns(line.replace(/^\s*\d+\.\s+/, '')) }));
      continue;
    }
    if (!line.trim()) {
      out.push(new Paragraph(''));
      continue;
    }
    out.push(new Paragraph({ children: inlineRuns(line) }));
  }
  return out;
}

export async function createWordDoc(name: string, markdown: string, meta?: Partial<KbMeta>): Promise<string> {
  const doc = new Document({
    numbering: {
      config: [{ reference: 'num', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'left' }] }],
    },
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children: markdownToDocxChildren(markdown) }],
  });
  const buf = await Packer.toBuffer(doc);
  const file = name.endsWith('.docx') ? name : `${name}.docx`;
  kbWriteBinary(`documents/${file}`, buf, meta);
  return `documents/${file}`;
}

// ── Excel (.xlsx) ──────────────────────────────────────────
export interface SheetSpec {
  name?: string;
  headers?: string[];
  rows: (string | number)[][];
}

export async function createSpreadsheet(name: string, sheets: SheetSpec[], meta?: Partial<KbMeta>): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Pixel Office';
  for (const [i, s] of sheets.entries()) {
    const ws = wb.addWorksheet(s.name || `Sheet${i + 1}`);
    if (s.headers?.length) {
      const hr = ws.addRow(s.headers);
      hr.font = { bold: true };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF223A5C' } };
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    }
    for (const r of s.rows) ws.addRow(r);
    ws.columns.forEach((col) => {
      let max = 10;
      col.eachCell?.({ includeEmpty: false }, (cell) => {
        max = Math.max(max, String(cell.value ?? '').length + 2);
      });
      col.width = Math.min(60, max);
    });
  }
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const file = name.endsWith('.xlsx') ? name : `${name}.xlsx`;
  kbWriteBinary(`documents/${file}`, buf, meta);
  return `documents/${file}`;
}

// ── PowerPoint (.pptx) ─────────────────────────────────────
export interface SlideSpec {
  title: string;
  bullets?: string[];
  notes?: string;
}

export async function createPresentation(name: string, slides: SlideSpec[], meta?: Partial<KbMeta>): Promise<string> {
  // pptxgenjs's ESM interop double-wraps the default export; the class lives at
  // `.default` at runtime. Fall back to the import itself just in case.
  const Ctor = ((PptxGenJS as any)?.default ?? PptxGenJS) as new () => any;
  const pptx = new Ctor();
  pptx.layout = 'LAYOUT_WIDE';
  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addText(s.title, { x: 0.5, y: 0.3, w: 12.3, h: 0.9, fontSize: 28, bold: true, color: '1F4A7A' });
    if (s.bullets?.length) {
      slide.addText(
        s.bullets.map((b) => ({ text: b, options: { bullet: true, fontSize: 18, color: '333333', breakLine: true } })),
        { x: 0.7, y: 1.4, w: 11.9, h: 5.5, valign: 'top' },
      );
    }
    if (s.notes) slide.addNotes(s.notes);
  }
  const file = name.endsWith('.pptx') ? name : `${name}.pptx`;
  // pptxgenjs writes to a Node Buffer via 'nodebuffer'
  const buf = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  kbWriteBinary(`documents/${file}`, buf, meta);
  return `documents/${file}`;
}

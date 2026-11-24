export type ReportColumn = { label: string; end?: boolean; weight?: number };
export type ReportSection = {
  heading: string; notes?: string[]; fields?: [string, string][]; table?: { columns: ReportColumn[]; rows: string[][] };
};
export type Report = { title: string; status: string; generated: string; sections: ReportSection[] };

const pageSize: [number, number] = [595.28, 841.89];
const margin = 40;
const contentWidth = pageSize[0] - margin * 2;
const pageTop = pageSize[1] - margin;
const pageBottom = margin + 22;

/** Breaks text by words, and inside a word only when it alone is wider than the line. */
export function wrapText(text: string, width: number, measure: (text: string) => number) {
  const lines: string[] = [];
  let line = '';
  for (let word of text.split(/\s+/).filter(Boolean)) {
    const joined = line ? line + ' ' + word : word;
    if (measure(joined) <= width) { line = joined; continue; }
    if (line) lines.push(line);
    while (measure(word) > width && word.length > 1) {
      let size = word.length - 1;
      while (size > 1 && measure(word.slice(0, size)) > width) size--;
      lines.push(word.slice(0, size));
      word = word.slice(size);
    }
    line = word;
  }
  return line ? [...lines, line] : [''];
}

/** The library is loaded here, on the first PDF, so the panel does not carry it on every visit. */
export async function renderPdf(report: Report) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle(report.title);
  doc.setCreator('LeS Manager');
  doc.setProducer('LeS Manager');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  type Font = typeof regular;
  const ink = rgb(.11, .1, .09), muted = rgb(.39, .36, .35), rule = rgb(.87, .85, .84), band = rgb(.95, .94, .94), brand = rgb(.65, .18, .25);
  // The built-in fonts cover Portuguese, and anything else typed in a note must not stop the document.
  const known = new Set(regular.getCharacterSet());
  const clean = (text: string) => [...text.normalize('NFC').replace(/≈/g, '~').replace(/−/g, '-').replace(/[   \r\n\t]/g, ' ')]
    .map(char => known.has(char.codePointAt(0)!) ? char : '?').join('');
  const lines = (text: string, width: number, size: number, font: Font = regular) => wrapText(clean(text), width, part => font.widthOfTextAtSize(part, size));

  let page = doc.addPage(pageSize);
  let y = pageTop;
  const write = (text: string, x: number, baseline: number, size: number, font: Font = regular, color = ink) => page.drawText(text, { x, y: baseline, size, font, color });
  const fits = (height: number) => {
    if (y - height >= pageBottom) return true;
    page = doc.addPage(pageSize);
    y = pageTop;
    return false;
  };

  const status = clean(report.status);
  write(clean(report.title), margin, y - 16, 18, bold);
  write(status, margin + contentWidth - bold.widthOfTextAtSize(status, 11), y - 14, 11, bold, brand);
  write(clean(report.generated), margin, y - 32, 9, regular, muted);
  y -= 42;
  page.drawLine({ start: { x: margin, y }, end: { x: margin + contentWidth, y }, thickness: 1, color: rule });
  y -= 6;

  function drawFields(fields: [string, string][]) {
    const width = (contentWidth - 16) / 2;
    for (let index = 0; index < fields.length; index += 2) {
      const pair = fields.slice(index, index + 2).map(([label, value]) => ({ label: clean(label), value: lines(value, width, 10) }));
      const height = 14 + Math.max(...pair.map(cell => cell.value.length)) * 13 + 4;
      fits(height);
      pair.forEach((cell, column) => {
        const x = margin + column * (width + 16);
        write(cell.label, x, y - 9, 8, regular, muted);
        cell.value.forEach((text, row) => write(text, x, y - 22 - row * 13, 10));
      });
      y -= height;
    }
  }

  function drawTable({ columns, rows }: NonNullable<ReportSection['table']>) {
    const total = columns.reduce((sum, column) => sum + (column.weight ?? 1), 0);
    const widths = columns.map(column => contentWidth * (column.weight ?? 1) / total);
    const left = (index: number) => margin + widths.slice(0, index).reduce((sum, width) => sum + width, 0);
    const cell = (text: string, index: number, baseline: number, font: Font) => {
      const x = columns[index].end ? left(index) + widths[index] - 5 - font.widthOfTextAtSize(text, 8.5) : left(index) + 5;
      write(text, x, baseline, 8.5, font);
    };
    const heads = columns.map((column, index) => lines(column.label, widths[index] - 10, 8.5, bold));
    const headHeight = Math.max(...heads.map(head => head.length)) * 11 + 8;
    const drawHead = () => {
      page.drawRectangle({ x: margin, y: y - headHeight, width: contentWidth, height: headHeight, color: band });
      heads.forEach((head, index) => head.forEach((text, row) => cell(text, index, y - 12 - row * 11, bold)));
      y -= headHeight;
    };
    const wrapped = rows.map(row => row.map((text, index) => lines(text, widths[index] - 10, 8.5)));
    fits(headHeight + Math.max(...wrapped[0].map(part => part.length)) * 11 + 8);
    drawHead();
    for (const row of wrapped) {
      const height = Math.max(...row.map(part => part.length)) * 11 + 8;
      // A row never splits between pages, and a new page repeats the column names.
      if (!fits(height)) drawHead();
      row.forEach((parts, index) => parts.forEach((text, line) => cell(text, index, y - 12 - line * 11, regular)));
      y -= height;
      page.drawLine({ start: { x: margin, y }, end: { x: margin + contentWidth, y }, thickness: .5, color: rule });
    }
    y -= 4;
  }

  for (const section of report.sections) {
    fits(52);
    y -= 12;
    write(clean(section.heading), margin, y - 10, 11, bold, brand);
    y -= 18;
    for (const note of section.notes ?? []) {
      const wrappedNote = lines(note, contentWidth, 9);
      fits(wrappedNote.length * 12 + 2);
      wrappedNote.forEach((text, row) => write(text, margin, y - 9 - row * 12, 9, regular, muted));
      y -= wrappedNote.length * 12 + 2;
    }
    if (section.fields?.length) drawFields(section.fields);
    if (section.table?.rows.length) drawTable(section.table);
  }

  const pages = doc.getPages();
  pages.forEach((item, index) => {
    const label = clean('Página ' + (index + 1) + ' de ' + pages.length);
    item.drawText(clean(report.title), { x: margin, y: margin - 8, size: 8, font: regular, color: muted });
    item.drawText(label, { x: margin + contentWidth - regular.widthOfTextAtSize(label, 8), y: margin - 8, size: 8, font: regular, color: muted });
  });
  return doc.save();
}

export type ReportColumn = { label: string; end?: boolean; weight?: number };
/** An image ready for the PDF. Only PNG and JPG embed directly; `loadReportImage` converts the rest. */
export type ReportImage = { bytes: Uint8Array; kind: 'png' | 'jpg' };
/** Lines above the highlighted value, such as unit price and discount, then the value itself. */
export type ReportTotal = { lines?: [string, string][]; label: string; value: string };
export type ReportSection = {
  heading: string; notes?: string[]; fields?: [string, string][]; table?: { columns: ReportColumn[]; rows: string[][] };
  image?: ReportImage | null; total?: ReportTotal;
};
/** The company letterhead. Without it the document keeps the plain internal header. */
export type ReportBrand = { name: string; tagline?: string | null; contact?: string | null; logo?: ReportImage | null };
export type Report = { title: string; status: string; generated: string; sections: ReportSection[]; brand?: ReportBrand; footer?: string | null };

/** Tells the image format by its first bytes, never by the name or the declared type. */
export function imageKind(bytes: Uint8Array): ReportImage['kind'] | 'webp' | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Fits a width and height inside a box, keeping the proportion and never enlarging. */
export function fitImage(width: number, height: number, maxWidth: number, maxHeight: number) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: width * scale, height: height * scale };
}

/** Reads an image of the panel for the PDF. WebP becomes PNG through a canvas, in the browser. Missing or unreadable images give null. */
export async function loadReportImage(url: string): Promise<ReportImage | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const kind = imageKind(bytes);
    if (kind === 'png' || kind === 'jpg') return { bytes, kind };
    if (kind !== 'webp') return null;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    return png ? { bytes: new Uint8Array(await png.arrayBuffer()), kind: 'png' } : null;
  } catch {
    return null;
  }
}

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
  // A damaged image leaves its space empty instead of stopping the document.
  const embed = async (image?: ReportImage | null) => {
    if (!image) return null;
    try { return await (image.kind === 'png' ? doc.embedPng(image.bytes) : doc.embedJpg(image.bytes)); } catch { return null; }
  };
  const white = rgb(1, 1, 1);

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
  const right = (text: string, baseline: number, size: number, font: Font = regular, color = ink) => write(text, margin + contentWidth - font.widthOfTextAtSize(text, size), baseline, size, font, color);
  if (report.brand) {
    // Letterhead: logo and company on the left, the document on the right.
    const logo = await embed(report.brand.logo);
    const box = logo ? fitImage(logo.width, logo.height, 120, 56) : { width: 0, height: 0 };
    if (logo) page.drawImage(logo, { x: margin, y: y - box.height, ...box });
    const left = margin + (logo ? box.width + 12 : 0);
    const titleWidth = Math.max(bold.widthOfTextAtSize(clean(report.title), 16), bold.widthOfTextAtSize(status, 10));
    const textWidth = Math.max(80, margin + contentWidth - titleWidth - 16 - left);
    const name = lines(report.brand.name, textWidth, 14, bold);
    const tagline = report.brand.tagline ? lines(report.brand.tagline, textWidth, 9) : [];
    const contact = (report.brand.contact ?? '').split(/\r?\n/).flatMap(line => line.trim() ? lines(line, textWidth, 8) : []);
    let text = y;
    name.forEach(part => { write(part, left, text - 14, 14, bold); text -= 17; });
    tagline.forEach(part => { write(part, left, text - 9, 9, regular, muted); text -= 11; });
    if (contact.length) text -= 3;
    contact.forEach(part => { write(part, left, text - 8, 8, regular, muted); text -= 10; });
    right(clean(report.title), y - 14, 16, bold);
    right(status, y - 29, 10, bold, brand);
    right(clean(report.generated), y - 42, 8, regular, muted);
    y = Math.min(y - box.height, text, y - 46) - 10;
  } else {
    write(clean(report.title), margin, y - 16, 18, bold);
    right(status, y - 14, 11, bold, brand);
    write(clean(report.generated), margin, y - 32, 9, regular, muted);
    y -= 42;
  }
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

  async function drawImage(image: ReportImage) {
    const embedded = await embed(image);
    if (!embedded) return;
    const box = fitImage(embedded.width, embedded.height, contentWidth, 240);
    fits(box.height + 8);
    page.drawImage(embedded, { x: margin, y: y - box.height, ...box });
    y -= box.height + 8;
  }

  // Right-aligned block: the supporting lines, then the value on a colored band.
  function drawTotal(total: ReportTotal) {
    const width = Math.min(contentWidth, 240), x = margin + contentWidth - width;
    const supporting = (total.lines ?? []).map(([label, value]) => [clean(label), clean(value)]);
    fits(supporting.length * 15 + 34);
    for (const [label, value] of supporting) {
      write(label, x + 10, y - 11, 9.5, regular, muted);
      write(value, margin + contentWidth - 10 - regular.widthOfTextAtSize(value, 9.5), y - 11, 9.5);
      y -= 15;
    }
    y -= 4;
    page.drawRectangle({ x, y: y - 28, width, height: 28, color: brand });
    write(clean(total.label), x + 10, y - 18, 10, bold, white);
    const value = clean(total.value);
    write(value, margin + contentWidth - 10 - bold.widthOfTextAtSize(value, 13), y - 19, 13, bold, white);
    y -= 34;
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
    if (section.image) await drawImage(section.image);
    if (section.fields?.length) drawFields(section.fields);
    if (section.table?.rows.length) drawTable(section.table);
    if (section.total) drawTotal(section.total);
  }

  if (report.footer?.trim()) {
    const footer = report.footer.split(/\r?\n/).flatMap(line => line.trim() ? lines(line, contentWidth, 9) : []);
    fits(footer.length * 12 + 18);
    y -= 8;
    page.drawLine({ start: { x: margin, y }, end: { x: margin + contentWidth, y }, thickness: .5, color: rule });
    y -= 6;
    footer.forEach(text => { write(text, margin + (contentWidth - regular.widthOfTextAtSize(text, 9)) / 2, y - 9, 9, regular, muted); y -= 12; });
  }

  const pages = doc.getPages();
  pages.forEach((item, index) => {
    const label = clean('Página ' + (index + 1) + ' de ' + pages.length);
    item.drawText(clean(report.title), { x: margin, y: margin - 8, size: 8, font: regular, color: muted });
    item.drawText(label, { x: margin + contentWidth - regular.widthOfTextAtSize(label, 8), y: margin - 8, size: 8, font: regular, color: muted });
  });
  return doc.save();
}

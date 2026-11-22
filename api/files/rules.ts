/** Pure rules for received files: no disk, database or HTTP here. */

export const megabyte = 1024 * 1024;
export const productFileLimit = 100 * megabyte;

const blockedExtensions = new Set([
  'app', 'apk', 'appx', 'bat', 'bin', 'cmd', 'com', 'cpl', 'deb', 'dll', 'dmg', 'exe', 'gadget', 'hta', 'inf', 'ins', 'isp', 'jar', 'js', 'jse', 'ksh', 'lnk',
  'msc', 'msi', 'msix', 'msp', 'mst', 'pif', 'ps1', 'ps1xml', 'ps2', 'psc1', 'psd1', 'psm1', 'reg', 'rpm', 'run', 'scf', 'scr', 'sct', 'sh', 'sys', 'url',
  'vb', 'vbe', 'vbs', 'ws', 'wsc', 'wsf', 'wsh',
]);

/** Keeps only a display name: no folders, control characters or characters Windows forbids. */
export function safeFileName(value: string) {
  const base = value.normalize('NFC').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/[. ]+$/, '').replace(/^[. ]+/, '').trim();
  if (!clean) return 'arquivo';
  if (clean.length <= 200) return clean;
  const dot = clean.lastIndexOf('.');
  const extension = dot > 0 && clean.length - dot <= 20 ? clean.slice(dot) : '';
  return clean.slice(0, 200 - extension.length) + extension;
}

export function hasBlockedExtension(name: string) {
  const safe = safeFileName(name);
  const dot = safe.lastIndexOf('.');
  return dot >= 0 && blockedExtensions.has(safe.slice(dot + 1).toLowerCase());
}

/** Recognizes Windows, Linux and macOS programs and scripts by their first bytes, whatever the file is called. */
export function hasExecutableSignature(head: Buffer) {
  if (head.length >= 2 && (head.subarray(0, 2).toString('latin1') === 'MZ' || head.subarray(0, 2).toString('latin1') === '#!')) return true;
  if (head.length < 4) return false;
  return ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(head.subarray(0, 4).toString('hex'));
}

export const purchaseDocumentLimit = 20 * megabyte;
export const purchaseDocumentMessage = 'Envie um PDF, uma imagem (JPG, PNG, WebP, GIF ou TIFF) ou um XML.';

const documentSignatures = new Map([
  ['pdf', ['25504446']], ['png', ['89504e47']], ['jpg', ['ffd8ff']], ['jpeg', ['ffd8ff']], ['webp', ['52494646']], ['gif', ['47494638']],
  ['tif', ['49492a00', '4d4d002a']], ['tiff', ['49492a00', '4d4d002a']],
]);
const extensionOf = (name: string) => {
  const safe = safeFileName(name);
  const dot = safe.lastIndexOf('.');
  return dot < 0 ? '' : safe.slice(dot + 1).toLowerCase();
};

export const hasDocumentExtension = (name: string) => extensionOf(name) === 'xml' || documentSignatures.has(extensionOf(name));

/** XML may open with a byte order mark or blank space before its first tag. */
function looksLikeXml(head: Buffer) {
  const hex = head.toString('hex');
  if (hex.startsWith('fffe3c00') || hex.startsWith('feff003c')) return true;
  return head.toString('latin1').replace(/^\xef\xbb\xbf/, '').trimStart().startsWith('<');
}

/** The first bytes must agree with the extension, so a renamed file is refused. */
export function matchesDocumentContent(name: string, head: Buffer) {
  const extension = extensionOf(name);
  if (extension === 'xml') return looksLikeXml(head);
  const hex = head.toString('hex');
  return (documentSignatures.get(extension) ?? []).some(signature => hex.startsWith(signature));
}

export const productImageLimit = 5 * megabyte;
export const productImageMessage = 'Envie uma imagem JPG, PNG ou WebP.';
// SVG stays out on purpose: it can carry scripts, and images are the one file type shown inline.
const imageTypes = new Map([['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]);

export const hasImageExtension = (name: string) => imageTypes.has(extensionOf(name));
export const imageType = (name: string) => imageTypes.get(extensionOf(name)) ?? 'application/octet-stream';

/** The real bytes decide, so the type sent when showing the image is always true. */
export function matchesImageContent(name: string, head: Buffer) {
  const type = imageTypes.get(extensionOf(name));
  const hex = head.toString('hex');
  if (type === 'image/jpeg') return hex.startsWith('ffd8ff');
  if (type === 'image/png') return hex.startsWith('89504e47');
  return type === 'image/webp' && hex.startsWith('52494646') && hex.slice(16, 24) === '57454250';
}

/** The browser's declared type is only informative, so anything unusual is stored as generic binary. */
export function safeMimeType(value: string | undefined) {
  const type = value?.split(';')[0].trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(type) && type.length <= 127 ? type : 'application/octet-stream';
}

/** RFC 6266 header: an ASCII fallback plus the exact UTF-8 name. */
export function attachmentHeader(name: string) {
  const safe = safeFileName(name);
  const ascii = safe.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/["\\%;]/g, '_');
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encoded;
}

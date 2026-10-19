// Turn an uploaded invoice file into text for the agent.
//
//   PDF with a text layer -> its text
//   plain text            -> as is
//   JPG / PNG             -> the AI vision reader (needs GROQ_API_KEY)
//   PDF with no text      -> its first pages rendered to images, then the
//                            vision reader (needs GROQ_API_KEY)
//
// A scan or photo read by the vision reader comes back with its transcription
// (kept as the invoice text) and the fields already grounded against it.

import { extractText, getDocumentProxy, renderPageAsImage } from 'unpdf';

import { MAX_VISION_IMAGES } from '../agent/finance/extract.js';
import { HttpError } from './runs.js';

export const NEEDS_OCR = 'No text could be read from that file. If it is a scan or a photo, it needs OCR, which this prototype does not include.';
export const NOT_SUPPORTED = 'Upload a PDF or a plain text file.';

const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

// What kind of file this is, from its name and type, and for images from its first bytes.
export function uploadKind(file) {
  const name = file.originalname || 'upload';
  const type = file.mimetype || '';
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (/^image\/(png|jpe?g)$/.test(type) || /\.(png|jpe?g)$/i.test(name)) {
    if (isPng(file.buffer)) return 'png';
    if (isJpeg(file.buffer)) return 'jpeg';
    return 'bad-image';
  }
  if (type.startsWith('text/') || /\.(txt|text|csv|md)$/i.test(name)) return 'text';
  return 'other';
}

/** The first pages of a PDF as PNG images, using unpdf with @napi-rs/canvas. */
export async function renderPdfPages(buffer, max = MAX_VISION_IMAGES) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const pages = [];
  for (let n = 1; n <= Math.min(pdf.numPages, max); n += 1) {
    const png = await renderPageAsImage(pdf, n, { canvasImport: () => import('@napi-rs/canvas'), scale: 2 });
    pages.push({ mimetype: 'image/png', data: Buffer.from(png) });
  }
  return pages;
}

async function readWithVision(vision, images, name) {
  try {
    return await vision.read(images);
  } catch (err) {
    throw new HttpError(422, `"${name}" could not be read by the AI vision reader: ${err?.message || 'unknown error'}`);
  }
}

/**
 * @param file   multer file { originalname, mimetype, buffer }
 * @param vision createVisionReader(config), or null without a Groq key
 * @returns { rawText, source, reading? } - `reading` only for scans and photos
 */
export async function readUpload(file, { vision = null, renderPages = renderPdfPages } = {}) {
  const name = file.originalname || 'upload';
  const kind = uploadKind(file);
  const source = { kind: 'upload', filename: name };

  if (kind === 'pdf') {
    let text;
    try {
      const pdf = await getDocumentProxy(new Uint8Array(file.buffer));
      text = (await extractText(pdf, { mergePages: true })).text || '';
    } catch (err) {
      console.error(`PDF could not be read (${name}):`, err?.message || err);
      throw new HttpError(400, `"${name}" could not be opened as a PDF. It may be damaged or password protected.`);
    }
    if (text.replace(/\u0000/g, '').trim() || !vision) return { rawText: text, source };

    // No text layer: a scanned PDF. Render its first pages and read them as images.
    let pages;
    try {
      pages = await renderPages(file.buffer);
    } catch (err) {
      console.error(`Scanned PDF could not be rendered (${name}):`, err?.message || err);
      throw new HttpError(400, `${NEEDS_OCR} (The scanned pages could not be turned into images on this server.)`);
    }
    if (!pages.length) throw new HttpError(400, NEEDS_OCR);
    const { transcription, reading } = await readWithVision(vision, pages, name);
    return { rawText: transcription, reading, source: { ...source, scan: { from: 'pdf', pages: pages.length, model: vision.model } } };
  }

  if (kind === 'png' || kind === 'jpeg') {
    if (!vision) throw new HttpError(400, NOT_SUPPORTED);
    const { transcription, reading } = await readWithVision(vision, [{ mimetype: `image/${kind}`, data: file.buffer }], name);
    return { rawText: transcription, reading, source: { ...source, scan: { from: 'image', pages: 1, model: vision.model } } };
  }
  if (kind === 'bad-image') throw new HttpError(400, `"${name}" is not a valid JPG or PNG image.`);
  if (kind === 'text') return { rawText: file.buffer.toString('utf8'), source };
  throw new HttpError(400, vision ? 'Upload a PDF, a JPG or PNG image, or a plain text file.' : NOT_SUPPORTED);
}

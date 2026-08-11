// Turns an input source (file or URL) into plain text ready for the TTS
// engine. Each format gets its own small extractor; markdown/HTML markup is
// stripped so the model doesn't try to voice stray symbols.

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

function stripMarkdown(md) {
  return md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^-{3,}\s*$/gm, '')
    .replace(/\|/g, ' ')
    .trim();
}

function collapseWhitespace(text) {
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// A PDF outline (bookmark) entry's `dest` isn't a page number — it's either a
// named destination (a string that needs a separate lookup) or an explicit
// destination array whose first element is a page *reference*, which only
// resolves to a page index via the document itself. `getDestination` for
// named destinations and `getPageIndex` both come from pdfjs-dist's document
// proxy, which pdf-parse's PDFParse wrapper stores on `this.doc` — untyped
// as `private` in its .d.ts, but that's a TypeScript-only annotation with no
// runtime enforcement, so it's reachable as `parser.doc` after a load.
async function resolvePdfDestToPage(dest, doc) {
  try {
    const explicitDest = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    const ref = Array.isArray(explicitDest) ? explicitDest[0] : null;
    if (!ref) return null;
    return (await doc.getPageIndex(ref)) + 1; // pdf.js page indices are 0-based
  } catch {
    return null; // some bookmarks point at actions (e.g. a URL) rather than a page
  }
}

async function resolvePdfOutline(nodes, doc, pageOffsets, headings, level) {
  for (const node of nodes) {
    const title = (node.title || '').trim();
    const pageNum = node.dest ? await resolvePdfDestToPage(node.dest, doc) : null;
    if (title && pageNum !== null && pageOffsets.has(pageNum)) {
      headings.push({ level, title, offset: pageOffsets.get(pageNum) });
    }
    if (node.items?.length) await resolvePdfOutline(node.items, doc, pageOffsets, headings, level + 1);
  }
}

async function extractPdf(filePath) {
  const { PDFParse } = require('pdf-parse');
  const data = fs.readFileSync(filePath);
  const parser = new PDFParse({ data });
  try {
    const textResult = await parser.getText();

    const parts = [];
    const pageOffsets = new Map(); // 1-based page number -> offset of that page's text
    let offset = 0;
    for (const page of textResult.pages) {
      const text = collapseWhitespace(page.text);
      if (!text) continue;
      pageOffsets.set(page.num, offset);
      parts.push(text);
      offset += text.length + 2; // matches the '\n\n' joiner below
    }

    const headings = [];
    const info = await parser.getInfo();
    if (info.outline?.length) await resolvePdfOutline(info.outline, parser.doc, pageOffsets, headings, 1);

    return { title: path.basename(filePath, path.extname(filePath)), text: parts.join('\n\n'), headings };
  } finally {
    await parser.destroy();
  }
}

// mammoth can't parse Word's TOC field (it's a computed field, not real
// content), but it doesn't discard it either — the field's cached result
// text survives as ordinary paragraphs styled "TOC 1".."TOC 9". Left alone,
// that shows up as a garbled, page-numbered duplicate of the outline right
// in the middle of the extracted text (and would get read aloud). Style IDs
// ("TOC1".."TOC9") are used rather than style *names* ("toc 1") since IDs
// stay stable across Word's localized UIs while names can be translated.
const TOC_STYLE_MAP = Array.from({ length: 9 }, (_, i) => `p.TOC${i + 1} => p.mammoth-toc:fresh`);

// mammoth turns internal cross-reference links (a manual "jump to a chapter"
// list, or the hyperlinks inside a real Word TOC field) into <a href="#id">,
// and the bookmark each one points at into <a id="id">. Ids in this range are
// mammoth's own machinery (footnotes/endnotes/comments), not user bookmarks.
const RESERVED_ANCHOR_ID = /^(footnote|endnote|comment)(-ref)?-/;

// Uses convertToHtml (rather than extractRawText) so heading paragraph
// styles (Heading 1-6) survive as h1-h6 tags — that structure becomes the
// in-app outline, since Word's actual TOC is a computed field that mammoth
// can't parse and drops entirely. Offsets are computed while building the
// text so they stay exact instead of drifting after a later whitespace pass.
async function extractDocx(filePath) {
  const mammoth = require('mammoth');
  const { JSDOM } = require('jsdom');
  const result = await mammoth.convertToHtml({ path: filePath }, { styleMap: TOC_STYLE_MAP });
  const body = new JSDOM(`<body>${result.value}</body>`).window.document.body;

  const parts = [];
  const headings = [];
  const bookmarkOffsets = new Map(); // bookmark id -> offset of the paragraph it sits in
  const linkCandidates = []; // { text, targetId }, resolved once every bookmark has been seen
  let offset = 0;

  for (const el of body.children) {
    const isToc = el.classList.contains('mammoth-toc');

    // Scan for links/bookmarks even inside a skipped TOC paragraph — its
    // cached text is garbled and gets dropped, but its hyperlinks still
    // point at each chapter's bookmark and are worth keeping.
    for (const a of el.querySelectorAll('a')) {
      if (a.id && !RESERVED_ANCHOR_ID.test(a.id)) bookmarkOffsets.set(a.id, offset);
      const href = a.getAttribute('href');
      if (href && href.startsWith('#')) {
        const linkText = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (linkText) linkCandidates.push({ text: linkText, targetId: href.slice(1) });
      }
    }
    if (isToc) continue;

    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const headingLevel = /^H([1-6])$/.exec(el.tagName);
    if (headingLevel) headings.push({ level: Number(headingLevel[1]), title: text, offset });
    parts.push(text);
    offset += text.length + 2; // matches the '\n\n' joiner below
  }

  // A link whose target isn't already a detected heading — e.g. a manually
  // built chapter list in a document that doesn't use Heading styles — still
  // becomes a jump point, using the link's own text as its outline entry.
  const headingOffsets = new Set(headings.map((h) => h.offset));
  const seenTargets = new Set();
  for (const link of linkCandidates) {
    const targetOffset = bookmarkOffsets.get(link.targetId);
    if (targetOffset === undefined || headingOffsets.has(targetOffset) || seenTargets.has(targetOffset)) continue;
    seenTargets.add(targetOffset);
    headings.push({ level: 1, title: link.text, offset: targetOffset });
  }
  headings.sort((a, b) => a.offset - b.offset);

  return {
    title: path.basename(filePath, path.extname(filePath)),
    text: parts.join('\n\n'),
    headings,
  };
}

async function extractEpub(filePath) {
  const { EPub } = require('epub2');
  const epub = await EPub.createAsync(filePath);
  const getChapter = promisify(epub.getChapter.bind(epub));
  const parts = [];
  for (const chapter of epub.flow) {
    try {
      const html = await getChapter(chapter.id);
      const text = html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"');
      if (text.trim()) parts.push(text.trim());
    } catch {
      // Some manifest entries (nav pages, cover, etc.) aren't readable chapters — skip them.
    }
  }
  const title = epub.metadata?.title || path.basename(filePath, path.extname(filePath));
  return { title, text: collapseWhitespace(parts.join('\n\n')) };
}

async function extractPlain(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  const text = ext === '.md' ? stripMarkdown(raw) : raw;
  return { title: path.basename(filePath, path.extname(filePath)), text: collapseWhitespace(text) };
}

async function extractFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  switch (ext) {
    case 'pdf': return extractPdf(filePath);
    case 'docx': return extractDocx(filePath);
    case 'epub': return extractEpub(filePath);
    case 'md':
    case 'txt': return extractPlain(filePath);
    default: throw new Error(`Unsupported file type: .${ext}`);
  }
}

async function extractFromUrl(url) {
  const { JSDOM } = require('jsdom');
  const { Readability } = require('@mozilla/readability');

  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Reader app)' } });
  if (!res.ok) throw new Error(`Failed to fetch URL (${res.status})`);
  const html = await res.text();

  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  if (!article || !article.textContent.trim()) {
    throw new Error('Could not find readable article content at that URL.');
  }
  return { title: article.title || url, text: collapseWhitespace(article.textContent) };
}

module.exports = { extractFromFile, extractFromUrl };

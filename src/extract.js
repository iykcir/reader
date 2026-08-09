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

async function extractPdf(filePath) {
  const { PDFParse } = require('pdf-parse');
  const data = fs.readFileSync(filePath);
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    return { title: path.basename(filePath, path.extname(filePath)), text: collapseWhitespace(result.text) };
  } finally {
    await parser.destroy();
  }
}

// Uses convertToHtml (rather than extractRawText) so heading paragraph
// styles (Heading 1-6) survive as h1-h6 tags — that structure becomes the
// in-app outline, since Word's actual TOC is a computed field that mammoth
// can't parse and drops entirely. Offsets are computed while building the
// text so they stay exact instead of drifting after a later whitespace pass.
async function extractDocx(filePath) {
  const mammoth = require('mammoth');
  const { JSDOM } = require('jsdom');
  const result = await mammoth.convertToHtml({ path: filePath });
  const body = new JSDOM(`<body>${result.value}</body>`).window.document.body;

  const parts = [];
  const headings = [];
  let offset = 0;

  for (const el of body.children) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const headingLevel = /^H([1-6])$/.exec(el.tagName);
    if (headingLevel) headings.push({ level: Number(headingLevel[1]), title: text, offset });
    parts.push(text);
    offset += text.length + 2; // matches the '\n\n' joiner below
  }

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

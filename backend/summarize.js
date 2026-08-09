// Scope-of-Work summariser (PPT slide 31 "Agentic AI reads the SoW and
// auto-generates the description"). Actually reads the uploaded document:
//   • PDF  -> pdf-parse
//   • DOCX -> mammoth
//   • txt  -> utf-8
// Then produces a description from the REAL content:
//   • if ANTHROPIC_API_KEY is set -> Claude (claude-opus-4-8) writes it
//   • otherwise -> an extractive summary built from the document's own text
// The result is always editable by the application owner before submission.
const express = require('express');
const multer = require('multer');
const { authenticate, authorize } = require('./middleware');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

async function extractText(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.pdf')) {
    const pdf = require('pdf-parse');
    const data = await pdf(file.buffer);
    return data.text || '';
  }
  if (name.endsWith('.docx')) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value || '';
  }
  // .doc (legacy binary) and plain text fall through to a best-effort UTF-8 read.
  return file.buffer.toString('utf8');
}

// A genuine summary derived from the document's own sentences (no AI key needed).
function extractiveSummary(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'No readable text could be extracted from the uploaded document. Please review and enter the scope of work manually.';
  const sentences = clean.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.split(' ').length >= 4);
  const picked = sentences.slice(0, 4).join(' ');
  return picked || clean.slice(0, 400);
}

// Real "Agentic AI" description via Claude, from the extracted document text.
async function aiSummary(text) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const excerpt = String(text || '').slice(0, 20000);
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 600,
    system: 'You read a Scope of Work document attached to a procurement Purchase Request and write the PR description. Write 3–5 concise, factual sentences describing the scope, deliverables, coverage and duration. No preamble, no bullet points, no headings — just the description text. The application owner will review and edit it.',
    messages: [{ role: 'user', content: `Scope of Work document:\n\n${excerpt}\n\nWrite the PR description.` }],
  });
  const block = response.content.find(b => b.type === 'text');
  return (block && block.text || '').trim();
}

router.post('/summarize', authenticate, authorize('pr:create'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No document uploaded.' });
  try {
    const text = await extractText(req.file);
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const summary = await aiSummary(text);
        if (summary) return res.json({ summary, source: 'Claude AI' });
      } catch (e) {
        // fall back to extractive if the AI call fails (bad key, network, etc.)
      }
    }
    return res.json({ summary: extractiveSummary(text), source: 'extractive (set ANTHROPIC_API_KEY for AI)' });
  } catch (err) {
    return res.status(500).json({ error: 'Could not read the document: ' + err.message });
  }
});

module.exports = router;

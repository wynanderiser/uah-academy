const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are the AI feedback step for an online art course run by Ulverston Art House, a small gallery and framing studio. This specific request is for a BEGINNER-tier student. Beginner tier has a strict, narrow job — do not go beyond it.

What to look at, and only this:
1. Basic proportion (do shapes and forms relate to each other believably)
2. Value and light (does shading create a sense of form/depth, or does it read flat)
3. Focal point (is there one clear place the eye is drawn to)

What you must NOT do at this tier:
- Do not discuss personal style, artistic voice, or "what were you going for" — far too early, and it can make a beginner self-conscious before they've built basic confidence.
- Do not discuss colour harmony or composition theory beyond focal point — that's intermediate-tier territory.
- Do not give more than ONE concrete fix. Even a gentle second note can tip a first attempt from "you're on the right track" into "here's what's wrong with it" — at this stage, one well-chosen fix lands as encouragement, two starts to feel like a checklist of failures. Pick the single thing that will help most.

Tone: warm, plain, encouraging, like a kind teacher talking to an adult beginner — never patronising, never generic ("great job!" with nothing behind it). Find something specific and real to praise before anything else — if you can't find something real, say what's promising about the attempt itself (e.g. ambition of the subject chosen).

The student may include a short note on what they were going for. If they do, don't second-guess the deliberate choice itself (e.g. if they say they wanted the shadow side very dark, don't tell them to lighten it) — but you can and should still comment on execution within that choice (e.g. the shape or proportion could still be off, form could still read flat, even in a deliberately dark piece).

Your entire response must be a single raw JSON object and nothing else — no markdown code fences, no preamble like "Here is my feedback", no closing remarks after the JSON, no explanation of your reasoning. The very first character of your response must be { and the very last character must be }. Respond in exactly this shape:
{"praise": "one or two sentences, specific to this piece", "fix": "one specific, actionable fix — just one", "encouragement": "one short warm closing line"}`;

const DETAIL_SYSTEM_PROMPT = `You are the AI feedback step for an online art course run by Ulverston Art House. A BEGINNER-tier student has already received a short critique on their piece and has explicitly asked for more detail. This is a one-time follow-up, not an open conversation.

You must stay strictly within Beginner-tier scope — the same three things as before, just more thoroughly:
1. Basic proportion
2. Value and light (does shading create form)
3. Focal point

Do NOT introduce anything beyond this scope — no personal style, no artistic voice, no colour theory, no composition theory beyond focal point. Going deeper means more nuance on the same three things, not new territory. This is the single most important rule to follow.

You will be given the image, the student's optional note on what they were going for, and the short critique they already received. Give one or two further observations that add real depth beyond what was already said — do not just repeat the original praise or fix in different words.

Your entire response must be a single raw JSON object and nothing else. The very first character must be { and the very last must be }. Respond in exactly this shape:
{"details": ["first additional observation", "second additional observation, or omit if only one is warranted"]}`;

function tryParseFeedback(rawText) {
  const text = rawText.trim();
  try { return JSON.parse(text); } catch (e) {}
  const noFences = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(noFences); } catch (e) {}
  const start = noFences.indexOf('{');
  const end = noFences.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const slice = noFences.slice(start, end + 1);
    try { return JSON.parse(slice); } catch (e) {}
  }
  return null;
}

async function callClaude(systemPrompt, userText, image, mediaType, maxTokens) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('Server has no ANTHROPIC_API_KEY set yet — add it in Render\'s Environment settings.');
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: userText }
        ]
      }]
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errText}`);
  }
  const data = await response.json();
  const textBlock = data.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No response text received from the model.');
  const parsed = tryParseFeedback(textBlock.text);
  if (!parsed) throw new Error('Could not read the feedback format.');
  return parsed;
}

app.post('/api/critique', async (req, res) => {
  try {
    const { image, mediaType, explanation } = req.body;
    if (!image || !mediaType) return res.status(400).json({ error: 'Missing image.' });
    let userText = "Please give beginner-tier feedback on this piece (Lesson 1: One Object, One Light).";
    if (explanation) userText += ` The student added this note about their submission: "${explanation}"`;
    const parsed = await callClaude(SYSTEM_PROMPT, userText, image, mediaType, 1000);
    res.json(parsed);
  } catch (err) {
    console.error('critique error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/more-detail', async (req, res) => {
  try {
    const { image, mediaType, explanation, lastFeedback } = req.body;
    if (!image || !mediaType || !lastFeedback) return res.status(400).json({ error: 'Missing data.' });
    let userText = `The student has already received this critique: praise="${lastFeedback.praise}", fix="${lastFeedback.fix}", encouragement="${lastFeedback.encouragement}". They've asked for more detail. Please go deeper, staying strictly within Beginner-tier scope.`;
    if (explanation) userText += ` The student's note on what they were going for: "${explanation}"`;
    const parsed = await callClaude(DETAIL_SYSTEM_PROMPT, userText, image, mediaType, 800);
    if (!parsed.details) throw new Error('Response did not include details.');
    res.json(parsed);
  } catch (err) {
    console.error('more-detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`UAH Academy prototype running on port ${PORT}`));

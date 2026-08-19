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

// ============ SIDE SHOOTS ============

const SIDESHOOT_THEMES = {
  moon: { title: "A Pastel Moon", brief: "Soft gradients, one quiet light source. Let the colours stay gentle — this is about calm, not drama." },
  sunset: { title: "An African Sunset", brief: "Bold, warm colour and a strong horizon. Let it feel hot — this is about real heat and contrast, not subtlety." },
  coastline: { title: "A Stormy Coastline", brief: "Rough, choppy water and heavy, energetic marks. Let it feel wild — this is about mood, not calm precision." },
  garden: { title: "A Quiet Garden Corner", brief: "Layered greens and soft shapes. Take your time — this is about gentle looking, not speed." },
  cityscape: { title: "A Midnight Cityscape", brief: "Hard edges and one warm light in the dark. Let the shapes stay simple — this is about contrast and quiet drama." }
};

function getTheme(slug){
  return SIDESHOOT_THEMES[slug] || SIDESHOOT_THEMES.sunset;
}

function buildSideshootSystemPrompt(theme){
  return `You are the AI tutor for UAH Academy's "Side Shoots" — short, playful themed exercises that sit outside the main structured course. This one is called "${theme.title}." The brief given to the student was: "${theme.brief}"

Side Shoots are not part of the graded Beginner/Intermediate/Advanced ladder, so unlike the main course, you may comment on mood, colour choice, and atmosphere as well as technical things like proportion, light, and focal point — whatever genuinely matters most for this particular piece and brief.

The same core discipline from the main course still applies here:
- Give exactly ONE concrete fix, never two. One well-chosen note lands as encouragement; two starts to feel like a checklist of failures.
- If the piece genuinely nails the mood and spirit of the brief, say so honestly instead of manufacturing a fix — "there's honestly nothing meaningful to add here" is a completely valid, expected response, not a failure to find something wrong.
- Tone: warm, plain, encouraging — like a kind teacher, never patronising, never generic praise with nothing behind it. Find something specific and real to praise first.

The student may include a short note on what they were going for. If they do, don't second-guess a deliberate choice — but you can still comment on execution within that choice.

Your entire response must be a single raw JSON object and nothing else — no markdown fences, no preamble, no closing remarks. The very first character must be { and the last must be }. Respond in exactly this shape:
{"praise": "one or two sentences, specific to this piece", "fix": "one specific, actionable fix — or, if it's genuinely already excellent, an honest statement that there's nothing meaningful to add", "encouragement": "one short warm closing line"}`;
}

function buildSideshootDetailPrompt(theme){
  return `You are the AI tutor for UAH Academy's "Side Shoots." The student is working on "${theme.title}" (brief: "${theme.brief}") and has already received a short critique, and has explicitly asked for more detail. This is a one-time follow-up, not an open conversation.

Since this is a Side Shoot, you may go deeper on mood, colour, and atmosphere as well as technical points — whatever's genuinely most useful for this piece.

Give one or two further observations that add real depth beyond what was already said — do not just repeat the original praise or fix in different words.

If you genuinely can't find a further observation that adds real depth, say so honestly rather than manufacturing something for the sake of it. A short, genuine "there isn't really more to add here, it's solid" is a valid response.

Your entire response must be a single raw JSON object and nothing else. The very first character must be { and the last must be }. Respond in exactly this shape:
{"details": ["first additional observation", "second additional observation, or omit if only one is warranted"]}`;
}

function buildSideshootRevisionPrompt(theme){
  return `You are the AI tutor for UAH Academy's "Side Shoots," looking at a revised attempt at "${theme.title}" (brief: "${theme.brief}"). The student already received feedback on an earlier photo of this same piece, and has now gone back and worked on it — or says they have.

You will be shown TWO images, in this exact order: first the EARLIER version, then the NEW version. Before saying anything else, genuinely and carefully compare the two images against each other — do not assume they are different just because two images were provided.

If the two images are identical, or so close to identical that no meaningful change is visible, you MUST say so plainly and honestly. Do NOT invent or describe a change that isn't genuinely visible, no matter how plausible it would sound. It is better to correctly notice nothing changed than to praise a change that didn't happen.

If there IS a genuine, visible difference: since this is a Side Shoot, you may comment on mood, colour, and atmosphere as well as technical points. Address directly and specifically what has visibly changed. If the earlier fix was addressed well, say so specifically, describing the actual visible difference, and credit the effort of revising. If it wasn't fully resolved, or a new issue is now more visible, name that clearly and kindly.

Give exactly ONE fix, same rule as before. Never two.

Your entire response must be a single raw JSON object and nothing else. The very first character must be { and the last must be }. Respond in exactly this shape:
{"praise": "one or two sentences — either genuine, specific praise about the visible change, or an honest note that no real change is visible", "fix": "one specific, actionable fix — or, if nothing changed, a suggestion to try the original fix again", "encouragement": "one short warm closing line, honest to whatever actually happened"}`;
}

function buildSideshootConversationPrompt(theme){
  return `You are the AI tutor for UAH Academy's "Side Shoots," continuing an ongoing conversation about a piece submitted for "${theme.title}" (brief: "${theme.brief}"). They have already received an initial critique (included in the conversation history).

This is an open conversation, not a one-shot critique. Since this is a Side Shoot, you may discuss mood, colour, and atmosphere as well as technical points — whatever's genuinely useful.

The most important thing in this conversation: if the student tells you something that changes how a specific detail in the image should be read, take that seriously and genuinely reconsider. Don't defensively hold onto your original reading, and don't just soften your wording while secretly keeping the same judgement. If your earlier note no longer applies given the new information, say so plainly and honestly. Then, where it's genuinely useful, offer one concrete, specific suggestion for handling that detail well.

Keep replies conversational and short — a few sentences, like a real reply in a chat, not a fresh structured report. Warm, plain, honest tone throughout.

Respond in plain text only. No JSON, no markdown formatting, no headers — just a natural written reply.`;
}

// General-purpose Claude call: takes a full messages array (supports multi-image and multi-turn),
// returns either parsed JSON (default) or raw text (expectJSON=false).
async function callClaudeMessages(systemPrompt, messages, maxTokens, expectJSON = true){
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
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: systemPrompt, messages })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errText}`);
  }
  const data = await response.json();
  const textBlock = data.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No response text received from the model.');
  if (!expectJSON) return textBlock.text.trim();
  const parsed = tryParseFeedback(textBlock.text);
  if (!parsed) throw new Error('Could not read the feedback format.');
  return parsed;
}

app.post('/api/sideshoot/critique', async (req, res) => {
  try {
    const { theme: themeSlug, image, mediaType, explanation } = req.body;
    if (!image || !mediaType) return res.status(400).json({ error: 'Missing image.' });
    const theme = getTheme(themeSlug);
    let userText = `Please give feedback on this piece for the Side Shoot "${theme.title}".`;
    if (explanation) userText += ` The student added this note about their submission: "${explanation}"`;
    const messages = [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
      { type: 'text', text: userText }
    ]}];
    const parsed = await callClaudeMessages(buildSideshootSystemPrompt(theme), messages, 1000);
    res.json(parsed);
  } catch (err) {
    console.error('sideshoot critique error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sideshoot/more-detail', async (req, res) => {
  try {
    const { theme: themeSlug, image, mediaType, explanation, lastFeedback } = req.body;
    if (!image || !mediaType || !lastFeedback) return res.status(400).json({ error: 'Missing data.' });
    const theme = getTheme(themeSlug);
    let userText = `The student has already received this critique: praise="${lastFeedback.praise}", fix="${lastFeedback.fix}", encouragement="${lastFeedback.encouragement}". They've asked for more detail. Please go deeper, staying within the spirit of this Side Shoot.`;
    if (explanation) userText += ` The student's note on what they were going for: "${explanation}"`;
    const messages = [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
      { type: 'text', text: userText }
    ]}];
    const parsed = await callClaudeMessages(buildSideshootDetailPrompt(theme), messages, 800);
    if (!parsed.details) throw new Error('Response did not include details.');
    res.json(parsed);
  } catch (err) {
    console.error('sideshoot more-detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sideshoot/revision', async (req, res) => {
  try {
    const { theme: themeSlug, priorImage, priorMediaType, image, mediaType } = req.body;
    if (!priorImage || !priorMediaType || !image || !mediaType) return res.status(400).json({ error: 'Missing image data.' });
    const theme = getTheme(themeSlug);
    const messages = [{ role: 'user', content: [
      { type: 'text', text: 'Earlier version:' },
      { type: 'image', source: { type: 'base64', media_type: priorMediaType, data: priorImage } },
      { type: 'text', text: 'New version:' },
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
      { type: 'text', text: 'The first image is the earlier version. The second image is the new version, just submitted. Compare them directly and respond accordingly.' }
    ]}];
    const parsed = await callClaudeMessages(buildSideshootRevisionPrompt(theme), messages, 1000);
    res.json(parsed);
  } catch (err) {
    console.error('sideshoot revision error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sideshoot/chat', async (req, res) => {
  try {
    const { theme: themeSlug, messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'Missing conversation.' });
    const theme = getTheme(themeSlug);
    const reply = await callClaudeMessages(buildSideshootConversationPrompt(theme), messages, 600, false);
    res.json({ reply });
  } catch (err) {
    console.error('sideshoot chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`UAH Academy prototype running on port ${PORT}`));

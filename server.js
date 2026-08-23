const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY;
const STRIPE_PRICE_ANNUAL = process.env.STRIPE_PRICE_ANNUAL;

const app = express();
app.set('trust proxy', 1); // so req.ip reflects the real visitor's address behind Render's proxy

// The Stripe webhook needs the raw, unparsed request body to verify its signature,
// so it must be registered BEFORE the general express.json() middleware below —
// Express runs middleware/routes in the order they're registered.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripeClient.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;
      const customerId = session.customer;
      const subscriptionId = session.subscription;

      const subscription = await stripeClient.subscriptions.retrieve(subscriptionId);
      const priceId = subscription.items.data[0].price.id;
      const plan = priceId === STRIPE_PRICE_ANNUAL ? 'annual' : 'monthly';
      const currentPeriodEnd = new Date(subscription.current_period_end * 1000);

      await pool.query(
        `UPDATE users SET stripe_customer_id = $1, subscription_status = 'active', subscription_plan = $2, current_period_end = $3 WHERE id = $4`,
        [customerId, plan, currentPeriodEnd, userId]
      );
      console.log(`Subscription activated for user ${userId} (${plan})`);
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const status = subscription.status === 'active' ? 'active' : 'inactive';
      const currentPeriodEnd = new Date(subscription.current_period_end * 1000);

      await pool.query(
        `UPDATE users SET subscription_status = $1, current_period_end = $2 WHERE stripe_customer_id = $3`,
        [status, currentPeriodEnd, subscription.customer]
      );
      console.log(`Subscription updated for customer ${subscription.customer}: ${status}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook handling error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ DATABASE ============
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initSchema() {
  if (!process.env.DATABASE_URL) {
    console.warn('No DATABASE_URL set — skipping database setup. Login/subscriptions will not work until this is added.');
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        stripe_customer_id TEXT,
        subscription_status TEXT DEFAULT 'inactive',
        subscription_plan TEXT,
        current_period_end TIMESTAMPTZ
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS login_tokens (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        session_token TEXT UNIQUE NOT NULL,
        user_id INTEGER REFERENCES users(id),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Database schema ready (users, login_tokens, sessions).');
  } catch (err) {
    console.error('Database schema setup failed:', err.message);
  }
}

// ============ FREE-TIER SAFETY NET ============
// Side Shoots are free, no-account-required entry points, which means they're the one
// surface a malicious visitor could hammer to run up Anthropic API costs. This isn't
// a substitute for real per-account limits (that arrives once real accounts exist) —
// it's a stopgap that caps worst-case exposure in the meantime.
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const PER_IP_LIMIT = 20; // generous for one honest person genuinely working through a piece (critique + detail + a few chat replies + a couple of revisions)
const GLOBAL_DAILY_LIMIT = 300; // hard backstop regardless of how per-IP limiting gets circumvented (VPNs, incognito, etc.)

const ipHits = new Map(); // ip -> { count, windowStart }
let globalCount = 0;
let globalWindowStart = Date.now();

function sideshootRateLimit(req, res, next) {
  const now = Date.now();

  if (now - globalWindowStart > RATE_WINDOW_MS) {
    globalCount = 0;
    globalWindowStart = now;
  }
  if (globalCount >= GLOBAL_DAILY_LIMIT) {
    return res.status(429).json({ error: 'This tool has reached its daily limit for free use. Please try again tomorrow, or enrol in UAH Academy for full access.' });
  }

  const ip = req.ip;
  let entry = ipHits.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
  }
  if (entry.count >= PER_IP_LIMIT) {
    return res.status(429).json({ error: "You've reached today's limit for free use from this connection. Enrol in UAH Academy to continue." });
  }

  entry.count += 1;
  ipHits.set(ip, entry);
  globalCount += 1;
  next();
}


const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

const LESSONS = {
  lesson1: {
    title: 'Lesson 1: One Object, One Light',
    scope: `1. Basic proportion (does the shape read believably)
2. Value and light (does shading create a sense of form/depth, or does it read flat)
3. Focal point (is there one clear place the eye is drawn to)`
  },
  lesson2: {
    title: 'Lesson 2: Two Objects, One Light',
    scope: `1. Relative proportion between the two objects (do they relate to each other believably in size and placement, not just correct individually)
2. Value and light consistency (is the same light logic applied convincingly across BOTH objects, not just one)
3. Focal point (does the pair read as one grouped subject, with a clear sense of what draws the eye first)`
  },
  lesson3: {
    title: 'Lesson 3: Line & Edges',
    scope: `1. Line confidence (are marks committed and clear, rather than scratchy, hesitant, repeated attempts at the same edge)
2. Edge variation (does the line vary appropriately — harder and more definite where a boundary is a strong contact point or shadow-side transition, softer or fading where the form turns gently into light — rather than one uniform outline all the way around)
3. Focal point (is there still one clear place the eye is drawn to, now reinforced partly through line weight rather than only shading)`
  },
  lesson4: {
    title: 'Lesson 4: Simple Still Life',
    scope: `1. Proportion and placement among three or four objects (do they relate to each other believably as a group, not just individually correct)
2. Value and light consistency across every object in the arrangement (same light logic applied convincingly to all forms, not just one or two)
3. Focal point (is there clearly one object the arrangement is built around, with the others genuinely supporting it — through overlap, scale, or reduced emphasis — rather than every object competing equally for attention)`
  },
  lesson5: {
    title: 'Lesson 5: Foreground & Background',
    scope: `1. Foreground subject quality (is the main subject rendered with the confidence, proportion, and edge control built up across earlier lessons)
2. Background restraint (does the background stay genuinely subordinate — lower contrast, less detail, softer or quieter marks — so it recedes, rather than being rendered with the same care as the subject and competing with it)
3. Depth read (does the piece convincingly read as something in front of something else, or does it read as one flat, evenly-weighted scene)`
  },
  lesson6: {
    title: 'Lesson 6: First Finished Piece',
    scope: `This is the final Beginner-tier lesson — a synthesis, not a new isolated skill. The student chose their own subject this time. Assess the piece as a considered whole, across everything built up so far:
1. Proportion and shape (does everything drawn read as believable, whatever the subject)
2. Value, light, and edge control together (is there one consistent light source, does shading create real form, do edges vary in weight the way a real object's edges do)
3. Composition as a whole (is there one clear focal point, does the background stay appropriately quieter than the subject, does the whole piece read as one considered scene rather than a collection of separate technical exercises)`
  }
};

function getLesson(slug) {
  return LESSONS[slug] || LESSONS.lesson1;
}

function buildLessonSystemPrompt(lesson) {
  return `You are the AI feedback step for an online art course run by Ulverston Art House, a small gallery and framing studio. This specific request is for a BEGINNER-tier student working on "${lesson.title}." Beginner tier has a strict, narrow job — do not go beyond it.

What to look at, and only this:
${lesson.scope}

What you must NOT do at this tier:
- Do not discuss personal style, artistic voice, or "what were you going for" — far too early, and it can make a beginner self-conscious before they've built basic confidence.
- Do not discuss colour harmony or composition theory beyond focal point — that's intermediate-tier territory.
- Do not give more than ONE concrete fix. Even a gentle second note can tip a first attempt from "you're on the right track" into "here's what's wrong with it" — at this stage, one well-chosen fix lands as encouragement, two starts to feel like a checklist of failures. Pick the single thing that will help most.

If the piece genuinely, honestly nails what this lesson is asking — say so plainly instead of manufacturing a fix. Do not invent a note just to fill the "fix" field; a real "there's honestly nothing meaningful to add here" is a completely valid and expected response, not a failure to find something wrong. Inventing a fix that isn't real is worse than having none, especially for someone who already has a genuine eye for this.

Tone: warm, plain, encouraging, like a kind teacher talking to an adult beginner — never patronising, never generic ("great job!" with nothing behind it). Find something specific and real to praise before anything else — if you can't find something real, say what's promising about the attempt itself (e.g. ambition of the subject chosen).

The student may include a short note on what they were going for. If they do, don't second-guess the deliberate choice itself (e.g. if they say they wanted the shadow side very dark, don't tell them to lighten it) — but you can and should still comment on execution within that choice.

Your entire response must be a single raw JSON object and nothing else — no markdown code fences, no preamble like "Here is my feedback", no closing remarks after the JSON, no explanation of your reasoning. The very first character of your response must be { and the very last character must be }. Respond in exactly this shape:
{"praise": "one or two sentences, specific to this piece", "fix": "one specific, actionable fix — or, if it's genuinely already excellent, an honest statement that there's nothing meaningful to add", "encouragement": "one short warm closing line"}`;
}

function buildLessonDetailPrompt(lesson) {
  return `You are the AI feedback step for an online art course run by Ulverston Art House. A BEGINNER-tier student working on "${lesson.title}" has already received a short critique on their piece and has explicitly asked for more detail. This is a one-time follow-up, not an open conversation.

You must stay strictly within Beginner-tier scope — the same things as before, just more thoroughly:
${lesson.scope}

Do NOT introduce anything beyond this scope — no personal style, no artistic voice, no colour theory, no composition theory beyond focal point. Going deeper means more nuance on the same things, not new territory. This is the single most important rule to follow.

You will be given the image, the student's optional note on what they were going for, and the short critique they already received. Give one or two further observations that add real depth beyond what was already said — do not just repeat the original praise or fix in different words.

If you genuinely can't find a further observation that adds real depth — the piece is already handling this well enough that there isn't a meaningful additional point to make — say so honestly rather than manufacturing something for the sake of it. A short, genuine "there isn't really more to add here, it's solid" is a valid response.

Your entire response must be a single raw JSON object and nothing else. The very first character must be { and the last must be }. Respond in exactly this shape:
{"details": ["first additional observation", "second additional observation, or omit if only one is warranted"]}`;
}

function buildLessonRevisionPrompt(lesson){
  return `You are the AI tutor for UAH Academy, looking at a revised attempt at "${lesson.title}". The student already received feedback on an earlier photo of this same piece, and has now gone back and worked on it — or says they have.

You will be shown TWO images, in this exact order: first the EARLIER version, then the NEW version. Before saying anything else, genuinely and carefully compare the two images against each other — do not assume they are different just because two images were provided.

If the two images are identical, or so close to identical that no meaningful change is visible, you MUST say so plainly and honestly. Do NOT invent or describe a change that isn't genuinely visible, no matter how plausible it would sound. It is better to correctly notice nothing changed than to praise a change that didn't happen.

If there IS a genuine, visible difference: stay strictly within Beginner-tier scope, only these things —
${lesson.scope}
No personal style, no artistic voice, no colour theory, no composition theory beyond focal point. Address directly and specifically what has visibly changed. If the earlier fix was addressed well, say so specifically, describing the actual visible difference, and credit the effort of revising. If it wasn't fully resolved, or a new issue is now more visible, name that clearly and kindly.

Give exactly ONE fix, same rule as before. Never two.

Your entire response must be a single raw JSON object and nothing else. The very first character must be { and the last must be }. Respond in exactly this shape:
{"praise": "one or two sentences — either genuine, specific praise about the visible change, or an honest note that no real change is visible", "fix": "one specific, actionable fix — or, if nothing changed, a suggestion to try the original fix again", "encouragement": "one short warm closing line, honest to whatever actually happened"}`;
}

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
    const { image, mediaType, explanation, lesson: lessonSlug } = req.body;
    if (!image || !mediaType) return res.status(400).json({ error: 'Missing image.' });
    const lesson = getLesson(lessonSlug);
    let userText = `Please give beginner-tier feedback on this piece (${lesson.title}).`;
    if (explanation) userText += ` The student added this note about their submission: "${explanation}"`;
    const parsed = await callClaude(buildLessonSystemPrompt(lesson), userText, image, mediaType, 1000);
    res.json(parsed);
  } catch (err) {
    console.error('critique error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/more-detail', async (req, res) => {
  try {
    const { image, mediaType, explanation, lastFeedback, lesson: lessonSlug } = req.body;
    if (!image || !mediaType || !lastFeedback) return res.status(400).json({ error: 'Missing data.' });
    const lesson = getLesson(lessonSlug);
    let userText = `The student has already received this critique: praise="${lastFeedback.praise}", fix="${lastFeedback.fix}", encouragement="${lastFeedback.encouragement}". They've asked for more detail. Please go deeper, staying strictly within Beginner-tier scope.`;
    if (explanation) userText += ` The student's note on what they were going for: "${explanation}"`;
    const parsed = await callClaude(buildLessonDetailPrompt(lesson), userText, image, mediaType, 800);
    if (!parsed.details) throw new Error('Response did not include details.');
    res.json(parsed);
  } catch (err) {
    console.error('more-detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/revision', async (req, res) => {
  try {
    const { lesson: lessonSlug, priorImage, priorMediaType, image, mediaType } = req.body;
    if (!priorImage || !priorMediaType || !image || !mediaType) return res.status(400).json({ error: 'Missing image data.' });
    const lesson = getLesson(lessonSlug);
    const messages = [{ role: 'user', content: [
      { type: 'text', text: 'Earlier version:' },
      { type: 'image', source: { type: 'base64', media_type: priorMediaType, data: priorImage } },
      { type: 'text', text: 'New version:' },
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
      { type: 'text', text: 'The first image is the earlier version. The second image is the new version, just submitted. Compare them directly and respond accordingly.' }
    ]}];
    const parsed = await callClaudeMessages(buildLessonRevisionPrompt(lesson), messages, 1000);
    res.json(parsed);
  } catch (err) {
    console.error('revision error:', err);
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

app.post('/api/sideshoot/critique', sideshootRateLimit, async (req, res) => {
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

app.post('/api/sideshoot/more-detail', sideshootRateLimit, async (req, res) => {
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

app.post('/api/sideshoot/revision', sideshootRateLimit, async (req, res) => {
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

app.post('/api/sideshoot/chat', sideshootRateLimit, async (req, res) => {
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

// ============ AUTHENTICATION (magic-link login) ============
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SITE_URL = process.env.SITE_URL || 'https://academy.ulverstonarthouse.co.uk';
const LOGIN_TOKEN_TTL_MINUTES = 15;
const SESSION_TTL_DAYS = 30;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendMagicLinkEmail(email, link) {
  if (!RESEND_API_KEY) {
    throw new Error('Server has no RESEND_API_KEY set yet — add it in Render\'s Environment settings.');
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'UAH Academy <academy@mail.ulverstonarthouse.co.uk>',
      to: [email],
      subject: 'Your UAH Academy login link',
      html: `
        <p>Hello,</p>
        <p>Click below to log in to UAH Academy. This link works once, and expires in ${LOGIN_TOKEN_TTL_MINUTES} minutes.</p>
        <p><a href="${link}">Log in to UAH Academy</a></p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend API error (${response.status}): ${errText}`);
  }
}

function setSessionCookie(res, sessionToken) {
  const maxAgeSeconds = SESSION_TTL_DAYS * 24 * 60 * 60;
  res.setHeader('Set-Cookie', `uah_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `uah_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? match.split('=')[1] : null;
}

async function getSessionUser(req) {
  const sessionToken = getCookie(req, 'uah_session');
  if (!sessionToken) return null;
  const result = await pool.query(
    `SELECT users.* FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.session_token = $1 AND sessions.expires_at > NOW()`,
    [sessionToken]
  );
  return result.rows[0] || null;
}

app.post('/api/auth/request-login', async (req, res) => {
  try {
    const { email } = req.body;
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

    const token = generateToken();
    const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MINUTES * 60 * 1000);
    await pool.query(
      `INSERT INTO login_tokens (email, token, expires_at) VALUES ($1, $2, $3)`,
      [email.toLowerCase().trim(), token, expiresAt]
    );

    const link = `${SITE_URL}/api/auth/verify?token=${token}`;
    await sendMagicLinkEmail(email, link);

    res.json({ ok: true });
  } catch (err) {
    console.error('request-login error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/verify', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send('Missing login token.');

    const tokenResult = await pool.query(
      `SELECT * FROM login_tokens WHERE token = $1 AND used = FALSE AND expires_at > NOW()`,
      [token]
    );
    const tokenRow = tokenResult.rows[0];
    if (!tokenRow) {
      return res.status(400).send('This login link has expired or already been used. Please request a new one.');
    }

    await pool.query(`UPDATE login_tokens SET used = TRUE WHERE id = $1`, [tokenRow.id]);

    let userResult = await pool.query(`SELECT * FROM users WHERE email = $1`, [tokenRow.email]);
    let user = userResult.rows[0];
    if (!user) {
      const insertResult = await pool.query(
        `INSERT INTO users (email) VALUES ($1) RETURNING *`,
        [tokenRow.email]
      );
      user = insertResult.rows[0];
    }

    const sessionToken = generateToken();
    const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO sessions (session_token, user_id, expires_at) VALUES ($1, $2, $3)`,
      [sessionToken, user.id, sessionExpiresAt]
    );

    setSessionCookie(res, sessionToken);
    res.redirect('/account.html');
  } catch (err) {
    console.error('verify error:', err);
    res.status(500).send('Something went wrong logging you in. Please try requesting a new link.');
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const user = await getSessionUser(req);
    if (!user) return res.json({ loggedIn: false });
    res.json({
      loggedIn: true,
      email: user.email,
      subscriptionStatus: user.subscription_status,
      subscriptionPlan: user.subscription_plan
    });
  } catch (err) {
    console.error('me error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const sessionToken = getCookie(req, 'uah_session');
    if (sessionToken) {
      await pool.query(`DELETE FROM sessions WHERE session_token = $1`, [sessionToken]);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (err) {
    console.error('logout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// !! TEMPORARY TEST-ONLY ROUTE — REMOVE BEFORE REAL LAUNCH !!
// Lets whoever is logged in flip their own account to "active" without
// paying anything, so the member experience can be built and tested
// while Stripe access is unavailable. Anyone could grant themselves
// free membership through this while it exists — it must be deleted
// before real students ever use this site.
// ============================================================
app.post('/api/dev/activate-me', async (req, res) => {
  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Please log in first.' });
    await pool.query(
      `UPDATE users SET subscription_status = 'active', subscription_plan = 'monthly' WHERE id = $1`,
      [user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('dev/activate-me error:', err);
    res.status(500).json({ error: err.message });
  }
});

const REWARD_NOTIFY_EMAIL = process.env.REWARD_NOTIFY_EMAIL || 'david@ulverstonarthouse.co.uk';

app.post('/api/claim-reward', async (req, res) => {
  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Please log in first.' });

    const { image, mediaType } = req.body;
    if (!image || !mediaType) return res.status(400).json({ error: 'Missing image.' });
    if (!RESEND_API_KEY) throw new Error('Server has no RESEND_API_KEY set yet.');

    const ext = mediaType === 'image/png' ? 'png' : 'jpg';

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'UAH Academy <academy@mail.ulverstonarthouse.co.uk>',
        to: [REWARD_NOTIFY_EMAIL],
        subject: `Greetings card reward claim — ${user.email}`,
        html: `<p>A student has just completed Beginner tier and claimed their free greetings card reward.</p><p><b>Student email:</b> ${user.email}</p><p>Their finished piece is attached.</p>`,
        attachments: [{ content: image, filename: `finished-piece.${ext}` }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Resend API error (${response.status}): ${errText}`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('claim-reward error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Please log in first.' });

    const { plan } = req.body;
    const priceId = plan === 'annual' ? STRIPE_PRICE_ANNUAL : STRIPE_PRICE_MONTHLY;
    if (!priceId) return res.status(500).json({ error: 'Pricing is not configured yet on the server.' });

    const sessionParams = {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${SITE_URL}/account.html?checkout=success`,
      cancel_url: `${SITE_URL}/account.html?checkout=cancelled`,
      client_reference_id: String(user.id)
    };
    if (user.stripe_customer_id) {
      sessionParams.customer = user.stripe_customer_id;
    } else {
      sessionParams.customer_email = user.email;
    }

    const checkoutSession = await stripeClient.checkout.sessions.create(sessionParams);
    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/db-check', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as time, (SELECT COUNT(*) FROM users) as user_count');
    res.json({ ok: true, time: result.rows[0].time, user_count: result.rows[0].user_count });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
initSchema().then(() => {
  app.listen(PORT, () => console.log(`UAH Academy prototype running on port ${PORT}`));
});

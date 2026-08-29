const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY;
const STRIPE_PRICE_ANNUAL = process.env.STRIPE_PRICE_ANNUAL;

// ============ FOUNDER MEMBER OFFER ============
// Percentage lives entirely in the Stripe coupon itself, not hardcoded here —
// genuinely capped at the first 25 people, checked live against the real database every time.
const FOUNDER_COUPON_ID = process.env.STRIPE_FOUNDER_COUPON_ID;
const FOUNDER_SLOTS_CAP = 25;

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
      const wasFounderOffer = session.metadata && session.metadata.founderOffer === 'true';

      const subscription = await stripeClient.subscriptions.retrieve(subscriptionId);
      const priceId = subscription.items.data[0].price.id;
      const plan = priceId === STRIPE_PRICE_ANNUAL ? 'annual' : 'monthly';
      const rawPeriodEnd = subscription.items.data[0]?.current_period_end;
      const currentPeriodEnd = rawPeriodEnd ? new Date(rawPeriodEnd * 1000) : null;

      await pool.query(
        `UPDATE users SET stripe_customer_id = $1, subscription_status = 'active', subscription_plan = $2, current_period_end = $3, signup_offer = COALESCE(signup_offer, $5) WHERE id = $4`,
        [customerId, plan, currentPeriodEnd, userId, wasFounderOffer ? 'founder' : null]
      );
      console.log(`Subscription activated for user ${userId} (${plan})${wasFounderOffer ? ' — founder rate' : ''}`);
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      let status;
      if (subscription.status !== 'active') {
        status = 'inactive';
      } else if (subscription.pause_collection) {
        // Pausing via pause_collection deliberately keeps Stripe's own status as "active" —
        // the subscription itself isn't cancelled, just billing. Without this check, this
        // same webhook (which our own pause/resume calls trigger) would silently overwrite
        // a genuine pause back to "active" moments after it was set.
        status = 'paused';
      } else {
        status = 'active';
      }
      const rawPeriodEnd = subscription.items.data[0]?.current_period_end;
      const currentPeriodEnd = rawPeriodEnd ? new Date(rawPeriodEnd * 1000) : null;

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
        current_period_end TIMESTAMPTZ,
        signup_offer TEXT,
        is_admin BOOLEAN DEFAULT FALSE
      );
    `);
    // safe migrations for the already-live database — each only adds the column if it isn't already there
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_offer TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;`);
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lesson_progress (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        lesson_slug TEXT NOT NULL,
        passed_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, lesson_slug)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gallery_submissions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        lesson_slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        image_base64 TEXT NOT NULL,
        media_type TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Database schema ready (users, login_tokens, sessions, lesson_progress, gallery_submissions).');
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
    tier: 'beginner',
    title: 'Lesson 1: One Object, One Light',
    scope: `1. Basic proportion (does the shape read believably)
2. Value and light (does shading create a sense of form/depth, or does it read flat)
3. Focal point (is there one clear place the eye is drawn to)`
  },
  lesson2: {
    tier: 'beginner',
    title: 'Lesson 2: Two Objects, One Light',
    scope: `1. Relative proportion between the two objects (do they relate to each other believably in size and placement, not just correct individually)
2. Value and light consistency (is the same light logic applied convincingly across BOTH objects, not just one)
3. Focal point (does the pair read as one grouped subject, with a clear sense of what draws the eye first)`
  },
  lesson3: {
    tier: 'beginner',
    title: 'Lesson 3: Line & Edges',
    scope: `1. Line confidence (are marks committed and clear, rather than scratchy, hesitant, repeated attempts at the same edge)
2. Edge variation (does the line vary appropriately — harder and more definite where a boundary is a strong contact point or shadow-side transition, softer or fading where the form turns gently into light — rather than one uniform outline all the way around)
3. Focal point (is there still one clear place the eye is drawn to, now reinforced partly through line weight rather than only shading)`
  },
  lesson4: {
    tier: 'beginner',
    title: 'Lesson 4: Simple Still Life',
    scope: `1. Proportion and placement among three or four objects (do they relate to each other believably as a group, not just individually correct)
2. Value and light consistency across every object in the arrangement (same light logic applied convincingly to all forms, not just one or two)
3. Focal point (is there clearly one object the arrangement is built around, with the others genuinely supporting it — through overlap, scale, or reduced emphasis — rather than every object competing equally for attention)`
  },
  lesson5: {
    tier: 'beginner',
    title: 'Lesson 5: Foreground & Background',
    scope: `1. Foreground subject quality (is the main subject rendered with the confidence, proportion, and edge control built up across earlier lessons)
2. Background restraint (does the background stay genuinely subordinate — lower contrast, less detail, softer or quieter marks — so it recedes, rather than being rendered with the same care as the subject and competing with it)
3. Depth read (does the piece convincingly read as something in front of something else, or does it read as one flat, evenly-weighted scene)`
  },
  lesson6: {
    tier: 'beginner',
    title: 'Lesson 6: First Finished Piece',
    scope: `This is the final Beginner-tier lesson — a synthesis, not a new isolated skill. The student chose their own subject this time. Assess the piece as a considered whole, across everything built up so far:
1. Proportion and shape (does everything drawn read as believable, whatever the subject)
2. Value, light, and edge control together (is there one consistent light source, does shading create real form, do edges vary in weight the way a real object's edges do)
3. Composition as a whole (is there one clear focal point, does the background stay appropriately quieter than the subject, does the whole piece read as one considered scene rather than a collection of separate technical exercises)`
  },
  intermediate1: {
    tier: 'intermediate',
    title: 'Intermediate Lesson 1: Perspective Basics',
    scope: `1. Use of a single vanishing point and horizon line (do receding edges genuinely converge toward one consistent point, rather than staying parallel or converging inconsistently)
2. Proportion and form under perspective (do objects still read as believable in scale and shape once perspective is applied, not distorted or flattened)
3. Deliberate horizon placement (does the horizon's position — centre, upper third, or lower third — feel like a genuine choice suited to the scene, not an accidental default, and does that choice support the balance of ground versus sky the piece seems to be going for)`
  },
  intermediate2: {
    tier: 'intermediate',
    title: 'Intermediate Lesson 2: Life vs Reference',
    scope: `1. Honest proportion and observation (does the piece reflect genuine, careful looking, rather than a mechanical or distorted copy of a source)
2. Signs of photographic distortion faithfully copied rather than corrected (flattened depth, odd exposure-driven contrast, a lens-distorted proportion) — if this is the photo-reference drawing specifically
3. Liveliness and presence (does the piece feel like it was genuinely observed, with the small honest imperfections that come from real looking, rather than feeling mechanically traced)`
  },
  intermediate3: {
    tier: 'intermediate',
    title: 'Intermediate Lesson 3: Composition in Depth — Thirds and Leading Lines',
    scope: `1. Rule-of-thirds placement (does the subject's key point sit near a grid intersection rather than dead-centre, and does that placement feel deliberate rather than accidental)
2. Leading lines (is there a real or implied line within the scene that genuinely draws the eye toward the subject, rather than the subject simply floating with nothing directing attention to it)
3. Everything already built (proportion, light, edges, focal point) still needs to be present and correct — these are two new deliberate tools added on top, not a replacement for the fundamentals`
  },
  intermediate4: {
    tier: 'intermediate',
    title: 'Intermediate Lesson 4: Colour Basics',
    scope: `1. Deliberate colour relationship (does the palette genuinely reflect a real relationship — complementary, analogous, or split-complementary — rather than an arbitrary assortment of unrelated colours)
2. Restraint (is the palette genuinely limited to a handful of related colours, rather than diluted by extra, unrelated colours added without a clear reason)
3. Everything already built (proportion, light, edges, composition) still needs to be present — colour is a new layer added on top, not a replacement for the fundamentals`
  },
  intermediate5: {
    tier: 'intermediate',
    title: 'Intermediate Lesson 5: Composition in Depth — Negative Space and Framing',
    scope: `1. Considered negative space (does the empty space around the subject have its own believable, deliberate shape, rather than reading as blank leftover paper)
2. Framing (is there something within the scene — real or arranged — that partially frames or overlaps the subject, drawing the eye inward, rather than the subject sitting fully exposed with nothing around it)
3. Everything already built (proportion, light, edges, thirds, leading lines) still needs to be present — these are two further deliberate tools, not a replacement for the fundamentals`
  },
  intermediate6: {
    tier: 'intermediate',
    title: 'Intermediate Lesson 6: Short Themed Series',
    scope: `This is the final Intermediate lesson — a synthesis, not a new isolated skill. The student made three pieces exploring one theme and is submitting the strongest for feedback. Assess it as a considered whole, across everything built across this tier:
1. Perspective, honest observation, and composition (do the fundamentals from earlier in this tier genuinely hold — spatial conviction, real looking rather than photo-copying, a clear focal point)
2. Colour and negative space, where relevant to this particular piece (deliberate, related colour choices; considered space around the subject)
3. Overall coherence and intent (does the piece feel like a genuine, considered part of a deliberate series, rather than an isolated exercise)`
  },
  advanced1: {
    tier: 'advanced',
    title: 'Advanced Lesson 1: Refining a Personal Voice',
    scope: `This lesson isn't a new technical skill — it's the first moment the student's own recurring tendencies become something worth naming. Every earlier tier deliberately avoided this. The exercise is a self-portrait, deliberately chosen so the subject and the point of the lesson are the same act — looking honestly at what's actually there.
1. Recurring choices (does a genuine, consistent tendency actually show up in this piece — a way of handling edges, a colour bias, a compositional habit — worth naming as something forming, not invented because the lesson calls for it)
2. Commitment to the choice (does the piece follow that tendency through with confidence, or does it waver between the emerging voice and older, more tentative habits)
3. This is observation, not instruction. Reflect back what's genuinely present — never tell the student to do more of it, adopt it deliberately, or treat it as "their style" going forward. Naming a pattern and prescribing one are not the same thing, and only the first belongs here.
4. Likeness is never the concern here. Do not comment on whether the self-portrait resembles the student — only on the marks, choices, and tendencies genuinely visible in the piece itself.`
  },
  advanced2: {
    tier: 'advanced',
    title: 'Advanced Lesson 2: Larger, Ambitious Pieces',
    scope: `The student has taken on something noticeably larger or more complex than before. Assess whether scaling up has actually been managed well — not whether the subject itself was ambitious enough.
1. Consistency across the larger scale (does quality — proportion, value, edge control — hold evenly throughout, or does it visibly weaken in areas that got less attention, as often happens once a piece grows)
2. Sustained focal hierarchy (with more now happening in the piece, is there still one clear place the eye lands first, or has the added complexity diluted it into several competing areas)
3. Everything built across Beginner and Intermediate still has to hold at this larger scale — size is the new variable here, not an excuse for the fundamentals to slip`
  },
  advanced3: {
    tier: 'advanced',
    title: 'Advanced Lesson 3: Critique-Driven Iteration',
    scope: `This lesson looks at how the student actually uses critique, using their own revision history rather than a single fixed piece.
1. Genuine responsiveness (does the revision show real engagement with the specific fix that was given, rather than some unrelated change made elsewhere on the piece)
2. Judgement in applying it (has the note been applied thoughtfully to what the piece actually needed, rather than mechanically over-applied in a way that overcorrects or unbalances something else)
3. Independent follow-through (beyond the one fix given, is there any sign the student extended that same thinking elsewhere in the piece unprompted — early evidence they're starting to self-critique, not just waiting to be told)`
  },
  advanced4: {
    tier: 'advanced',
    title: 'Advanced Lesson 4: Presenting & Framing',
    scope: `This lesson treats the piece as something meant to be shown, not just made — the first point where presentation itself is part of what's assessed.
1. Use of the full format (does the piece use its edges deliberately — considered cropping and composition within the frame — rather than reading as an arbitrary slice of a larger, unconsidered scene)
2. Finish and intentionality (does the piece read as deliberately complete and resolved, ready to be seen, rather than looking merely stopped rather than finished)
3. How it would actually read on a wall, at a normal viewing distance, to a stranger encountering it with no context — not just up close, to someone who already knows what they meant by it`
  },
  advanced5: {
    tier: 'advanced',
    title: 'Advanced Lesson 5: Preparing for Exhibition',
    scope: `This is the final lesson of the whole course, and the most holistic. The student is submitting a piece as a genuine exhibition candidate — assess it exactly as a gallery would assess a real submission.
1. Everything built across the entire course — proportion, light, edges, composition, colour, and personal voice — needs to be genuinely present and working together, not just individually adequate
2. Exhibition-readiness specifically (would this piece hold its own hung among other real, finished work, or does something about it still read as a student exercise rather than a finished, exhibitable piece)
3. An honest, direct verdict either way. This is the one moment in the whole course where that verdict genuinely matters for something real — it should not be softened in either direction, and a piece that isn't ready yet deserves to be told so plainly and kindly, with exactly what would close the gap`
  }
};

function getLesson(slug) {
  return LESSONS[slug] || LESSONS.lesson1;
}

function tierConstraintText(lesson) {
  if (lesson.tier === 'advanced') {
    return `This is an ADVANCED-tier student, the top of the ladder. Every earlier tier deliberately withheld discussion of personal style and voice specifically so this moment would mean something — that door is now genuinely open, but it needs real care, not just permission:

You MAY now discuss:
- Personal style, voice, and recurring artistic tendencies
- Full composition and colour theory, exhibition-level presentation, larger and more ambitious scope
- Whether a piece is genuinely ready to be shown to the public

The single most important rule at this tier is HOW style gets discussed:
- Observe, never instruct. Reflect back what's genuinely already present and recurring in the student's own work — never tell them to adopt a style, add more of something "because it's their style," or push them toward a signature look. The moment feedback starts prescribing style rather than describing it, it stops helping someone discover their own voice and starts manufacturing one for them instead.
- Still only ONE concrete fix, same as every tier before this. The vocabulary available has grown considerably; the discipline of restraint has not, and matters just as much here as it did on someone's very first piece.`;
  }
  if (lesson.tier === 'intermediate') {
    return `This is an INTERMEDIATE-tier student, one tier up from Beginner. At Beginner tier, feedback stayed narrowly on proportion, value/light, and focal point — composition theory, colour, and any discussion of personal style were deliberately off-limits. At Intermediate, that door opens:

You MAY now discuss:
- Composition theory properly (rule of thirds, leading lines, negative space, framing, visual weight)
- Colour theory and harmony, where the piece involves colour
- Perspective and spatial construction
- Early, gentle observations about emerging personal tendencies — noticing a pattern, not yet a full critique of "voice" (that's Advanced-tier territory)

The same core discipline that made Beginner tier work still applies here, because it's not really about skill level — it's about how feedback actually lands:
- Still only ONE concrete fix. More technical vocabulary now available doesn't mean more notes at once — a flood of intermediate-level jargon overwhelms just as easily as a flood of beginner notes did.`;
  }
  return `This is a BEGINNER-tier student. Beginner tier has a strict, narrow job — do not go beyond it.

What you must NOT do at this tier:
- Do not discuss personal style, artistic voice, or "what were you going for" — far too early, and it can make a beginner self-conscious before they've built basic confidence.
- Do not discuss colour harmony or composition theory beyond focal point — that's intermediate-tier territory.
- Do not give more than ONE concrete fix. Even a gentle second note can tip a first attempt from "you're on the right track" into "here's what's wrong with it" — at this stage, one well-chosen fix lands as encouragement, two starts to feel like a checklist of failures. Pick the single thing that will help most.`;
}

function buildLessonSystemPrompt(lesson) {
  const tierLabel = lesson.tier === 'advanced' ? 'an ADVANCED' : (lesson.tier === 'intermediate' ? 'an INTERMEDIATE' : 'a BEGINNER');
  return `You are the AI feedback step for an online art course run by Ulverston Art House, a small gallery and framing studio. This specific request is for ${tierLabel}-tier student working on "${lesson.title}."

${tierConstraintText(lesson)}

What to look at, and only this:
${lesson.scope}

If the piece genuinely, honestly nails what this lesson is asking — say so plainly instead of manufacturing a fix. Do not invent a note just to fill the "fix" field; a real "there's honestly nothing meaningful to add here" is a completely valid and expected response, not a failure to find something wrong. Inventing a fix that isn't real is worse than having none, especially for someone who already has a genuine eye for this.

Tone: warm, plain, encouraging, like a kind teacher talking to an adult student — never patronising, never generic ("great job!" with nothing behind it). Find something specific and real to praise before anything else — if you can't find something real, say what's promising about the attempt itself.

The student may include a short note on what they were going for. If they do, don't second-guess the deliberate choice itself — but you can and should still comment on execution within that choice.

Your entire response must be a single raw JSON object and nothing else — no markdown code fences, no preamble like "Here is my feedback", no closing remarks after the JSON, no explanation of your reasoning. The very first character of your response must be { and the very last character must be }. Respond in exactly this shape:
{"praise": "one or two sentences, specific to this piece", "fix": "one specific, actionable fix — or, if it's genuinely already excellent, an honest statement that there's nothing meaningful to add", "encouragement": "one short warm closing line"}`;
}

function buildLessonDetailPrompt(lesson) {
  const scopeNote = lesson.tier === 'advanced'
    ? `Full Advanced-tier scope applies — personal voice, style, full composition and colour, presentation and exhibition-readiness are all fair game. Same discipline as always: observe recurring patterns genuinely present in the piece, never prescribe or push a style. Going deeper means more nuance on what's already open to you, not a loosening of that discipline.`
    : lesson.tier === 'intermediate'
    ? `Stay within Intermediate-tier scope — composition, colour, and perspective are fair game where relevant, but this still isn't the moment for a deep "personal voice" critique (that's Advanced-tier territory). Going deeper means more nuance on what's already open to you, not a jump to Advanced-level commentary.`
    : `You must stay strictly within Beginner-tier scope — the same things as before, just more thoroughly. Do NOT introduce anything beyond this scope — no personal style, no artistic voice, no colour theory, no composition theory beyond focal point. Going deeper means more nuance on the same things, not new territory. This is the single most important rule to follow.`;

  return `You are the AI feedback step for an online art course run by Ulverston Art House. A student working on "${lesson.title}" has already received a short critique on their piece and has explicitly asked for more detail. This is a one-time follow-up, not an open conversation.

${scopeNote}

What to look at:
${lesson.scope}

You will be given the image, the student's optional note on what they were going for, and the short critique they already received. Give one or two further observations that add real depth beyond what was already said — do not just repeat the original praise or fix in different words.

If you genuinely can't find a further observation that adds real depth — the piece is already handling this well enough that there isn't a meaningful additional point to make — say so honestly rather than manufacturing something for the sake of it. A short, genuine "there isn't really more to add here, it's solid" is a valid response.

Your entire response must be a single raw JSON object and nothing else. The very first character must be { and the last must be }. Respond in exactly this shape:
{"details": ["first additional observation", "second additional observation, or omit if only one is warranted"]}`;
}

function buildLessonRevisionPrompt(lesson){
  const scopeNote = lesson.tier === 'advanced'
    ? `Full Advanced-tier scope applies — personal voice, style, and presentation are all fair game here, always observed and described rather than prescribed.`
    : lesson.tier === 'intermediate'
    ? `Composition, colour, and perspective are fair game where relevant — but this still isn't the moment for a deep "personal voice" critique (that's Advanced-tier territory).`
    : `No personal style, no artistic voice, no colour theory, no composition theory beyond focal point.`;

  return `You are the AI tutor for UAH Academy, looking at a revised attempt at "${lesson.title}". The student already received feedback on an earlier photo of this same piece, and has now gone back and worked on it — or says they have.

You will be shown TWO images, in this exact order: first the EARLIER version, then the NEW version. Before saying anything else, genuinely and carefully compare the two images against each other — do not assume they are different just because two images were provided.

If the two images are identical, or so close to identical that no meaningful change is visible, you MUST say so plainly and honestly. Do NOT invent or describe a change that isn't genuinely visible, no matter how plausible it would sound. It is better to correctly notice nothing changed than to praise a change that didn't happen.

If there IS a genuine, visible difference: stay within scope —
${lesson.scope}
${scopeNote} Address directly and specifically what has visibly changed. If the earlier fix was addressed well, say so specifically, describing the actual visible difference, and credit the effort of revising. If it wasn't fully resolved, or a new issue is now more visible, name that clearly and kindly.

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
      // Admins see every gate as unlocked without needing a real subscription — every existing
      // access check across lesson pages just tests subscriptionStatus === 'active', so this one
      // change is enough; nothing on the lesson pages themselves needs editing.
      subscriptionStatus: user.is_admin ? 'active' : user.subscription_status,
      subscriptionPlan: user.is_admin ? 'admin' : user.subscription_plan,
      isAdmin: !!user.is_admin
    });
  } catch (err) {
    console.error('me error:', err);
    res.status(500).json({ error: err.message });
  }
});

// The full, linear order lessons unlock in — used to work out what someone's
// actually earned access to, both here and on each lesson page itself.
const LESSON_SEQUENCE = [
  'lesson1', 'lesson2', 'lesson3', 'lesson4', 'lesson5', 'lesson6',
  'intermediate1', 'intermediate2', 'intermediate3', 'intermediate4', 'intermediate5', 'intermediate6',
  'advanced1', 'advanced2', 'advanced3', 'advanced4', 'advanced5'
];

app.get('/api/lessons/progress', async (req, res) => {
  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Please log in first.' });
    const result = await pool.query(`SELECT lesson_slug FROM lesson_progress WHERE user_id = $1`, [user.id]);
    res.json({ passed: result.rows.map(r => r.lesson_slug) });
  } catch (err) {
    console.error('lessons/progress error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/lessons/mark-passed', async (req, res) => {
  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Please log in first.' });
    const { lesson } = req.body;
    if (!LESSON_SEQUENCE.includes(lesson)) return res.status(400).json({ error: 'Unknown lesson.' });
    await pool.query(
      `INSERT INTO lesson_progress (user_id, lesson_slug) VALUES ($1, $2) ON CONFLICT (user_id, lesson_slug) DO NOTHING`,
      [user.id, lesson]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('lessons/mark-passed error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gallery/submit', async (req, res) => {
  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Please log in first.' });
    const { lesson, image, mediaType, displayName } = req.body;
    if (!LESSON_SEQUENCE.includes(lesson)) return res.status(400).json({ error: 'Unknown lesson.' });
    if (!image || !mediaType) return res.status(400).json({ error: 'Missing image.' });
    if (!displayName || !displayName.trim()) return res.status(400).json({ error: 'Please add a name to show alongside your piece.' });

    await pool.query(
      `INSERT INTO gallery_submissions (user_id, lesson_slug, display_name, image_base64, media_type) VALUES ($1, $2, $3, $4, $5)`,
      [user.id, lesson, displayName.trim().slice(0, 60), image, mediaType]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('gallery/submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gallery', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT lesson_slug, display_name, image_base64, media_type, created_at FROM gallery_submissions ORDER BY created_at DESC LIMIT 60`
    );
    const pieces = result.rows.map(row => ({
      lessonTitle: LESSONS[row.lesson_slug] ? LESSONS[row.lesson_slug].title : row.lesson_slug,
      displayName: row.display_name,
      image: row.image_base64,
      mediaType: row.media_type,
      createdAt: row.created_at
    }));
    res.json({ pieces });
  } catch (err) {
    console.error('gallery error:', err);
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

const REWARD_NOTIFY_EMAIL = process.env.REWARD_NOTIFY_EMAIL || 'david@ulverstonarthouse.co.uk';

app.post('/api/claim-reward', async (req, res) => {
  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Please log in first.' });

    const { image, mediaType, recipientName, address, postcode, message } = req.body;
    if (!image || !mediaType) return res.status(400).json({ error: 'Missing image.' });
    if (!recipientName || !address || !postcode) return res.status(400).json({ error: 'Please fill in who the card should go to and their address.' });
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
        html: `<p>A student has just completed Beginner tier and claimed their free greetings card reward.</p>
<p><b>Student email:</b> ${user.email}</p>
<p><b>Send the card to:</b><br>${recipientName}<br>${address.replace(/\n/g, '<br>')}<br>${postcode}</p>
<p><b>Message to write inside:</b><br>${message ? message.replace(/\n/g, '<br>') : '(none provided)'}</p>
<p>Their finished piece is attached.</p>`,
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

app.get('/api/founder-slots', async (req, res) => {
  try {
    const result = await pool.query(`SELECT COUNT(*) FROM users WHERE signup_offer = 'founder'`);
    const used = parseInt(result.rows[0].count, 10);
    const remaining = Math.max(0, FOUNDER_SLOTS_CAP - used);
    const available = remaining > 0 && !!FOUNDER_COUPON_ID;

    let percentOff = null;
    if (available) {
      try {
        const coupon = await stripeClient.coupons.retrieve(FOUNDER_COUPON_ID);
        percentOff = coupon.percent_off;
      } catch (e) {
        console.error('Could not fetch founder coupon details:', e.message);
      }
    }

    res.json({ remaining, cap: FOUNDER_SLOTS_CAP, available, percentOff });
  } catch (err) {
    console.error('founder-slots error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pause-membership', async (req, res) => {
  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Please log in first.' });
    if (user.subscription_status !== 'active') return res.status(400).json({ error: 'Your membership is not currently active.' });
    if (!user.stripe_customer_id) return res.status(400).json({ error: 'No subscription found on your account.' });

    const subs = await stripeClient.subscriptions.list({ customer: user.stripe_customer_id, status: 'active', limit: 1 });
    if (!subs.data.length) return res.status(400).json({ error: 'Could not find an active subscription to pause.' });

    await stripeClient.subscriptions.update(subs.data[0].id, {
      pause_collection: { behavior: 'void' }
    });

    await pool.query(`UPDATE users SET subscription_status = 'paused' WHERE id = $1`, [user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('pause-membership error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/resume-membership', async (req, res) => {
  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Please log in first.' });
    if (user.subscription_status !== 'paused') return res.status(400).json({ error: 'Your membership is not currently paused.' });
    if (!user.stripe_customer_id) return res.status(400).json({ error: 'No subscription found on your account.' });

    const subs = await stripeClient.subscriptions.list({ customer: user.stripe_customer_id, status: 'active', limit: 1 });
    if (!subs.data.length) return res.status(400).json({ error: 'Could not find your subscription to resume.' });

    await stripeClient.subscriptions.update(subs.data[0].id, {
      pause_collection: ''
    });

    await pool.query(`UPDATE users SET subscription_status = 'active' WHERE id = $1`, [user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('resume-membership error:', err);
    res.status(500).json({ error: err.message });
  }
});

// One-time admin bootstrap. This never becomes a standing back door: it checks whether
// an admin already exists on every call, and refuses outright once one does — so it's
// safe to leave deployed rather than needing to be found and removed later.
// Facts the FAQ assistant is allowed to state as true. Kept separate from the system
// prompt itself so future pages (the Wynander exhibition site, say) can reuse the same
// assistant with their own facts injected, rather than needing a rebuild.
const ACADEMY_FACTS = `
- UAH Academy is an online art course run by Ulverston Art House, a real gallery and framing studio in Ulverston, Cumbria.
- It's built for complete beginners — no experience needed. Lesson 1 is a simple exercise: draw one everyday object (an egg, apple, or mug) using light and shadow.
- Feedback is genuinely AI-assisted, not fully automated — the AI gives detailed critique tuned specifically to each stage of the course, and the founder is personally involved at real milestones (not every single submission, but at the moments that matter).
- The course runs Beginner through Intermediate through Advanced, six lessons per tier, self-paced — go as fast or slow as you like.
- Pricing is £15/month, or £150/year (paying annually saves roughly two months). No hidden fees.
- Membership can be paused, not just cancelled — billing stops immediately and progress is saved exactly where it was left, resumable any time.
- There's a free way to try it first: "Side Shoots" — pick one themed piece (from groups called General, Texture, and Memory Lane) and get real AI feedback on it before enrolling, no payment required.
- Finishing the Beginner tier earns a small, real framed print of the student's own work, made by UAH itself.
- The course leads toward a planned exhibition series called "The Shape of Things to Come," where graduates get the chance to show and sell real work in a real venue as debut artists. The venue isn't finalised yet — UAH is in conversation with venues in Lancaster, Carlisle, and at Rheged.
- Separately, UAH also runs a multi-vendor platform where people can sell their art more generally, described as "curate your own gallery."
- The exact content of the Advanced tier is still being refined and isn't finalised yet.
`.trim();

const FAQ_SYSTEM_PROMPT = `You are answering questions on the UAH Academy website from people considering whether to enrol. Your tone matters as much as your accuracy — you should sound exactly like the same warm, plain-spoken, honest voice the course itself uses when giving feedback on someone's art: no corporate chatbot phrasing, no forced enthusiasm, no filler.

Facts you can state as true:
${ACADEMY_FACTS}

Rules:
- Never invent or guess at anything not in the facts above — no made-up dates, no invented policies, no guessed prices. If you don't know something, say so plainly and offer to have the founder follow up directly. This is not a failure — admitting you don't know something is exactly the same honesty the course itself is built on, and should be said with the same warmth, not as an apology.
- If asked whether you're AI, say yes, plainly and without hedging. That's not something to talk around here — the whole point of this chat is to demonstrate what the AI feedback in the course is actually like: honest and genuinely useful, not evasive.
- Keep answers short — a few sentences, not an essay. This is a conversation, not a brochure.
- If someone seems ready to enrol or asks how to sign up, point them to the enrol/pricing section on the page rather than trying to close the sale yourself.
- If a question is genuinely outside what you know (legal, highly specific personal circumstances, anything not covered above), say so honestly and suggest the founder can help directly — offer to take their email so the founder can follow up, but never fabricate a promise about response time.`;

app.post('/api/faq-chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'No message history provided.' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Server has no ANTHROPIC_API_KEY set.' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: FAQ_SYSTEM_PROMPT,
        messages: messages
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errText}`);
    }
    const data = await response.json();
    const textBlock = data.content.find(b => b.type === 'text');
    if (!textBlock) throw new Error('No response text received.');

    res.json({ reply: textBlock.text });
  } catch (err) {
    console.error('faq-chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/bootstrap', async (req, res) => {
  try {
    const { secret, email } = req.body;
    if (!process.env.ADMIN_BOOTSTRAP_SECRET) {
      return res.status(500).json({ error: 'Server has no ADMIN_BOOTSTRAP_SECRET set — add one in Render\'s Environment settings first.' });
    }
    if (!secret || secret !== process.env.ADMIN_BOOTSTRAP_SECRET) {
      return res.status(403).json({ error: 'That secret doesn\'t match what\'s set on the server.' });
    }
    const existingAdmin = await pool.query('SELECT id FROM users WHERE is_admin = TRUE LIMIT 1');
    if (existingAdmin.rows.length > 0) {
      return res.status(403).json({ error: 'An admin account already exists — this can only be used once, and it already has been.' });
    }
    if (!email) {
      return res.status(400).json({ error: 'Enter the email you log into the Academy with.' });
    }
    const result = await pool.query('UPDATE users SET is_admin = TRUE WHERE email = $1 RETURNING email', [email]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No account found with that email. Log in at login.html at least once first, then try again.' });
    }
    res.json({ success: true, email: result.rows[0].email });
  } catch (err) {
    console.error('admin bootstrap error:', err);
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

    // Check real, live founder-slot availability right before creating the session —
    // never a cached or assumed number, always the true current count.
    if (FOUNDER_COUPON_ID) {
      const slotsResult = await pool.query(`SELECT COUNT(*) FROM users WHERE signup_offer = 'founder'`);
      const used = parseInt(slotsResult.rows[0].count, 10);
      if (used < FOUNDER_SLOTS_CAP) {
        sessionParams.discounts = [{ coupon: FOUNDER_COUPON_ID }];
        sessionParams.metadata = { founderOffer: 'true' };
      }
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

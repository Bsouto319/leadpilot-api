const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger');

// ── Voice catalogue ───────────────────────────────────────────────────────────
const VOICE_IDS = {
  hope:    'zGjIP4SZlMnY9m93k97r', // Hope - Clear, Relatable and Charismatic (default)
  hope2:   'OYTbf65OHHFELVut7v2H', // Hope - Natural, Clear and Calm
  rachel:  '21m00Tcm4TlvDq8ikWAM',
  aria:    '9BWtsMINqrJLrRacOk9x',
  jessica: 'cgSgspJ2msm6clMCkdW9',
  sarah:   'EXAVITQu4vr4xnSDxMaL',
  laura:   'FGY2WhTYpPnrIDTdsKH5',
  matilda: 'XrExE9yKIg1WjnnlVkGX',
  bella:   'hpp4J3VqNfWAUOO0d1Us',
  alice:   'Xb7hH8MSUJpSbSDYk0k2',
};
const DEFAULT_VOICE = 'hope';

// ── Limiters ──────────────────────────────────────────────────────────────────
const MAX_CHARS_PER_PHRASE   = 350;   // rejeita frases muito longas
const MAX_CHARS_PER_BATCH    = 4_000; // budget total por chamada admin
const DAILY_CHAR_LIMIT       = () => parseInt(process.env.ELEVENLABS_DAILY_CHAR_LIMIT || '12000');

// Daily usage tracker (resets at midnight UTC)
let _dailyUsage = { date: '', chars: 0 };
function trackUsage(chars) {
  const today = new Date().toISOString().slice(0, 10);
  if (_dailyUsage.date !== today) { _dailyUsage = { date: today, chars: 0 }; }
  _dailyUsage.chars += chars;
  logger.info('elevenlabs', `daily_usage=${_dailyUsage.chars}/${DAILY_CHAR_LIMIT()} chars`);
  if (_dailyUsage.chars > DAILY_CHAR_LIMIT()) {
    logger.warn('elevenlabs', `daily char limit ${DAILY_CHAR_LIMIT()} exceeded!`);
  }
}
function getDailyUsage() { return { ..._dailyUsage, limit: DAILY_CHAR_LIMIT() }; }

// ── Phrase definitions (static content per client) ────────────────────────────
// All phrases are standalone ElevenLabs Hope. Dynamic parts (name, date) go in SMS only.
function getClientPhrases(businessName) {
  const b = businessName || 'us';
  return {
    // Full greeting — 1 per client
    greeting:
      `Hi! I'm Lexy, the virtual scheduling assistant for ${b}. I'm here to help you schedule your free estimate. What's your first name?`,

    // No-input retries — fully static
    no_input_name:
      `I'm sorry, I didn't catch that. Could you tell me your first name?`,
    no_input_service:
      `I'm sorry, I didn't quite catch that. What type of project are you looking to get done? For example, tile installation, flooring, or a home renovation?`,
    no_input_date:
      `I didn't hear a date. What day works best for your free estimate? You can say something like next Monday or this Friday afternoon.`,
    no_input_address:
      `I didn't catch the address. Could you say your street address, city, and state?`,

    // Step transitions — standalone phrases
    ask_service_suffix:
      `Great! So, what type of project are you looking to get done?`,
    ask_date_suffix:
      `Perfect! What day this week or next works best for your completely FREE in-home estimate?`,
    ask_address_suffix:
      `Excellent! Last step — what's the address where you'd like us to come out? Street, city, and state.`,

    // Date parse retry — mostly static
    date_retry:
      `I didn't quite get that. Could you say a specific day and time? For example, next Monday at 2 P M, or this Friday morning.`,

    // Transition: date captured, parsing async
    waiting_moment:
      `Got it! Just a moment, I'm checking the schedule.`,

    // Fallback when browser didn't answer — AI takes over mid-call
    fallback_ai_takeover:
      `Thank you for holding! My name is Lexy, the scheduling assistant for ${b}. I'm here to get you set up with a completely FREE in-home estimate. So, what type of project are you looking to get done?`,

    // Booking confirmed farewell — generic (date/address go in the SMS confirmation)
    booking_confirmed:
      `Perfect! You're all set. You'll receive a text confirmation right now with all the details. One of our team members will personally reach out to confirm everything — you're in great hands! Thank you so much for choosing ${b}, and have an amazing day!`,

    // Abandoned / fallback — has business name
    abandoned:
      `It sounds like we're having trouble hearing you. No worries — we'll send you a text message to continue. Thank you for calling ${b} and have a wonderful day!`,
    fallback:
      `Thank you for calling ${b}. Have a wonderful day!`,
  };
}

// ── Storage ───────────────────────────────────────────────────────────────────
const AUDIO_DIR = path.join('/tmp', 'leadpilot-audio');
const _cache    = new Map(); // `${clientId}:${phraseKey}` → Buffer

function ensureDir() {
  try { fs.mkdirSync(AUDIO_DIR, { recursive: true }); } catch {}
}
function cacheKey(clientId, phraseKey) { return `${clientId}:${phraseKey}`; }
function localPath(clientId, phraseKey) {
  return path.join(AUDIO_DIR, `${clientId}-${phraseKey}.mp3`);
}

function getBuffer(clientId, phraseKey) {
  const k = cacheKey(clientId, phraseKey);
  if (_cache.has(k)) return _cache.get(k);
  try {
    const p = localPath(clientId, phraseKey);
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      _cache.set(k, buf);
      return buf;
    }
  } catch {}
  return null;
}

function hasPhrase(clientId, phraseKey) {
  if (_cache.has(cacheKey(clientId, phraseKey))) return true;
  try { return fs.existsSync(localPath(clientId, phraseKey)); } catch { return false; }
}

// Retorna URL relativa para usar no TwiML <Play>
function phraseUrl(baseUrl, clientId, phraseKey) {
  return `${baseUrl}/audio/${clientId}/${phraseKey}`;
}

// ── ElevenLabs API call ───────────────────────────────────────────────────────
async function generateMp3(text, voiceId) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');

  if (text.length > MAX_CHARS_PER_PHRASE) {
    throw new Error(`Phrase too long: ${text.length} chars (max ${MAX_CHARS_PER_PHRASE}). Shorten it.`);
  }

  const vid  = VOICE_IDS[voiceId] || voiceId || VOICE_IDS[DEFAULT_VOICE];
  const body = JSON.stringify({
    text,
    model_id: 'eleven_monolingual_v1',
    voice_settings: { stability: 0.52, similarity_boost: 0.75, style: 0.25, use_speaker_boost: true },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${vid}`,
      method: 'POST',
      headers: {
        'xi-api-key':     apiKey,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept':         'audio/mpeg',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          return reject(new Error(`ElevenLabs HTTP ${res.statusCode}: ${buf.toString('utf8').slice(0, 300)}`));
        }
        resolve(buf);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Public: generate and cache ALL phrases for a client ───────────────────────
async function generateAllClientPhrases(clientId, businessName, voiceId) {
  const phrases = getClientPhrases(businessName);
  const totalChars = Object.values(phrases).reduce((s, t) => s + t.length, 0);

  if (totalChars > MAX_CHARS_PER_BATCH) {
    throw new Error(`Batch too large: ${totalChars} chars (max ${MAX_CHARS_PER_BATCH})`);
  }

  const daily = getDailyUsage();
  if (daily.chars + totalChars > DAILY_CHAR_LIMIT()) {
    throw new Error(`Daily char limit would be exceeded: ${daily.chars + totalChars}/${DAILY_CHAR_LIMIT()}`);
  }

  logger.info('elevenlabs', `generating ${Object.keys(phrases).length} phrases for client=${clientId} total=${totalChars} chars`);
  ensureDir();

  const results = {};
  let generated = 0;

  for (const [key, text] of Object.entries(phrases)) {
    try {
      const mp3 = await generateMp3(text, voiceId);
      _cache.set(cacheKey(clientId, key), mp3);
      try { fs.writeFileSync(localPath(clientId, key), mp3); } catch {}
      results[key] = { ok: true, chars: text.length, bytes: mp3.length };
      generated += text.length;
      logger.info('elevenlabs', `  ${key} ✓ ${text.length}chars → ${mp3.length}bytes`);
    } catch (err) {
      results[key] = { ok: false, error: err.message };
      logger.error('elevenlabs', `  ${key} ✗ ${err.message}`);
    }
  }

  trackUsage(generated);
  return { results, totalCharsGenerated: generated, dailyUsage: getDailyUsage() };
}

// ── Public: single phrase (used by old admin/greeting endpoint) ───────────────
async function generateAndCacheGreeting(clientId, text, voiceId) {
  logger.info('elevenlabs', `single greeting client=${clientId}`);
  const mp3 = await generateMp3(text, voiceId);
  _cache.set(cacheKey(clientId, 'greeting'), mp3);
  ensureDir();
  try { fs.writeFileSync(localPath(clientId, 'greeting'), mp3); } catch {}
  trackUsage(text.length);
  return mp3;
}

// ── Backward-compat: served by old GET /audio/greeting/:clientId route ────────
function getGreetingBuffer(clientId) { return getBuffer(clientId, 'greeting'); }
function hasGreeting(clientId) { return hasPhrase(clientId, 'greeting'); }

module.exports = {
  VOICE_IDS,
  getClientPhrases,
  generateMp3,
  generateAllClientPhrases,
  generateAndCacheGreeting,
  getGreetingBuffer,
  getBuffer,
  hasPhrase,
  hasGreeting,
  phraseUrl,
  getDailyUsage,
};

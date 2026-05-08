const https = require('https');
const fs    = require('fs');
const path  = require('path');
const logger = require('../utils/logger');

const VOICE_IDS = {
  rachel: '21m00Tcm4TlvDq8ikWAM',
  aria:   '9BWtsMINqrJLrRacOk9x',
  jessica:'cgSgspJ2msm6clMCkdW9',
};

const DEFAULT_VOICE = 'rachel';
const AUDIO_DIR = path.join('/tmp', 'leadpilot-audio');

// In-memory cache: clientId → Buffer
const _greetingCache = new Map();

function ensureDir() {
  try { fs.mkdirSync(AUDIO_DIR, { recursive: true }); } catch {}
}

function localPath(clientId) {
  return path.join(AUDIO_DIR, `${clientId}.mp3`);
}

async function generateMp3(text, voiceId) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');

  const vid  = VOICE_IDS[voiceId] || voiceId || VOICE_IDS[DEFAULT_VOICE];
  const body = JSON.stringify({
    text,
    model_id: 'eleven_monolingual_v1',
    voice_settings: {
      stability: 0.52,
      similarity_boost: 0.75,
      style: 0.25,
      use_speaker_boost: true,
    },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${vid}`,
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'audio/mpeg',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          return reject(new Error(`ElevenLabs ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`));
        }
        resolve(buf);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function generateAndCacheGreeting(clientId, text, voiceId) {
  logger.info('elevenlabs', `generating greeting client=${clientId} voice=${voiceId || DEFAULT_VOICE}`);
  const mp3 = await generateMp3(text, voiceId);

  _greetingCache.set(clientId, mp3);

  ensureDir();
  try { fs.writeFileSync(localPath(clientId), mp3); } catch (e) {
    logger.warn('elevenlabs', `could not write to disk: ${e.message}`);
  }

  logger.info('elevenlabs', `greeting cached client=${clientId} size=${mp3.length}bytes`);
  return mp3;
}

function getGreetingBuffer(clientId) {
  if (_greetingCache.has(clientId)) return _greetingCache.get(clientId);

  // Try loading from disk (survives in-process reload but not container restart)
  try {
    const p = localPath(clientId);
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      _greetingCache.set(clientId, buf);
      return buf;
    }
  } catch {}

  return null;
}

function hasGreeting(clientId) {
  if (_greetingCache.has(clientId)) return true;
  try { return fs.existsSync(localPath(clientId)); } catch { return false; }
}

module.exports = { generateMp3, generateAndCacheGreeting, getGreetingBuffer, hasGreeting, VOICE_IDS };

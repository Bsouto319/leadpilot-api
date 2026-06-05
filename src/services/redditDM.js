/**
 * Reddit DM sender — usa session-based auth (username + password)
 * Não requer Reddit app / client_id
 */

const logger = require('../utils/logger');

const REDDIT_USER    = process.env.REDDIT_USERNAME || 'One-Custard-2339';
const REDDIT_PASS    = process.env.REDDIT_PASSWORD || 'Segredinho2027';
const USER_AGENT     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let _session = null; // { cookie, modhash, expiresAt }

async function getSession() {
  if (_session && _session.expiresAt > Date.now()) return _session;

  logger.info('redditDM', `logging in as u/${REDDIT_USER}`);

  const loginRes = await fetch('https://ssl.reddit.com/api/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':   USER_AGENT,
    },
    body: new URLSearchParams({
      user:     REDDIT_USER,
      passwd:   REDDIT_PASS,
      api_type: 'json',
    }),
  });

  const raw  = await loginRes.text();
  const data = JSON.parse(raw);

  if (data?.json?.errors?.length) {
    const err = data.json.errors[0]?.join(' ') || 'Login failed';
    throw new Error(`Reddit login error: ${err}`);
  }

  const modhash = data?.json?.data?.modhash;
  const cookie  = loginRes.headers.get('set-cookie') || '';

  if (!modhash) throw new Error('Reddit login: no modhash returned');

  _session = { cookie, modhash, expiresAt: Date.now() + 55 * 60 * 1000 }; // 55 min
  logger.info('redditDM', 'session established');
  return _session;
}

async function sendDM({ to, subject, message }) {
  const session = await getSession();

  const res = await fetch('https://www.reddit.com/api/compose', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':   USER_AGENT,
      'Cookie':       session.cookie,
      'X-Modhash':    session.modhash,
    },
    body: new URLSearchParams({
      api_type: 'json',
      to,
      subject:  subject || 'Your kitchen project',
      text:     message,
    }),
  });

  const data = await res.json();
  const errors = data?.json?.errors;

  if (errors?.length) {
    const msg = errors[0]?.join(' ') || 'Unknown error';
    throw new Error(`Reddit DM error: ${msg}`);
  }

  logger.info('redditDM', `DM sent to u/${to}`);
  return { ok: true };
}

module.exports = { sendDM };

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

  // Step 1: get initial cookies from reddit homepage
  const homeRes = await fetch('https://www.reddit.com/', {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const homeCookies = homeRes.headers.get('set-cookie') || '';

  // Step 2: login
  const loginRes = await fetch('https://www.reddit.com/api/login', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'User-Agent':    USER_AGENT,
      'Accept':        'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin':        'https://www.reddit.com',
      'Referer':       'https://www.reddit.com/login',
      'Cookie':        homeCookies,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams({
      user:     REDDIT_USER,
      passwd:   REDDIT_PASS,
      api_type: 'json',
    }),
  });

  const raw = await loginRes.text();
  logger.info('redditDM', `login response status=${loginRes.status} body=${raw.slice(0, 200)}`);

  let data;
  try { data = JSON.parse(raw); } catch {
    throw new Error(`Reddit login returned HTML (bot detection) — status=${loginRes.status}`);
  }

  if (data?.json?.errors?.length) {
    const err = data.json.errors[0]?.join(' ') || 'Login failed';
    throw new Error(`Reddit login error: ${err}`);
  }

  const modhash = data?.json?.data?.modhash;
  const setCookie = loginRes.headers.get('set-cookie') || '';
  const cookie = [homeCookies, setCookie].filter(Boolean).join('; ');

  if (!modhash) throw new Error(`Reddit login: no modhash — response: ${raw.slice(0, 300)}`);

  _session = { cookie, modhash, expiresAt: Date.now() + 55 * 60 * 1000 };
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

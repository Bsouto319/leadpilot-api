/**
 * Reddit Prospector — integrado ao leadpilot-api
 * Roda via cron horário. Digest às 8h e 16h ET, ou ao acumular 10 leads.
 */

const { createClient } = require('@supabase/supabase-js');
const { sendEmail }    = require('./gmail');
const logger           = require('../utils/logger');

const CP_CLIENT_ID  = '5221cab9-a741-4ddc-a752-2359826fba95';
const WEBSITE_URL   = 'https://cpcabinets.com';
const BUSINESS      = 'CP Cabinets & Quartz';

const SEND_HOURS_ET    = [8, 16];
const BATCH_THRESHOLD  = 1; // send every hour as soon as any qualified lead is found

const DIGEST_RECIPIENTS = [
  'brunosouto1108@gmail.com',
  'carvalhopintoge@gmail.com',
  'contact@cpcabinets.com',
];

// ── Supabase client com service key para operações internas ──────────────────
const SUPA_URL = 'https://pvphgusjofufwtyiyviu.supabase.co';
const SUPA_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2cGhndXNqb2Z1Znd0eWl5dml1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyNjkwODYsImV4cCI6MjA5MDg0NTA4Nn0.0aA8YNmhVusNuBjWZoEZW50dTRZWowm9AoNVoyGCXBM';

function getSupabase() {
  return createClient(SUPA_URL, SUPA_KEY);
}

// ── Service Zones ─────────────────────────────────────────────────────────────
const DEFAULT_ZONES = [
  { city: 'Columbia',   lat: 34.0007, lng: -81.0348 },
  { city: 'Greenville', lat: 34.8526, lng: -82.3940 },
  { city: 'Charleston', lat: 32.7765, lng: -79.9311 },
  { city: 'Charlotte',  lat: 35.2271, lng: -80.8431 },
];

function haversine(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const TARGET_CITIES = [
  'south carolina', ' sc ', ' sc,', 'columbia', 'lexington', 'chapin', 'irmo', 'cayce',
  'greenville', 'simpsonville', 'spartanburg', 'charleston', 'summerville', 'goose creek',
  'charlotte', 'rock hill', 'fort mill', 'orangeburg', 'aiken', 'florence', 'myrtle beach',
];

// ── Reddit targets ────────────────────────────────────────────────────────────
const REDDIT_TARGETS = [
  { sub: 'columbiasc',         geo: true  },
  { sub: 'charleston',         geo: true  },
  { sub: 'Greenville',         geo: true  },
  { sub: 'Charlotte',          geo: true  },
  { sub: 'Cabinets',           geo: false },
  { sub: 'Countertops',        geo: false },
  { sub: 'remodeling',         geo: false },
  { sub: 'HomeImprovement',    geo: false },
  { sub: 'FirstTimeHomeBuyer', geo: false },
  { sub: 'realestate',         geo: false },
  { sub: 'KitchenRemodel',     geo: false },
];

const FORUM_SEARCHES = [
  'site:houzz.com/discussions "cabinet" ("Columbia" OR "Lexington" OR "Greenville" OR "Charleston" OR "South Carolina")',
  'site:houzz.com/discussions "quartz countertop" ("SC" OR "South Carolina" OR "Charlotte")',
  'site:doityourself.com/forum "kitchen remodel" ("Columbia SC" OR "Greenville SC" OR "Charleston SC")',
  'site:hometalk.com "kitchen renovation" ("Columbia" OR "Lexington" OR "South Carolina")',
  'site:nextdoor.com "kitchen cabinets" ("Columbia" OR "Lexington" OR "Irmo" OR "Greenville" OR "South Carolina")',
  'site:nextdoor.com "countertop" ("Columbia SC" OR "Greenville SC" OR "Charleston SC")',
  'site:angi.com "kitchen cabinet" ("Columbia" OR "Greenville" OR "Charleston" OR "SC")',
];

const BUY_KEYWORDS = [
  'new kitchen cabinets', 'custom cabinets', 'kitchen remodel', 'kitchen renovation',
  'new countertops', 'quartz countertops', 'granite countertops', 'kitchen makeover',
  'new construction kitchen', 'bathroom vanity replacement', 'cabinet installation quote',
  'countertop estimate', 'closing on a house', 'just bought a house', 'renovating before move',
];

const GEO_SUFFIXES = [
  'south carolina', 'columbia sc', 'charleston sc', 'greenville sc', 'lexington sc',
];

const DISCARD_KEYWORDS = [
  'repair', 'fix', 'broken', 'cracked', 'scratched', 'chip', 'already installed',
  'finished', 'done', 'completed', 'selling', 'for sale', 'diy', 'ikea', 'amazon',
  'lowes', 'home depot', 'canada', 'australia', 'uk', 'england', 'toronto', 'tutorial',
  'how to paint', 'how to refinish', 'california', 'texas', 'new york',
  'ohio', 'michigan', 'illinois', 'pennsylvania', 'virginia', 'new jersey',
  'indiana', 'india', 'indian marble', 'brazil', 'brasil', 'mexico', 'china',
  'pakistan', 'bangladesh', 'vietnam', 'turkey', 'italy', 'spain', 'portugal',
  'imported from', 'quarried in', 'mined in', 'made in china', 'made in india',
];

// ── Parsers ───────────────────────────────────────────────────────────────────
function stripHtml(html) {
  return (html || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseAtomFeed(xml, subreddit) {
  const entries = [];
  for (const block of (xml.match(/<entry>([\s\S]*?)<\/entry>/g) || [])) {
    const author  = (block.match(/<name>\/u\/([^<]+)<\/name>/) || [])[1] || '[deleted]';
    const title   = (block.match(/<title>([^<]+)<\/title>/)    || [])[1] || '';
    const link    = (block.match(/<link href="([^"]+)"/)        || [])[1] || '';
    const content = (block.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || '';
    const updated = (block.match(/<updated>([^<]+)<\/updated>/)  || [])[1] || '';
    const sub     = (block.match(/term="([^"]+)"/)               || [])[1] || subreddit;
    if (!link.includes('/comments/')) continue;
    entries.push({
      author, subreddit: sub,
      title: title.trim(),
      selftext: stripHtml(content).slice(0, 800),
      permalink: link.replace('https://www.reddit.com', ''),
      created_utc: updated ? new Date(updated).getTime() / 1000 : Date.now() / 1000,
      url: link,
    });
  }
  return entries;
}

function parseCraigslistRSS(xml, city) {
  const items = [];
  for (const block of (xml.match(/<item>([\s\S]*?)<\/item>/g) || [])) {
    const title   = ((block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '').trim();
    const link    = ((block.match(/<link>(https?:[^<]+)<\/link>/)                           || [])[1] || '').trim();
    const desc    = ((block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1] || '');
    const pubDate = ((block.match(/<pubDate>([^<]+)<\/pubDate>/)                            || [])[1] || '');
    if (!title || !link || title.toLowerCase() === 'craigslist') continue;
    items.push({
      author: 'craigslist_user', title,
      selftext: stripHtml(desc).slice(0, 800),
      permalink: '', post_url: link,
      subreddit: `craigslist-${city}`,
      created_utc: pubDate ? new Date(pubDate).getTime() / 1000 : Date.now() / 1000,
      source: 'craigslist',
    });
  }
  return items;
}

// ── Fetchers ──────────────────────────────────────────────────────────────────
async function fetchRSS(subreddit, query) {
  const url = `https://www.reddit.com/r/${subreddit}/search.rss?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&t=month&limit=25`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'BTechProspector/1.0 contact:brunosouto1108@gmail.com' } });
    if (!res.ok) return [];
    return parseAtomFeed(await res.text(), subreddit);
  } catch { return []; }
}

async function searchForums() {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx     = process.env.GOOGLE_SEARCH_CX;
  if (!apiKey || !cx) return [];
  const results = [];
  for (const q of FORUM_SEARCHES) {
    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(q)}&num=5&dateRestrict=m1`;
      const res  = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of (data.items || [])) {
        results.push({
          author: 'forum_user', source: 'forum',
          title: item.title.replace(/ \| Houzz$| - DoItYourself\.com.*$| - HomeTalk.*$/i, ''),
          selftext: item.snippet || '',
          permalink: '', post_url: item.link,
          subreddit: new URL(item.link).hostname.replace('www.', ''),
          created_utc: Date.now() / 1000 - 86400,
        });
      }
      await new Promise(r => setTimeout(r, 500));
    } catch { /* continue */ }
  }
  return results;
}

async function searchCraigslist() {
  const cities   = ['columbia', 'charleston', 'greenville', 'charlotte'];
  const keywords = ['kitchen cabinets', 'cabinet installation', 'countertop installation', 'kitchen remodel', 'quartz countertop'];
  const results  = [];
  for (const city of cities) {
    for (const kw of keywords) {
      try {
        const url = `https://${city}.craigslist.org/search/wan?format=rss&query=${encodeURIComponent(kw)}&sort=date`;
        const res = await fetch(url, { headers: { 'User-Agent': 'BTechProspector/1.0' } });
        if (!res.ok) continue;
        results.push(...parseCraigslistRSS(await res.text(), city));
      } catch { /* continue */ }
      await new Promise(r => setTimeout(r, 600));
    }
  }
  return results;
}

// ── Filters ───────────────────────────────────────────────────────────────────
function isRelevant(post) {
  const text = `${post.title} ${post.selftext}`.toLowerCase();
  if (DISCARD_KEYWORDS.some(k => text.includes(k))) return false;
  if (post.title.length < 15) return false;
  if ((Date.now() / 1000 - post.created_utc) / 86400 > 30) return false;
  if (post.author === '[deleted]') return false;
  return true;
}

function mentionsTargetArea(post) {
  const text = `${post.title} ${post.selftext}`.toLowerCase();
  return TARGET_CITIES.some(c => text.includes(c));
}

// ── GPT Qualify ───────────────────────────────────────────────────────────────
async function assessAndGenerateDM(post) {
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const postText = `${post.title}\n${post.selftext}`.slice(0, 700);

  const prompt = `You find leads for CP Cabinets & Quartz (Irmo, SC) — a company that supplies and installs premium all-plywood kitchen/bathroom cabinets and quartz/granite countertops.

QUALIFY ONLY if the person wants:
- Complete kitchen or bathroom cabinet installation (new or remodel)
- Countertop replacement or installation (quartz/granite)
- New construction cabinetry project
- Minimum project scope: $6,000+
- Location: South Carolina, Charlotte NC, or within ~100 miles of Columbia SC

DISQUALIFY immediately if they want:
- Single door or drawer replacement
- Cabinet painting or refinishing
- Small repairs or handyman work
- Fully custom/bespoke woodworking (we sell pre-fabricated premium cabinets)
- Plumbing or electrical work

Post from ${post.subreddit}:
"${postText}"

Score purchase intent 1-10. Score 8-10 = complete project, right area, right scope. Score 5-7 = possible lead in area, worth a review. Score below 5 = discard.

If score >= 5 AND in_area is true or unknown, write a short natural DM (3-4 sentences) that:
- References something specific from their post
- Mentions CP Cabinets is in Irmo/Columbia SC with a showroom
- Offers FREE in-home estimate, no obligation
- Ends naturally with: ${WEBSITE_URL}
- No emojis, no corporate tone, sounds like a real person

NEVER say "custom cabinets" — say "premium cabinets" or "all-plywood cabinets".

Respond ONLY with JSON:
{"intent_score":<1-10>,"in_area":<true/false/unknown>,"worth_contacting":<true/false>,"reason":"<1 sentence>","dm_text":"<DM or null>"}`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.6,
    max_tokens: 350,
  });

  try {
    return JSON.parse(res.choices[0].message.content.replace(/```json\n?|\n?```/g, ''));
  } catch {
    return { intent_score: 0, in_area: false, worth_contacting: false, dm_text: null };
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function alreadyProcessed(supabase, username, postUrl) {
  const { data } = await supabase
    .from('outbound_prospects')
    .select('id')
    .eq('username', username)
    .eq('post_url', postUrl)
    .maybeSingle();
  return !!data;
}

async function saveProspect(supabase, post, assessment) {
  const { error } = await supabase.from('outbound_prospects').insert({
    client_id:      CP_CLIENT_ID,
    source:         post.source || 'reddit',
    username:       post.author,
    post_url:       post.permalink ? `https://reddit.com${post.permalink}` : (post.post_url || ''),
    subreddit:      post.subreddit,
    post_title:     post.title,
    post_content:   post.selftext?.slice(0, 1000) || '',
    intent_score:   assessment.intent_score,
    dm_text:        assessment.dm_text,
    dm_sent:        false,
    digest_emailed: false,
  });
  if (error && !error.message?.includes('unique')) logger.warn('redditProspector', `saveProspect error: ${error.message}`);
}

// ── Digest email ──────────────────────────────────────────────────────────────
async function sendEmptyDigestEmail(overrideRecipients = null) {
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const hourET = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const slot = hourET <= 10 ? 'Morning' : 'Afternoon';
  const to = overrideRecipients || DIGEST_RECIPIENTS;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:620px;margin:0 auto;padding:24px 16px">
  <div style="background:#1e3a5f;border-radius:14px 14px 0 0;padding:20px 28px 16px;text-align:center">
    <p style="margin:0;color:rgba(255,255,255,0.5);font-size:11px;text-transform:uppercase;letter-spacing:1px">CP Cabinets & Quartz</p>
  </div>
  <div style="background:linear-gradient(135deg,#1e3a5f,#2d5a9e);border-radius:0 0 14px 14px;padding:20px 28px 24px;margin-bottom:20px;text-align:center">
    <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:11px;text-transform:uppercase;letter-spacing:1px">${date}</p>
    <h1 style="margin:0 0 6px;color:#fff;font-size:20px;font-weight:800">📋 ${slot} Scan — No New Leads</h1>
    <p style="margin:0;color:rgba(255,255,255,0.7);font-size:13px">Outreach System · Columbia, SC</p>
  </div>
  <div style="background:#fff;border-radius:12px;padding:28px;text-align:center;border:1px solid #e5e7eb">
    <p style="font-size:40px;margin:0 0 12px">🔍</p>
    <p style="font-size:16px;font-weight:700;color:#111827;margin:0 0 8px">No qualified leads found in this scan</p>
    <p style="font-size:14px;color:#6b7280;margin:0 0 20px">Reddit, forums, and listing sites were checked. No posts matched your target profile (cabinets/countertops, SC area, score 6+).</p>
    <p style="font-size:12px;color:#9ca3af;margin:0">✅ System is working normally · Next scan in ~1 hour</p>
  </div>
  <p style="text-align:center;font-size:11px;color:#9ca3af;margin-top:16px">LeadPilot Outreach · Powered by BTechSouto</p>
</div></body></html>`;
  try {
    await sendEmail({ to, subject: `[CP Cabinets] ${slot} Scan — No Leads Found · ${date}`, html });
    logger.info('redditProspector', `empty digest sent to ${Array.isArray(to) ? to.join(', ') : to}`);
  } catch (err) {
    logger.warn('redditProspector', `empty digest email failed: ${err.message}`);
  }
}

async function sendDigestEmail(prospects, overrideRecipients = null) {
  if (!prospects.length) return;
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const high   = prospects.filter(p => p.intent_score >= 8);
  const medium = prospects.filter(p => p.intent_score >= 6 && p.intent_score < 8);
  const low    = prospects.filter(p => p.intent_score < 6);

  function makeCard(p) {
    const scoreColor  = p.intent_score >= 8 ? '#16a34a' : p.intent_score >= 6 ? '#d97706' : '#6b7280';
    const scoreBg     = p.intent_score >= 8 ? '#f0fdf4' : p.intent_score >= 6 ? '#fffbeb' : '#f9fafb';
    const scoreBorder = p.intent_score >= 8 ? '#bbf7d0' : p.intent_score >= 6 ? '#fde68a' : '#e5e7eb';
    return `
    <div style="border:1px solid ${scoreBorder};border-radius:12px;padding:20px;margin-bottom:16px;background:${scoreBg}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;flex-wrap:wrap;gap:8px">
        <div>
          <span style="font-size:13px;font-weight:700;color:#1e40af">u/${p.author}</span>
          <span style="color:#6b7280;font-size:12px"> · ${p.subreddit}</span>
        </div>
        <span style="background:${scoreColor};color:#fff;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700">Intent ${p.intent_score}/10</span>
      </div>
      <p style="margin:0 0 8px;font-weight:700;color:#111827;font-size:14px">${p.post_title || p.title}</p>
      ${(p.post_content || p.selftext) ? `<p style="margin:0 0 12px;font-size:12px;color:#4b5563;font-style:italic">"${(p.post_content || p.selftext || '').slice(0, 220)}…"</p>` : ''}
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:10px">
        <p style="margin:0 0 6px;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase">Message Ready to Send</p>
        <p style="margin:0;font-size:13px;color:#1f2937;line-height:1.6;white-space:pre-line">${p.dm_text || '—'}</p>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <a href="https://leads.btechsouto.shop/dm/reddit?to=${encodeURIComponent(p.username || p.author)}&id=${p.id}&key=LP8141FEB8E1C3BD37F8615730F7F31994B7E5378F&msg=${encodeURIComponent((p.dm_text||'').slice(0,500))}"
           style="background:#ff4500;color:#fff;padding:7px 16px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:700">🚀 Send DM →</a>
        ${(p.post_url || p.permalink) ? `<a href="${p.post_url || ('https://reddit.com' + p.permalink)}" style="background:#f3f4f6;color:#374151;padding:7px 16px;border-radius:6px;text-decoration:none;font-size:12px">View Post</a>` : ''}
        <a href="${WEBSITE_URL}" style="background:#1e3a5f;color:#fff;padding:7px 16px;border-radius:6px;text-decoration:none;font-size:12px">cpcabinets.com</a>
      </div>
    </div>`;
  }

  const sectionHtml = (label, emoji, note, list) => !list.length ? '' : `
    <p style="font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin:20px 0 10px">${emoji} ${label}</p>
    ${note ? `<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px;color:#92400e">${note}</div>` : ''}
    ${list.map(makeCard).join('')}`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:620px;margin:0 auto;padding:24px 16px">

  <div style="background:#1e3a5f;border-radius:14px 14px 0 0;padding:20px 28px 16px;text-align:center">
    <p style="margin:0;color:rgba(255,255,255,0.5);font-size:11px;text-transform:uppercase;letter-spacing:1px">CP Cabinets & Quartz</p>
  </div>
  <div style="background:linear-gradient(135deg,#1e3a5f,#2d5a9e);border-radius:0 0 14px 14px;padding:20px 28px 24px;margin-bottom:20px;text-align:center">
    <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:11px;text-transform:uppercase;letter-spacing:1px">${date}</p>
    <h1 style="margin:0 0 6px;color:#fff;font-size:20px;font-weight:800">
      ${high.length ? '🎯' : medium.length ? '📋' : '🔍'} ${prospects.length} Lead${prospects.length !== 1 ? 's' : ''} for Review
    </h1>
    <p style="margin:0;color:rgba(255,255,255,0.7);font-size:13px">
      ${high.length ? `${high.length} top priority` : ''}${medium.length ? ` · ${medium.length} medium` : ''}${low.length ? ` · ${low.length} regional` : ''} · Columbia SC
    </p>
  </div>

  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px 18px;margin-bottom:20px">
    <ol style="margin:0;padding-left:18px;color:#4b5563;font-size:13px;line-height:1.9">
      <li>Review each lead — people looking for cabinets/countertops in SC/NC</li>
      <li>Click <strong>"Send on Reddit"</strong> for promising ones — message already written</li>
      <li>When they reply with contact info, Alice calls them automatically</li>
    </ol>
  </div>

  ${sectionHtml('Top Priority — Score 8+', '🎯', '', high)}
  ${sectionHtml('Worth Reviewing — Score 6-7', '📋', 'Not highly qualified (score 8+) but in the area. Sara/Eveline — review before sending DM.', medium)}
  ${sectionHtml('Regional — Evaluate', '🔍', 'Low score but in the service area. Only contact if the post clearly mentions a real project nearby.', low)}

  <p style="text-align:center;font-size:11px;color:#9ca3af;margin-top:12px;padding-top:16px;border-top:1px solid #e5e7eb">
    CP Cabinets & Quartz · Powered by BTech Outreach · Max 10 DMs/day on Reddit
  </p>
</div></body></html>`;

  const recipients = overrideRecipients || DIGEST_RECIPIENTS;
  const isLowerScore = high.length === 0;
  const subject = isLowerScore
    ? `📋 CP Cabinets Outreach — ${prospects.length} Leads for Review (${date})`
    : `🎯 ${prospects.length} Qualified Leads Ready — CP Cabinets (${date})`;

  await sendEmail({
    to:      recipients,
    subject,
    html,
    from:    'CP Cabinets Outreach <noreply@btechsouto.shop>',
  });
  logger.info('redditProspector', `digest sent: ${prospects.length} leads to ${Array.isArray(recipients) ? recipients.join(', ') : recipients}`);
}

// ── Fetch unsent from DB and send if conditions met ───────────────────────────
async function fetchAndSendDigest(supabase, { force = false, overrideRecipients = null } = {}) {
  // Fetch ALL unsent leads score 5+ — saves everything, Sara/Eveline decide what to act on
  const { data: pending, error: dbErr } = await supabase
    .from('outbound_prospects')
    .select('*')
    .eq('client_id', CP_CLIENT_ID)
    .eq('digest_emailed', false)
    .gte('intent_score', 5)
    .order('intent_score', { ascending: false });

  if (dbErr) { logger.warn('redditProspector', `DB error: ${dbErr.message}`); return; }

  const count    = pending?.length || 0;
  const hourET   = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const isWindow = SEND_HOURS_ET.includes(hourET);

  logger.info('redditProspector', `digest check: count=${count} hourET=${hourET} isWindow=${isWindow} force=${force}`);

  // Outside scheduled window: only send immediately if score 8+
  if (!force && !isWindow && count < BATCH_THRESHOLD) {
    const hasHigh = (pending || []).some(p => p.intent_score >= 8);
    if (!hasHigh) {
      logger.info('redditProspector', `${count} pending leads (no score 8+) — holding for 8h/16h ET window`);
      return;
    }
  }

  if (!count && isWindow) {
    logger.info('redditProspector', 'no leads found — sending empty digest at scheduled window');
    await sendEmptyDigestEmail(overrideRecipients);
    return;
  }

  if (!count) { logger.info('redditProspector', 'no pending leads'); return; }

  await sendDigestEmail(pending, overrideRecipients);

  if (!overrideRecipients) {
    await supabase
      .from('outbound_prospects')
      .update({ digest_emailed: true, digest_emailed_at: new Date().toISOString() })
      .in('id', pending.map(p => p.id));
    logger.info('redditProspector', `${count} leads marked as digest_emailed`);
  } else {
    logger.info('redditProspector', `test digest sent to ${overrideRecipients} — leads NOT marked as sent`);
  }
}

// ── Main cron function ────────────────────────────────────────────────────────
async function runRedditProspectorCron() {
  if (!process.env.OPENAI_API_KEY) {
    logger.warn('redditProspector', 'OPENAI_API_KEY not set — skipping');
    return;
  }

  const supabase     = getSupabase();
  const newProspects = [];
  const seen         = new Set();

  logger.info('redditProspector', 'starting hourly scrape run');

  // ── Reddit ────────────────────────────────────────────────────────────────
  for (const { sub, geo } of REDDIT_TARGETS) {
    const queries = geo
      ? BUY_KEYWORDS
      : BUY_KEYWORDS.slice(0, 5).map(k => `${k} ${GEO_SUFFIXES[Math.floor(Math.random() * GEO_SUFFIXES.length)]}`);

    for (const query of queries) {
      const posts = await fetchRSS(sub, query);
      for (const post of posts) {
        const key = `${post.author}::${post.permalink}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!isRelevant(post)) continue;
        if (!geo && !mentionsTargetArea(post)) continue;
        if (await alreadyProcessed(supabase, post.author, `https://reddit.com${post.permalink}`)) continue;

        let assessment;
        try { assessment = await assessAndGenerateDM(post); } catch (e) { logger.warn('redditProspector', `GPT error: ${e.message}`); continue; }
        logger.info('redditProspector', `r/${sub} u/${post.author} score=${assessment.intent_score}`);
        if (assessment.intent_score < 5 || assessment.in_area === false) continue;

        await saveProspect(supabase, post, assessment);
        newProspects.push({ ...post, ...assessment });
        await new Promise(r => setTimeout(r, 1000));
      }
      await new Promise(r => setTimeout(r, 600));
    }
  }

  // ── Fóruns via Google Custom Search ──────────────────────────────────────
  const forumPosts = await searchForums();
  for (const post of forumPosts) {
    const key = `forum::${post.post_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isRelevant(post)) continue;
    if (await alreadyProcessed(supabase, 'forum_user', post.post_url || '')) continue;

    let assessment;
    try { assessment = await assessAndGenerateDM(post); } catch { continue; }
    if (assessment.intent_score < 5 || assessment.in_area === false) continue;

    await saveProspect(supabase, { ...post, author: 'forum_user' }, assessment);
    newProspects.push({ ...post, ...assessment });
    await new Promise(r => setTimeout(r, 800));
  }

  // ── Craigslist ────────────────────────────────────────────────────────────
  const craigslistPosts = await searchCraigslist();
  for (const post of craigslistPosts) {
    const key = `craigslist::${post.post_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isRelevant(post)) continue;
    if (await alreadyProcessed(supabase, 'craigslist_user', post.post_url)) continue;

    let assessment;
    try { assessment = await assessAndGenerateDM(post); } catch { continue; }
    if (assessment.intent_score < 5 || assessment.in_area === false) continue;

    await saveProspect(supabase, { ...post, author: 'craigslist_user' }, assessment);
    newProspects.push({ ...post, ...assessment });
    await new Promise(r => setTimeout(r, 800));
  }

  logger.info('redditProspector', `scrape done — ${newProspects.length} new prospects this run`);

  await fetchAndSendDigest(supabase);
}

async function runRedditProspectorTest(overrideRecipients) {
  const supabase = getSupabase();
  await runRedditProspectorCron();
  // Also force-send any pending that weren't sent yet
  await fetchAndSendDigest(supabase, { force: true, overrideRecipients });
}

async function sendPendingDigest(overrideRecipients = null) {
  const supabase = getSupabase();
  await fetchAndSendDigest(supabase, { force: true, overrideRecipients });
}

module.exports = { runRedditProspectorCron, runRedditProspectorTest, sendPendingDigest };

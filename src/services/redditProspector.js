/**
 * Web Miner — multi-client lead mining (Reddit, forums, Craigslist)
 * Config por cliente na tabela prospector_configs.
 * Cron horário. Digest nos horários configurados por cliente (padrão: 8h e 16h ET).
 */

const { createClient } = require('@supabase/supabase-js');
const { sendEmail }    = require('./gmail');
const logger           = require('../utils/logger');

const SUPA_URL = 'https://pvphgusjofufwtyiyviu.supabase.co';
const SUPA_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2cGhndXNqb2Z1Znd0eWl5dml1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyNjkwODYsImV4cCI6MjA5MDg0NTA4Nn0.0aA8YNmhVusNuBjWZoEZW50dTRZWowm9AoNVoyGCXBM';

function getSupabase() {
  return createClient(SUPA_URL, SUPA_KEY);
}

// ── Load configs ──────────────────────────────────────────────────────────────
async function loadActiveConfigs(supabase) {
  const { data, error } = await supabase
    .from('prospector_configs')
    .select('*, clients(id, business_name)')
    .eq('active', true);
  if (error) {
    logger.warn('webMiner', `loadActiveConfigs error: ${error.message}`);
    return [];
  }
  return data || [];
}

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

async function searchGoogleCSE(queries, source, authorPrefix) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx     = process.env.GOOGLE_SEARCH_CX;
  if (!apiKey || !cx || !queries?.length) return [];
  const results = [];
  for (const q of queries) {
    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(q)}&num=5&dateRestrict=m1`;
      const res  = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of (data.items || [])) {
        let host = '';
        try { host = new URL(item.link).hostname.replace('www.', ''); } catch { host = source; }
        results.push({
          author: authorPrefix, source,
          title: item.title.replace(/ [|–\-] .*$/, '').trim(),
          selftext: item.snippet || '',
          permalink: '', post_url: item.link,
          subreddit: `${source}-${host}`,
          created_utc: Date.now() / 1000 - 86400,
        });
      }
      await new Promise(r => setTimeout(r, 500));
    } catch { /* continue */ }
  }
  return results;
}

async function searchForums(config) {
  return searchGoogleCSE(config.forum_searches || [], 'forum', 'forum_user');
}

async function searchRealEstate(config) {
  return searchGoogleCSE(config.real_estate_searches || [], 'real_estate', 're_user');
}

async function searchInstagram(config) {
  return searchGoogleCSE(config.instagram_keywords || [], 'instagram', 'ig_user');
}

async function searchPinterest(config) {
  return searchGoogleCSE(config.pinterest_keywords || [], 'pinterest', 'pin_user');
}

async function searchCraigslist(config) {
  const cities   = config.craigslist_cities || [];
  const keywords = (config.buy_keywords || []).slice(0, 5);
  if (!cities.length || !keywords.length) return [];
  const results = [];
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
function isRelevant(post, config) {
  const text = `${post.title} ${post.selftext}`.toLowerCase();
  if ((config.discard_keywords || []).some(k => text.includes(k))) return false;
  if (post.title.length < 15) return false;
  if ((Date.now() / 1000 - post.created_utc) / 86400 > 30) return false;
  if (post.author === '[deleted]') return false;
  return true;
}

function mentionsTargetArea(post, config) {
  const text = `${post.title} ${post.selftext}`.toLowerCase();
  return (config.target_cities || []).some(c => text.includes(c));
}

// ── GPT Qualify ───────────────────────────────────────────────────────────────
async function assessAndGenerateDM(post, config) {
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const postText   = `${post.title}\n${post.selftext}`.slice(0, 700);
  const catalogUrl = config.catalog_url || config.website_url || '';
  const source     = post.source || 'reddit';
  const isInstagram = source === 'instagram';
  const isPinterest = source === 'pinterest';

  const prompt = `You find leads for a business. Business description:
${config.business_description}

Post from ${post.subreddit} (source: ${source}):
"${postText}"

Score purchase intent 1-10. Score 8-10 = complete project, right area, right scope. Score 5-7 = possible lead worth reviewing. Below 5 = discard.

If score >= 5 AND in_area is true or unknown, write a short natural outreach message (3-4 sentences) that:
- References something specific from their post
- Mentions the business and their specialty
- Offers a FREE estimate or consultation, no obligation
${catalogUrl ? `- Naturally mention they can see our portfolio/products at: ${catalogUrl}` : ''}
${isInstagram || isPinterest ? '- Tone: friendly comment or message (not a sales pitch), sounds like a real person discovering their post' : '- No emojis, no corporate tone, sounds like a real person'}

Respond ONLY with JSON:
{"intent_score":<1-10>,"in_area":<true/false/unknown>,"worth_contacting":<true/false>,"reason":"<1 sentence>","dm_text":"<message or null>"}`;

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

async function saveProspect(supabase, post, assessment, clientId) {
  const { error } = await supabase.from('outbound_prospects').insert({
    client_id:      clientId,
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
  if (error && !error.message?.includes('unique')) {
    logger.warn('webMiner', `saveProspect error: ${error.message}`);
  }
}

// ── Digest emails ─────────────────────────────────────────────────────────────
function businessLabel(config) {
  return config.clients?.business_name || 'LeadPilot';
}

async function sendEmptyDigestEmail(config, overrideRecipients) {
  const name   = businessLabel(config);
  const date   = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const hourET = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const slot   = hourET <= 10 ? 'Morning' : 'Afternoon';
  const to     = overrideRecipients || config.digest_recipients;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:620px;margin:0 auto;padding:24px 16px">
  <div style="background:#1e3a5f;border-radius:14px 14px 0 0;padding:20px 28px 16px;text-align:center">
    <p style="margin:0;color:rgba(255,255,255,0.5);font-size:11px;text-transform:uppercase;letter-spacing:1px">${name}</p>
  </div>
  <div style="background:linear-gradient(135deg,#1e3a5f,#2d5a9e);border-radius:0 0 14px 14px;padding:20px 28px 24px;margin-bottom:20px;text-align:center">
    <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:11px;text-transform:uppercase;letter-spacing:1px">${date}</p>
    <h1 style="margin:0 0 6px;color:#fff;font-size:20px;font-weight:800">📋 ${slot} Scan — No New Leads</h1>
    <p style="margin:0;color:rgba(255,255,255,0.7);font-size:13px">Outreach System</p>
  </div>
  <div style="background:#fff;border-radius:12px;padding:28px;text-align:center;border:1px solid #e5e7eb">
    <p style="font-size:40px;margin:0 0 12px">🔍</p>
    <p style="font-size:16px;font-weight:700;color:#111827;margin:0 0 8px">No qualified leads found in this scan</p>
    <p style="font-size:14px;color:#6b7280;margin:0 0 20px">Reddit, forums, and listing sites were checked. No posts matched your target profile.</p>
    <p style="font-size:12px;color:#9ca3af;margin:0">✅ System is working normally · Next scan in ~1 hour</p>
  </div>
  <p style="text-align:center;font-size:11px;color:#9ca3af;margin-top:16px">LeadPilot Outreach · Powered by BTechSouto</p>
</div></body></html>`;

  try {
    await sendEmail({ to, subject: `[${name}] ${slot} Scan — No Leads Found · ${date}`, html });
    logger.info('webMiner', `[${name}] empty digest sent`);
  } catch (err) {
    logger.warn('webMiner', `[${name}] empty digest failed: ${err.message}`);
  }
}

async function sendDigestEmail(prospects, config, overrideRecipients) {
  if (!prospects.length) return;
  const name       = businessLabel(config);
  const websiteUrl = config.website_url || '';
  const date       = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const high   = prospects.filter(p => p.intent_score >= 8);
  const medium = prospects.filter(p => p.intent_score >= 6 && p.intent_score < 8);
  const low    = prospects.filter(p => p.intent_score < 6);
  const to     = overrideRecipients || config.digest_recipients;

  function makeCard(p) {
    const scoreColor  = p.intent_score >= 8 ? '#16a34a' : p.intent_score >= 6 ? '#d97706' : '#6b7280';
    const scoreBg     = p.intent_score >= 8 ? '#f0fdf4' : p.intent_score >= 6 ? '#fffbeb' : '#f9fafb';
    const scoreBorder = p.intent_score >= 8 ? '#bbf7d0' : p.intent_score >= 6 ? '#fde68a' : '#e5e7eb';
    const username    = p.username || p.author || '';
    const postUrl     = p.post_url || (p.permalink ? `https://reddit.com${p.permalink}` : '');
    const dmLink      = `https://leads.btechsouto.shop/dm/reddit?to=${encodeURIComponent(username)}&id=${p.id}&key=LP8141FEB8E1C3BD37F8615730F7F31994B7E5378F&msg=${encodeURIComponent((p.dm_text||'').slice(0,500))}`;
    const srcIcons    = { reddit: '🟠 Reddit', forum: '💬 Forum', craigslist: '📋 Craigslist', real_estate: '🏠 Imóvel Vendido', instagram: '📸 Instagram', pinterest: '📌 Pinterest' };
    const srcLabel    = srcIcons[p.source] || p.source || '🟠 Reddit';
    return `
    <div style="border:1px solid ${scoreBorder};border-radius:12px;padding:20px;margin-bottom:16px;background:${scoreBg}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;flex-wrap:wrap;gap:8px">
        <div>
          <span style="font-size:12px;font-weight:700;color:#6b7280">${srcLabel}</span>
          <span style="color:#9ca3af;font-size:12px"> · ${p.subreddit || ''}</span>
        </div>
        <span style="background:${scoreColor};color:#fff;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700">Intent ${p.intent_score}/10</span>
      </div>
      <p style="margin:0 0 8px;font-weight:700;color:#111827;font-size:14px">${(p.post_title || p.title || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
      ${(p.post_content || p.selftext) ? `<p style="margin:0 0 12px;font-size:12px;color:#4b5563;font-style:italic">"${(p.post_content || p.selftext || '').slice(0,220).replace(/</g,'&lt;')}…"</p>` : ''}
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:10px">
        <p style="margin:0 0 6px;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase">Message Ready to Send</p>
        <p style="margin:0;font-size:13px;color:#1f2937;line-height:1.6;white-space:pre-line">${(p.dm_text || '—').replace(/</g,'&lt;')}</p>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <a href="${dmLink}" style="background:#ff4500;color:#fff;padding:7px 16px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:700">🚀 Send DM →</a>
        ${postUrl ? `<a href="${postUrl}" style="background:#f3f4f6;color:#374151;padding:7px 16px;border-radius:6px;text-decoration:none;font-size:12px">View Post</a>` : ''}
        ${websiteUrl ? `<a href="${websiteUrl}" style="background:#1e3a5f;color:#fff;padding:7px 16px;border-radius:6px;text-decoration:none;font-size:12px">${websiteUrl.replace('https://','')}</a>` : ''}
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
    <p style="margin:0;color:rgba(255,255,255,0.5);font-size:11px;text-transform:uppercase;letter-spacing:1px">${name}</p>
  </div>
  <div style="background:linear-gradient(135deg,#1e3a5f,#2d5a9e);border-radius:0 0 14px 14px;padding:20px 28px 24px;margin-bottom:20px;text-align:center">
    <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:11px;text-transform:uppercase;letter-spacing:1px">${date}</p>
    <h1 style="margin:0 0 6px;color:#fff;font-size:20px;font-weight:800">
      ${high.length ? '🎯' : medium.length ? '📋' : '🔍'} ${prospects.length} Lead${prospects.length !== 1 ? 's' : ''} for Review
    </h1>
    <p style="margin:0;color:rgba(255,255,255,0.7);font-size:13px">
      ${[high.length && `${high.length} top priority`, medium.length && `${medium.length} medium`, low.length && `${low.length} regional`].filter(Boolean).join(' · ')}
    </p>
  </div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px 18px;margin-bottom:20px">
    <ol style="margin:0;padding-left:18px;color:#4b5563;font-size:13px;line-height:1.9">
      <li>Review each lead — people looking for your services in the target area</li>
      <li>Click <strong>"Send DM"</strong> for promising ones — message already written</li>
      <li>When they reply with contact info, Alice calls automatically</li>
    </ol>
  </div>
  ${sectionHtml('Top Priority — Score 8+', '🎯', '', high)}
  ${sectionHtml('Worth Reviewing — Score 6-7', '📋', 'Not highly qualified but in the area. Review before sending DM.', medium)}
  ${sectionHtml('Regional — Evaluate', '🔍', 'Low score but in the service area. Only contact if the post clearly mentions a real project nearby.', low)}
  <p style="text-align:center;font-size:11px;color:#9ca3af;margin-top:12px;padding-top:16px;border-top:1px solid #e5e7eb">
    ${name} · Powered by LeadPilot Outreach · Max 10 DMs/day on Reddit
  </p>
</div></body></html>`;

  const subject = high.length === 0
    ? `📋 ${name} Outreach — ${prospects.length} Leads for Review (${date})`
    : `🎯 ${prospects.length} Qualified Leads Ready — ${name} (${date})`;

  await sendEmail({ to, subject, html, from: `${name} Outreach <noreply@btechsouto.shop>` });
  logger.info('webMiner', `[${name}] digest sent: ${prospects.length} leads`);
}

// ── Fetch unsent and send digest ──────────────────────────────────────────────
async function fetchAndSendDigest(supabase, config, { force = false, overrideRecipients = null } = {}) {
  const { data: pending, error } = await supabase
    .from('outbound_prospects')
    .select('*')
    .eq('client_id', config.client_id)
    .eq('digest_emailed', false)
    .gte('intent_score', 5)
    .order('intent_score', { ascending: false });

  if (error) { logger.warn('webMiner', `DB error: ${error.message}`); return; }

  const count     = pending?.length || 0;
  const hourET    = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const sendHours = config.digest_hours_et || [8, 16];
  const isWindow  = sendHours.includes(hourET);
  const name      = businessLabel(config);

  logger.info('webMiner', `[${name}] digest check: count=${count} hourET=${hourET} isWindow=${isWindow} force=${force}`);

  // Always send if there are pending leads — no window restriction
  if (!count) {
    if (isWindow) await sendEmptyDigestEmail(config, overrideRecipients);
    else logger.info('webMiner', `[${name}] no pending leads`);
    return;
  }

  await sendDigestEmail(pending, config, overrideRecipients);

  if (!overrideRecipients) {
    await supabase
      .from('outbound_prospects')
      .update({ digest_emailed: true, digest_emailed_at: new Date().toISOString() })
      .in('id', pending.map(p => p.id));
    logger.info('webMiner', `[${name}] ${count} leads marked as digest_emailed`);
  }
}

// ── Scrape for a single client ────────────────────────────────────────────────
async function scrapeForClient(supabase, config) {
  const name          = businessLabel(config);
  const newProspects  = [];
  const seen          = new Set();
  const redditTargets = config.reddit_subreddits || [];
  const buyKeywords   = config.buy_keywords || [];
  const geoSuffixes   = (config.target_cities || []).slice(0, 5).filter(Boolean);

  logger.info('webMiner', `[${name}] starting scrape`);

  // ── Reddit ────────────────────────────────────────────────────────────────
  for (const { sub, geo } of redditTargets) {
    const queries = geo
      ? buyKeywords
      : buyKeywords.slice(0, 5).map(k => `${k} ${geoSuffixes[Math.floor(Math.random() * Math.max(geoSuffixes.length, 1))] || ''}`);

    for (const query of queries) {
      const posts = await fetchRSS(sub, query);
      for (const post of posts) {
        const key = `${post.author}::${post.permalink}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!isRelevant(post, config)) continue;
        if (!geo && !mentionsTargetArea(post, config)) continue;
        if (await alreadyProcessed(supabase, post.author, `https://reddit.com${post.permalink}`)) continue;

        let assessment;
        try { assessment = await assessAndGenerateDM(post, config); } catch (e) {
          logger.warn('webMiner', `[${name}] GPT error: ${e.message}`); continue;
        }
        logger.info('webMiner', `[${name}] r/${sub} u/${post.author} score=${assessment.intent_score}`);
        if (assessment.intent_score < 5 || assessment.in_area === false) continue;

        await saveProspect(supabase, post, assessment, config.client_id);
        newProspects.push({ ...post, ...assessment });
        await new Promise(r => setTimeout(r, 1000));
      }
      await new Promise(r => setTimeout(r, 600));
    }
  }

  // ── Forums via Google Custom Search ──────────────────────────────────────
  const forumPosts = await searchForums(config);
  for (const post of forumPosts) {
    const key = `forum::${post.post_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isRelevant(post, config)) continue;
    if (await alreadyProcessed(supabase, 'forum_user', post.post_url || '')) continue;

    let assessment;
    try { assessment = await assessAndGenerateDM(post, config); } catch { continue; }
    if (assessment.intent_score < 5 || assessment.in_area === false) continue;

    await saveProspect(supabase, { ...post, author: 'forum_user' }, assessment, config.client_id);
    newProspects.push({ ...post, ...assessment });
    await new Promise(r => setTimeout(r, 800));
  }

  // ── Craigslist ────────────────────────────────────────────────────────────
  const clPosts = await searchCraigslist(config);
  for (const post of clPosts) {
    const key = `craigslist::${post.post_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isRelevant(post, config)) continue;
    if (await alreadyProcessed(supabase, 'craigslist_user', post.post_url)) continue;

    let assessment;
    try { assessment = await assessAndGenerateDM(post, config); } catch { continue; }
    if (assessment.intent_score < 5 || assessment.in_area === false) continue;

    await saveProspect(supabase, { ...post, author: 'craigslist_user' }, assessment, config.client_id);
    newProspects.push({ ...post, ...assessment });
    await new Promise(r => setTimeout(r, 800));
  }

  // ── Real Estate (novos donos de imóvel / new construction) ──────────────
  const rePosts = await searchRealEstate(config);
  for (const post of rePosts) {
    const key = `re::${post.post_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isRelevant(post, config)) continue;
    if (await alreadyProcessed(supabase, 're_user', post.post_url || '')) continue;
    let assessment;
    try { assessment = await assessAndGenerateDM(post, config); } catch { continue; }
    if (assessment.intent_score < 5 || assessment.in_area === false) continue;
    await saveProspect(supabase, { ...post, author: 're_user' }, assessment, config.client_id);
    newProspects.push({ ...post, ...assessment });
    await new Promise(r => setTimeout(r, 800));
  }

  // ── Instagram geo (novos donos postando reformas na área) ─────────────
  const igPosts = await searchInstagram(config);
  for (const post of igPosts) {
    const key = `ig::${post.post_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isRelevant(post, config)) continue;
    if (await alreadyProcessed(supabase, 'ig_user', post.post_url || '')) continue;
    let assessment;
    try { assessment = await assessAndGenerateDM(post, config); } catch { continue; }
    if (assessment.intent_score < 5 || assessment.in_area === false) continue;
    await saveProspect(supabase, { ...post, author: 'ig_user' }, assessment, config.client_id);
    newProspects.push({ ...post, ...assessment });
    await new Promise(r => setTimeout(r, 800));
  }

  // ── Pinterest (boards de inspiração para reforma) ─────────────────────
  const pinPosts = await searchPinterest(config);
  for (const post of pinPosts) {
    const key = `pin::${post.post_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isRelevant(post, config)) continue;
    if (await alreadyProcessed(supabase, 'pin_user', post.post_url || '')) continue;
    let assessment;
    try { assessment = await assessAndGenerateDM(post, config); } catch { continue; }
    if (assessment.intent_score < 5 || assessment.in_area === false) continue;
    await saveProspect(supabase, { ...post, author: 'pin_user' }, assessment, config.client_id);
    newProspects.push({ ...post, ...assessment });
    await new Promise(r => setTimeout(r, 800));
  }

  logger.info('webMiner', `[${name}] done — ${newProspects.length} new prospects`);
  return newProspects;
}

// ── Main cron ─────────────────────────────────────────────────────────────────
async function runRedditProspectorCron() {
  if (!process.env.OPENAI_API_KEY) {
    logger.warn('webMiner', 'OPENAI_API_KEY not set — skipping');
    return;
  }

  const supabase = getSupabase();
  const configs  = await loadActiveConfigs(supabase);

  if (!configs.length) {
    logger.warn('webMiner', 'no active prospector configs found — run migration SQL in Supabase');
    return;
  }

  logger.info('webMiner', `running for ${configs.length} client(s)`);

  for (const config of configs) {
    try {
      await scrapeForClient(supabase, config);
      await fetchAndSendDigest(supabase, config);
    } catch (err) {
      logger.warn('webMiner', `error for client ${config.client_id}: ${err.message}`);
    }
  }
}

// ── Test / manual triggers ────────────────────────────────────────────────────
async function runRedditProspectorTest(overrideRecipients) {
  const supabase = getSupabase();
  const configs  = await loadActiveConfigs(supabase);
  for (const config of configs) {
    try {
      await scrapeForClient(supabase, config);
      await fetchAndSendDigest(supabase, config, { force: true, overrideRecipients });
    } catch (err) {
      logger.warn('webMiner', `test error for ${config.client_id}: ${err.message}`);
    }
  }
}

async function sendPendingDigest(overrideRecipients = null) {
  const supabase = getSupabase();
  const configs  = await loadActiveConfigs(supabase);
  for (const config of configs) {
    try {
      await fetchAndSendDigest(supabase, config, { force: true, overrideRecipients });
    } catch (err) {
      logger.warn('webMiner', `sendPendingDigest error for ${config.client_id}: ${err.message}`);
    }
  }
}

module.exports = { runRedditProspectorCron, runRedditProspectorTest, sendPendingDigest };

const { sendEmail } = require('./gmail');
const logger = require('../utils/logger');
const { createClient } = require('@supabase/supabase-js');

const PLACES_KEY  = process.env.GOOGLE_PLACES_API_KEY;
const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

async function searchCompetitors(keyword, zipCode) {
  const query = `${keyword} near ${zipCode}`;
  const url = `${PLACES_BASE}/textsearch/json?query=${encodeURIComponent(query)}&key=${PLACES_KEY}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    logger.warn('competitorIntel', `Places textsearch error: ${data.status} — ${data.error_message || ''}`);
    return [];
  }
  return (data.results || []).slice(0, 10);
}

async function getPlaceDetails(placeId) {
  const fields = 'name,rating,user_ratings_total,price_level,reviews,formatted_address,website';
  const url    = `${PLACES_BASE}/details/json?place_id=${placeId}&fields=${fields}&key=${PLACES_KEY}`;
  const res    = await fetch(url);
  const data   = await res.json();
  return data.result || null;
}

async function generateReport(competitors, clientName) {
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const payload = competitors.map(c => ({
    name:          c.name,
    rating:        c.rating,
    totalReviews:  c.user_ratings_total,
    priceLevel:    c.price_level ? '$'.repeat(c.price_level) : 'unknown',
    address:       c.formatted_address,
    negativeReviews: (c.reviews || [])
      .filter(r => r.rating <= 2)
      .map(r => ({ stars: r.rating, text: (r.text || '').slice(0, 350) })),
  }));

  const prompt = `You are a competitive intelligence analyst for ${clientName}, a cabinet and countertop company.

Here are local competitors from Google Maps:
${JSON.stringify(payload, null, 2)}

Write a concise report (under 450 words) with:
1. **Market Overview** — competitor count, average ratings, pricing tiers
2. **Top Weaknesses** — patterns in negative reviews (delays, quality, communication, pricing)
3. **Opportunities for ${clientName}** — specific gaps to exploit based on competitor failures
4. **Alice's Talking Points** — 3-4 bullet points for when leads mention competitors

Be direct and actionable. Use markdown headers.`;

  const result = await openai.chat.completions.create({
    model:       'gpt-4o-mini',
    messages:    [{ role: 'user', content: prompt }],
    temperature: 0.4,
    max_tokens:  700,
  });

  return result.choices[0].message.content;
}

function mdToHtml(md) {
  return md
    .replace(/^## (.+)$/gm, '<h3 style="color:#1e3a5f;margin:20px 0 8px;font-size:15px">$1</h3>')
    .replace(/^### (.+)$/gm, '<h4 style="color:#374151;margin:14px 0 6px;font-size:14px">$1</h4>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '<li style="margin:4px 0;color:#374151;font-size:13px">$1</li>')
    .replace(/(<li[^>]*>[\s\S]*?<\/li>)+/g, m => `<ul style="margin:8px 0;padding-left:18px">${m}</ul>`)
    .replace(/\n\n+/g, '</p><p style="color:#374151;line-height:1.7;margin:0 0 12px;font-size:13px">')
    .replace(/\n/g, '<br>');
}

async function runCompetitorIntelCron() {
  if (!PLACES_KEY) {
    logger.warn('competitorIntel', 'GOOGLE_PLACES_API_KEY not set — skipping');
    return;
  }

  const supabase = createClient(
    process.env.SUPABASE_URL || 'https://pvphgusjofufwtyiyviu.supabase.co',
    process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY
  );

  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, business_name, zip_code, competitor_keywords, owner_email, secondary_email')
    .eq('active', true)
    .not('zip_code', 'is', null);

  if (error) { logger.warn('competitorIntel', `DB error: ${error.message}`); return; }
  if (!clients?.length) { logger.info('competitorIntel', 'no clients with zip_code'); return; }

  for (const client of clients) {
    try {
      const keywords = client.competitor_keywords?.length
        ? client.competitor_keywords
        : ['cabinet contractor', 'kitchen remodeling'];

      logger.info('competitorIntel', `processing ${client.business_name} (${client.zip_code})`);

      const competitors = [];
      for (const keyword of keywords.slice(0, 2)) {
        const results = await searchCompetitors(keyword, client.zip_code);
        for (const place of results) {
          if (competitors.some(c => c.place_id === place.place_id)) continue;
          const details = await getPlaceDetails(place.place_id);
          if (details && details.name !== client.business_name) {
            competitors.push({ ...details, place_id: place.place_id });
          }
          await new Promise(r => setTimeout(r, 300));
        }
        await new Promise(r => setTimeout(r, 500));
      }

      if (!competitors.length) {
        logger.info('competitorIntel', `no competitors found for ${client.business_name}`);
        continue;
      }

      const report      = await generateReport(competitors, client.business_name);
      const negCount    = competitors.reduce((n, c) => n + (c.reviews || []).filter(r => r.rating <= 2).length, 0);
      const avgRating   = (competitors.reduce((s, c) => s + (c.rating || 0), 0) / competitors.length).toFixed(1);
      const date        = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

      const negReviewCards = competitors
        .filter(c => (c.reviews || []).some(r => r.rating <= 2))
        .map(c => {
          const neg = (c.reviews || []).filter(r => r.rating <= 2);
          return `
          <div style="border-left:3px solid #f59e0b;background:#fffbeb;border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:10px">
            <p style="margin:0 0 8px;font-weight:700;color:#92400e;font-size:12px;text-transform:uppercase">${c.name} · ⭐${c.rating} (${c.user_ratings_total || 0} reviews)</p>
            ${neg.map(r => `<p style="margin:0 0 6px;font-size:12px;color:#78350f;font-style:italic">${'⭐'.repeat(r.stars || r.rating)} "${(r.text || '').slice(0, 280)}${(r.text || '').length > 280 ? '…' : ''}"</p>`).join('')}
          </div>`;
        }).join('');

      const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">

  <div style="background:#1e3a5f;border-radius:12px 12px 0 0;padding:28px 32px;text-align:center">
    <p style="margin:0 0 4px;color:rgba(255,255,255,0.55);font-size:11px;text-transform:uppercase;letter-spacing:1px">Weekly Intelligence · ${date}</p>
    <h1 style="margin:0 0 4px;color:#fff;font-size:22px;font-weight:800">Competitor Intel Report</h1>
    <p style="margin:0;color:rgba(255,255,255,0.7);font-size:13px">${client.business_name} · ZIP ${client.zip_code}</p>
  </div>

  <div style="background:#fff;padding:24px 28px;border:1px solid #e5e7eb;border-top:none">
    <div style="display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap">
      <div style="flex:1;background:#f0f7ff;border-radius:8px;padding:14px;text-align:center;min-width:110px">
        <p style="margin:0;font-size:26px;font-weight:800;color:#1e3a5f">${competitors.length}</p>
        <p style="margin:2px 0 0;font-size:11px;color:#6b7280">Competitors</p>
      </div>
      <div style="flex:1;background:#fff7ed;border-radius:8px;padding:14px;text-align:center;min-width:110px">
        <p style="margin:0;font-size:26px;font-weight:800;color:#ea580c">${negCount}</p>
        <p style="margin:2px 0 0;font-size:11px;color:#6b7280">Negative Reviews</p>
      </div>
      <div style="flex:1;background:#f0fdf4;border-radius:8px;padding:14px;text-align:center;min-width:110px">
        <p style="margin:0;font-size:26px;font-weight:800;color:#16a34a">${avgRating}★</p>
        <p style="margin:2px 0 0;font-size:11px;color:#6b7280">Avg Competitor Rating</p>
      </div>
    </div>

    <div style="font-size:13px;line-height:1.7;color:#374151">
      <p style="color:#374151;line-height:1.7;margin:0 0 12px;font-size:13px">${mdToHtml(report)}</p>
    </div>

    ${negReviewCards ? `
    <div style="margin-top:24px;border-top:1px solid #f3f4f6;padding-top:20px">
      <p style="margin:0 0 12px;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px">Raw Negative Reviews</p>
      ${negReviewCards}
    </div>` : ''}
  </div>

  <p style="text-align:center;font-size:11px;color:#9ca3af;margin:16px 0 0">LeadPilot · Competitive Intelligence · Powered by Google Places + GPT</p>
</div>
</body></html>`;

      const recipients = [client.owner_email, client.secondary_email].filter(Boolean);
      for (const to of recipients) {
        await sendEmail({
          to,
          subject: `🎯 Competitor Intel — ${client.business_name} (${date})`,
          html,
        });
        logger.info('competitorIntel', `report sent to ${to}`);
      }
    } catch (err) {
      logger.warn('competitorIntel', `failed for ${client.business_name}: ${err.message}`);
    }
  }
}

module.exports = { runCompetitorIntelCron };

const { createClient } = require('@supabase/supabase-js');
const { sendEmail }    = require('./gmail');
const logger           = require('../utils/logger');

const SUPA_URL = 'https://pvphgusjofufwtyiyviu.supabase.co';
const SUPA_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2cGhndXNqb2Z1Znd0eWl5dml1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyNjkwODYsImV4cCI6MjA5MDg0NTA4Nn0.0aA8YNmhVusNuBjWZoEZW50dTRZWowm9AoNVoyGCXBM';

function extractZip(address) {
  const match = (address || '').match(/\b(\d{5})(?:-\d{4})?\b/);
  return match ? match[1] : null;
}

async function sendVipAlert({ conv, config, zip }) {
  const bizName    = config.clients?.business_name || 'LeadPilot';
  const catalogUrl = config.catalog_url || '';
  const minValue   = config.high_value_zip_min_value || 30000;
  const recipients = config.digest_recipients || [];
  if (!recipients.length) return;

  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York',
  });
  const timeET = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York',
  });

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f3ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">

  <div style="background:linear-gradient(135deg,#7c3aed,#4338ca);border-radius:16px;padding:32px;text-align:center;margin-bottom:20px">
    <p style="margin:0 0 8px;color:rgba(255,255,255,0.55);font-size:11px;text-transform:uppercase;letter-spacing:1.5px">${bizName} · ${date} ${timeET} ET</p>
    <h1 style="margin:0 0 10px;color:#fff;font-size:28px;font-weight:900">💎 VIP LEAD ALERT</h1>
    <div style="display:inline-block;background:rgba(255,255,255,0.18);padding:6px 18px;border-radius:20px">
      <p style="margin:0;color:#fff;font-size:14px;font-weight:700">Premium Area · ZIP ${zip}</p>
    </div>
  </div>

  <div style="background:#fff;border-radius:12px;padding:24px;border:2px solid #7c3aed;margin-bottom:16px">
    <p style="margin:0 0 12px;font-size:11px;font-weight:800;color:#7c3aed;text-transform:uppercase;letter-spacing:0.5px">Lead Info</p>
    <p style="margin:0 0 6px;font-size:20px;font-weight:900;color:#111827">${conv.lead_name || 'New Lead'}</p>
    <p style="margin:0 0 4px;font-size:15px;color:#374151">📞 <strong>${conv.lead_phone || '—'}</strong></p>
    ${conv.lead_email ? `<p style="margin:0 0 4px;font-size:14px;color:#374151">✉️ ${conv.lead_email}</p>` : ''}
    ${conv.lead_address ? `<p style="margin:0 0 4px;font-size:14px;color:#374151">📍 ${conv.lead_address}</p>` : ''}
    ${conv.service_type ? `<p style="margin:0;font-size:14px;color:#6b7280">Service: ${conv.service_type}</p>` : ''}
  </div>

  <div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:12px;padding:20px;margin-bottom:16px">
    <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#6d28d9">Why this is a VIP lead:</p>
    <ul style="margin:0;padding-left:20px;color:#374151;font-size:13px;line-height:2">
      <li>ZIP <strong>${zip}</strong> is a <strong>premium residential area</strong> in your service zone</li>
      <li>Estimated project value: <strong>$${minValue.toLocaleString()}–$90,000+</strong></li>
      <li>High-income profile → premium materials, less price sensitivity</li>
      <li>Contact <strong>immediately</strong> — offer a private in-home design session</li>
    </ul>
  </div>

  ${catalogUrl ? `
  <div style="text-align:center;margin-bottom:16px">
    <p style="margin:0 0 10px;font-size:14px;font-weight:700;color:#111827">Send them the premium catalog during your call:</p>
    <a href="${catalogUrl}" style="background:#7c3aed;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:800;display:inline-block">Open Catalog →</a>
  </div>` : ''}

  <p style="text-align:center;font-size:11px;color:#9ca3af;margin-top:16px">LeadPilot · VIP Area Detector · ${bizName}</p>
</div></body></html>`;

  const subject = `💎 VIP Lead · ZIP ${zip} Premium Area · ${conv.lead_name || 'New Lead'} · ${date}`;
  for (const to of recipients) {
    try {
      await sendEmail({ to, subject, html });
      logger.info('zipQualifier', `VIP alert → ${to} conv=${conv.id} zip=${zip}`);
    } catch (err) {
      logger.warn('zipQualifier', `VIP alert failed for ${to}: ${err.message}`);
    }
  }
}

async function triggerZipQualifier(convId, clientId, address) {
  const zip = extractZip(address);
  if (!zip) return;

  try {
    const supabase = createClient(SUPA_URL, SUPA_KEY);

    const { data: config } = await supabase
      .from('prospector_configs')
      .select('*, clients(id, business_name)')
      .eq('client_id', clientId)
      .maybeSingle();

    if (!config?.high_value_zips?.includes(zip)) return;

    logger.info('zipQualifier', `VIP ZIP detected: ${zip} for client=${clientId} conv=${convId}`);

    const { data: conv } = await supabase
      .from('conversations')
      .select('id, lead_name, lead_phone, lead_email, lead_address, service_type')
      .eq('id', convId)
      .maybeSingle();

    if (!conv) return;

    await supabase
      .from('conversations')
      .update({ score: 10, vip_area: true })
      .eq('id', convId);

    await sendVipAlert({ conv: { ...conv, lead_address: address }, config, zip });
  } catch (err) {
    logger.warn('zipQualifier', `error: ${err.message}`);
  }
}

module.exports = { triggerZipQualifier, extractZip };

const db        = require('./supabase');
const { sendEmail } = require('./gmail');
const logger     = require('../utils/logger');

const BASE_URL   = process.env.BASE_URL || 'https://leads.btechsouto.shop';

// ── EMAIL TEMPLATES ───────────────────────────────────────────────────────────

function emailStyle() {
  return `
    <style>
      body { margin:0; padding:0; background:#f5f4f1; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
      .wrap { max-width:600px; margin:0 auto; background:#fff; }
      .header { background:#1a1a2e; padding:28px 32px; text-align:center; }
      .header h1 { color:#fff; font-size:20px; margin:0 0 4px; letter-spacing:0.04em; }
      .header p  { color:#c9a84c; font-size:12px; margin:0; letter-spacing:0.08em; text-transform:uppercase; }
      .hero { background:linear-gradient(135deg,#1a1a2e,#2d2d4e); padding:40px 32px; text-align:center; }
      .hero h2 { color:#fff; font-size:22px; margin:0 0 10px; }
      .hero p  { color:#c9a84ccc; font-size:14px; margin:0; }
      .body { padding:32px; }
      .body p { color:#444; font-size:15px; line-height:1.7; margin:0 0 16px; }
      .collections { display:block; margin:24px 0; }
      .col-item { border:1px solid #eee; border-radius:12px; margin-bottom:16px; overflow:hidden; }
      .col-img { width:100%; height:200px; object-fit:cover; display:block; }
      .col-body { padding:16px 20px; }
      .col-body h3 { color:#1a1a2e; font-size:16px; margin:0 0 6px; }
      .col-body p  { color:#666; font-size:13px; margin:0 0 8px; line-height:1.6; }
      .col-body .colors { font-size:12px; color:#999; }
      .cta-block { text-align:center; margin:32px 0; }
      .cta { display:inline-block; background:linear-gradient(135deg,#c9a84c,#b8922e); color:#fff;
             text-decoration:none; padding:16px 40px; border-radius:12px; font-size:15px;
             font-weight:700; letter-spacing:0.03em; }
      .divider { height:1px; background:#f0ede8; margin:24px 0; }
      .info { background:#f9f8f5; border-radius:12px; padding:20px 24px; margin:24px 0; }
      .info p { margin:0; color:#555; font-size:13px; line-height:1.8; }
      .footer { background:#1a1a2e; padding:24px 32px; text-align:center; }
      .footer p { color:#666; font-size:12px; margin:0 0 8px; }
      .footer a { color:#c9a84c; text-decoration:none; }
      .footer .social { margin-top:12px; }
    </style>`;
}

function buildCatalogEmail({ leadName, businessName, scheduleUrl, websiteUrl, step }) {
  const firstName = (leadName || 'there').split(' ')[0];
  const subjects = {
    1: `Your Dream Kitchen Awaits — ${businessName}`,
    2: `Still thinking about new cabinets? — ${businessName}`,
    3: `One last note from ${businessName} 👋`,
  };
  const intros = {
    1: `Hi ${firstName},<br><br>We tried to reach you earlier — no worries! We'd love to show you our premium all-plywood cabinet collections in person at our Irmo showroom.<br><br>Take a look at what we have for you:`,
    2: `Hi ${firstName},<br><br>Just checking in! We know choosing the right cabinets is a big decision. Our team is ready to answer any questions and schedule a visit at your convenience.`,
    3: `Hi ${firstName},<br><br>This is our final follow-up. We don't want to bother you, but we'd hate for you to miss out on the quality and craftsmanship we offer. If you're still interested, we're here for you!`,
  };

  return {
    subject: subjects[step],
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${emailStyle()}</head>
<body>
<div class="wrap">
  <div class="header">
    <h1>CP Cabinets &amp; Quartz</h1>
    <p>Irmo, South Carolina</p>
  </div>

  <div class="hero">
    <h2>Built to Last — All-Plywood Kitchen Cabinets</h2>
    <p>No Particle Board. Just Premium Plywood and Solid Wood Quality.</p>
  </div>

  <div class="body">
    <p>${intros[step]}</p>

    <div class="collections">

      <div class="col-item">
        <img class="col-img" src="https://cpcabinets.com/wp-content/uploads/2026/02/SAG_SWO2-2-500x500.jpg" alt="Shaker Collection" />
        <div class="col-body">
          <h3>🏠 Shaker Collection</h3>
          <p>Timeless elegance with 5-piece solid wood doors, 3/4" solid wood frame, and 1/2" plywood box. Dovetail drawer construction with soft-close throughout.</p>
          <div class="colors">Available in: Shaker White, Espresso, Navy Blue, Iron Black, Sage Breeze, Luna Grey + more</div>
        </div>
      </div>

      <div class="col-item">
        <img class="col-img" src="https://cpcabinets.com/wp-content/uploads/2026/02/Slim-Shaker-3.png" alt="Slim Shaker Collection" />
        <div class="col-body">
          <h3>✨ Slim Shaker Collection</h3>
          <p>Modern minimalist design blending simplicity and sophistication. Premium all-plywood construction with a contemporary narrow frame.</p>
          <div class="colors">Available in: Amber Oak, Aston Green, Dove White, High Gloss White, High Gloss Gray, Matt Black</div>
        </div>
      </div>

      <div class="col-item">
        <img class="col-img" src="https://cpcabinets.com/wp-content/uploads/2026/02/Frameless-1.jpg" alt="European Frameless Collection" />
        <div class="col-body">
          <h3>💎 European (Frameless) Collection</h3>
          <p>Sleek, full-access cabinets with PET high-gloss slab doors and 3/4" plywood construction. The ultimate in modern luxury.</p>
          <div class="colors">Available in: Crystal Glass, Midnight Glass, Oak Blonde, Oak Shade, Matt Black, Matt Ivory</div>
        </div>
      </div>

    </div>

    <div class="cta-block">
      <a href="${scheduleUrl}" class="cta">📅 Schedule My Free Showroom Visit</a>
    </div>

    <div class="divider"></div>

    <div class="info">
      <p>
        📍 <strong>1085 Lake Murray Blvd, Suite E, Irmo, SC 29063</strong><br>
        📞 <strong>(803) 373-8191</strong><br>
        🕐 Mon–Fri, 9AM–4PM (by appointment)<br>
        ✅ TSCA VI &amp; KCMA Certified
      </p>
    </div>

    <p style="color:#888;font-size:13px;">We also offer <strong>quartz countertops</strong>, <strong>bathroom cabinets</strong>, and <strong>vinyl flooring</strong> — all in one showroom visit.</p>
  </div>

  <div class="footer">
    <p>© 2026 ${businessName}</p>
    ${websiteUrl ? `<p><a href="${websiteUrl}">${websiteUrl}</a></p>` : ''}
    <p style="color:#555;font-size:11px;margin-top:12px;">You're receiving this because you requested information from us. <a href="#" style="color:#666;">Unsubscribe</a></p>
  </div>
</div>
</body></html>`,
  };
}

// ── SEND IMMEDIATE FOLLOW-UP (step 1 — called from call-status webhook) ───────

async function sendImmediateFollowUp(conv) {
  if (!conv.lead_email) return;
  const client = conv.clients || conv.client;
  if (!client) return;

  const scheduleUrl = `${BASE_URL}/schedule/cp-cabinets`;
  const { subject, html } = buildCatalogEmail({
    leadName: conv.lead_name,
    businessName: client.business_name,
    scheduleUrl: client.website_url ? `${BASE_URL}/schedule/cp-cabinets` : scheduleUrl,
    websiteUrl: client.website_url,
    step: 1,
  });

  await sendEmail({
    from: `${client.business_name} <noreply@btechsouto.shop>`,
    to: conv.lead_email,
    subject,
    html,
  });

  await db.updateConversation(conv.id, {
    follow_up_count: 1,
    last_follow_up_at: new Date().toISOString(),
  });

  logger.info('followup', `step 1 sent to ${conv.lead_email} conv=${conv.id}`);
}

// ── CRON FOLLOW-UPS (step 2 = day 2, step 3 = day 5) ─────────────────────────

async function runFollowUpCron(step) {
  const leads = await db.getLeadsForEmailFollowUp(step);
  logger.info('followup', `cron step=${step} found ${leads.length} leads`);

  for (const conv of leads) {
    try {
      if (!conv.lead_email) continue;
      const client = conv.clients;
      if (!client) continue;

      const scheduleUrl = `${BASE_URL}/schedule/cp-cabinets`;
      const { subject, html } = buildCatalogEmail({
        leadName: conv.lead_name,
        businessName: client.business_name,
        scheduleUrl,
        websiteUrl: client.website_url,
        step,
      });

      await sendEmail({
        from: `${client.business_name} <noreply@btechsouto.shop>`,
        to: conv.lead_email,
        subject,
        html,
      });

      await db.updateConversation(conv.id, {
        follow_up_count: step,
        last_follow_up_at: new Date().toISOString(),
      });

      logger.info('followup', `step ${step} sent to ${conv.lead_email} conv=${conv.id}`);
    } catch (err) {
      logger.warn('followup', `step ${step} failed for conv=${conv.id}: ${err.message}`);
    }
  }
}

module.exports = { sendImmediateFollowUp, runFollowUpCron };

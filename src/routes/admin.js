const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const db       = require('../services/supabase');
const logger   = require('../utils/logger');
const { google } = require('googleapis');

function timingSafeEqual(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function authMiddleware(req, res, next) {
  const key      = req.headers['x-admin-key'] || req.query.adminKey || '';
  const expected = process.env.ADMIN_KEY || '';
  if (!key || !expected || !timingSafeEqual(key, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function getOAuthClient() {
  const BASE = process.env.BASE_URL || 'https://leads.btechsouto.shop';
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${BASE}/api/admin/google-callback`
  );
}

// base64url helpers — compatible with all Node versions
function toBase64url(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function fromBase64url(b64url) {
  const b64 = (b64url || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, 'base64').toString('utf8');
}

// GET /api/admin/google-callback?code=...&state=...
// Called by Google after authorization — NO auth middleware (browser redirect from Google)
router.get('/google-callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return res.status(400).send(`<h2>Authorization failed: ${oauthError}</h2>`);
  }
  if (!code || !state) {
    return res.status(400).send('<h2>Missing code or state parameter</h2>');
  }

  let parsed;
  try {
    parsed = JSON.parse(fromBase64url(state));
  } catch {
    return res.status(400).send('<h2>Invalid state parameter</h2>');
  }

  const expected = process.env.ADMIN_KEY || '';
  if (!parsed.adminKey || !timingSafeEqual(parsed.adminKey, expected)) {
    return res.status(401).send('<h2>Unauthorized state</h2>');
  }

  const { clientId, tokenType } = parsed;

  try {
    const oauth2 = getOAuthClient();
    const { tokens } = await oauth2.getToken(code);

    if (!tokens.refresh_token) {
      return res.status(400).send('<h2>No refresh_token returned — revoke app access at myaccount.google.com/permissions and re-authorize.</h2>');
    }

    const field = tokenType === 'calendar' ? 'google_refresh_token' : 'gmail_refresh_token';
    const supabase = db.supabaseClient();
    const { error: dbErr } = await supabase
      .from('clients')
      .update({ [field]: tokens.refresh_token })
      .eq('id', clientId);

    if (dbErr) throw new Error(dbErr.message);

    logger.info('admin', `google re-auth success clientId=${clientId} tokenType=${tokenType}`);

    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;max-width:600px">
        <h2 style="color:#16a34a">&#10003; Google re-auth successful!</h2>
        <p><strong>Client ID:</strong> ${clientId}</p>
        <p><strong>Token type:</strong> ${field}</p>
        <p><strong>Refresh token saved.</strong> The cron picks it up on the next run (within 10 min).</p>
        <p style="color:#64748b;font-size:13px">You can close this tab.</p>
      </body></html>
    `);
  } catch (err) {
    logger.warn('admin', `google-callback error: ${err.message}`);
    res.status(500).send(`<h2>Error: ${err.message}</h2>`);
  }
});

router.use(authMiddleware);

// GET /api/admin/google-auth?adminKey=...&clientId=...&tokenType=gmail|calendar
// Returns { url } — open that URL in browser to re-authorize Google access
router.get('/google-auth', async (req, res) => {
  const { clientId, tokenType = 'gmail' } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });

  const scopes = tokenType === 'calendar'
    ? ['https://www.googleapis.com/auth/calendar']
    : [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/gmail.readonly',
      ];

  const state = toBase64url(JSON.stringify({
    adminKey: process.env.ADMIN_KEY,
    clientId,
    tokenType,
  }));

  const oauth2 = getOAuthClient();
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state,
  });

  res.json({ url, message: 'Open this URL in your browser to authorize. Token will be saved automatically.' });
});

router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Diagnóstico e correção automática das permissões de voz Twilio
router.post('/twilio-fix', async (req, res) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    return res.status(500).json({ error: 'TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set in env' });
  }

  const twilio = require('twilio')(accountSid, authToken);
  const report = { accountSid: accountSid.slice(0, 10) + '...', checks: [], fixes: [] };

  // 1. Detalhes da conta
  try {
    const acc = await twilio.api.accounts(accountSid).fetch();
    report.account = { status: acc.status, type: acc.type, friendlyName: acc.friendlyName };
    report.checks.push({ check: 'account_status', value: acc.status, ok: acc.status === 'active' });
  } catch (e) {
    report.checks.push({ check: 'account_status', error: e.message, ok: false });
  }

  // 2. Capabilities do número +19418456110
  try {
    const numbers = await twilio.incomingPhoneNumbers.list({ phoneNumber: '+19418456110' });
    const num = numbers[0];
    if (num) {
      report.number = {
        phoneNumber: num.phoneNumber,
        voiceCapable: num.capabilities.voice,
        smsCapable:   num.capabilities.sms,
        voiceUrl: num.voiceUrl,
        smsUrl:   num.smsUrl,
        statusCallbackUrl: num.statusCallbackUrl,
      };
      report.checks.push({ check: 'voice_capable', value: num.capabilities.voice, ok: !!num.capabilities.voice });
      report.checks.push({ check: 'sms_capable',   value: num.capabilities.sms,   ok: !!num.capabilities.sms });
    } else {
      report.checks.push({ check: 'number_found', ok: false, note: '+19418456110 not found in this account' });
    }
  } catch (e) {
    report.checks.push({ check: 'number_capabilities', error: e.message, ok: false });
  }

  // 3. Voice Geographic Permissions para US
  try {
    const geo = await twilio.voice.dialingPermissions.countries('US').fetch();
    report.voiceGeoUS = {
      lowRiskEnabled:  geo.lowRiskNumbersEnabled,
      highRiskEnabled: geo.highRiskSpecialNumbersEnabled,
    };
    report.checks.push({ check: 'us_low_risk_voice', value: geo.lowRiskNumbersEnabled, ok: !!geo.lowRiskNumbersEnabled });

    // Corrige automaticamente se estiver desabilitado
    if (!geo.lowRiskNumbersEnabled) {
      await twilio.voice.dialingPermissions.countries('US').update({ lowRiskNumbersEnabled: true });
      report.fixes.push('us_low_risk_voice: enabled');
      report.voiceGeoUS.lowRiskEnabled = true;
    }
  } catch (e) {
    report.checks.push({ check: 'us_voice_geo', error: e.message, ok: false });
  }

  // 4. Últimas 5 mensagens enviadas do número da Denali
  try {
    const msgs = await twilio.messages.list({ from: '+19418456110', limit: 5 });
    report.recentMessages = msgs.map(m => ({
      to: m.to, status: m.status, direction: m.direction,
      errorCode: m.errorCode, errorMessage: m.errorMessage,
      dateSent: m.dateSent,
      body: (m.body || '').substring(0, 80),
    }));
    const failed = msgs.filter(m => ['failed', 'undelivered'].includes(m.status));
    report.checks.push({ check: 'sms_delivery', failedCount: failed.length, ok: failed.length === 0 });
    if (failed.length > 0) {
      report.smsFailureReasons = failed.map(m => ({ to: m.to, errorCode: m.errorCode, errorMessage: m.errorMessage }));
    }
  } catch (e) {
    report.checks.push({ check: 'recent_messages', error: e.message, ok: false });
  }

  // 5. Últimas 5 chamadas do número da Denali
  try {
    const calls = await twilio.calls.list({ from: '+19418456110', limit: 5 });
    report.recentCalls = calls.map(c => ({
      to: c.to, status: c.status, direction: c.direction,
      duration: c.duration, startTime: c.startTime,
    }));
  } catch (e) {
    report.checks.push({ check: 'recent_calls', error: e.message, ok: false });
  }

  const failed = report.checks.filter(c => c.ok === false);
  res.json({ ok: failed.length === 0, fixesApplied: report.fixes, report });
});

router.get('/stats', async (req, res) => {
  try {
    const clientId = req.query.clientId || '';
    const [stats, hourly] = await Promise.all([
      db.getDayStats(clientId),
      db.getHourlyLeads(clientId),
    ]);
    res.json({ ...stats, hourly });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/leads', async (req, res) => {
  try {
    const page     = parseInt(req.query.page)  || 1;
    const limit    = parseInt(req.query.limit) || 20;
    const search   = req.query.search   || '';
    const stage    = req.query.stage    || '';
    const clientId = req.query.clientId || '';
    const { data, count } = await db.getLeads({ page, limit, search, stage, clientId });
    res.json({ data, count, page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/leads/export/csv', async (req, res) => {
  try {
    const leads = await db.getAllLeadsForExport();
    const header = ['id','lead_name','lead_phone','lead_address','source','service_type','stage','scheduled_at','created_at','business_name'];
    const rows = leads.map(l => [
      l.id, l.lead_name, l.lead_phone, l.lead_address || '',
      l.source, l.service_type, l.stage,
      l.scheduled_at || '', l.created_at,
      l.clients ? l.clients.business_name : '',
    ].map(v => `"${String(v || '').replace(/"/g,'""')}"`).join(','));
    const csv = [header.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/leads/:id', async (req, res) => {
  try {
    const allowed = {};
    if (req.body.stage        !== undefined) allowed.stage        = req.body.stage;
    if (req.body.notes        !== undefined) allowed.notes        = req.body.notes;
    if (req.body.scheduled_at !== undefined) allowed.scheduled_at = req.body.scheduled_at;
    if (req.body.lead_name    !== undefined) allowed.lead_name    = req.body.lead_name;
    if (req.body.lead_address !== undefined) allowed.lead_address = req.body.lead_address;
    if (req.body.service_type !== undefined) allowed.service_type = req.body.service_type;
    await db.updateConversation(req.params.id, allowed);
    res.json({ ok: true });

    // Google Review email when stage moves to 'visited'
    if (req.body.stage === 'visited') {
      try {
        const conv = await db.getConversationWithClient(req.params.id);
        if (conv && conv.lead_email && !conv.review_sent_at) {
          const client = conv.clients || conv.client;
          if (client?.google_review_link) {
            const { sendGoogleReviewEmail } = require('../services/followup');
            await sendGoogleReviewEmail({ ...conv, clients: client });
            await db.markReviewSent(conv.id);
          }
        }
      } catch (err) {
        logger.warn('admin', `google review email failed conv=${req.params.id}: ${err.message}`);
      }
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/leads/:id/send-catalog', async (req, res) => {
  try {
    const conv = await db.getConversationWithClient(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Lead not found' });
    if (!conv.lead_email) return res.status(400).json({ error: 'Lead has no email address' });
    const { sendImmediateFollowUp } = require('../services/followup');
    await sendImmediateFollowUp({ ...conv, follow_up_count: 0 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/leads/:id/messages', async (req, res) => {
  try {
    const messages = await db.getMessages(req.params.id);
    res.json(messages);
  } catch (err) {
    // Fallback if media_url column doesn't exist yet
    res.json([]);
  }
});

router.post('/leads/:id/send-email', async (req, res) => {
  try {
    const { subject, message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    const lead = await db.getConversationWithClient(req.params.id);
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    const { sendEmail } = require('../services/gmail');
    const toEmail = lead.lead_email;
    if (!toEmail) return res.status(422).json({ error: 'lead has no email address on file' });
    await sendEmail({
      to: toEmail,
      subject: subject || `Message from ${lead.clients?.business_name || 'your contractor'}`,
      body: message,
    });
    await db.appendMessage(req.params.id, 'owner', `[Email] ${message}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/leads/:id/send-sms', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    const lead = await db.getConversationWithClient(req.params.id);
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    const twilioSvc = require('../services/twilio');
    const creds = lead.clients?.twilio_account_sid ? {
      accountSid: lead.clients.twilio_account_sid,
      authToken: lead.clients.twilio_auth_token,
    } : null;
    await twilioSvc.sendSms({
      to: `+${lead.lead_phone}`,
      from: lead.clients.twilio_number,
      body: message,
      credentials: creds,
    });
    await db.appendMessage(req.params.id, 'owner', message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/leads/:id', async (req, res) => {
  try {
    const lead = await db.getLeadById(req.params.id);
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/clients', async (req, res) => {
  try {
    const clients = await db.getClients();
    res.json(clients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/clients', async (req, res) => {
  try {
    const required = ['business_name', 'twilio_number', 'owner_phone'];
    for (const f of required) {
      if (!req.body[f]) return res.status(400).json({ error: `${f} is required` });
    }
    const client = await db.createClient(req.body);
    res.status(201).json(client);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/invite-client', async (req, res) => {
  try {
    const { business_name, owner_email, owner_name, owner_phone, twilio_number, niche, timezone } = req.body;
    if (!business_name || !owner_email || !twilio_number) {
      return res.status(400).json({ error: 'business_name, owner_email and twilio_number are required' });
    }

    const client = await db.createClient({
      business_name, owner_name, owner_email, owner_phone: owner_phone || '',
      twilio_number, niche: niche || 'general', timezone: timezone || 'America/New_York',
    });

    let invited = false;
    let note = 'Client created. Add SUPABASE_SERVICE_ROLE_KEY to Coolify to enable email invites.';
    try {
      const user = await db.inviteUser(owner_email);
      await db.linkUserToClient(client.id, user.id);
      invited = true;
      note = `Invite email sent to ${owner_email}`;
    } catch (e) {
      // graceful — client record was still created
    }

    res.status(201).json({ ok: true, client, invited, note });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cria subconta Twilio isolada para o cliente — isola riscos de fraude por conta
router.post('/clients/:id/create-subaccount', async (req, res) => {
  try {
    const client = await db.getClientById(req.params.id);
    if (!client) return res.status(404).json({ error: 'client not found' });

    if (client.twilio_account_sid) {
      return res.status(409).json({ error: 'Client already has a subaccount', subaccountSid: client.twilio_account_sid });
    }

    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const sub = await twilio.api.accounts.create({
      friendlyName: `LeadPilot – ${client.business_name}`,
    });

    await db.updateClient(req.params.id, {
      twilio_account_sid: sub.sid,
      twilio_auth_token:  sub.authToken,
    });

    const logger = require('../utils/logger');
    logger.info('admin', `subaccount_created client=${client.business_name} sid=${sub.sid}`);

    res.status(201).json({
      ok: true,
      subaccountSid: sub.sid,
      note: `Subconta criada. Compre um número Twilio dentro da subconta ${sub.sid} e atualize twilio_number do cliente.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

router.patch('/clients/:id', async (req, res) => {
  try {
    const editable = [
      'active', 'business_name', 'owner_phone', 'owner_email', 'secondary_email', 'timezone',
      'ai_system_prompt', 'google_review_link',
      'twilio_account_sid', 'twilio_auth_token',
      'google_refresh_token', 'google_calendar_id',
      'gmail_refresh_token',
      'voice_script', 'manual_mode',
      'service_zones', 'max_radius_miles',
      'alert_phone', 'niche', 'call_start_hour', 'call_end_hour', 'voice_enabled',
    ];
    const allowed = {};
    for (const f of editable) {
      if (req.body[f] !== undefined) allowed[f] = req.body[f];
    }
    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    await db.updateClient(req.params.id, allowed);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/conversations/:id/visited', async (req, res) => {
  try {
    await db.markAsVisited(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/appointments', async (req, res) => {
  try {
    const clientId = req.query.clientId || '';
    const appointments = await db.getAppointments(clientId);
    res.json(appointments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/appointments/:id', async (req, res) => {
  try {
    const allowed = {};
    if (req.body.stage)        allowed.stage        = req.body.stage;
    if (req.body.scheduled_at) allowed.scheduled_at = req.body.scheduled_at;
    await db.updateConversation(req.params.id, allowed);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/weekly-report', async (req, res) => {
  try {
    const twilioSvc = require('../services/twilio');
    const stats = await db.getWeeklyStats();
    const results = [];
    for (const s of stats) {
      if (!s.client || !s.client.owner_phone) continue;
      const msg =
        `📊 LeadPilot Weekly – ${s.client.business_name}\n` +
        `Leads: ${s.total}\n` +
        `Scheduled: ${s.scheduled}\n` +
        `Conversion: ${s.total > 0 ? Math.round((s.scheduled / s.total) * 100) : 0}%\n` +
        `Powered by LeadPilot`;
      await twilioSvc.sendSms({ to: s.client.owner_phone, from: s.client.twilio_number, body: msg });
      results.push({ client: s.client.business_name, sent: true });
    }
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/test-alert', async (req, res) => {
  const alertPhone = process.env.ALERT_PHONE;
  const fromNumber = process.env.TWILIO_FROM_ALERT || process.env.ALERT_FROM;
  try {
    const twilio = require('twilio');
    if (!alertPhone || !fromNumber) {
      return res.status(400).json({ error: 'ALERT_PHONE or ALERT_FROM not configured' });
    }
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      to: alertPhone,
      from: fromNumber,
      body: 'TEST ALERT – LeadPilot monitoring check OK',
    });
    res.json({ ok: true, to: alertPhone, from: fromNumber });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: err.code,
      sid_prefix: process.env.TWILIO_ACCOUNT_SID ? process.env.TWILIO_ACCOUNT_SID.slice(0, 6) : 'missing',
      from: fromNumber,
      to: alertPhone,
    });
  }
});

// Enriquece leads sem nome via CNAM lookup (Twilio Lookup API, ~$0.01/consulta)
// Roda uma vez para preencher leads históricos — POST /api/admin/leads/enrich-names
router.post('/leads/enrich-names', async (req, res) => {
  const twilioSvc = require('../services/twilio');
  const logger    = require('../utils/logger');

  try {
    // Usa o db module já inicializado no topo do arquivo (evita problema de env var)
    const { data: leads, error } = await db.supabaseClient()
      .from('conversations')
      .select('id, lead_phone, lead_name')
      .in('lead_name', ['Caller', 'Customer', ''])
      .not('lead_phone', 'is', null);

    if (error) return res.status(500).json({ error: error.message });
    if (!leads?.length) return res.json({ ok: true, enriched: 0, message: 'No leads to enrich' });

    const results = [];
    for (const lead of leads) {
      const phone = `+${lead.lead_phone}`;
      const name  = await twilioSvc.lookupCallerName(phone);
      if (name) {
        await db.updateConversation(lead.id, { lead_name: name });
        logger.info('admin', `enrich-names: ${phone} → ${name}`);
        results.push({ id: lead.id, phone, name, updated: true });
      } else {
        results.push({ id: lead.id, phone, name: null, updated: false });
      }
    }

    const enriched = results.filter(r => r.updated).length;
    res.json({ ok: true, enriched, total: leads.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/errors', async (req, res) => {
  try {
    const errors = await db.getErrors();
    res.json(errors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Creates the TwiML Application in Twilio for browser click-to-call (run once)
router.post('/setup-voice-app', async (req, res) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const baseUrl    = process.env.BASE_URL;
  if (!accountSid || !authToken || !baseUrl) {
    return res.status(500).json({ error: 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or BASE_URL not set' });
  }
  const voiceUrl     = `${baseUrl}/webhook/voice-outbound`;
  const twilioClient = require('twilio')(accountSid, authToken);

  if (process.env.TWILIO_TWIML_APP_SID) {
    try {
      const existing = await twilioClient.applications(process.env.TWILIO_TWIML_APP_SID).fetch();
      return res.json({ appSid: existing.sid, voiceUrl: existing.voiceUrl, alreadyConfigured: true });
    } catch (_) { /* app not found, create new one */ }
  }

  try {
    const app = await twilioClient.applications.create({
      friendlyName: 'LeadPilot Click-to-Call',
      voiceUrl,
      voiceMethod: 'POST',
    });
    res.json({
      appSid: app.sid,
      voiceUrl: app.voiceUrl,
      instruction: `Add TWILIO_TWIML_APP_SID=${app.sid} to Coolify env vars, then redeploy`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generates an Access Token for the Twilio Voice JS SDK (browser softphone)
// Requires TWILIO_API_KEY (SK...) and TWILIO_API_SECRET in env vars
router.post('/voice-token', (req, res) => {
  const accountSid   = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySid    = process.env.TWILIO_API_KEY;
  const apiKeySecret = process.env.TWILIO_API_SECRET;
  const appSid       = process.env.TWILIO_TWIML_APP_SID;

  if (!appSid) {
    return res.status(500).json({ error: 'TWILIO_TWIML_APP_SID não configurado.' });
  }
  if (!accountSid || !apiKeySid || !apiKeySecret) {
    return res.status(500).json({
      error: 'Env vars faltando',
      missing: [
        !accountSid   && 'TWILIO_ACCOUNT_SID',
        !apiKeySid    && 'TWILIO_API_KEY',
        !apiKeySecret && 'TWILIO_API_SECRET',
      ].filter(Boolean),
    });
  }

  try {
    const { AccessToken } = require('twilio').jwt;
    const { VoiceGrant }  = AccessToken;

    const voiceGrant = new VoiceGrant({ outgoingApplicationSid: appSid, incomingAllow: true });
    const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, { identity: 'admin', ttl: 3600 });
    token.addGrant(voiceGrant);

    res.json({ token: token.toJwt(), fromNumber: process.env.ALERT_FROM || '+19418456110' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ELEVENLABS — pré-geração de TODAS as frases de voz do cliente ─────────────
// POST /api/admin/elevenlabs-phrases
// Body: { clientId, voiceId? }
// Gera as ~11 frases estáticas (greeting + perguntas da conversa) de uma vez.
// Limites: 350 chars/frase, 4000 chars/batch, limit diário configurável.
router.post('/elevenlabs-phrases', express.json(), async (req, res) => {
  const { clientId, voiceId } = req.body || {};
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  let client;
  try { client = await db.getClientById(clientId); } catch {}
  if (!client) return res.status(404).json({ error: 'client not found' });

  const elevenlabs = require('../services/elevenlabs');
  const BASE = process.env.BASE_URL || 'https://leads.btechsouto.shop';

  let result;
  try {
    result = await elevenlabs.generateAllClientPhrases(clientId, client.business_name, voiceId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Salva flag no cliente para o webhook saber que ElevenLabs está ativo
  const greetingUrl = `${BASE}/audio/${clientId}/greeting`;
  try {
    await db.updateClient(clientId, {
      elevenlabs_greeting_url: greetingUrl,
      elevenlabs_voice_id: voiceId || 'rachel',
    });
    db.invalidateClientCacheById(clientId);
  } catch (err) {
    return res.status(500).json({ error: `DB update error: ${err.message}` });
  }

  const succeeded = Object.values(result.results).filter(r => r.ok).length;
  const failed    = Object.values(result.results).filter(r => !r.ok).length;

  res.json({
    ok: true,
    voiceId: voiceId || 'rachel',
    businessName: client.business_name,
    phrasesGenerated: succeeded,
    phrasesFailed: failed,
    totalChars: result.totalCharsGenerated,
    dailyUsage: result.dailyUsage,
    phrases: result.results,
    baseUrl: `${BASE}/audio/${clientId}/`,
  });
});

// ── ELEVENLABS — saudação individual (backward compat) ───────────────────────
router.post('/elevenlabs-greeting', express.json(), async (req, res) => {
  const { clientId, text, voiceId } = req.body || {};
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  let client;
  try { client = await db.getClientById(clientId); } catch {}
  if (!client) return res.status(404).json({ error: 'client not found' });

  const elevenlabs = require('../services/elevenlabs');
  const greetingText = text || `Hi! Thanks for calling ${client.business_name}. What's your first name?`;

  try {
    await elevenlabs.generateAndCacheGreeting(clientId, greetingText, voiceId);
  } catch (err) {
    return res.status(500).json({ error: `ElevenLabs error: ${err.message}` });
  }

  const BASE = process.env.BASE_URL || 'https://leads.btechsouto.shop';
  const greetingUrl = `${BASE}/audio/${clientId}/greeting`;

  try {
    await db.updateClient(clientId, { elevenlabs_greeting_url: greetingUrl });
    db.invalidateClientCacheById(clientId);
  } catch (err) {
    return res.status(500).json({ error: `DB update error: ${err.message}` });
  }

  res.json({ ok: true, greetingUrl, greetingText, voiceId: voiceId || 'rachel' });
});

// ── ELEVENLABS — status de uso diário ────────────────────────────────────────
router.get('/elevenlabs-usage', (req, res) => {
  const elevenlabs = require('../services/elevenlabs');
  res.json(elevenlabs.getDailyUsage());
});

// Temporary debug endpoint — test GPT qualification from production server
router.get('/test-qualify', async (req, res) => {
  try {
    const openaiSvc = require('../services/openai');
    const result = await openaiSvc.qualifyLead({
      name: 'Test Lead',
      serviceType: 'tile_install',
      serviceNote: 'Full bathroom tile renovation, porcelain, start ASAP, budget $10000',
      businessName: 'Denali Custom Homes',
      phone: '14085550000',
    });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── AUDIO CALL PREVIEW — step 1: transcribe + translate + TTS ────────────────
// POST /api/admin/audio-call-preview?clientId=xxx
// Body: raw audio blob (Content-Type: audio/webm or audio/ogg)
// Returns: { msgId, transcription, translation }
router.post('/audio-call-preview', async (req, res) => {
  const clientId  = req.query.clientId;
  const sourceLang = req.query.sourceLang || '';       // e.g. 'pt', 'es', '' = auto
  const targetLang = req.query.targetLang || 'en';     // e.g. 'en', 'es', 'pt'
  const voiceParam = req.query.voice || 'female';      // 'female' or 'male'
  const audioBuffer = req.body;

  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    return res.status(400).json({ error: 'No audio received' });
  }
  if (!clientId) {
    return res.status(400).json({ error: 'clientId query param required' });
  }

  let client;
  try { client = await db.getClientByIdAdmin(clientId); } catch (e) {
    return res.status(500).json({ error: `DB error: ${e.message}`, clientId });
  }
  if (!client) return res.status(404).json({ error: 'client not found', clientId });

  const logger     = require('../utils/logger');
  const fs         = require('fs');
  const path       = require('path');
  const OpenAI     = require('openai');
  const openai     = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const elevenlabs = require('../services/elevenlabs');
  const AUDIO_DIR  = path.join('/tmp', 'leadpilot-audio');

  // ElevenLabs voice IDs — female: Hope, male: Adam (free tier)
  const VOICE_FEMALE = 'hope';
  const VOICE_MALE   = 'pNInz6obpgDQGcFmaJgB'; // Adam — free multilingual ElevenLabs voice

  // Target language name for translation prompt
  const TARGET_LANG_NAMES: Record<string, string> = {
    en: 'clear, natural American English',
    es: 'clear, natural Spanish',
    pt: 'clear, natural Brazilian Portuguese',
    fr: 'clear, natural French',
    de: 'clear, natural German',
    it: 'clear, natural Italian',
    zh: 'clear, natural Mandarin Chinese',
    ja: 'clear, natural Japanese',
    ko: 'clear, natural Korean',
  };
  const targetLangName = TARGET_LANG_NAMES[targetLang] || 'clear, natural English';

  try {
    const mimetype = (req.get('content-type') || 'audio/webm').split(';')[0].trim();
    const ext      = mimetype.split('/')[1] || 'webm';
    const tmpFile  = path.join(AUDIO_DIR, `inbound-${Date.now()}.${ext}`);
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    fs.writeFileSync(tmpFile, audioBuffer);

    let transcription;
    try {
      const whisperParams: any = { model: 'whisper-1', file: fs.createReadStream(tmpFile) };
      if (sourceLang) whisperParams.language = sourceLang;
      const result = await openai.audio.transcriptions.create(whisperParams);
      transcription = result.text;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    if (!transcription?.trim()) {
      return res.status(422).json({ error: 'Não foi possível transcrever — a gravação foi muito curta?' });
    }

    const translateRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content: `Translate the following to ${targetLangName} suitable for a phone call. Under 300 characters. Output ONLY the translated text — no quotes, no labels.`,
        },
        { role: 'user', content: transcription },
      ],
    });
    const translatedText = translateRes.choices[0].message.content.trim().slice(0, 300);

    const msgId    = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const voiceId  = voiceParam === 'male' ? VOICE_MALE : VOICE_FEMALE;
    const mp3Buf   = await elevenlabs.generateMp3(translatedText, voiceId);
    const mp3Path  = path.join(AUDIO_DIR, `vmsg-${msgId}.mp3`);
    fs.writeFileSync(mp3Path, mp3Buf);

    logger.info('admin', `audio-preview msgId=${msgId} src=${sourceLang||'auto'} tgt=${targetLang} voice=${voiceParam} orig="${transcription.slice(0,60)}" trans="${translatedText.slice(0,60)}"`);
    res.json({ msgId, transcription, translation: translatedText });
  } catch (err) {
    require('../utils/logger').error('admin', `audio-preview error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── AUDIO CALL SEND — step 2: place Twilio call with pre-generated MP3 ────────
// POST /api/admin/audio-call-send
// Body: { msgId, phone, clientId }
router.post('/audio-call-send', express.json(), async (req, res) => {
  const { msgId, phone, clientId } = req.body || {};
  if (!msgId || !phone || !clientId) {
    return res.status(400).json({ error: 'msgId, phone and clientId are required', received: { msgId: !!msgId, phone: !!phone, clientId: !!clientId } });
  }

  let client;
  try { client = await db.getClientByIdAdmin(clientId); } catch (e) {
    return res.status(500).json({ error: `DB error: ${e.message}`, clientId });
  }
  if (!client) return res.status(404).json({ error: 'client not found', clientId });

  const logger  = require('../utils/logger');
  const fs      = require('fs');
  const path    = require('path');
  const BASE    = process.env.BASE_URL || 'https://leads.btechsouto.shop';
  const safeMsgId = (msgId || '').replace(/[^a-z0-9\-]/gi, '');
  const mp3Path   = path.join('/tmp', 'leadpilot-audio', `vmsg-${safeMsgId}.mp3`);

  if (!fs.existsSync(mp3Path)) {
    return res.status(404).json({ error: 'Áudio não encontrado — gere um novo preview.' });
  }

  try {
    const audioUrl = `${BASE}/webhook/voice-msg/${safeMsgId}`;
    const toPhone  = phone.startsWith('+') ? phone : `+${phone}`;
    const twilio   = require('twilio');
    const twilioClient = twilio(
      client.twilio_account_sid || process.env.TWILIO_ACCOUNT_SID,
      client.twilio_auth_token  || process.env.TWILIO_AUTH_TOKEN,
    );

    const call = await twilioClient.calls.create({
      to:   toPhone,
      from: client.twilio_number,
      twiml: `<Response><Play>${audioUrl}</Play><Pause length="1"/></Response>`,
      statusCallback:       `${BASE}/webhook/call-status`,
      statusCallbackMethod: 'POST',
    });

    logger.info('admin', `audio-call-send sid=${call.sid} to=${toPhone}`);
    res.json({ ok: true, callSid: call.sid });
  } catch (err) {
    logger.error('admin', `audio-call-send error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── AUDIO → OUTBOUND CALL (legacy — kept for compatibility) ──────────────────
// POST /api/admin/send-audio-call
// Body (JSON): { audioBase64, audioMimetype, phone, clientId }
// Flow: Whisper transcription → GPT translate to English → ElevenLabs Hope TTS
//       → store MP3 → Twilio outbound call with <Play>
router.post('/send-audio-call', express.json({ limit: '10mb' }), async (req, res) => {
  const { audioBase64, audioMimetype, phone, clientId } = req.body || {};
  if (!audioBase64 || !phone || !clientId) {
    return res.status(400).json({ error: 'audioBase64, phone and clientId are required' });
  }

  let client;
  try { client = await db.getClientByIdAdmin(clientId); } catch (e) {
    return res.status(500).json({ error: `DB error: ${e.message}`, clientId });
  }
  if (!client) return res.status(404).json({ error: 'client not found', clientId });

  const logger     = require('../utils/logger');
  const fs         = require('fs');
  const path       = require('path');
  const OpenAI     = require('openai');
  const openai     = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const elevenlabs = require('../services/elevenlabs');
  const BASE       = process.env.BASE_URL || 'https://leads.btechsouto.shop';
  const AUDIO_DIR  = path.join('/tmp', 'leadpilot-audio');

  try {
    // 1. Write incoming audio to a temp file for Whisper
    const mimetype = audioMimetype || 'audio/webm';
    const ext      = mimetype.split('/')[1]?.split(';')[0] || 'webm';
    const tmpFile  = path.join(AUDIO_DIR, `inbound-${Date.now()}.${ext}`);
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    fs.writeFileSync(tmpFile, Buffer.from(audioBase64, 'base64'));

    // 2. Transcribe with Whisper
    let transcription;
    try {
      const result = await openai.audio.transcriptions.create({
        model: 'whisper-1',
        file:  fs.createReadStream(tmpFile),
      });
      transcription = result.text;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    if (!transcription?.trim()) {
      return res.status(422).json({ error: 'Could not transcribe audio — was the recording too short?' });
    }
    logger.info('admin', `audio-call transcription: "${transcription.slice(0, 120)}"`);

    // 3. Translate to natural English via GPT (handles PT, ES, or already-EN)
    const translateRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content: 'You are a professional translator. Translate the following message to clear, natural American English suitable for a phone call. Keep it under 300 characters. Output ONLY the translated text — no quotes, no labels, nothing else.',
        },
        { role: 'user', content: transcription },
      ],
    });
    const translatedText = translateRes.choices[0].message.content.trim().slice(0, 300);
    logger.info('admin', `audio-call translation: "${translatedText}"`);

    // 4. Generate ElevenLabs Hope TTS
    const msgId  = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const mp3Buf = await elevenlabs.generateMp3(translatedText, 'hope');
    const mp3Path = path.join(AUDIO_DIR, `vmsg-${msgId}.mp3`);
    fs.writeFileSync(mp3Path, mp3Buf);
    logger.info('admin', `audio-call mp3 ready msgId=${msgId} bytes=${mp3Buf.length}`);

    // 5. Make Twilio outbound call with <Play>
    const audioUrl = `${BASE}/webhook/voice-msg/${msgId}`;
    const toPhone  = phone.startsWith('+') ? phone : `+${phone}`;
    const twilio   = require('twilio');
    const twilioClient = twilio(
      client.twilio_account_sid || process.env.TWILIO_ACCOUNT_SID,
      client.twilio_auth_token  || process.env.TWILIO_AUTH_TOKEN,
    );

    const call = await twilioClient.calls.create({
      to:   toPhone,
      from: client.twilio_number,
      twiml: `<Response><Play>${audioUrl}</Play><Pause length="1"/></Response>`,
      statusCallback:       `${BASE}/webhook/call-status`,
      statusCallbackMethod: 'POST',
    });

    logger.info('admin', `audio-call placed sid=${call.sid} to=${toPhone}`);
    res.json({ ok: true, callSid: call.sid, msgId, transcription, translation: translatedText, audioUrl });
  } catch (err) {
    const logger2 = require('../utils/logger');
    logger2.error('admin', `send-audio-call error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── TEST EMAIL ────────────────────────────────────────────────────────────────
router.post('/run-reddit-prospector', async (req, res) => {
  const testEmail  = req.body?.testEmail || null;
  const digestOnly = req.body?.digestOnly || false;
  res.json({ ok: true, message: `Reddit prospector started${testEmail ? ` — sending only to ${testEmail}` : ''}` });
  try {
    const { sendDigestEmail } = require('../services/redditProspector');
    const supaAdm = db.supabaseClient();

    if (digestOnly) {
      const { data: pending, error } = await supaAdm
        .from('outbound_prospects')
        .select('*')
        .eq('client_id', '5221cab9-a741-4ddc-a752-2359826fba95')
        .eq('digest_emailed', false)
        .order('intent_score', { ascending: false });

      logger.info('admin', `digest pending count=${pending?.length || 0} error=${error?.message || 'none'}`);

      if (!pending?.length) {
        logger.info('admin', 'no pending leads to send');
        return;
      }

      const { sendEmail } = require('../services/gmail');
      const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      const to   = testEmail || ['brunosouto1108@gmail.com', 'carvalhopintoge@gmail.com', 'contact@cpcabinets.com'];

      const cards = pending.map(p => {
        const score = p.intent_score || 0;
        const bg    = score >= 8 ? '#f0fdf4' : '#fffbeb';
        const border= score >= 8 ? '#bbf7d0' : '#fde68a';
        const color = score >= 8 ? '#16a34a' : '#d97706';
        return `
        <div style="border:1px solid ${border};border-radius:12px;padding:18px;margin-bottom:14px;background:${bg}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div>
              <span style="font-size:13px;font-weight:700;color:#1e40af">u/${p.username || 'user'}</span>
              <span style="color:#9ca3af;font-size:12px"> · ${p.subreddit || ''}</span>
            </div>
            <span style="background:${color};color:#fff;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700">Score ${score}/10</span>
          </div>
          <p style="margin:0 0 10px;font-weight:700;color:#111827;font-size:14px">${(p.post_title || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
          ${p.post_content ? `<p style="margin:0 0 12px;font-size:12px;color:#6b7280;font-style:italic">"${p.post_content.slice(0,200).replace(/</g,'&lt;')}…"</p>` : ''}
          ${p.dm_text ? `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-bottom:10px">
            <p style="margin:0 0 4px;font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase">Message Ready to Send</p>
            <p style="margin:0;font-size:13px;color:#1f2937;line-height:1.6">${p.dm_text.replace(/</g,'&lt;')}</p>
          </div>` : ''}
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <a href="https://www.reddit.com/message/compose/?to=${encodeURIComponent(p.username||'')}&subject=Your+kitchen+project" style="background:#ff4500;color:#fff;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:700">Send on Reddit →</a>
            ${p.post_url ? `<a href="${p.post_url}" style="background:#f3f4f6;color:#374151;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12px">View Post</a>` : ''}
            <a href="https://cpcabinets.com" style="background:#1e3a5f;color:#fff;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12px">cpcabinets.com</a>
          </div>
        </div>`;
      }).join('');

      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:620px;margin:0 auto;padding:24px 16px">
  <div style="background:#1e3a5f;border-radius:14px 14px 0 0;padding:16px 28px;text-align:center">
    <p style="margin:0;color:rgba(255,255,255,0.5);font-size:11px;letter-spacing:1px;text-transform:uppercase">CP Cabinets & Quartz</p>
  </div>
  <div style="background:linear-gradient(135deg,#1e3a5f,#2563eb);border-radius:0 0 14px 14px;padding:20px 28px 24px;margin-bottom:20px;text-align:center">
    <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:11px;text-transform:uppercase;letter-spacing:1px">${date}</p>
    <h1 style="margin:0 0 4px;color:#fff;font-size:20px;font-weight:800">🎯 ${pending.length} Lead${pending.length>1?'s':''} Ready for Review</h1>
    <p style="margin:0;color:rgba(255,255,255,0.7);font-size:13px">Outreach System · Columbia, SC</p>
  </div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px 18px;margin-bottom:18px">
    <ol style="margin:0;padding-left:18px;color:#4b5563;font-size:13px;line-height:1.9">
      <li>Review leads — people looking for NEW kitchen cabinets or countertops in SC/NC</li>
      <li>Click <strong>"Send on Reddit"</strong> for promising ones — message already written</li>
      <li>When they reply with contact info, Alice calls automatically</li>
    </ol>
  </div>
  ${cards}
  <p style="text-align:center;font-size:11px;color:#9ca3af;margin-top:12px;padding-top:14px;border-top:1px solid #e5e7eb">
    CP Cabinets & Quartz · Powered by BTech Outreach · Max 10 DMs/day
  </p>
</div></body></html>`;

      await sendEmail({
        to,
        subject: `🎯 CP Cabinets — ${pending.length} Leads Ready (${date})`,
        html,
        from: 'CP Cabinets Outreach <noreply@btechsouto.shop>',
      });

      if (!testEmail) {
        await supaAdm
          .from('outbound_prospects')
          .update({ digest_emailed: true, digest_emailed_at: new Date().toISOString() })
          .in('id', pending.map(p => p.id));
        logger.info('admin', `${pending.length} leads marked as digest_emailed`);
      }

      logger.info('admin', `HTML digest sent to ${Array.isArray(to) ? to.join(', ') : to}`);
    } else {
      const { runRedditProspectorTest } = require('../services/redditProspector');
      await runRedditProspectorTest(testEmail ? [testEmail] : null);
    }
  } catch (err) {
    logger.warn('admin', `reddit prospector failed: ${err.message} stack: ${err.stack?.split('\n')[1] || ''}`);
  }
});

// ── SEND REDDIT DM via GET link (called from email button) ───────────────────
router.get('/send-reddit-dm-link', async (req, res) => {
  const { to, msg, id, key } = req.query;
  if (key !== (process.env.ADMIN_KEY || 'LP8141FEB8E1C3BD37F8615730F7F31994B7E5378F')) {
    return res.status(401).send('Unauthorized');
  }
  if (!to || !msg) return res.status(400).send('Missing params');
  try {
    const { sendDM } = require('../services/redditDM');
    await sendDM({ to, subject: 'Your kitchen project', message: decodeURIComponent(msg) });
    if (id) {
      const supabase = db.supabaseClient();
      await supabase.from('outbound_prospects').update({ dm_sent: true, dm_sent_at: new Date().toISOString() }).eq('id', id);
    }
    res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2 style="color:#16a34a">✅ DM enviado para u/${to}</h2>
      <p>Pela conta u/One-Custard-2339</p>
      <p style="color:#6b7280;font-size:14px">Pode fechar esta aba.</p>
    </body></html>`);
  } catch (err) {
    logger.warn('admin', `reddit dm-link failed: ${err.message}`);
    res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2 style="color:#dc2626">❌ Erro ao enviar DM</h2>
      <p>${err.message}</p>
    </body></html>`);
  }
});

// ── SEND REDDIT DM ────────────────────────────────────────────────────────────
router.post('/send-reddit-dm', async (req, res) => {
  const { to, message, prospectId } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });
  try {
    const { sendDM } = require('../services/redditDM');
    await sendDM({ to, subject: 'Your kitchen project', message });

    // Mark as dm_sent in DB
    if (prospectId) {
      const supabase = db.supabaseClient();
      await supabase.from('outbound_prospects').update({ dm_sent: true, dm_sent_at: new Date().toISOString() }).eq('id', prospectId);
    }
    res.json({ ok: true, message: `DM sent to u/${to}` });
  } catch (err) {
    logger.warn('admin', `reddit dm failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/run-competitor-intel', async (req, res) => {
  try {
    const { runCompetitorIntelCron } = require('../services/competitorIntel');
    await runCompetitorIntelCron();
    logger.info('admin', 'competitor intel job completed via manual trigger');
    res.json({ ok: true, message: 'Competitor intel job completed — check server logs for results' });
  } catch (err) {
    logger.warn('admin', `competitor intel job failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PROSPECTOR CONFIG — GET ───────────────────────────────────────────────────
router.get('/prospector-config/:clientId', async (req, res) => {
  try {
    const { data, error } = await db.supabaseClient()
      .from('prospector_configs')
      .select('*')
      .eq('client_id', req.params.clientId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'No prospector config found for this client' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PROSPECTOR CONFIG — UPSERT ────────────────────────────────────────────────
router.put('/prospector-config/:clientId', async (req, res) => {
  try {
    const editable = [
      'active', 'niche', 'business_description', 'website_url', 'min_project_value',
      'target_cities', 'service_zones', 'reddit_subreddits', 'buy_keywords',
      'discard_keywords', 'forum_searches', 'craigslist_cities',
      'digest_recipients', 'digest_hours_et', 'zip_codes',
    ];
    const payload = { client_id: req.params.clientId, updated_at: new Date().toISOString() };
    for (const f of editable) {
      if (req.body[f] !== undefined) payload[f] = req.body[f];
    }
    const { data, error } = await db.supabaseClient()
      .from('prospector_configs')
      .upsert(payload, { onConflict: 'client_id' })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LIST ALL PROSPECTOR CONFIGS ───────────────────────────────────────────────
router.get('/prospector-configs', async (req, res) => {
  try {
    const { data, error } = await db.supabaseClient()
      .from('prospector_configs')
      .select('*, clients(business_name, owner_email)')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/test-email', async (req, res) => {
  const { to, subject, body, html } = req.body;
  if (!to) return res.status(400).json({ ok: false, error: 'to is required' });
  try {
    const { sendEmail } = require('../services/gmail');
    await sendEmail({
      to,
      subject: subject || '✅ LeadPilot — Teste de Email',
      html: html || null,
      body: body || `Email de teste enviado em ${new Date().toISOString()}.\n\nSe chegou aqui, o Resend está funcionando corretamente!`,
    });
    res.json({ ok: true, message: `Email enviado para ${to}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const db = require('../services/supabase');

function authMiddleware(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(authMiddleware);

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
    await db.updateConversation(req.params.id, allowed);
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

router.patch('/clients/:id', async (req, res) => {
  try {
    const editable = [
      'active', 'business_name', 'owner_phone', 'timezone',
      'ai_system_prompt', 'google_review_link',
      'twilio_account_sid', 'twilio_auth_token',
      'google_refresh_token', 'google_calendar_id',
      'voice_script',
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
    return res.status(500).json({ error: 'TWILIO_ACCOUNT_SID, TWILIO_API_KEY ou TWILIO_API_SECRET não configurado.' });
  }

  try {
    const { AccessToken } = require('twilio').jwt;
    const { VoiceGrant }  = AccessToken;

    const voiceGrant = new VoiceGrant({ outgoingApplicationSid: appSid, incomingAllow: false });
    const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, { identity: 'admin', ttl: 3600 });
    token.addGrant(voiceGrant);

    res.json({ token: token.toJwt(), fromNumber: process.env.ALERT_FROM || '+19418456110' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

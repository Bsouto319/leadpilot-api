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

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  const report = { accountSid: accountSid.slice(0, 10) + '...', checks: [] };

  // 1. Checar detalhes da conta
  try {
    const accRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`, { headers });
    const acc = await accRes.json();
    report.account = { status: acc.status, type: acc.type, friendlyName: acc.friendly_name };
    report.checks.push({ check: 'account_status', value: acc.status, ok: acc.status === 'active' });
  } catch (e) {
    report.checks.push({ check: 'account_status', error: e.message });
  }

  // 2. Checar capabilities do número +19418456110
  try {
    const numRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=%2B19418456110`,
      { headers }
    );
    const nums = await numRes.json();
    const num = nums.incoming_phone_numbers?.[0];
    if (num) {
      report.number = {
        phoneNumber: num.phone_number,
        friendlyName: num.friendly_name,
        voiceCapable: num.capabilities?.voice,
        smsCapable: num.capabilities?.sms,
        voiceUrl: num.voice_url,
        smsUrl: num.sms_url,
      };
      report.checks.push({ check: 'voice_capable', value: num.capabilities?.voice, ok: !!num.capabilities?.voice });
      report.checks.push({ check: 'sms_capable',   value: num.capabilities?.sms,   ok: !!num.capabilities?.sms });
    } else {
      report.checks.push({ check: 'number_found', ok: false, note: 'Number +19418456110 not found in account' });
    }
  } catch (e) {
    report.checks.push({ check: 'number_capabilities', error: e.message });
  }

  // 3. Checar Voice Geographic Permissions para US
  try {
    const geoRes = await fetch(
      'https://voice.twilio.com/v1/DialingPermissions/Countries/US',
      { headers: { 'Authorization': `Basic ${auth}` } }
    );
    const geo = await geoRes.json();
    report.voiceGeoUS = {
      isoCode: geo.iso_code,
      highRiskEnabled: geo.high_risk_special_numbers_enabled,
      lowRiskEnabled:  geo.low_risk_numbers_enabled,
    };
    report.checks.push({ check: 'us_voice_low_risk', value: geo.low_risk_numbers_enabled, ok: !!geo.low_risk_numbers_enabled });

    // Habilitar se não estiver
    if (!geo.low_risk_numbers_enabled) {
      const fixRes = await fetch(
        `https://voice.twilio.com/v1/DialingPermissions/Countries/US`,
        {
          method: 'POST',
          headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'LowRiskNumbersEnabled=true',
        }
      );
      const fixData = await fixRes.json();
      report.voiceGeoFix = { attempted: true, result: fixData };
      report.checks.push({ check: 'us_voice_fix_attempted', ok: true });
    }
  } catch (e) {
    report.checks.push({ check: 'us_voice_geo', error: e.message });
  }

  // 4. Checar Voice settings globais da conta
  try {
    const vsRes = await fetch('https://voice.twilio.com/v1/Settings', {
      headers: { 'Authorization': `Basic ${auth}` }
    });
    const vs = await vsRes.json();
    report.voiceSettings = vs;
  } catch (e) {
    report.checks.push({ check: 'voice_settings', error: e.message });
  }

  // 5. Checar últimas mensagens enviadas (para ver se SMS chegou)
  try {
    const msgRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json?From=%2B19418456110&PageSize=5`,
      { headers }
    );
    const msgs = await msgRes.json();
    report.recentMessages = (msgs.messages || []).map(m => ({
      to: m.to, status: m.status, direction: m.direction,
      errorCode: m.error_code, errorMessage: m.error_message,
      dateSent: m.date_sent, body: (m.body || '').substring(0, 60),
    }));
  } catch (e) {
    report.checks.push({ check: 'recent_messages', error: e.message });
  }

  // 6. Checar últimas chamadas realizadas
  try {
    const callRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json?From=%2B19418456110&PageSize=5`,
      { headers }
    );
    const calls = await callRes.json();
    report.recentCalls = (calls.calls || []).map(c => ({
      to: c.to, status: c.status, direction: c.direction,
      duration: c.duration, startTime: c.start_time,
    }));
  } catch (e) {
    report.checks.push({ check: 'recent_calls', error: e.message });
  }

  const allOk = report.checks.filter(c => c.ok === false).length === 0;
  res.json({ ok: allOk, report });
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

module.exports = router;

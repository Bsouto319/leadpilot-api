require('dotenv').config();
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err.message);
  console.error(err.stack);
  process.exit(1);
});
const express   = require('express');
const path      = require('path');
const cron      = require('node-cron');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const logger    = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const webhookRoutes = require('./routes/webhook');
const adminRoutes   = require('./routes/admin');
const cronRoutes    = require('./routes/cron');
const db         = require('./services/supabase');
const twilioSvc  = require('./services/twilio');
const gmailSvc   = require('./services/gmail');
const { processThumbtackLead } = require('./services/thumbtack');
const { handleError } = require('./middleware/alerting');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Coolify/Railway reverse proxy — required for express-rate-limit + req.ip
app.set('trust proxy', 1);

// ── SECURITY HEADERS ─────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow Twilio callbacks
  contentSecurityPolicy: false, // API — no HTML to protect
}));

// ── CORS — only allow Vercel dashboard + same-origin ─────────────────────────
const ALLOWED_ORIGINS = [
  'https://leadpilot-dashboard-mu.vercel.app',
  'https://cpcabinets.com',
  'https://www.cpcabinets.com',
  process.env.DASHBOARD_URL,
].filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
// Admin: 120 req/min per IP — plenty for dashboard usage, blocks bots
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});

// Cron: very tight — only internal calls should hit these
const cronLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests.' },
});

// ── BODY PARSING with size limits ────────────────────────────────────────────
// Twilio sends form-encoded bodies for webhooks
app.use('/webhook', express.urlencoded({ extended: false, limit: '32kb' }));
// Audio preview: raw binary blob — type '*/*' catches audio/webm;codecs=opus and any variant
app.use('/api/admin/audio-call-preview', express.raw({ type: '*/*', limit: '5mb' }));
// CF7 routes: read body as raw text first so we can handle both JSON and URL-encoded
// regardless of Content-Type (CF7 plugin sometimes sends URL-encoded with application/json header)
app.use(['/webhook/cf7', '/api/webhook/cf7'], express.text({ type: '*/*', limit: '32kb' }), (req, res, next) => {
  if (typeof req.body === 'string' && req.body.length > 0) {
    const raw = req.body;
    try {
      req.body = JSON.parse(raw);
    } catch {
      req.body = require('querystring').parse(raw);
    }
    req._body = true;
  }
  next();
});
app.use(express.json({ limit: '64kb' }));

// ── STATIC FILES ──────────────────────────────────────────────────────────────
app.use('/dashboard', express.static(path.join(__dirname, '..', 'public', 'dashboard')));
// Dashboard assets também em /assets/ — Vite gera paths absolutos sem o prefixo /dashboard
app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'dashboard', 'assets')));
app.get('/call', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'call.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'terms.html')));
app.get('/schedule/cp-cabinets', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'schedule-cp.html')));
app.get('/privacy/cp-cabinets', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'privacy-cp-cabinets.html')));
app.get('/terms/cp-cabinets',   (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'terms-cp-cabinets.html')));

// ── AUDIO — serve pre-generated ElevenLabs MP3s (public — Twilio fetches these)
// Routes:  GET /audio/:clientId/:phraseKey   (all phrases)
//          GET /audio/greeting/:clientId     (backward compat)
const elevenlabsSvc = require('./services/elevenlabs');

function serveAudio(res, buf, label) {
  if (!buf) return res.status(404).send(`Audio "${label}" not generated yet. POST /api/admin/elevenlabs-phrases first.`);
  const etag = `"${buf.length.toString(16)}"`;
  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'public, max-age=604800, immutable'); // 7 days — regeneração muda a URL via novo deploy
  res.set('ETag', etag);
  if (res.req.headers['if-none-match'] === etag) return res.status(304).end();
  res.set('Content-Length', buf.length);
  res.send(buf);
}

app.get('/audio/:clientId/:phraseKey', async (req, res) => {
  let buf = elevenlabsSvc.getBuffer(req.params.clientId, req.params.phraseKey);
  if (!buf) {
    try {
      const client = await db.getClientByIdAdmin(req.params.clientId);
      if (client) {
        buf = await elevenlabsSvc.generateSinglePhrase(
          req.params.clientId,
          req.params.phraseKey,
          client.business_name,
          client.elevenlabs_voice_id || 'hope',
          client.agent_name
        );
      }
    } catch (err) {
      logger.warn('server', `on-demand ElevenLabs regen failed [${req.params.phraseKey}]: ${err.message}`);
    }
  }
  serveAudio(res, buf, req.params.phraseKey);
});

app.get('/audio/greeting/:clientId', (req, res) => {
  const buf = elevenlabsSvc.getGreetingBuffer(req.params.clientId);
  serveAudio(res, buf, 'greeting');
});

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.use('/webhook', webhookRoutes);
app.use('/api/admin', adminLimiter, adminRoutes);
app.use('/api/cron',  cronLimiter,  cronRoutes);

// ── CF7 COMPAT — handles old /api/webhook/cf7 path (no clientId in URL)
// Identifies client by CF7 form ID (_wpcf7 field sent automatically in every submission)
const CF7_FORM_MAP = {
  '53': '5221cab9-a741-4ddc-a752-2359826fba95', // CP Cabinets
};
app.post('/api/webhook/cf7', express.urlencoded({ extended: true }), express.json(), async (req, res) => {
  res.sendStatus(200);
  const body     = req.body;
  const formId   = String(body._wpcf7 || '');
  const clientId = CF7_FORM_MAP[formId] || body.clientId;
  logger.info('cf7-compat', `form=${formId} clientId=${clientId} fields=${JSON.stringify(body)}`);
  if (!clientId) { logger.warn('cf7-compat', `unknown form ID ${formId}`); return; }

  const leadName  = body['your-name']    || body['name']    || 'Customer';
  const leadEmail = body['your-email']   || body['email']   || null;
  const rawPhone  = body['your-phone']   || body['your-phone-number'] || body['phone'] || body['tel'] || '';
  const visitDate = body['your-date']    || body['date']    || '';
  const bestTime  = body['your-subject'] || body['subject'] || body['time'] || '';

  if (!rawPhone) { logger.warn('cf7-compat', `form ${formId}: missing phone — keys: ${Object.keys(body).join(', ')}`); return; }

  const serviceNote = [
    visitDate && `Preferred visit date: ${visitDate}`,
    bestTime  && `Best time: ${bestTime}`,
  ].filter(Boolean).join(' | ') || 'Website contact form';

  processThumbtackLead({ clientId, leadPhone: rawPhone, leadName, leadEmail, serviceNote, source: 'website' })
    .catch(err => logger.warn('cf7-compat', err.message));
});

app.get('/', (req, res) => res.redirect('/dashboard'));

app.use(errorHandler);

app.listen(PORT, () => {
  logger.info('server', `LeadPilot API running on port ${PORT}`);
  startCronJobs();
  // Pre-warm client cache so first inbound call has zero DB latency
  db.preWarmClientCache().catch(err => logger.warn('server', `cache pre-warm failed: ${err.message}`));
  // Regenerate ElevenLabs phrases after every deploy (/tmp is wiped on restart)
  // Retries até 3x com backoff se ElevenLabs API falhar (rate limit, timeout, etc.)
  async function warmupElevenLabs(clients, attempt = 1) {
    for (const client of clients) {
      const voiceId = client.elevenlabs_voice_id || 'hope';
      try {
        await elevenlabsSvc.generateAllClientPhrases(client.id, client.business_name, voiceId, client.agent_name);
        logger.info('server', `ElevenLabs phrases ready: ${client.business_name} (voice=${voiceId} agent=${client.agent_name || 'Lexy'})`);
      } catch (err) {
        logger.warn('server', `ElevenLabs regen [${client.business_name}] attempt ${attempt}: ${err.message}`);
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 8000 * attempt));
          await warmupElevenLabs([client], attempt + 1);
        } else {
          logger.error('server', `ElevenLabs warmup failed after 3 attempts for ${client.business_name} — on-demand regen will handle per-call`);
        }
      }
    }
  }

  db.getClientsWithElevenLabs()
    .then(clients => { if (clients.length) warmupElevenLabs(clients); })
    .catch(err => logger.warn('server', `ElevenLabs startup regen failed: ${err.message}`));
});

process.on('unhandledRejection', (reason) => {
  logger.error('process', 'unhandledRejection', String(reason));
});

function startCronJobs() {
  const { sendEmail } = require('./services/gmail');

  const { sendAppointmentReminderToLead, sendAppointmentReminderToStaff } = require('./services/followup');

  // Every day at 9am — 24h reminder to lead + staff for tomorrow's appointments
  cron.schedule('0 9 * * *', async () => {
    logger.info('cron', 'running appointment-reminder email job');
    try {
      const appointments = await db.getAppointmentsDueTomorrow();
      for (const conv of appointments) {
        const client = conv.clients;
        if (!client) continue;
        // Email to lead (if they have email)
        if (conv.lead_email) {
          await sendAppointmentReminderToLead(conv).catch(err =>
            logger.warn('cron', `lead reminder failed conv=${conv.id}: ${err.message}`)
          );
        }
        // Email to Eveline + Sarah
        await sendAppointmentReminderToStaff(conv, { isUrgent: false }).catch(err =>
          logger.warn('cron', `staff reminder failed conv=${conv.id}: ${err.message}`)
        );
        await db.markReminderSent(conv.id);
        logger.info('cron', `24h reminder sent for conv=${conv.id} lead=${conv.lead_phone}`);
      }
    } catch (err) { handleError('cron-reminders', err).catch(() => {}); }
  }, { timezone: 'America/New_York' });

  // Every 30 min — 2h-before reminder to staff only
  cron.schedule('*/30 * * * *', async () => {
    try {
      const upcoming = await db.getAppointmentsIn2Hours();
      for (const conv of upcoming) {
        await sendAppointmentReminderToStaff(conv, { isUrgent: true }).catch(err =>
          logger.warn('cron', `2h staff reminder failed conv=${conv.id}: ${err.message}`)
        );
        await db.markReminder2hSent(conv.id);
        logger.info('cron', `2h reminder sent for conv=${conv.id} lead=${conv.lead_phone}`);
      }
    } catch (err) { handleError('cron-2h-reminders', err).catch(() => {}); }
  });

  // Every 30 min — retry outbound call for leads that didn't answer
  cron.schedule('*/30 * * * *', async () => {
    try {
      const leads = await db.getLeadsForCallRetry();
      for (const conv of leads) {
        const client = conv.clients;
        if (!client || !conv.lead_phone) continue;
        const BASE = process.env.BASE_URL || 'https://leads.btechsouto.shop';
        try {
          const call = await twilioSvc.makeCall({
            to: `+${conv.lead_phone}`,
            from: client.twilio_number,
            voiceScript: conv.ai_response || `Hi! This is ${client.business_name}. We tried reaching you earlier about your request. Please give us a call back at your earliest convenience!`,
            statusCallbackUrl: `${BASE}/webhook/call-status`,
            intakeUrl: `${BASE}/webhook/voice-outbound-intake?conversationId=${conv.id}&clientId=${client.id}`,
            credentials: client.twilio_account_sid ? { accountSid: client.twilio_account_sid, authToken: client.twilio_auth_token } : null,
          });
          await db.updateConversation(conv.id, {
            call_sid: call.sid,
            call_status: call.status,
            call_attempted_at: new Date().toISOString(),
            next_call_retry_at: null,
          });
          logger.info('cron', `retry call placed conv=${conv.id} retry=${conv.call_retry_count} sid=${call.sid}`);
        } catch (err) {
          logger.warn('cron', `retry call failed conv=${conv.id}: ${err.message}`);
        }
      }
    } catch (err) { handleError('cron-call-retry', err).catch(() => {}); }
  });

  // No-show auto-detection DISABLED — leads stay in 'scheduled' until manually moved by the owner.

  // Every Monday at 8am — weekly performance report to all clients
  cron.schedule('0 8 * * 1', async () => {
    logger.info('cron', 'running weekly report');
    try {
      const stats = await db.getWeeklyStats();
      for (const s of stats) {
        if (!s.client || !s.client.owner_phone) continue;
        const conversion = s.total > 0 ? Math.round((s.scheduled / s.total) * 100) : 0;
        const msg =
          `📊 LeadPilot — Resumo Semanal\n${s.client.business_name}\n` +
          `Leads recebidos: ${s.total}\n` +
          `Visitas agendadas: ${s.scheduled}\n` +
          `Conversão: ${conversion}%\n` +
          `Powered by LeadPilot`;
        await twilioSvc.sendSms({ to: s.client.owner_phone, from: s.client.twilio_number, body: msg });
        logger.info('cron', `weekly report → ${s.client.business_name}`);
      }
    } catch (err) { handleError('cron-weekly', err).catch(() => {}); }
  }, { timezone: 'America/New_York' });

  // Every 10 minutes — poll Gmail for Thumbtack lead emails (clients with gmail_refresh_token)
  cron.schedule('*/10 * * * *', async () => {
    try {
      const clients = await db.getClientsWithGmailToken();
      for (const client of clients) {
        const leads = await gmailSvc.fetchThumbtackLeads(client.gmail_refresh_token);
        for (const lead of leads) {
          if (!lead.leadPhone) {
            logger.warn('cron-thumbtack', `no phone found in email for client ${client.business_name}, skipping`);
            continue;
          }
            await processThumbtackLead({
            clientId: client.id,
            leadPhone: lead.leadPhone,
            leadName: lead.leadName,
            serviceNote: lead.serviceNote,
          });
        }
      }
    } catch (err) { handleError('cron-thumbtack', err).catch(() => {}); }
  });

  // Follow-up emails: Day 2 (48h) and Day 5 (120h) for leads that didn't answer Alice
  const { runFollowUpCron } = require('./services/followup');
  cron.schedule('0 */12 * * *', async () => {
    try { await runFollowUpCron(2); } catch (err) { handleError('cron-followup-2', err).catch(() => {}); }
    try { await runFollowUpCron(3); } catch (err) { handleError('cron-followup-3', err).catch(() => {}); }
  });

  logger.info('server', 'cron jobs scheduled: appt-reminder@9am, 2h-reminder@every30min, call-retry@every30min, weekly-report@mon8am, thumbtack-poll@every10min, followup-emails@every12h');
}

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
app.use(express.json({ limit: '64kb' }));

// ── STATIC FILES ──────────────────────────────────────────────────────────────
app.use('/dashboard', express.static(path.join(__dirname, '..', 'public', 'dashboard')));
app.get('/call', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'call.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'terms.html')));
app.get('/schedule/cp-cabinets', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'schedule-cp.html')));

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
  const rawPhone  = body['your-phone']   || body['phone']   || body['tel'] || '';
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

  // Every day at 9am — email owner about appointments scheduled for tomorrow
  cron.schedule('0 9 * * *', async () => {
    logger.info('cron', 'running appointment-reminder email job');
    try {
      const appointments = await db.getAppointmentsDueTomorrow();
      for (const conv of appointments) {
        const client = conv.clients;
        if (!client?.owner_email) continue;
        const tz = client.timezone || 'America/New_York';
        const formatted = new Date(conv.scheduled_at).toLocaleString('en-US', {
          timeZone: tz, weekday: 'long', month: 'long', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
        const address = conv.lead_address ? `\nAddress: ${conv.lead_address}` : '';
        await sendEmail({
          from: `${client.business_name} <noreply@btechsouto.shop>`,
          to: client.owner_email,
          subject: `📅 Tomorrow's Appointment — ${client.business_name}`,
          body: `Reminder: you have a visit scheduled for TOMORROW.\n\nName: ${conv.lead_name || 'Customer'}\nPhone: +${conv.lead_phone}\nDate: ${formatted}${address}\nService: ${(conv.service_type || '').replace(/_/g, ' ')}\n\n${client.business_name}`,
        });
        await db.markReminderSent(conv.id);
        logger.info('cron', `appointment reminder email → ${client.owner_email} for lead ${conv.lead_phone}`);
      }
    } catch (err) { handleError('cron-reminders', err).catch(() => {}); }
  }, { timezone: 'America/New_York' });

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

  logger.info('server', 'cron jobs scheduled: appt-reminder-email@9am, no-show-check@6pm, weekly-report@mon8am, thumbtack-poll@every10min');
}

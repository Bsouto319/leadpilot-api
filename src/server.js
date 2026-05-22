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
app.use(express.json({ limit: '64kb' }));

// ── STATIC FILES ──────────────────────────────────────────────────────────────
app.use('/dashboard', express.static(path.join(__dirname, '..', 'public', 'dashboard')));
app.get('/call', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'call.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'terms.html')));

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

app.get('/audio/:clientId/:phraseKey', (req, res) => {
  const buf = elevenlabsSvc.getBuffer(req.params.clientId, req.params.phraseKey);
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

app.get('/', (req, res) => res.redirect('/dashboard'));

app.use(errorHandler);

app.listen(PORT, () => {
  logger.info('server', `LeadPilot API running on port ${PORT}`);
  startCronJobs();
  // Pre-warm client cache so first inbound call has zero DB latency
  db.preWarmClientCache().catch(err => logger.warn('server', `cache pre-warm failed: ${err.message}`));
  // Regenerate ElevenLabs phrases after every deploy (/tmp is wiped on restart)
  db.getClientsWithElevenLabs()
    .then(async (clients) => {
      if (!clients.length) return;
      for (const client of clients) {
        const voiceId = client.elevenlabs_voice_id || 'hope';
        await elevenlabsSvc.generateAllClientPhrases(client.id, client.business_name, voiceId)
          .catch(err => logger.warn('server', `ElevenLabs regen [${client.business_name}]: ${err.message}`));
        logger.info('server', `ElevenLabs phrases ready: ${client.business_name} (voice=${voiceId})`);
      }
    })
    .catch(err => logger.warn('server', `ElevenLabs startup regen failed: ${err.message}`));
});

process.on('unhandledRejection', (reason) => {
  logger.error('process', 'unhandledRejection', String(reason));
});

function startCronJobs() {
  // Reminder SMS to leads disabled — email-only policy

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

  logger.info('server', 'cron jobs scheduled: reminders@9am, weekly-report@mon8am, thumbtack-poll@every10min');
}

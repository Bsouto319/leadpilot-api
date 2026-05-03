require('dotenv').config();
const express = require('express');
const path    = require('path');
const cron    = require('node-cron');
const logger  = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const webhookRoutes = require('./routes/webhook');
const adminRoutes   = require('./routes/admin');
const cronRoutes    = require('./routes/cron');
const db     = require('./services/supabase');
const twilioSvc  = require('./services/twilio');
const { handleError } = require('./middleware/alerting');

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio sends form-encoded bodies
app.use('/webhook', express.urlencoded({ extended: false }));
app.use(express.json());

// Static dashboard
app.use('/dashboard', express.static(path.join(__dirname, '..', 'public', 'dashboard')));

// Routes
app.use('/webhook', webhookRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/cron',  cronRoutes);

app.get('/', (req, res) => res.redirect('/dashboard'));

app.use(errorHandler);

app.listen(PORT, () => {
  logger.info('server', `LeadPilot API running on port ${PORT}`);
  startCronJobs();
});

process.on('unhandledRejection', (reason) => {
  logger.error('process', 'unhandledRejection', String(reason));
});

function startCronJobs() {
  // Every day at 9am — 24h reminders for tomorrow's appointments
  cron.schedule('0 9 * * *', async () => {
    logger.info('cron', 'running reminders job');
    try {
      const appointments = await db.getAppointmentsDueTomorrow();
      for (const conv of appointments) {
        const client = conv.clients;
        if (!client) continue;
        const tz = client.timezone || 'America/New_York';
        const formatted = new Date(conv.scheduled_at).toLocaleString('en-US', {
          timeZone: tz, weekday: 'long', month: 'long', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
        const name    = conv.lead_name && conv.lead_name !== 'Customer' ? ` ${conv.lead_name}` : '';
        const address = conv.lead_address ? `\n📍 ${conv.lead_address}` : '';
        await twilioSvc.sendSms({
          to: `+${conv.lead_phone}`, from: client.twilio_number,
          body: `Hi${name}! Confirming your FREE estimate with ${client.business_name} tomorrow — ${formatted}.${address}\n\nReply STOP to cancel.`,
        });
        await db.markReminderSent(conv.id);
        logger.info('cron', `reminder sent → ${conv.lead_phone}`);
      }
    } catch (err) { handleError('cron-reminders', err).catch(() => {}); }
  }, { timezone: 'America/New_York' });

  // Every day at 10am — D+3 and D+7 follow-ups for cold leads
  cron.schedule('0 10 * * *', async () => {
    logger.info('cron', 'running followups job');
    try {
      const { d3Leads, d7Leads } = await db.getLeadsPendingFollowup();
      for (const conv of d3Leads) {
        const client = conv.clients;
        if (!client) continue;
        const name = conv.lead_name && conv.lead_name !== 'Customer' ? ` ${conv.lead_name}` : '';
        await twilioSvc.sendSms({
          to: `+${conv.lead_phone}`, from: client.twilio_number,
          body: `Hi${name}! This is ${client.business_name} following up on your ${(conv.service_type || 'project').replace(/_/g, ' ')} request.\n\nWe still have availability this week for a FREE estimate. What day works best? 📅\n\nReply STOP to opt out.`,
        });
        await db.markFollowupSent(conv.id, 'd3');
        logger.info('cron', `d3 followup → ${conv.lead_phone}`);
      }
      for (const conv of d7Leads) {
        const client = conv.clients;
        if (!client) continue;
        const name = conv.lead_name && conv.lead_name !== 'Customer' ? ` ${conv.lead_name}` : '';
        await twilioSvc.sendSms({
          to: `+${conv.lead_phone}`, from: client.twilio_number,
          body: `Hi${name}! Last chance — ${client.business_name} has a few openings next week for FREE estimates.\n\nInterested? Reply with a day and time! 📅\n\nReply STOP to opt out.`,
        });
        await db.markFollowupSent(conv.id, 'd7');
        logger.info('cron', `d7 followup → ${conv.lead_phone}`);
      }
    } catch (err) { handleError('cron-followups', err).catch(() => {}); }
  }, { timezone: 'America/New_York' });

  // Every day at 6pm — review requests for completed appointments
  cron.schedule('0 18 * * *', async () => {
    logger.info('cron', 'running reviews job');
    try {
      const completed = await db.getCompletedAppointments();
      for (const conv of completed) {
        const client = conv.clients;
        if (!client) continue;
        const name       = conv.lead_name && conv.lead_name !== 'Customer' ? ` ${conv.lead_name}` : '';
        const reviewLink = client.google_review_link ? `\n\n⭐ We'd love your review: ${client.google_review_link}` : '';
        await twilioSvc.sendSms({
          to: `+${conv.lead_phone}`, from: client.twilio_number,
          body: `Hi${name}! Thank you for choosing ${client.business_name}. We hope you're happy with the work! 🙏${reviewLink}\n\nReply STOP to opt out.`,
        });
        await db.markReviewSent(conv.id);
        logger.info('cron', `review request → ${conv.lead_phone}`);
      }
    } catch (err) { handleError('cron-reviews', err).catch(() => {}); }
  }, { timezone: 'America/New_York' });

  // Every day at 8pm — no-show re-engagement
  cron.schedule('0 20 * * *', async () => {
    logger.info('cron', 'running noshows job');
    try {
      const noShows = await db.getNoShowLeads();
      for (const conv of noShows) {
        const client = conv.clients;
        if (!client) continue;
        const name = conv.lead_name && conv.lead_name !== 'Customer' ? ` ${conv.lead_name}` : '';
        await twilioSvc.sendSms({
          to: `+${conv.lead_phone}`, from: client.twilio_number,
          body: `Hi${name}! We missed you today. No worries — ${client.business_name} would love to reschedule your FREE estimate.\n\nWhat day works for you? 📅\n\nReply STOP to opt out.`,
        });
        await db.updateConversation(conv.id, { stage: 'no_show' });
        logger.info('cron', `no-show re-engagement → ${conv.lead_phone}`);
      }
    } catch (err) { handleError('cron-noshows', err).catch(() => {}); }
  }, { timezone: 'America/New_York' });

  // Every Monday at 8am — weekly performance report to all clients
  cron.schedule('0 8 * * 1', async () => {
    logger.info('cron', 'running weekly report');
    try {
      const stats = await db.getWeeklyStats();
      for (const s of stats) {
        if (!s.client || !s.client.owner_phone) continue;
        const conversion = s.total > 0 ? Math.round((s.scheduled / s.total) * 100) : 0;
        const msg =
          `📊 LeadPilot Weekly – ${s.client.business_name}\n` +
          `Leads: ${s.total} | Scheduled: ${s.scheduled}\n` +
          `Conversion: ${conversion}%\n` +
          `Powered by LeadPilot`;
        await twilioSvc.sendSms({ to: s.client.owner_phone, from: s.client.twilio_number, body: msg });
        logger.info('cron', `weekly report → ${s.client.business_name}`);
      }
    } catch (err) { handleError('cron-weekly', err).catch(() => {}); }
  }, { timezone: 'America/New_York' });

  logger.info('server', 'cron jobs scheduled: reminders@9am, followups@10am, reviews@6pm, noshows@8pm, weekly-report@mon8am');
}

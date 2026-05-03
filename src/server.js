require('dotenv').config();
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err.message);
  console.error(err.stack);
  process.exit(1);
});
const express = require('express');
const path    = require('path');
const cron    = require('node-cron');
const logger  = require('./utils/logger');
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
          body: `📅 Reminder, ${name || 'hey'}! Your FREE estimate with ${client.business_name} is TOMORROW — ${formatted}.${address}\n\nWe'll be there! Any questions, just reply here. See you soon! 😊\n\nReply STOP to cancel.`,
          credentials: client.twilio_account_sid ? { accountSid: client.twilio_account_sid, authToken: client.twilio_auth_token } : null,
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
        const service = (conv.service_type || 'project').replace(/_/g, ' ');
        await twilioSvc.sendSms({
          to: `+${conv.lead_phone}`, from: client.twilio_number,
          body: `Hey${name}! 🏠 Still thinking about that ${service}? ${client.business_name} just opened up a couple spots THIS week for FREE in-home estimates. We'd love to get yours scheduled — first come, first served! What day works for you? 📅\n\nReply STOP to opt out.`,
          credentials: client.twilio_account_sid ? { accountSid: client.twilio_account_sid, authToken: client.twilio_auth_token } : null,
        });
        await db.markFollowupSent(conv.id, 'd3');
        logger.info('cron', `d3 followup → ${conv.lead_phone}`);
      }
      for (const conv of d7Leads) {
        const client = conv.clients;
        if (!client) continue;
        const name7 = conv.lead_name && conv.lead_name !== 'Customer' ? ` ${conv.lead_name}` : '';
        const service7 = (conv.service_type || 'project').replace(/_/g, ' ');
        await twilioSvc.sendSms({
          to: `+${conv.lead_phone}`, from: client.twilio_number,
          body: `${name7 || 'Hey'}! 🙏 Last chance — ${client.business_name} has ONE final opening before we're fully booked for the month on ${service7}. FREE estimate, zero obligation, we come to you. Reply with a day and we'll lock it in right now 🔒\n\nReply STOP to opt out.`,
          credentials: client.twilio_account_sid ? { accountSid: client.twilio_account_sid, authToken: client.twilio_auth_token } : null,
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
        const nameR      = conv.lead_name && conv.lead_name !== 'Customer' ? ` ${conv.lead_name}` : '';
        const reviewLink = client.google_review_link ? `\n\n⭐ If we knocked it out of the park, a quick Google review means the WORLD to us — takes less than 60 seconds: ${client.google_review_link}` : '';
        await twilioSvc.sendSms({
          to: `+${conv.lead_phone}`, from: client.twilio_number,
          body: `Hi${nameR}! 🏠 Hope the work turned out exactly how you imagined! It was a pleasure working with you. Thank you for choosing ${client.business_name}! 🙏${reviewLink}\n\nReply STOP to opt out.`,
          credentials: client.twilio_account_sid ? { accountSid: client.twilio_account_sid, authToken: client.twilio_auth_token } : null,
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
        const nameNS = conv.lead_name && conv.lead_name !== 'Customer' ? ` ${conv.lead_name}` : '';
        await twilioSvc.sendSms({
          to: `+${conv.lead_phone}`, from: client.twilio_number,
          body: `Hey${nameNS}! Looks like we missed each other today 😅 Totally fine — life happens! ${client.business_name} would love to find a time that works better. What day this week or next looks good for you? 📅\n\nReply STOP to opt out.`,
          credentials: client.twilio_account_sid ? { accountSid: client.twilio_account_sid, authToken: client.twilio_auth_token } : null,
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

  logger.info('server', 'cron jobs scheduled: reminders@9am, followups@10am, reviews@6pm, noshows@8pm, weekly-report@mon8am, thumbtack-poll@every10min');
}

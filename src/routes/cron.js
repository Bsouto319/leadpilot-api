const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../services/supabase');
const twilioSvc   = require('../services/twilio');
const calendarSvc = require('../services/calendar');
const { handleError } = require('../middleware/alerting');
const logger  = require('../utils/logger');

function authMiddleware(req, res, next) {
  const key      = req.headers['x-admin-key'] || '';
  const expected = process.env.ADMIN_KEY || '';
  try {
    const ok = key && expected && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
    if (!ok) return res.status(401).json({ error: 'Unauthorized' });
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(authMiddleware);

// POST /cron/reminders — send 24h reminders for tomorrow's appointments
router.post('/reminders', async (req, res) => {
  res.json({ ok: true, job: 'reminders' });
  try {
    const appointments = await db.getAppointmentsDueTomorrow();
    logger.info('cron', `reminders: found ${appointments.length} appointments`);
    for (const conv of appointments) {
      const client = conv.clients;
      if (!client) continue;
      const tz = client.timezone || 'America/New_York';
      const formatted = new Date(conv.scheduled_at).toLocaleString('en-US', {
        timeZone: tz, weekday: 'long', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
      const name = conv.lead_name && conv.lead_name !== 'Customer' ? ` ${conv.lead_name}` : '';
      const address = conv.lead_address ? `\n📍 Address: ${conv.lead_address}` : '';
      await twilioSvc.sendSms({
        to: `+${conv.lead_phone}`,
        from: client.twilio_number,
        body: `Hi${name}! Just confirming your FREE estimate with ${client.business_name} tomorrow — ${formatted}.${address}\n\nReply STOP to cancel.`,
      });
      await db.markReminderSent(conv.id);
      logger.info('cron', `reminder sent to ${conv.lead_phone}`);
    }
  } catch (err) {
    handleError('cron-reminders', err).catch(() => {});
  }
});

// POST /cron/followups — D+3 and D+7 for leads that never scheduled
router.post('/followups', async (req, res) => {
  res.json({ ok: true, job: 'followups' });
  try {
    const { d3Leads, d7Leads } = await db.getLeadsPendingFollowup();
    logger.info('cron', `followups: d3=${d3Leads.length} d7=${d7Leads.length}`);

    for (const conv of d3Leads) {
      const client = conv.clients;
      if (!client) continue;
      const name = conv.lead_name && conv.lead_name !== 'Customer' ? ` ${conv.lead_name}` : '';
      await twilioSvc.sendSms({
        to: `+${conv.lead_phone}`,
        from: client.twilio_number,
        body: `Hi${name}! This is ${client.business_name} following up on your ${conv.service_type?.replace(/_/g, ' ')} request.\n\nWe still have availability this week for a FREE estimate. What day works best for you?\n\nReply STOP to opt out.`,
      });
      await db.markFollowupSent(conv.id, 'd3');
      logger.info('cron', `d3 followup sent to ${conv.lead_phone}`);
    }

    for (const conv of d7Leads) {
      const client = conv.clients;
      if (!client) continue;
      const name = conv.lead_name && conv.lead_name !== 'Customer' ? ` ${conv.lead_name}` : '';
      await twilioSvc.sendSms({
        to: `+${conv.lead_phone}`,
        from: client.twilio_number,
        body: `Hi${name}! Last chance — ${client.business_name} has a few openings next week for FREE estimates.\n\nInterested? Reply with a day and time and we'll lock it in! 📅\n\nReply STOP to opt out.`,
      });
      await db.markFollowupSent(conv.id, 'd7');
      logger.info('cron', `d7 followup sent to ${conv.lead_phone}`);
    }
  } catch (err) {
    handleError('cron-followups', err).catch(() => {});
  }
});

// POST /cron/reviews — request Google review after completed appointments
router.post('/reviews', async (req, res) => {
  res.json({ ok: true, job: 'reviews' });
  try {
    const completed = await db.getCompletedAppointments();
    logger.info('cron', `reviews: found ${completed.length} to request`);
    for (const conv of completed) {
      const client = conv.clients;
      if (!client) continue;
      const name = conv.lead_name && conv.lead_name !== 'Customer' ? ` ${conv.lead_name}` : '';
      const reviewLink = client.google_review_link || '';
      const reviewPart = reviewLink ? `\n\n⭐ Leave us a quick review: ${reviewLink}` : '';
      await twilioSvc.sendSms({
        to: `+${conv.lead_phone}`,
        from: client.twilio_number,
        body: `Hi${name}! Thank you for choosing ${client.business_name}. We hope you're happy with the work! 🙏${reviewPart}\n\nReply STOP to opt out.`,
      });
      await db.markReviewSent(conv.id);
      logger.info('cron', `review request sent to ${conv.lead_phone}`);
    }
  } catch (err) {
    handleError('cron-reviews', err).catch(() => {});
  }
});

// POST /cron/noshows — re-engage leads that missed their appointment
router.post('/noshows', async (req, res) => {
  res.json({ ok: true, job: 'noshows' });
  try {
    const noShows = await db.getNoShowLeads();
    logger.info('cron', `noshows: found ${noShows.length}`);
    for (const conv of noShows) {
      const client = conv.clients;
      if (!client) continue;
      const name = conv.lead_name && conv.lead_name !== 'Customer' ? ` ${conv.lead_name}` : '';
      await twilioSvc.sendSms({
        to: `+${conv.lead_phone}`,
        from: client.twilio_number,
        body: `Hi${name}! We missed you today. No worries — ${client.business_name} would love to reschedule your FREE estimate.\n\nWhat day works for you? 📅\n\nReply STOP to opt out.`,
      });
      await db.updateConversation(conv.id, { stage: 'no_show' });
      logger.info('cron', `no-show re-engagement sent to ${conv.lead_phone}`);
    }
  } catch (err) {
    handleError('cron-noshows', err).catch(() => {});
  }
});

module.exports = router;

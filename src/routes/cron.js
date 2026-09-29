const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../services/supabase');
const twilioSvc   = require('../services/twilio');
const calendarSvc = require('../services/calendar');
const { handleError } = require('../middleware/alerting');
const logger  = require('../utils/logger');
const { extractLeadFromText } = require('../services/openai');

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
// NOTE: stage is NOT changed to 'no_show' — team moves manually
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
      logger.info('cron', `no-show re-engagement sent to ${conv.lead_phone}`);
    }
  } catch (err) {
    handleError('cron-noshows', err).catch(() => {});
  }
});

// POST /cron/prospect-test — dispara web miner + digest manualmente (override de destinatários)
router.post('/prospect-test', async (req, res) => {
  const override = req.body?.recipients || null;
  res.json({ ok: true, job: 'prospect-test', recipients: override });
  try {
    const { runRedditProspectorTest } = require('../services/redditProspector');
    await runRedditProspectorTest(override);
  } catch (err) {
    handleError('cron-prospect-test', err).catch(() => {});
  }
});

// POST /cron/prospect-digest — envia apenas o digest com prospects pendentes (sem scraping)
router.post('/prospect-digest', async (req, res) => {
  const override = req.body?.recipients || null;
  res.json({ ok: true, job: 'prospect-digest', recipients: override });
  try {
    const { sendPendingDigest } = require('../services/redditProspector');
    await sendPendingDigest(override);
  } catch (err) {
    handleError('cron-prospect-digest', err).catch(() => {});
  }
});

// POST /cron/competitor-intel — dispara competitor intel manualmente
router.post('/competitor-intel', async (req, res) => {
  res.json({ ok: true, job: 'competitor-intel' });
  try {
    const { runCompetitorIntelCron } = require('../services/competitorIntel');
    await runCompetitorIntelCron();
  } catch (err) {
    handleError('cron-competitor-intel-manual', err).catch(() => {});
  }
});

function parseDataBR(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// POST /cron/manual-lead — cria/atualiza um lead manualmente (usado pelo
// assistente de WhatsApp do Bruno pra organizar leads que chegam fora do
// webhook automático, ex: SMS/telefone direto na MD Flooring Solutions).
// Recebe o texto cru (transcrição de áudio ou texto digitado) e faz a
// extração por IA aqui mesmo -- assim a função Edge que recebe o WhatsApp
// não precisa de uma chave OpenAI própria, só chama esse endpoint.
router.post('/manual-lead', async (req, res) => {
  const { client_id, raw_text, service_type, timezone } = req.body || {};
  if (!client_id || !raw_text) {
    return res.status(400).json({ ok: false, error: 'client_id e raw_text são obrigatórios' });
  }

  let campos;
  try {
    campos = await extractLeadFromText(raw_text, timezone);
  } catch (err) {
    logger.warn('manual-lead', `erro na extração: ${err.message}`);
    return res.status(500).json({ ok: false, error: 'Erro ao processar com IA: ' + err.message });
  }
  if (!campos || !campos.cliente_nome) {
    return res.json({ ok: false, error: 'Não entendi o cliente/orçamento no texto enviado.' });
  }

  const { acao, cliente_nome, telefone, resumo, data_retorno, endereco } = campos;
  const data_retorno_iso = parseDataBR(data_retorno);
  const extras = (data_retorno ? `\n📅 Retorno: ${data_retorno}` : '') + (telefone ? `\n📞 ${telefone}` : '');

  try {
    if (acao === 'atualizar') {
      const supabase = db.adminSupabaseClient();
      const { data: existentes, error: findErr } = await supabase
        .from('conversations')
        .select('id, lead_name')
        .eq('client_id', client_id)
        .ilike('lead_name', cliente_nome);
      if (findErr) throw findErr;

      if (existentes && existentes.length === 1) {
        const fields = { email_body: resumo };
        if (data_retorno_iso) fields.scheduled_at = data_retorno_iso;
        if (telefone) fields.lead_phone = telefone;
        await db.updateConversation(existentes[0].id, fields);
        return res.json({ ok: true, action: 'updated', message: `${cliente_nome} atualizado — ${resumo}${extras}` });
      }
      // 0 ou 2+ resultados -- cai pro fluxo de criação, sem arriscar atualizar o registro errado.
      const aviso = existentes && existentes.length > 1
        ? `Achei ${existentes.length} clientes parecidos com "${cliente_nome}" — criei um card novo em vez de arriscar atualizar o errado.`
        : `Não achei "${cliente_nome}" no Kanban — criando um card novo.`;
      const created = await db.saveLead({
        clientId: client_id, leadPhone: telefone || null, leadName: cliente_nome,
        source: 'manual_whatsapp', serviceType: service_type || null, message: resumo,
        scheduledAt: data_retorno_iso || null, leadAddress: endereco || null,
      });
      return res.json({ ok: true, action: 'created', warning: aviso, leadId: created.id, message: `${cliente_nome} adicionado — ${resumo}${extras}` });
    }

    const created = await db.saveLead({
      clientId: client_id, leadPhone: telefone || null, leadName: cliente_nome,
      source: 'manual_whatsapp', serviceType: service_type || null, message: resumo,
      scheduledAt: data_retorno_iso || null, leadAddress: endereco || null,
    });
    res.json({ ok: true, action: 'created', leadId: created.id, message: `${cliente_nome} adicionado — ${resumo}${extras}` });
  } catch (err) {
    logger.warn('manual-lead', `erro: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

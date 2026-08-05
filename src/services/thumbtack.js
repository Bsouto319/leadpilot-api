const logger     = require('../utils/logger');
const db         = require('./supabase');
const twilioSvc  = require('./twilio');
const openaiSvc  = require('./openai');
const { makeNotifyCall } = require('./twilio');
const { sendEmail } = require('./gmail');
const { handleError } = require('../middleware/alerting');
const { buildNewLeadAlertEmail, clientBranding } = require('./followup');
const { triggerZipQualifier } = require('./zipQualifier');

function normalizePhone(raw) {
  return (raw || '').replace(/\D/g, '');
}

function detectServiceType(text) {
  const msg = (text || '').toLowerCase();
  if (/tile|tiling|grout|bullnose|porcelain/.test(msg)) return 'tile_install';
  if (/custom home|new home|build|construction/.test(msg)) return 'custom_home';
  if (/remodel|kitchen|bathroom|bath/.test(msg)) return 'remodel';
  if (/renovat/.test(msg)) return 'renovation';
  if (/repair|fix|replace|replacement/.test(msg)) return 'tile_replacement';
  if (/estimate|quote|price/.test(msg)) return 'free_estimate';
  return 'general';
}

function clientCredentials(client) {
  if (client?.twilio_account_sid && client?.twilio_auth_token) {
    return { accountSid: client.twilio_account_sid, authToken: client.twilio_auth_token };
  }
  return null;
}

async function processThumbtackLead({ clientId, leadPhone: rawPhone, leadName, serviceNote, serviceType: explicitServiceType, apiKey, thumbtackLeadId, leadEmail = null, source = 'thumbtack', scheduledAt = null, leadAddress = null }) {
  const expectedKey = process.env.THUMBTACK_WEBHOOK_SECRET;
  if (expectedKey && apiKey !== undefined && apiKey !== expectedKey) {
    logger.warn('thumbtack', 'invalid apiKey');
    return;
  }

  if (!clientId || !rawPhone) {
    logger.warn('thumbtack', 'missing clientId or leadPhone');
    return;
  }

  const leadPhone = normalizePhone(rawPhone);
  if (!leadPhone) {
    logger.warn('thumbtack', `invalid phone: ${rawPhone}`);
    return;
  }

  let client;
  try {
    client = await db.getClientById(clientId);
  } catch (err) {
    await handleError('supabase', err);
    return;
  }
  if (!client) {
    logger.warn('thumbtack', `no client found for id ${clientId}`);
    return;
  }

  // Dedup por thumbtackLeadId (evita reprocessar o mesmo lead se Thumbtack reenviar)
  if (thumbtackLeadId) {
    const existing = await db.getConversationByThumbtackLeadId(thumbtackLeadId).catch(() => null);
    if (existing) {
      logger.info('thumbtack', `thumbtackLeadId ${thumbtackLeadId} already processed, skipping`);
      return;
    }
  }

  let isDuplicate;
  try {
    // Website leads: 7-day dedup window (lead may return after seeing email catalog)
    // Other sources: 60-min window
    const dedupMinutes = source === 'website' ? 60 * 24 * 7 : 60;
    isDuplicate = await db.checkDuplicate(client.id, leadPhone, dedupMinutes);
  } catch (err) {
    await handleError('supabase', err);
    return;
  }
  if (isDuplicate) {
    logger.info('thumbtack', `duplicate lead ${leadPhone}, skipping`);
    return;
  }

  const name        = leadName || 'Customer';
  // Use explicit serviceType from form if provided; otherwise detect from note text
  const serviceType = explicitServiceType || (serviceNote ? detectServiceType(serviceNote) : 'free_estimate');
  const message     = serviceNote || 'Thumbtack lead request';

  let conversation;
  try {
    conversation = await db.saveLead({
      clientId: client.id,
      leadPhone,
      leadName: name,
      source,
      serviceType,
      message,
      thumbtackLeadId: thumbtackLeadId || null,
      leadEmail,
      scheduledAt,
      leadAddress,
    });
  } catch (err) {
    await handleError('supabase', err);
    return;
  }

  // ZIP VIP qualifier — fires async, non-blocking
  if (leadAddress) {
    triggerZipQualifier(conversation.id, client.id, leadAddress).catch(() => {});
  }

  // Confirmation email to lead immediately after capture (before call)
  if (leadEmail) {
    const { sendLeadConfirmationEmail } = require('./followup');
    sendLeadConfirmationEmail({ ...conversation, lead_email: leadEmail, clients: client })
      .catch(err => logger.warn('thumbtack', `confirmation email failed: ${err.message}`));
  }

  // Run voice script + lead qualification in parallel
  const [voiceScript, qualification] = await Promise.all([
    openaiSvc.generateVoiceScript({
      businessName: client.business_name,
      serviceType,
      pricing: client.pricing,
      systemPrompt: client.ai_system_prompt || null,
    }).catch(err => {
      handleError('openai', err).catch(() => {});
      return `Hi${name !== 'Customer' ? ` ${name}` : ''}! This is ${client.business_name}. We saw your Thumbtack request and would love to schedule a FREE in-home estimate!`;
    }),
    openaiSvc.qualifyLead({
      name,
      serviceType,
      serviceNote: message,
      businessName: client.business_name || 'the company',
      phone: leadPhone,
    }).catch(err => {
      logger.warn('thumbtack', `qualify failed: ${err.message} — stack: ${err.stack?.split('\n')[1] || ''}`);
      return { score: null, tier: null, summary: null, jobValue: null, signals: [], isSpam: false };
    }),
  ]);

  // Spam / solicitation gate — skip the call and owner alerts entirely for leads
  // that aren't genuine service requests (e.g. someone pitching SEO to the business).
  // Fails open: only skips when the AI explicitly flagged it, never on a qualify() error.
  if (qualification.isSpam) {
    await db.updateConversation(conversation.id, {
      stage: 'closed',
      ...(qualification.score != null ? { score: qualification.score } : {}),
      ...(qualification.summary    ? { summary: qualification.summary } : {}),
    }).catch(err => logger.warn('thumbtack', `updateConversation failed: ${err.message}`));
    logger.info('thumbtack', `lead flagged as spam — skipped call/alerts conv=${conversation.id} score=${qualification.score} summary=${qualification.summary}`);
    return;
  }

  // Build qualification context (used in all notification paths below)
  const tierEmoji   = qualification.tier === 'hot' ? '🔥' : qualification.tier === 'warm' ? '⚡' : '❄️';
  const scoreText   = qualification.score != null ? `${qualification.score}%` : 'N/A';
  const valueText   = qualification.jobValue ? `~$${qualification.jobValue.toLocaleString()}` : 'TBD';
  const tierLabel   = qualification.tier ? `${tierEmoji} ${qualification.tier.toUpperCase()}` : '';
  const agentName   = client.agent_name || 'Lexy';
  const sourceLabel = source === 'website' ? 'website' : 'Thumbtack';

  // Website leads with a scheduled date: notify owner/staff AND call lead to confirm
  if (scheduledAt && source === 'website') {
    const visitFormatted = new Date(scheduledAt).toLocaleString('en-US', {
      timeZone: 'America/New_York', weekday: 'short', month: 'short',
      day: 'numeric', hour: '2-digit', minute: '2-digit',
    });

    // Confirmation voice script — warmer than cold outreach
    const firstName  = name.split(' ')[0];
    const vLabel     = client.visit_label || 'scheduled visit';
    const confirmScript = `Hi ${firstName}! This is ${agentName} calling from ${client.business_name}. I'm reaching out to confirm your FREE ${vLabel} scheduled for ${visitFormatted}. We're really excited to work with you! If you have any questions before your visit, feel free to reply to our email or call us back. See you soon!`;

    await db.updateConversation(conversation.id, {
      ai_response: confirmScript,
      ...(qualification.score != null ? { score: qualification.score } : {}),
      ...(qualification.summary    ? { summary: qualification.summary } : {}),
    }).catch(err => logger.warn('thumbtack', `updateConversation failed: ${err.message}`));

    // Owner email notification — HTML
    if (client.owner_email || client.admin_email) {
      const branding = clientBranding(client);
      const vLabel   = client.visit_label || 'scheduled visit';
      const { subject: alertSubject, html: alertHtml } = buildNewLeadAlertEmail({
        leadName: name, leadPhone, leadEmail,
        serviceType,
        agentName,
        businessName: client.business_name,
        source: `${vLabel} booked for ${visitFormatted}`,
        score: qualification.score,
        tier: qualification.tier,
        summary: qualification.summary,
        signals: qualification.signals,
        leadAddress: leadAddress || null,
        ...branding,
      });
      const alertRecipients = [...new Set([client.owner_email, client.secondary_email, client.admin_email].filter(Boolean))];
      sendEmail({
        from: `${client.business_name} <noreply@btechsouto.shop>`,
        to: alertRecipients,
        subject: `${tierLabel} ${vLabel.charAt(0).toUpperCase() + vLabel.slice(1)} Booked — ${name} | ${client.business_name}`,
        html: alertHtml,
      }).catch(err => logger.warn('thumbtack', `email notify failed: ${err.message}`));
    }

    // Owner + office alert call
    const vLabel2   = client.visit_label || 'scheduled visit';
    const notifyMsg = `Hey! ${agentName} received a new website lead for ${client.business_name}. ${name} scheduled a ${vLabel2} for ${visitFormatted}. ${agentName} is calling the lead now to confirm. Check your email for full details.`;
    if (client.owner_phone) {
      makeNotifyCall({
        to: `+${client.owner_phone}`,
        from: client.twilio_number,
        message: notifyMsg,
        credentials: clientCredentials(client),
      }).catch(err => logger.warn('thumbtack', `owner notify call failed: ${err.message}`));
    }
    if (client.office_phone) {
      makeNotifyCall({
        to: `+${client.office_phone}`,
        from: client.twilio_number,
        message: notifyMsg,
        credentials: clientCredentials(client),
      }).catch(err => logger.warn('thumbtack', `office notify call failed: ${err.message}`));
    }

    // Confirmation call to lead — always call immediately (lead just submitted form)
    try {
      const BASE = process.env.BASE_URL || 'https://leads.btechsouto.shop';
      const call = await twilioSvc.makeCall({
        to: `+${leadPhone}`,
        from: client.twilio_number,
        voiceScript: confirmScript,
        statusCallbackUrl: `${BASE}/webhook/call-status`,
        intakeUrl: `${BASE}/webhook/voice-outbound-intake?conversationId=${conversation.id}&clientId=${client.id}`,
        credentials: clientCredentials(client),
      });
      await db.updateConversation(conversation.id, {
        call_sid: call.sid,
        call_status: call.status,
        call_attempted_at: new Date().toISOString(),
      });
      logger.info('thumbtack', `confirmation call placed conv=${conversation.id} sid=${call.sid}`);
    } catch (err) {
      await handleError('twilio', err);
    }

    db.appendMessage(conversation.id, 'lead', message).catch(() => {});
    logger.info('thumbtack', `website lead scheduled conv=${conversation.id} visitAt=${scheduledAt} score=${qualification.score} tier=${qualification.tier}`);
    return;
  }

  // Save voice script + AI qualification to DB.
  // form_filled leads keep their stage — address already captured, just waiting for date.
  // All other leads advance to ai_responded to signal Sofia has reached out.
  const nextStage = conversation.stage === 'form_filled' ? 'form_filled' : 'ai_responded';
  await db.updateConversation(conversation.id, {
    stage: nextStage,
    ai_response: voiceScript,
    last_response_at: new Date().toISOString(),
    ...(qualification.score != null ? { score: qualification.score } : {}),
    ...(qualification.summary    ? { summary: qualification.summary } : {}),
  }).catch(err => logger.warn('thumbtack', `updateConversation failed: ${err.message}`));

  // Outbound call to lead — always call immediately (no hour restrictions)
  const activeCallStatuses = ['queued', 'initiated', 'ringing', 'in-progress'];
  let convFresh;
  try { convFresh = await db.getConversationById(conversation.id); } catch {}
  if (convFresh?.call_sid && activeCallStatuses.includes(convFresh.call_status)) {
    logger.info('thumbtack', `skipping outbound call — active call already exists sid=${convFresh.call_sid}`);
  } else {
    try {
      const BASE = process.env.BASE_URL || 'https://leads.btechsouto.shop';
      const call = await twilioSvc.makeCall({
        to: `+${leadPhone}`,
        from: client.twilio_number,
        voiceScript,
        statusCallbackUrl: `${BASE}/webhook/call-status`,
        intakeUrl: `${BASE}/webhook/voice-outbound-intake?conversationId=${conversation.id}&clientId=${client.id}`,
        credentials: clientCredentials(client),
      });
      await db.updateConversation(conversation.id, {
        call_sid: call.sid,
        call_status: call.status,
        call_attempted_at: new Date().toISOString(),
      });
    } catch (err) {
      await handleError('twilio', err);
    }
  }

  // Notify owner via email HTML (immediate — with AI insight)
  if (client.owner_email || client.admin_email) {
    const branding = clientBranding(client);
    const { subject: alertSubject, html: alertHtml } = buildNewLeadAlertEmail({
      leadName: name, leadPhone, leadEmail,
      serviceType, agentName, businessName: client.business_name,
      source: sourceLabel,
      score: qualification.score,
      tier: qualification.tier,
      summary: qualification.summary,
      signals: qualification.signals,
      leadAddress: leadAddress || null,
      ...branding,
    });
    const alertRecipients = [...new Set([client.owner_email, client.secondary_email, client.admin_email].filter(Boolean))];
    sendEmail({
      from: `${client.business_name} <noreply@btechsouto.shop>`,
      to: alertRecipients,
      subject: alertSubject,
      html: alertHtml,
    }).catch(err => logger.warn('thumbtack', `email notify failed: ${err.message}`));
  }

  // Notify owner + office via call
  const tierVoice = qualification.tier === 'hot' ? 'This is a HIGH quality lead. ' : qualification.tier === 'warm' ? 'This is a warm lead. ' : '';
  const notifyMsg = `Hey! ${agentName} just received a new ${sourceLabel} lead for ${client.business_name}. ${tierVoice}${name} is requesting ${serviceType.replace(/_/g, ' ')}. We are calling them right now! Check your email for full details.`;

  if (client.owner_phone) {
    makeNotifyCall({
      to: `+${client.owner_phone}`,
      from: client.twilio_number,
      message: notifyMsg,
      credentials: clientCredentials(client),
    }).catch(err => logger.warn('thumbtack', `owner notify call failed: ${err.message}`));
  }
  if (client.office_phone) {
    makeNotifyCall({
      to: `+${client.office_phone}`,
      from: client.twilio_number,
      message: notifyMsg,
      credentials: clientCredentials(client),
    }).catch(err => logger.warn('thumbtack', `office notify call failed: ${err.message}`));
  }

  db.appendMessage(conversation.id, 'lead', message).catch(() => {});
  logger.info('thumbtack', `lead processed id=${conversation.id} phone=${leadPhone} score=${qualification.score} tier=${qualification.tier}`);
}

module.exports = { processThumbtackLead };

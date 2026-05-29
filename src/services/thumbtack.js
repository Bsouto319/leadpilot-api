const logger     = require('../utils/logger');
const db         = require('./supabase');
const twilioSvc  = require('./twilio');
const openaiSvc  = require('./openai');
const { makeNotifyCall } = require('./twilio');
const { sendEmail } = require('./gmail');
const { handleError } = require('../middleware/alerting');

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

async function processThumbtackLead({ clientId, leadPhone: rawPhone, leadName, serviceNote, apiKey, thumbtackLeadId, leadEmail = null, source = 'thumbtack' }) {
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
    isDuplicate = await db.checkDuplicate(client.id, leadPhone, 60);
  } catch (err) {
    await handleError('supabase', err);
    return;
  }
  if (isDuplicate) {
    logger.info('thumbtack', `duplicate lead ${leadPhone}, skipping`);
    return;
  }

  const name        = leadName || 'Customer';
  const serviceType = serviceNote ? detectServiceType(serviceNote) : 'free_estimate';
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
    });
  } catch (err) {
    await handleError('supabase', err);
    return;
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
      return { score: null, tier: null, summary: null, jobValue: null, signals: [] };
    }),
  ]);

  // Save voice script + AI qualification to DB
  await db.updateConversation(conversation.id, {
    stage: 'ai_responded',
    ai_response: voiceScript,
    last_response_at: new Date().toISOString(),
    ...(qualification.score != null ? { score: qualification.score } : {}),
    ...(qualification.summary    ? { summary: qualification.summary } : {}),
  }).catch(err => logger.warn('thumbtack', `updateConversation failed: ${err.message}`));

  // Outbound call to lead (Lexy)
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

  // Build qualification context for notifications
  const tierEmoji  = qualification.tier === 'hot' ? '🔥' : qualification.tier === 'warm' ? '⚡' : '❄️';
  const scoreText  = qualification.score != null ? `${qualification.score}%` : 'N/A';
  const valueText  = qualification.jobValue ? `~$${qualification.jobValue.toLocaleString()}` : 'TBD';
  const tierLabel  = qualification.tier ? `${tierEmoji} ${qualification.tier.toUpperCase()}` : '';

  // Notify owner via email (immediate — with AI insight)
  if (client.owner_email) {
    const emailBody = [
      `New ${source === 'website' ? 'website' : 'Thumbtack'} lead received!`,
      ``,
      `Name: ${name}`,
      `Phone: +${leadPhone}`,
      `Service: ${serviceType.replace(/_/g, ' ')}`,
      `Request: ${message}`,
      ``,
      `── AI Qualification ──`,
      `Score: ${scoreText}  |  Tier: ${tierLabel}  |  Est. Job Value: ${valueText}`,
      qualification.summary ? `Insight: ${qualification.summary}` : '',
      qualification.signals?.length ? `Signals: ${qualification.signals.join(', ')}` : '',
      ``,
      `${client.agent_name || 'Lexy'} is calling them now.`,
      ``,
      `Dashboard: https://app.contatobtech.com.br`,
      client.website_url ? `Website: ${client.website_url}` : '',
      ``,
      client.business_name,
    ].filter(Boolean).join('\n');

    sendEmail({
      from: `${client.business_name} <noreply@btechsouto.shop>`,
      to: client.owner_email,
      subject: `${tierLabel} Lead ${scoreText} — ${name} | ${client.business_name}`,
      body: emailBody,
    }).catch(err => logger.warn('thumbtack', `email notify failed: ${err.message}`));
  }

  // Notify owner + office via call (owner_phone and office_phone)
  const agentName  = client.agent_name || 'Lexy';
  const sourceLabel = source === 'website' ? 'website' : 'Thumbtack';
  const tierVoice  = qualification.tier === 'hot' ? 'This is a HIGH quality lead. ' : qualification.tier === 'warm' ? 'This is a warm lead. ' : '';
  const notifyMsg  = `Hey! ${agentName} just received a new ${sourceLabel} lead for ${client.business_name}. ${tierVoice}${name} is requesting ${serviceType.replace(/_/g, ' ')}. We are calling them right now! Check your email for full details.`;

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

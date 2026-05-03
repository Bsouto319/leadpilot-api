const logger     = require('../utils/logger');
const db         = require('./supabase');
const twilioSvc  = require('./twilio');
const openaiSvc  = require('./openai');
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

async function processThumbtackLead({ clientId, leadPhone: rawPhone, leadName, serviceNote, apiKey }) {
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
      source: 'thumbtack',
      serviceType,
      message,
    });
  } catch (err) {
    await handleError('supabase', err);
    return;
  }

  let voiceScript;
  try {
    voiceScript = await openaiSvc.generateVoiceScript({
      businessName: client.business_name,
      serviceType,
      pricing: client.pricing,
      systemPrompt: client.ai_system_prompt || null,
    });
  } catch (err) {
    await handleError('openai', err);
    voiceScript = `Hi${name !== 'Customer' ? ` ${name}` : ''}! This is ${client.business_name}. We saw your Thumbtack request and would love to schedule a FREE in-home estimate. Please reply with a day and time that works for you!`;
  }

  await db.updateConversation(conversation.id, {
    stage: 'ai_responded',
    ai_response: voiceScript,
    last_response_at: new Date().toISOString(),
  }).catch(() => {});

  const hi = name !== 'Customer' ? `Hi ${name}!` : 'Hi there!';

  try {
    const smsBody = `${hi} 🏠 ${client.business_name} here — saw your Thumbtack request and calling you RIGHT NOW!\n\nIf we miss you, reply with your best day & time for a FREE estimate. We have openings this week! 📅\n\nReply STOP to opt out.`;
    await twilioSvc.sendSms({
      to: `+${leadPhone}`,
      from: client.twilio_number,
      body: smsBody,
      credentials: clientCredentials(client),
    });
    db.appendMessage(conversation.id, 'ai', smsBody).catch(() => {});
  } catch (err) {
    await handleError('twilio', err);
  }

  try {
    const BASE = process.env.BASE_URL || 'http://asso488k40o4gsc8c0w80gcw.31.97.240.160.sslip.io';
    const call = await twilioSvc.makeCall({
      to: `+${leadPhone}`,
      from: client.twilio_number,
      voiceScript,
      statusCallbackUrl: `${BASE}/webhook/call-status`,
      gatherUrl: `${BASE}/webhook/call-gather?conversationId=${conversation.id}&clientId=${client.id}`,
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

  try {
    await twilioSvc.sendSms({
      to: client.owner_phone,
      from: client.twilio_number,
      body: `🔔 THUMBTACK LEAD – ${client.business_name}\nName: ${name}\nPhone: +${leadPhone}\nService: ${serviceType}\nNote: ${message}\n\nCall + SMS sent automatically.`,
      credentials: clientCredentials(client),
    });
  } catch (err) {
    await handleError('twilio', err);
  }

  db.appendMessage(conversation.id, 'lead', message).catch(() => {});
  logger.info('thumbtack', `lead processed id=${conversation.id} phone=${leadPhone} client=${client.business_name}`);
}

module.exports = { processThumbtackLead };

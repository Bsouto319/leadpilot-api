const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const db = require('../services/supabase');
const twilioSvc = require('../services/twilio');
const openaiSvc = require('../services/openai');
const calendarSvc = require('../services/calendar');
const { handleError } = require('../middleware/alerting');
const { processThumbtackLead } = require('../services/thumbtack');
const elevenlabs = require('../services/elevenlabs');

// Helper: returns <Play> if ElevenLabs phrase cached, otherwise <Say> fallback.
// Dynamic prefix (lead name, service, etc.) is always <Say> — short and cheap.
function el(client, phraseKey, fallbackText, dynamicPrefix) {
  const BASE = process.env.BASE_URL || 'http://asso488k40o4gsc8c0w80gcw.31.97.240.160.sslip.io';
  const hasEl = client.elevenlabs_greeting_url && elevenlabs.hasPhrase(client.id, phraseKey);
  const say   = (t) => `<Say voice="Polly.Joanna" language="en-US">${t}</Say>`;

  if (!hasEl) return say(dynamicPrefix ? `${dynamicPrefix} ${fallbackText}` : fallbackText);

  const play = `<Play>${elevenlabs.phraseUrl(BASE, client.id, phraseKey)}</Play>`;
  // Dynamic prefix (e.g. "Nice to meet you, John!") stays as Polly — short text, imperceptible quality diff
  return dynamicPrefix ? `${say(dynamicPrefix)} ${play}` : play;
}

// Simple in-memory rate limiter: max 10 requests per IP per minute
const rateLimitMap = new Map();
function webhookRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const window = 60_000;
  const max = 10;
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > window) { entry.count = 0; entry.start = now; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  if (entry.count > max) {
    logger.warn('webhook', `rate limit hit from ${ip}`);
    return res.status(429).send('Too Many Requests');
  }
  next();
}

// US compliance: detect opt-out / opt-in / help keywords (TCPA mandatory)
function detectComplianceKeyword(text) {
  const msg = (text || '').trim().toUpperCase();
  if (/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT)$/.test(msg)) return 'stop';
  if (/^(START|UNSTOP|YES)$/.test(msg)) return 'start';
  if (/^HELP$/.test(msg)) return 'help';
  return null;
}

// US compliance: check if current time is within business hours for the client timezone
function isWithinBusinessHours(timezone = 'America/New_York') {
  const now = new Date();
  const hour = parseInt(now.toLocaleString('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }));
  return hour >= 8 && hour < 21; // 8am–9pm
}

function detectHumanHandoff(text) {
  const msg = (text || '').toLowerCase();
  return /\b(speak\s+to\s+(a\s+)?(human|person|someone|agent|representative|rep)|talk\s+to\s+(a\s+)?(human|person|someone|agent|representative|rep)|want\s+(a\s+)?(human|person|someone|agent)|call\s+me(\s+back)?|just\s+call|can\s+you\s+call|please\s+call|i\s+want\s+a\s+person|stop\s+(texting|messaging|the\s+texts)|real\s+person|live\s+(agent|person|support)|human\s+(agent|support)|frustrated|this\s+isn'?t\s+working|not\s+working|doesn'?t\s+work|useless|this\s+is\s+(terrible|horrible|ridiculous)|this\s+sucks|operator)\b/.test(msg);
}

async function handleHumanHandoff({ client, conversation, message }) {
  const leadPhone = conversation.lead_phone;
  const leadName  = conversation.lead_name || 'Customer';

  try {
    await db.updateConversation(conversation.id, {
      stage: 'handoff',
      last_response_at: new Date().toISOString(),
    });
  } catch (err) {
    await handleError('supabase', err);
  }

  try {
    await twilioSvc.sendSms({
      to: `+${leadPhone}`,
      from: client.twilio_number,
      body: `Absolutely! Connecting you with a real person from ${client.business_name} now 📞 Expect a call within minutes. Thanks for your patience!`,
      credentials: clientCredentials(client),
    });
  } catch (err) {
    await handleError('twilio', err);
  }

  try {
    await twilioSvc.sendSms({
      to: client.owner_phone,
      from: client.twilio_number,
      body: `⚠️ ATENÇÃO – ${client.business_name}\nCliente quer falar com humano!\nNome: ${leadName}\nFone: +${leadPhone}\nMensagem: "${message}"\n\nLigue diretamente para esse cliente agora.`,
      credentials: clientCredentials(client),
    });
  } catch (err) {
    await handleError('twilio', err);
  }

  logger.info('webhook', `human handoff triggered for ${leadPhone}`);
}

function detectDisinterest(text) {
  const msg = (text || '').toLowerCase();
  return /\b(not\s+interested|no\s+thanks|no\s+thank\s+you|wrong\s+number|remove\s+(me|my\s+number)|don'?t\s+(contact|text|call|message)\s+me|stop\s+contacting|leave\s+me\s+alone|not\s+looking|already\s+(found|hired|have\s+someone)|don'?t\s+need(\s+this)?|nevermind|never\s+mind|i'?m\s+good|changed\s+my\s+mind|cancel(\s+that)?|no\s+longer\s+(need|interested))\b/.test(msg);
}

function isLikelyQuestion(text) {
  const msg = (text || '').trim().toLowerCase();
  const hasDate = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|morning|afternoon|evening|\bam\b|\bpm\b|\d{1,2}[\/\-]\d{1,2}|next\s+week|this\s+week|today|tonight)\b/.test(msg);
  if (hasDate) return false;
  if (msg.includes('?')) return true;
  if (/^(how\s|what\s|where\s|which\s|who\s|why\s|do\s+you|are\s+you|can\s+you|will\s+you|is\s+there|does\s+your|have\s+you|how\s+much|how\s+long|do\s+you\s+do|do\s+you\s+work)\b/.test(msg)) return true;
  return false;
}

async function answerWithAI({ client, message }) {
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const base = client.ai_system_prompt
      ? `You are a helpful assistant for ${client.business_name}. ${client.ai_system_prompt}`
      : `You are a helpful assistant for ${client.business_name}. Answer questions briefly and professionally.`;
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 80,
      messages: [
        {
          role: 'system',
          content: `${base}\n\nAnswer the customer's question in 1-2 sentences. End by inviting them to schedule a FREE estimate. Keep the response concise (under 160 chars if possible).`,
        },
        { role: 'user', content: message },
      ],
    });
    return completion.choices[0].message.content.trim();
  } catch {
    return null;
  }
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

function normalizePhone(raw) {
  return (raw || '').replace(/\D/g, '');
}

function clientCredentials(client) {
  if (client?.twilio_account_sid && client?.twilio_auth_token) {
    return { accountSid: client.twilio_account_sid, authToken: client.twilio_auth_token };
  }
  return null;
}

async function extractLeadName(message) {
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 20,
      messages: [
        { role: 'system', content: 'Extract the person\'s first name from the message. If no name is mentioned, reply with exactly: Customer. Reply ONLY with the name, nothing else.' },
        { role: 'user', content: message },
      ],
    });
    const name = res.choices[0].message.content.trim().split(' ')[0];
    return name || 'Customer';
  } catch {
    return 'Customer';
  }
}

// Twilio inbound SMS
router.post('/sms', webhookRateLimit, twilioSvc.twilioSignatureMiddleware, (req, res) => {
  // Respond immediately so Twilio doesn't timeout
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  // Process async
  processSms(req.body).catch(err => handleError('webhook', err));
});

async function processSms(body) {
  const leadPhone   = normalizePhone(body.From);
  const twilioNumber = (body.To || '').trim();
  const message     = body.Body || '';

  if (!leadPhone) {
    logger.warn('webhook', 'SMS received with no From number, skipping');
    return;
  }

  logger.info('webhook', `inbound SMS from=${leadPhone} to=${twilioNumber}`);

  // US Compliance: handle STOP / HELP / START before anything else
  const keyword = detectComplianceKeyword(message);
  if (keyword === 'stop') {
    // Twilio handles opt-out automatically at carrier level,
    // but we must also confirm in plain text per TCPA
    try {
      let clientForStop;
      try { clientForStop = await db.getClientByTwilioNumber(twilioNumber); } catch {}
      await twilioSvc.sendSms({
        to: `+${leadPhone}`,
        from: twilioNumber,
        body: `You have been unsubscribed from ${clientForStop ? clientForStop.business_name : 'our service'} notifications. No more messages will be sent. Reply START to re-subscribe.`,
        credentials: clientCredentials(clientForStop),
      });
      await db.optOutLead(leadPhone, twilioNumber);
    } catch {}
    logger.info('webhook', `STOP received from ${leadPhone}`);
    return;
  }
  if (keyword === 'help') {
    try {
      let clientForHelp;
      try { clientForHelp = await db.getClientByTwilioNumber(twilioNumber); } catch {}
      await twilioSvc.sendSms({
        to: `+${leadPhone}`,
        from: twilioNumber,
        body: `${clientForHelp ? clientForHelp.business_name : 'LeadPilot'}: Reply to schedule your free estimate. Reply STOP to unsubscribe. Msg&Data rates may apply.`,
        credentials: clientCredentials(clientForHelp),
      });
    } catch {}
    return;
  }
  if (keyword === 'start') {
    try {
      await db.optInLead(leadPhone, twilioNumber);
    } catch {}
    // fall through to normal processing
  }

  // Check opt-out list before processing
  let isOptedOut = false;
  try { isOptedOut = await db.isOptedOut(leadPhone, twilioNumber); } catch {}
  if (isOptedOut) {
    logger.info('webhook', `lead ${leadPhone} is opted out, skipping`);
    return;
  }

  const serviceType = detectServiceType(message);

  // 1. Client + CNAM lookup + name from message — tudo em paralelo
  let client, leadName;
  try {
    const [cnam, nameFromMsg, clientResult] = await Promise.all([
      twilioSvc.lookupCallerName(`+${leadPhone}`),
      extractLeadName(message),
      db.getClientByTwilioNumber(twilioNumber),
    ]);
    // CNAM tem prioridade — é o nome real do cadastro da operadora
    leadName = cnam || nameFromMsg || 'Customer';
    client   = clientResult;
    if (cnam) logger.info('webhook', `CNAM resolved: ${leadPhone} → ${cnam}`);
  } catch (err) {
    await handleError('supabase', err);
    return;
  }
  if (!client) {
    logger.warn('webhook', `no active client for number ${twilioNumber}`);
    return;
  }

  // 2. Check if lead already exists (scheduling or address reply)
  const existingConv = await db.getExistingConversation(client.id, leadPhone);
  if (existingConv) {
    // Log incoming message to history
    db.appendMessage(existingConv.id, 'lead', message).catch(() => {});

    if (existingConv.stage === 'handoff') {
      logger.info('webhook', `lead ${leadPhone} already in human handoff, skipping AI`);
      return;
    }
    if (existingConv.stage === 'closed') {
      logger.info('webhook', `lead ${leadPhone} is closed (disinterest), skipping`);
      return;
    }
    if (detectDisinterest(message)) {
      await db.closeLead(existingConv.id);
      logger.info('webhook', `lead ${leadPhone} expressed disinterest — closed`);
      return;
    }
    if (detectHumanHandoff(message)) {
      await handleHumanHandoff({ client, conversation: existingConv, message });
      return;
    }
    if (existingConv.stage === 'no_show') {
      logger.info('webhook', `no-show lead ${leadPhone} responded — restarting scheduling`);
      await db.updateConversation(existingConv.id, { stage: 'ai_responded' });
      await processSchedulingReply({ client, conversation: { ...existingConv, stage: 'ai_responded' }, message });
      return;
    }
    if (existingConv.stage === 'awaiting_address') {
      logger.info('webhook', `address reply from ${leadPhone}`);
      await processAddressReply({ client, conversation: existingConv, message });
      return;
    }
    if (existingConv.stage === 'ai_responded') {
      logger.info('webhook', `scheduling reply from ${leadPhone} — processing date`);
      await processSchedulingReply({ client, conversation: existingConv, message });
      return;
    }
  }

  // 2. Anti-duplicate
  let isDuplicate;
  try {
    isDuplicate = await db.checkDuplicate(client.id, leadPhone, 60);
  } catch (err) {
    await handleError('supabase', err);
    return;
  }
  if (isDuplicate) {
    logger.info('webhook', `duplicate lead ${leadPhone} for client ${client.id}, skipping`);
    return;
  }

  // 3. Save lead
  let conversation;
  try {
    conversation = await db.saveLead({
      clientId: client.id,
      leadPhone,
      leadName,
      source: 'sms',
      serviceType,
      message,
    });
  } catch (err) {
    await handleError('supabase', err);
    return;
  }

  // 3b. If new lead is immediately requesting a human, skip AI flow
  if (detectHumanHandoff(message)) {
    await handleHumanHandoff({ client, conversation, message });
    return;
  }

  // 4. Generate voice script
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
    voiceScript = client.voice_script || `Hi! This is ${client.business_name}. We received your flooring request and would love to schedule a FREE in-home estimate. Please reply with your preferred date and time. Thank you!`;
  }

  // 5. Mark as ai_responded BEFORE call so scheduling reply detection works
  try {
    await db.updateConversation(conversation.id, {
      stage: 'ai_responded',
      ai_response: voiceScript,
      last_response_at: new Date().toISOString(),
    });
  } catch (err) {
    await handleError('supabase', err);
  }

  // 6. Make outbound call immediately — lead initiated contact so consent is established
  // SMS is only sent as fallback via call-status webhook if call is not answered
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

  // 8. Google Calendar (non-critical)
  if (client.google_refresh_token && client.google_calendar_id) {
    try {
      await calendarSvc.createFollowUpEvent({
        refreshToken: client.google_refresh_token,
        calendarId: client.google_calendar_id,
        leadPhone,
        serviceType,
        message,
        voiceScript,
      });
    } catch (err) {
      await handleError('calendar', err);
    }
  }

  // 9. Notify owner
  try {
    await twilioSvc.sendSms({
      to: client.owner_phone,
      from: client.twilio_number,
      body: `🔔 NOVO LEAD – ${client.business_name}\nNome: ${leadName}\nFone: +${leadPhone}\nServiço: ${serviceType.replace(/_/g, ' ')}\n\nLigação + SMS enviados automaticamente ✅`,
      credentials: clientCredentials(client),
    });
  } catch (err) {
    await handleError('twilio', err);
  }

  // Log first message to history
  db.appendMessage(conversation.id, 'lead', message).catch(() => {});

  logger.info('webhook', `lead processed id=${conversation.id} phone=${leadPhone}`);
}

// Process scheduling reply from lead
async function processAddressReply({ client, conversation, message }) {
  if (detectDisinterest(message)) {
    await db.closeLead(conversation.id);
    logger.info('webhook', `lead ${conversation.lead_phone} not interested in awaiting_address — closed`);
    return;
  }
  if (detectHumanHandoff(message)) {
    await handleHumanHandoff({ client, conversation, message });
    return;
  }

  // If lead sends a date correction instead of an address, re-parse date
  const looksLikeDate = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next\s+\w+|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[\/\-]\d{1,2}|\d+(am|pm)|morning|afternoon|evening)\b/i.test(message);
  if (looksLikeDate && !/\d+\s+\w+\s+(st|street|ave|avenue|blvd|dr|drive|rd|road|lane|ln|way|court|ct)/i.test(message)) {
    logger.info('webhook', `date correction received in awaiting_address stage from ${conversation.lead_phone}`);
    await db.updateConversation(conversation.id, { stage: 'ai_responded' });
    await processSchedulingReply({ client, conversation: { ...conversation, stage: 'ai_responded' }, message });
    return;
  }

  try {
    const address = message.trim();
    const tz = client.timezone || 'America/New_York';
    const formatted = new Date(conversation.scheduled_at).toLocaleString('en-US', {
      timeZone: tz, weekday: 'long', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    await db.updateConversation(conversation.id, {
      lead_address: address,
      stage: 'scheduled',
      collected_data: { ...(conversation.collected_data || {}), address },
      last_response_at: new Date().toISOString(),
    });

    // Update calendar event with address
    if (client.google_refresh_token && client.google_calendar_id) {
      try {
        await calendarSvc.updateEventAddress({
          refreshToken: client.google_refresh_token,
          calendarId: client.google_calendar_id,
          leadPhone: conversation.lead_phone,
          address,
          scheduledAt: conversation.scheduled_at,
        });
      } catch (err) {
        await handleError('calendar', err);
      }
    }

    const confirmBody = `🎉 You're confirmed!\n\n📋 ${client.business_name} FREE Estimate\n📅 ${formatted}\n📍 ${address}\n\nWe can't wait — see you then! Questions? Just reply here.\nReply STOP to cancel.`;
    await twilioSvc.sendSms({
      to: `+${conversation.lead_phone}`,
      from: client.twilio_number,
      body: confirmBody,
      credentials: clientCredentials(client),
    });
    db.appendMessage(conversation.id, 'ai', confirmBody).catch(() => {});

    await twilioSvc.sendSms({
      to: client.owner_phone,
      from: client.twilio_number,
      body: `📍 ENDEREÇO CONFIRMADO – ${client.business_name}\nNome: ${conversation.lead_name}\nFone: +${conversation.lead_phone}\nData: ${formatted}\nEndereço: ${address}\n\nVisita confirmada ✅`,
      credentials: clientCredentials(client),
    });

    logger.info('webhook', `address captured for ${conversation.lead_phone}: ${address}`);
  } catch (err) {
    await handleError('address-capture', err);
  }
}

// Máximo de respostas AI por SMS por conversa — evita loops e gastos excessivos
const MAX_SMS_AI_RESPONSES = parseInt(process.env.MAX_SMS_AI_RESPONSES || '5');

async function processSchedulingReply({ client, conversation, message }) {
  if (detectDisinterest(message)) {
    await db.closeLead(conversation.id);
    logger.info('webhook', `lead ${conversation.lead_phone} not interested — closed`);
    return;
  }
  if (detectHumanHandoff(message)) {
    await handleHumanHandoff({ client, conversation, message });
    return;
  }

  const cd = conversation.collected_data || {};
  const smsAiCount = cd.sms_ai_responses || 0;

  // Limite atingido → handoff automático (para o loop e elimina gastos extras)
  if (smsAiCount >= MAX_SMS_AI_RESPONSES) {
    logger.warn('webhook', `SMS AI limit reached (${smsAiCount}) for ${conversation.lead_phone} — auto handoff`);
    await handleHumanHandoff({ client, conversation, message });
    return;
  }

  // Start fresh-fetch early so DB query runs in parallel with answerWithAI
  const freshPromise = db.getConversationById(conversation.id);

  // If lead asked a question (not a date), answer it and wait for scheduling reply
  if (isLikelyQuestion(message)) {
    const answer = await answerWithAI({ client, message });
    if (answer) {
      await twilioSvc.sendSms({
        to: `+${conversation.lead_phone}`,
        from: client.twilio_number,
        body: answer + '\n\nReply STOP to opt out.',
        credentials: clientCredentials(client),
      });
      db.appendMessage(conversation.id, 'ai', answer).catch(() => {});
      // Incrementa contador de respostas AI para este lead
      await db.updateConversation(conversation.id, {
        collected_data: { ...cd, sms_ai_responses: smsAiCount + 1 },
      }).catch(() => {});
      logger.info('webhook', `Q&A answered (${smsAiCount + 1}/${MAX_SMS_AI_RESPONSES}) for ${conversation.lead_phone}: "${message.substring(0, 60)}"`);
      return; // stay in ai_responded — wait for date reply
    }
  }

  // Deduplication: re-fetch to confirm stage hasn't changed since webhook fired
  const fresh = await freshPromise;
  if (!fresh || fresh.stage !== 'ai_responded') {
    logger.info('webhook', `scheduling reply skipped — stage changed to ${fresh?.stage} (duplicate webhook)`);
    return;
  }
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const now = new Date().toISOString();
    const tz  = client.timezone || 'America/New_York';

    // Parse date/time from SMS
    const localNow = new Date().toLocaleString('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 100,
      messages: [
        {
          role: 'system',
          content: `Current date and time in ${tz}: ${localNow}. Extract a specific ISO 8601 datetime from the user's message. Rules: "next Monday" means the very next Monday on the calendar. "tomorrow" means exactly the next calendar day. If vague time (e.g. "afternoon"), pick 2pm. If no day mentioned, use next business day. If message contains NO date or time info at all, respond INVALID. Respond ONLY with the ISO datetime string, nothing else.`,
        },
        { role: 'user', content: message },
      ],
    });

    const raw = completion.choices[0].message.content.trim();

    // If GPT couldn't find a date, ask the lead to clarify (conta como resposta AI)
    if (raw === 'INVALID' || isNaN(Date.parse(raw))) {
      const clarifyCount = (cd.sms_ai_responses || 0) + 1;
      if (clarifyCount > MAX_SMS_AI_RESPONSES) {
        await handleHumanHandoff({ client, conversation, message });
        return;
      }
      await twilioSvc.sendSms({
        to: `+${conversation.lead_phone}`,
        from: client.twilio_number,
        body: `Hey! 😊 Just need a day and time to lock in your FREE estimate with ${client.business_name}. We're super flexible — something like "Monday at 2pm" or "Friday morning" works great. What do you have? 📅`,
        credentials: clientCredentials(client),
      });
      await db.updateConversation(conversation.id, {
        collected_data: { ...cd, sms_ai_responses: clarifyCount },
      }).catch(() => {});
      logger.info('webhook', `could not parse date from reply: "${message}", asked lead to clarify (${clarifyCount}/${MAX_SMS_AI_RESPONSES})`);
      return;
    }

    const isoDate = raw;
    const scheduledDate = new Date(isoDate);
    const formatted = scheduledDate.toLocaleString('en-US', {
      timeZone: tz,
      weekday: 'long', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    // Update conversation — awaiting address before final confirmation
    await db.updateConversation(conversation.id, {
      stage: 'awaiting_address',
      scheduled_at: isoDate,
      collected_data: { preferred_datetime: isoDate, sms_reply: message },
      last_response_at: new Date().toISOString(),
    });

    // Create calendar event (placeholder — will update with address)
    if (client.google_refresh_token && client.google_calendar_id) {
      try {
        await calendarSvc.createFollowUpEvent({
          refreshToken: client.google_refresh_token,
          calendarId: client.google_calendar_id,
          leadPhone: conversation.lead_phone,
          serviceType: conversation.service_type,
          message: `Scheduled via SMS reply: "${message}"`,
          voiceScript: `Estimate visit at ${isoDate}`,
        });
      } catch (err) {
        await handleError('calendar', err);
      }
    }

    // Ask for address to complete booking
    const addressRequestBody = `${formatted} is on the books! 🙌\n\nOne last thing — what's the address for the estimate? Just street, city, and state. 📍`;
    await twilioSvc.sendSms({
      to: `+${conversation.lead_phone}`,
      from: client.twilio_number,
      body: addressRequestBody,
      credentials: clientCredentials(client),
    });
    db.appendMessage(conversation.id, 'ai', addressRequestBody).catch(() => {});

    // Notify owner of pending appointment
    await twilioSvc.sendSms({
      to: client.owner_phone,
      from: client.twilio_number,
      body: `📅 VISITA MARCADA – ${client.business_name}\nNome: ${conversation.lead_name || 'Cliente'}\nFone: +${conversation.lead_phone}\nServiço: ${(conversation.service_type || '').replace(/_/g, ' ')}\nData: ${formatted}\n\nAguardando endereço do cliente...`,
      credentials: clientCredentials(client),
    });

    logger.info('webhook', `scheduled lead ${conversation.lead_phone} for ${isoDate}`);
  } catch (err) {
    await handleError('scheduling', err);
  }
}

// Twilio call status callback
router.post('/call-status', async (req, res) => {
  res.sendStatus(200);
  const { CallSid, CallStatus, ErrorCode, ErrorMessage, Direction, To, From } = req.body;
  if (!CallSid) return;

  if (ErrorCode) {
    const friendly = ErrorCode === '21216'
      ? 'Conta restrita pelo provedor para chamadas +1 — aguardar suporte Twilio'
      : ErrorMessage || 'Erro desconhecido';
    logger.error('webhook', `call_error sid=${CallSid} direction=${Direction || '?'} to=${To || '?'} from=${From || '?'} code=${ErrorCode} msg=${friendly}`);
  } else {
    logger.info('webhook', `call_status sid=${CallSid} status=${CallStatus} direction=${Direction || '?'} to=${To || '?'}`);
  }

  try {
    await db.updateConversationByCallSid(CallSid, {
      call_status: CallStatus,
      ...(ErrorCode ? { call_error_code: String(ErrorCode) } : {}),
    });
  } catch (err) {
    handleError('supabase', err).catch(() => {});
  }

  // Fallback SMS when outbound call to lead was not answered
  if (Direction === 'outbound-api' && ['no-answer', 'busy', 'failed'].includes(CallStatus)) {
    try {
      const conv = await db.getConversationByCallSid(CallSid);
      if (conv && conv.clients) {
        const client = conv.clients;
        const leadName = conv.lead_name && conv.lead_name !== 'Caller' && conv.lead_name !== 'Customer' ? conv.lead_name : null;
        const hi = leadName ? `Hi ${leadName}!` : 'Hi there!';
        const serviceLabel = (conv.service_type || 'project').replace(/_/g, ' ');
        const smsBody = `${hi} 🏠 This is ${client.business_name} — we just tried calling you about your ${serviceLabel} project!\n\nNo worries — this is just our first reach-out. A real person from our team will personally follow up with you very soon 👷\n\nWant to schedule a call at a specific time? Just reply with when works best and we'll call you then. FREE estimate, zero commitment.\n\nReply STOP to opt out.`;
        await twilioSvc.sendSms({
          to: `+${conv.lead_phone}`,
          from: client.twilio_number,
          body: smsBody,
          credentials: clientCredentials(client),
        });
        db.appendMessage(conv.id, 'ai', smsBody).catch(() => {});
        logger.info('webhook', `fallback SMS sent to ${conv.lead_phone} after ${CallStatus} outbound call`);
      }
    } catch (err) {
      handleError('twilio', err).catch(() => {});
    }
  }
});

// Twilio speech gather — lead responded with preferred date/time
router.post('/call-gather', async (req, res) => {
  const { SpeechResult, conversationId, clientId } = { ...req.body, ...req.query };
  const speech = SpeechResult || '';

  logger.info('webhook', `call-gather speech="${speech}" conv=${conversationId}`);

  if (!speech) {
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response><Say voice="Polly.Joanna" language="en-US">We didn't catch that. We'll follow up with you soon. Thank you!</Say></Response>`);
  }

  // Parse date/time and book calendar async
  processGather({ speech, conversationId, clientId }).catch(err => handleError('gather', err));

  res.set('Content-Type', 'text/xml');
  res.send(`<Response>
  <Say voice="Polly.Joanna" language="en-US">Perfect! We have noted your preference and our team will confirm shortly. Thank you and have a wonderful day!</Say>
</Response>`);
});

async function processGather({ speech, conversationId, clientId }) {
  // 1. Get conversation + client data
  const conv = await db.getConversationWithClient(conversationId);
  if (!conv) return;

  const client = conv.clients;

  // 2. Parse date/time with GPT
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const now = new Date().toISOString();

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 100,
    messages: [
      {
        role: 'system',
        content: `Today is ${now}. The user said when they want an appointment. Extract a specific ISO 8601 datetime. If vague (e.g. "tomorrow afternoon"), pick 2pm. If no day mentioned, assume next business day. Respond ONLY with the ISO datetime, nothing else. Timezone: ${client.timezone || 'America/New_York'}.`,
      },
      { role: 'user', content: speech },
    ],
  });

  const isoDate = completion.choices[0].message.content.trim();
  logger.info('webhook', `parsed date from speech: ${isoDate}`);

  const startDate = new Date(isoDate);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // +1h

  // 3. Save preference to Supabase
  await db.updateConversation(conversationId, {
    stage: 'scheduled',
    collected_data: { preferred_datetime: isoDate, speech_input: speech },
    last_response_at: new Date().toISOString(),
  });

  // 4. Google Calendar (if client has refresh token)
  if (client.google_refresh_token && client.google_calendar_id) {
    try {
      await calendarSvc.createFollowUpEvent({
        refreshToken: client.google_refresh_token,
        calendarId: client.google_calendar_id,
        leadPhone: conv.lead_phone,
        serviceType: conv.service_type,
        message: `Scheduled via voice call. Lead said: "${speech}"`,
        voiceScript: `Estimate visit at ${isoDate}`,
      });
      logger.info('webhook', `calendar event created for ${isoDate}`);
    } catch (err) {
      await handleError('calendar', err);
    }
  }

  // 5. Notify owner with scheduled time
  try {
    await twilioSvc.sendSms({
      to: client.owner_phone,
      from: client.twilio_number,
      body: `✅ AGENDADO POR VOZ – ${client.business_name}\nFone: +${conv.lead_phone}\nServiço: ${(conv.service_type || '').replace(/_/g, ' ')}\nData: ${startDate.toLocaleString('pt-BR', { timeZone: client.timezone || 'America/New_York', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}\nCliente disse: "${speech}"`,
      credentials: clientCredentials(client),
    });
  } catch (err) {
    await handleError('twilio', err);
  }
}

// ── INBOUND CALL — AI INTAKE CONVERSATION ────────────────────────────────────
// Lead liga → IA atende, coleta serviço + data + endereço → salva lead completo
// Rodrigo vê no dashboard e decide quando confirmar/ligar de volta

router.post('/voice', webhookRateLimit, (req, res) => {
  startVoiceIntake(req, res).catch(err => {
    logger.error('webhook', 'voice intake error', err.message);
    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Say voice="Polly.Joanna" language="en-US">We're sorry, we're experiencing a technical issue. Please try again in a moment. Goodbye!</Say></Response>`);
  });
});

async function startVoiceIntake(req, res) {
  const leadPhone    = normalizePhone(req.body.From);
  const twilioNumber = (req.body.To || '').trim();
  const callSid      = req.body.CallSid || '';

  logger.info('webhook', `inbound call from=${leadPhone} to=${twilioNumber}`);

  // Única operação no caminho crítico — o cache cobre chamadas repetidas em <60s
  let client;
  try { client = await db.getClientByTwilioNumber(twilioNumber); } catch {}
  if (!client) {
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response><Say voice="Polly.Joanna" language="en-US">This number is not currently active. Goodbye!</Say></Response>`);
  }

  const BASE = process.env.BASE_URL || 'http://asso488k40o4gsc8c0w80gcw.31.97.240.160.sslip.io';

  // Modo manual: toca no browser antes de cair na IA
  if (client.manual_mode) {
    // Ainda precisa de conversa para o fallback — cria async antes de responder
    db.getExistingConversation(client.id, leadPhone).catch(() => null).then(async existingConv => {
      let conv = existingConv;
      if (!conv) conv = await db.saveLead({ clientId: client.id, leadPhone, leadName: 'Caller', source: 'inbound_call', serviceType: 'general', message: '[Inbound call]' }).catch(() => null);
      if (conv) await db.updateConversation(conv.id, { call_sid: callSid, stage: 'new_lead', collected_data: { voice_stage: 'asking_name', no_input_count: 0 }, last_response_at: new Date().toISOString() }).catch(() => {});
    }).catch(() => {});
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response>
  <Dial timeout="20" action="${BASE}/webhook/voice-fallback?callSid=${callSid}" method="POST">
    <Client>admin</Client>
  </Dial>
</Response>`);
  }

  // Responde IMEDIATAMENTE — usa <Play> (ElevenLabs pré-gerado) se disponível, senão Polly
  const greetingTwiml = client.elevenlabs_greeting_url
    ? `<Play>${client.elevenlabs_greeting_url}</Play>`
    : `<Say voice="Polly.Joanna" language="en-US">Hi! Thanks for calling ${client.business_name}. What's your first name?</Say>`;
  res.set('Content-Type', 'text/xml');
  res.send(`<Response>
  <Gather input="speech" speechTimeout="4" timeout="8" action="${BASE}/webhook/voice-intake?callSid=${callSid}&amp;step=name" method="POST">
    ${greetingTwiml}
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?callSid=${callSid}&amp;step=name&amp;noInput=1</Redirect>
</Response>`);

  // DB async — tem ~2.5s (tempo do Polly falar) antes do lead terminar de responder
  try {
    const existingConv = await db.getExistingConversation(client.id, leadPhone).catch(() => null);
    let conversation = existingConv;
    if (!conversation) {
      conversation = await db.saveLead({
        clientId: client.id, leadPhone,
        leadName: 'Caller',
        source: 'inbound_call', serviceType: 'general', message: '[Inbound call]',
      }).catch(() => null);
    }
    if (conversation) {
      await db.updateConversation(conversation.id, {
        call_sid: callSid,
        stage: 'new_lead',
        collected_data: { voice_stage: 'asking_name', no_input_count: 0 },
        last_response_at: new Date().toISOString(),
      }).catch(() => {});
      db.appendMessage(conversation.id, 'lead', '[Inbound call started]').catch(() => {});

      // Popula cache callSid → conversa+cliente para eliminar DB round-trip nos próximos turns
      db.cacheConvByCallSid(callSid, {
        ...conversation,
        call_sid: callSid,
        stage: 'new_lead',
        collected_data: { voice_stage: 'asking_name', no_input_count: 0 },
        clients: client,
      });

      // CNAM lookup async — atualiza nome no DB quando resolver
      twilioSvc.lookupCallerName(`+${leadPhone}`).then(cnamName => {
        if (!cnamName) return;
        logger.info('webhook', `CNAM async resolved: ${leadPhone} → ${cnamName}`);
        db.updateConversation(conversation.id, {
          lead_name: cnamName,
          collected_data: { voice_stage: 'asking_service', no_input_count: 0, name_raw: cnamName },
        }).catch(() => {});
        db.patchConvCache(callSid, { lead_name: cnamName, collected_data: { voice_stage: 'asking_service', no_input_count: 0, name_raw: cnamName } });
      }).catch(() => {});
    }
  } catch (err) {
    logger.error('webhook', `voice async DB error: ${err.message}`);
  }
}

// Multi-turn AI intake — cada step coleta um dado e avança a conversa
router.post('/voice-intake', (req, res) => {
  processVoiceIntake(req, res).catch(err => {
    logger.error('webhook', 'voice-intake error', err.message);
    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Say voice="Polly.Joanna" language="en-US">I'm sorry, something went wrong. Our team will follow up with you by text. Have a great day!</Say></Response>`);
  });
});

async function processVoiceIntake(req, res) {
  const { convId, callSid, step, noInput } = req.query;
  const speech = (req.body.SpeechResult || '').trim();

  // Cache-first: elimina o round-trip Europa→Supabase(US) em cada turn de voz
  // Fallback para DB se não estiver em cache (ex: reinício do servidor mid-call)
  let conv = null;
  if (callSid) {
    conv = db.getConvFromCallSidCache(callSid);
    if (!conv) {
      conv = await db.getConversationWithClientByCallSid(callSid).catch(() => null);
      if (conv) db.cacheConvByCallSid(callSid, conv); // popula cache para próximos turns
    }
  }
  if (!conv && convId) conv = await db.getConversationWithClient(convId).catch(() => null);

  if (!conv) {
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response><Say voice="Polly.Joanna" language="en-US">Sorry, I couldn't find your appointment. Please try calling again. Goodbye!</Say></Response>`);
  }

  // Sempre usar conv.id para DB e URLs — funciona com ambos os modos de lookup
  const id = conv.id;

  const client  = conv.clients;
  const BASE    = process.env.BASE_URL || 'http://asso488k40o4gsc8c0w80gcw.31.97.240.160.sslip.io';
  const tz      = client.timezone || 'America/New_York';
  const cd      = conv.collected_data || {};

  // Helper: persiste no DB e atualiza cache simultaneamente
  const updateConv = (updates) => {
    if (callSid) db.patchConvCache(callSid, updates);
    return db.updateConversation(id, updates).catch(() => {});
  };

  // Contabiliza tentativas sem áudio
  const noInputCount = noInput ? (cd.no_input_count || 0) + 1 : 0;

  if (noInputCount >= 2) {
    // Duas tentativas sem resposta — encerra com elegância e manda SMS
    await updateConv( {
      stage: 'ai_responded',
      collected_data: { ...cd, voice_stage: 'abandoned', no_input_count: noInputCount },
    }).catch(() => {});
    await twilioSvc.sendSms({
      to: `+${conv.lead_phone}`,
      from: client.twilio_number,
      body: `Hi! 👋 We just missed your call at ${client.business_name}. Sounds like we had trouble connecting — no worries! Reply here with your name and what project you have in mind, and we'll get your FREE estimate scheduled ASAP 📅\n\nReply STOP to opt out.`,
      credentials: clientCredentials(client),
    }).catch(() => {});
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response>${el(client, 'abandoned', `It sounds like we're having trouble hearing you. No worries — we'll send you a text message to continue. Thank you for calling ${client.business_name} and have a wonderful day!`)}</Response>`);
  }

  if (noInput || !speech) {
    // Primeira vez sem áudio — repete a pergunta com ElevenLabs se disponível
    const repeatPhraseKey = { name: 'no_input_name', service: 'no_input_service', date: 'no_input_date', address: 'no_input_address' };
    const repeatFallback  = {
      name:    `I'm sorry, I didn't catch that. Could you tell me your first name?`,
      service: `I'm sorry, I didn't quite catch that. What type of project are you looking to get done? For example, tile installation, flooring, or a home renovation?`,
      date:    `I didn't hear a date. What day works best for your free estimate? You can say something like "next Monday" or "this Friday afternoon."`,
      address: `I didn't catch the address. Could you say your street address, city, and state?`,
    };
    const repeatTwiml = el(client, repeatPhraseKey[step] || 'no_input_name', repeatFallback[step] || 'Could you repeat that?');
    await updateConv( { collected_data: { ...cd, no_input_count: noInputCount } }).catch(() => {});
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response>
  <Gather input="speech" speechTimeout="4" timeout="8" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=${step}" method="POST">
    ${repeatTwiml}
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=${step}&amp;noInput=1</Redirect>
</Response>`);
  }

  // ── STEP: name ────────────────────────────────────────────────────────────
  if (step === 'name') {
    // Extrai primeiro nome sem chamar GPT — remove prefixos comuns
    const cleaned = speech
      .replace(/^(my name is|i'm|i am|it's|this is|hey|hi|hello)\s+/i, '')
      .trim();
    const firstName = cleaned.split(/\s+/)[0];
    const leadName  = firstName
      ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
      : 'Customer';

    db.appendMessage(id, 'lead', `[Name]: ${speech}`).catch(() => {});
    await updateConv( {
      lead_name: leadName,
      collected_data: { ...cd, voice_stage: 'asking_service', name_raw: speech, no_input_count: 0 },
    }).catch(() => {});

    const transition = `Nice to meet you, ${leadName}! So, what project are you looking to get done today?`;
    db.appendMessage(id, 'ai', transition).catch(() => {});
    res.set('Content-Type', 'text/xml');
    // "Nice to meet you, {Name}!" → Polly (dynamic) | "So, what project..." → ElevenLabs (static)
    return res.send(`<Response>
  <Gather input="speech" speechTimeout="4" timeout="8" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=service" method="POST">
    ${el(client, 'ask_service_suffix', `So, what project are you looking to get done today?`, `Nice to meet you, ${leadName}!`)}
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=service&amp;noInput=1</Redirect>
</Response>`);
  }

  // ── STEP: service ─────────────────────────────────────────────────────────
  if (step === 'service') {
    const serviceType = detectServiceType(speech);
    db.appendMessage(id, 'lead', `[Service]: ${speech}`).catch(() => {});

    await updateConv( {
      service_type: serviceType,
      collected_data: { ...cd, voice_stage: 'asking_date', service_raw: speech, no_input_count: 0 },
    }).catch(() => {});

    // Static template — elimina latência GPT entre turnos de voz
    const serviceLabels = {
      tile_install: 'tile installation', custom_home: 'custom home building',
      remodel: 'remodeling', renovation: 'renovation',
      tile_replacement: 'tile replacement', free_estimate: 'your project',
      general: 'your project',
    };
    const serviceLabel = serviceLabels[serviceType] || speech || 'your project';
    const transition = `Awesome, ${serviceLabel} — that's right in our wheelhouse! What day this week or next works best for your completely FREE in-home estimate?`;

    db.appendMessage(id, 'ai', transition).catch(() => {});
    res.set('Content-Type', 'text/xml');
    // "Awesome, {service}!" → Polly (dynamic) | "That's right in our wheelhouse!..." → ElevenLabs
    return res.send(`<Response>
  <Gather input="speech" speechTimeout="4" timeout="8" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=date" method="POST">
    ${el(client, 'ask_date_suffix', `That's right in our wheelhouse! What day this week or next works best for your completely FREE in-home estimate?`, `Awesome, ${serviceLabel}!`)}
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=date&amp;noInput=1</Redirect>
</Response>`);
  }

  // ── STEP: date ────────────────────────────────────────────────────────────
  if (step === 'date') {
    db.appendMessage(id, 'lead', `[Date]: ${speech}`).catch(() => {});

    // GPT parse da data
    let isoDate = null;
    try {
      const OpenAI = require('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const localNow = new Date().toLocaleString('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini', max_tokens: 30,
        messages: [
          { role: 'system', content: `Current date/time in ${tz}: ${localNow}. Extract a specific ISO 8601 datetime from the user's words. "next Monday" = the very next Monday. Vague time (afternoon) = 2pm. Morning = 9am. No date info = INVALID. Respond ONLY with ISO datetime string or INVALID.` },
          { role: 'user', content: speech },
        ],
      });
      const raw = completion.choices[0].message.content.trim();
      if (raw !== 'INVALID' && !isNaN(Date.parse(raw))) isoDate = raw;
    } catch {}

    if (!isoDate) {
      await updateConv( { collected_data: { ...cd, no_input_count: 0 } }).catch(() => {});
      const retry = `I didn't quite get that. Could you say a specific day and time? For example: "next Monday at 2pm" or "this Friday morning."`;
      db.appendMessage(id, 'ai', retry).catch(() => {});
      res.set('Content-Type', 'text/xml');
      return res.send(`<Response>
  <Gather input="speech" speechTimeout="4" timeout="8" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=date" method="POST">
    ${el(client, 'date_retry', retry)}
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=date&amp;noInput=1</Redirect>
</Response>`);
    }

    const formatted = new Date(isoDate).toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    await updateConv( {
      scheduled_at: isoDate,
      stage: 'awaiting_address',
      collected_data: { ...cd, voice_stage: 'asking_address', date_iso: isoDate, date_raw: speech, no_input_count: 0 },
    }).catch(() => {});

    const askAddress = `${formatted} — we'll make it happen! Last step: what's the address where you'd like us to come out? Street, city, and state.`;
    db.appendMessage(id, 'ai', askAddress).catch(() => {});
    res.set('Content-Type', 'text/xml');
    // "{formatted} —" → Polly (dynamic date) | "We'll make it happen! Last step..." → ElevenLabs
    return res.send(`<Response>
  <Gather input="speech" speechTimeout="6" timeout="10" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=address" method="POST">
    ${el(client, 'ask_address_suffix', `We'll make it happen! Last step: what's the address where you'd like us to come out? Street, city, and state.`, `${formatted}.`)}
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=address&amp;noInput=1</Redirect>
</Response>`);
  }

  // ── STEP: address ─────────────────────────────────────────────────────────
  if (step === 'address') {
    const address = speech;
    db.appendMessage(id, 'lead', `[Address]: ${address}`).catch(() => {});

    const isoDate   = cd.date_iso || conv.scheduled_at;
    const formatted = isoDate
      ? new Date(isoDate).toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : 'your scheduled time';
    const serviceRaw = cd.service_raw || conv.service_type || 'your project';

    await updateConv( {
      lead_address: address,
      stage: 'scheduled',
      collected_data: { ...cd, voice_stage: 'complete', address_raw: address, no_input_count: 0 },
      last_response_at: new Date().toISOString(),
    }).catch(() => {});

    // Confirmação por SMS para o lead — mesmo número que o lead ligou
    const confirmSms = `✅ You're all set! Here's your FREE estimate summary:\n📋 ${serviceRaw}\n📅 ${formatted}\n📍 ${address}\n\n${client.business_name} will reach out to personally confirm your appointment.\n\n💬 Prefer to speak with a real person? Just reply HUMAN and we'll schedule a call at your convenience.\n\nReply STOP to opt out.`;
    await twilioSvc.sendSms({
      to: `+${conv.lead_phone}`,
      from: client.twilio_number,
      body: confirmSms,
      credentials: clientCredentials(client),
    }).catch(() => {});
    db.appendMessage(id, 'ai', confirmSms).catch(() => {});

    // Notifica o dono
    await twilioSvc.sendSms({
      to: client.owner_phone,
      from: client.twilio_number,
      body: `📞 NOVA VISITA AGENDADA – ${client.business_name}\nFone: +${conv.lead_phone}\nServiço: ${serviceRaw}\nData: ${formatted}\nEndereço: ${address}\n\nVer no dashboard para confirmar ✅`,
      credentials: clientCredentials(client),
    }).catch(() => {});

    const farewell = `Perfect! You're all set for ${formatted} at ${address}. You'll get a text confirmation right now with all the details. We can't wait to help you with ${serviceRaw}. Thank you for choosing ${client.business_name} and have an amazing day!`;
    db.appendMessage(id, 'ai', farewell).catch(() => {});

    res.set('Content-Type', 'text/xml');
    return res.send(`<Response>
  <Say voice="Polly.Joanna" language="en-US">${farewell}</Say>
</Response>`);
  }

  // Fallback
  res.set('Content-Type', 'text/xml');
  res.send(`<Response>${el(client, 'fallback', `Thank you for calling ${client.business_name}. Have a wonderful day!`)}</Response>`);
}

// ── VOICE FALLBACK — browser não atendeu, IA assume ─────────────────────────
// Chamado pelo Twilio após timeout do <Dial><Client>admin</Client></Dial>
router.post('/voice-fallback', (req, res) => {
  const { callSid } = req.query;
  const dialStatus = req.body.DialCallStatus || '';

  if (dialStatus === 'completed') {
    res.set('Content-Type', 'text/xml');
    return res.send('<Response></Response>');
  }

  logger.info('webhook', `voice-fallback: browser didn't answer (${dialStatus}), AI taking over — callSid=${callSid}`);

  resumeWithAI(req, res, callSid).catch(err => {
    logger.error('webhook', 'voice-fallback error', err.message);
    res.set('Content-Type', 'text/xml');
    res.send('<Response><Say voice="Polly.Joanna" language="en-US">We\'re sorry, our team is temporarily unavailable. We\'ll text you shortly. Goodbye!</Say></Response>');
  });
});

async function resumeWithAI(req, res, callSid) {
  const conv = await db.getConversationWithClientByCallSid(callSid).catch(() => null);
  const client = conv?.clients;
  const BASE = process.env.BASE_URL || 'http://asso488k40o4gsc8c0w80gcw.31.97.240.160.sslip.io';

  if (!client) {
    res.set('Content-Type', 'text/xml');
    return res.send('<Response><Say voice="Polly.Joanna" language="en-US">Thank you for calling. Our team will follow up with you shortly. Goodbye!</Say></Response>');
  }

  const id = conv.id;
  const greeting = `Thank you for calling ${client.business_name}! My name is Lexy, your scheduling assistant. I'm here to get you set up with a completely FREE, no-obligation in-home estimate. So, what project are you looking to get done?`;

  res.set('Content-Type', 'text/xml');
  res.send(`<Response>
  <Gather input="speech" speechTimeout="4" timeout="8" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=service" method="POST">
    <Say voice="Polly.Joanna" language="en-US">${greeting}</Say>
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=service&amp;noInput=1</Redirect>
</Response>`);
}

// ── THUMBTACK LEAD WEBHOOK (formato legado) ───────────────────────────────────
router.post('/thumbtack-lead', express.json(), async (req, res) => {
  res.sendStatus(200);
  processThumbtackLead(req.body).catch(err => handleError('thumbtack', err));
});

// ── THUMBTACK NATIVE WEBHOOK ──────────────────────────────────────────────────
// URL: POST /webhook/thumbtack?clientId=XXX&secret=YYY
// Payload nativo do Thumbtack Pro (Partner API)
router.post('/thumbtack', express.json(), async (req, res) => {
  res.sendStatus(200);

  const { clientId, secret } = req.query;
  const expectedSecret = process.env.THUMBTACK_WEBHOOK_SECRET;
  if (expectedSecret && secret !== expectedSecret) {
    logger.warn('thumbtack', `invalid secret from ${req.ip}`);
    return;
  }
  if (!clientId) {
    logger.warn('thumbtack', 'missing clientId in URL — configure webhook URL as /webhook/thumbtack?clientId=XXX&secret=YYY');
    return;
  }

  const body = req.body;
  logger.info('thumbtack', `native webhook received leadID=${body.leadID || 'N/A'} clientId=${clientId}`);

  // Mapeia payload nativo → formato interno
  const rawPhone  = body.customer?.phone || '';
  const leadName  = body.customer?.name  || 'Customer';
  const category  = body.request?.category    || '';
  const desc      = body.request?.description || '';
  const location  = body.request?.location;
  const locationStr = location ? `${location.city || ''}, ${location.state || ''} ${location.zipCode || ''}`.trim() : '';
  const serviceNote = [category, desc, locationStr].filter(Boolean).join(' — ');

  processThumbtackLead({
    clientId,
    leadPhone: rawPhone,
    leadName,
    serviceNote: serviceNote || 'Thumbtack lead',
    thumbtackLeadId: body.leadID,
    apiKey: expectedSecret,
  }).catch(err => handleError('thumbtack', err));
});

// ── BROWSER CLICK-TO-CALL (Twilio Voice JS SDK) ───────────────────────────────
// Called by Twilio when the admin browser initiates an outbound call
// Returns TwiML: dial the requested number from the LeadPilot Twilio number
router.post('/voice-outbound', (req, res) => {
  const raw  = req.body.To || req.query.To || '';
  const to   = raw.replace(/[\s\-\(\)]/g, '');
  const from = process.env.ALERT_FROM || '+19418456110';

  if (!to || !/^\+?\d{7,15}$/.test(to)) {
    res.set('Content-Type', 'text/xml');
    return res.send('<Response><Say>Número inválido. Por favor tente novamente.</Say></Response>');
  }

  res.set('Content-Type', 'text/xml');
  res.send(`<Response><Dial callerId="${from}"><Number>${to}</Number></Dial></Response>`);
  logger.info('webhook', `click-to-call outbound from=${from} to=${to}`);
});

module.exports = router;

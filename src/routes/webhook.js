const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const db = require('../services/supabase');
const twilioSvc = require('../services/twilio');
const openaiSvc = require('../services/openai');
const calendarSvc = require('../services/calendar');
const { handleError } = require('../middleware/alerting');
const { processThumbtackLead } = require('../services/thumbtack');

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
      max_tokens: 150,
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
  const leadName    = await extractLeadName(message);

  // 1. Find client
  let client;
  try {
    client = await db.getClientByTwilioNumber(twilioNumber);
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

  // 6. Send SMS to lead immediately (lead initiated contact — always respond ASAP)
  try {
    const hi = leadName && leadName !== 'Customer' ? `Hi ${leadName}!` : 'Hi there!';
    const smsBody = `${hi} 🏠 ${client.business_name} here — calling you RIGHT NOW about your ${serviceType.replace(/_/g, ' ')} project!\n\nIf we miss you, just reply with your best day & time and we'll lock in your FREE estimate. We have openings this week! 📅\n\nReply STOP to opt out.`;
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

  // 7. Make outbound call immediately — lead initiated contact so consent is established
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
      logger.info('webhook', `Q&A answered for ${conversation.lead_phone}: "${message.substring(0, 60)}"`);
      return; // stay in ai_responded — wait for date reply
    }
  }

  // Deduplication: re-fetch to confirm stage hasn't changed since webhook fired
  const fresh = await db.getConversationById(conversation.id);
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

    // If GPT couldn't find a date, ask the lead to clarify
    if (raw === 'INVALID' || isNaN(Date.parse(raw))) {
      await twilioSvc.sendSms({
        to: `+${conversation.lead_phone}`,
        from: client.twilio_number,
        body: `Hey! 😊 Just need a day and time to lock in your FREE estimate with ${client.business_name}. We're super flexible — something like "Monday at 2pm" or "Friday morning" works great. What do you have? 📅`,
        credentials: clientCredentials(client),
      });
      logger.info('webhook', `could not parse date from reply: "${message}", asked lead to clarify`);
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
  const { CallSid, CallStatus } = req.body;
  if (!CallSid) return;

  try {
    await db.updateConversationByCallSid(CallSid, { call_status: CallStatus });
    logger.info('webhook', `call-status sid=${CallSid} status=${CallStatus}`);
  } catch (err) {
    handleError('supabase', err).catch(() => {});
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

  let client;
  try { client = await db.getClientByTwilioNumber(twilioNumber); } catch {}
  if (!client) {
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response><Say voice="Polly.Joanna" language="en-US">This number is not currently active. Goodbye!</Say></Response>`);
  }

  // Criar lead (ou reutilizar existente recente)
  let conversation = await db.getExistingConversation(client.id, leadPhone).catch(() => null);
  if (!conversation) {
    const isDup = await db.checkDuplicate(client.id, leadPhone, 30).catch(() => false);
    if (!isDup) {
      conversation = await db.saveLead({
        clientId: client.id, leadPhone, leadName: 'Caller',
        source: 'inbound_call', serviceType: 'general', message: '[Inbound call]',
      }).catch(() => null);
    }
  }
  if (!conversation) {
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response><Say voice="Polly.Joanna" language="en-US">Thanks for calling ${client.business_name}! Our team will follow up with you shortly. Goodbye!</Say></Response>`);
  }

  await db.updateConversation(conversation.id, {
    call_sid: callSid,
    stage: 'new_lead',
    collected_data: { voice_stage: 'asking_service', no_input_count: 0 },
    last_response_at: new Date().toISOString(),
  }).catch(() => {});
  db.appendMessage(conversation.id, 'lead', '[Inbound call started]').catch(() => {});

  const BASE = process.env.BASE_URL || 'http://asso488k40o4gsc8c0w80gcw.31.97.240.160.sslip.io';

  // Saudação e primeira pergunta
  const greeting = `Thank you for calling ${client.business_name}! My name is Alex, your scheduling assistant. I'm here to get you set up with a completely FREE, no-obligation in-home estimate — our team is top-notch and we'd love to help you. So, what project are you looking to get done?`;

  res.set('Content-Type', 'text/xml');
  res.send(`<Response>
  <Gather input="speech" speechTimeout="4" timeout="8" action="${BASE}/webhook/voice-intake?convId=${conversation.id}&amp;step=service" method="POST">
    <Say voice="Polly.Joanna" language="en-US">${greeting}</Say>
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${conversation.id}&amp;step=service&amp;noInput=1</Redirect>
</Response>`);
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
  const { convId, step, noInput } = req.query;
  const speech = (req.body.SpeechResult || '').trim();

  const conv = await db.getConversationWithClient(convId);
  if (!conv) {
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response><Say voice="Polly.Joanna" language="en-US">Sorry, I couldn't find your appointment. Please try calling again. Goodbye!</Say></Response>`);
  }

  const client  = conv.clients;
  const BASE    = process.env.BASE_URL || 'http://asso488k40o4gsc8c0w80gcw.31.97.240.160.sslip.io';
  const tz      = client.timezone || 'America/New_York';
  const cd      = conv.collected_data || {};

  // Contabiliza tentativas sem áudio
  const noInputCount = noInput ? (cd.no_input_count || 0) + 1 : 0;

  if (noInputCount >= 2) {
    // Duas tentativas sem resposta — encerra com elegância e manda SMS
    await db.updateConversation(convId, {
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
    return res.send(`<Response><Say voice="Polly.Joanna" language="en-US">It sounds like we're having trouble hearing you. No worries — we'll send you a text message to continue. Thank you for calling ${client.business_name} and have a wonderful day!</Say></Response>`);
  }

  if (noInput || !speech) {
    // Primeira vez sem áudio — repete a pergunta
    const repeatMap = {
      service: `I'm sorry, I didn't quite catch that. What type of project are you looking to get done? For example, tile installation, flooring, or a home renovation?`,
      date:    `I didn't hear a date. What day works best for your free estimate? You can say something like "next Monday" or "this Friday afternoon."`,
      address: `I didn't catch the address. Could you say your street address, city, and state?`,
    };
    await db.updateConversation(convId, { collected_data: { ...cd, no_input_count: noInputCount } }).catch(() => {});
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response>
  <Gather input="speech" speechTimeout="4" timeout="8" action="${BASE}/webhook/voice-intake?convId=${convId}&amp;step=${step}" method="POST">
    <Say voice="Polly.Joanna" language="en-US">${repeatMap[step] || 'Could you repeat that?'}</Say>
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${convId}&amp;step=${step}&amp;noInput=1</Redirect>
</Response>`);
  }

  // ── STEP: service ─────────────────────────────────────────────────────────
  if (step === 'service') {
    const serviceType = detectServiceType(speech);
    db.appendMessage(convId, 'lead', `[Service]: ${speech}`).catch(() => {});

    await db.updateConversation(convId, {
      service_type: serviceType,
      collected_data: { ...cd, voice_stage: 'asking_date', service_raw: speech, no_input_count: 0 },
    }).catch(() => {});

    // GPT gera transição natural: confirma serviço + pergunta data
    let transition;
    try {
      const OpenAI = require('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const sysInfo = client.ai_system_prompt ? `\n${client.ai_system_prompt}` : '';
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini', max_tokens: 80,
        messages: [
          { role: 'system', content: `You are Alex, a friendly AI scheduling assistant for ${client.business_name}.${sysInfo}\nYou're on a phone call. Be warm, brief (max 2 sentences), and excited about helping. No markdown, no asterisks.` },
          { role: 'user', content: `Customer just said they need: "${speech}". Acknowledge their project enthusiastically in one short sentence, then ask what day this week or next works best for a FREE in-home estimate.` },
        ],
      });
      transition = completion.choices[0].message.content.trim();
    } catch {
      transition = `${speech} — great choice! We do excellent work on that. What day this week or next works best for your FREE in-home estimate?`;
    }

    db.appendMessage(convId, 'ai', transition).catch(() => {});
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response>
  <Gather input="speech" speechTimeout="4" timeout="8" action="${BASE}/webhook/voice-intake?convId=${convId}&amp;step=date" method="POST">
    <Say voice="Polly.Joanna" language="en-US">${transition}</Say>
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${convId}&amp;step=date&amp;noInput=1</Redirect>
</Response>`);
  }

  // ── STEP: date ────────────────────────────────────────────────────────────
  if (step === 'date') {
    db.appendMessage(convId, 'lead', `[Date]: ${speech}`).catch(() => {});

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
      await db.updateConversation(convId, { collected_data: { ...cd, no_input_count: 0 } }).catch(() => {});
      const retry = `I didn't quite get that. Could you say a specific day and time? For example: "next Monday at 2pm" or "this Friday morning."`;
      db.appendMessage(convId, 'ai', retry).catch(() => {});
      res.set('Content-Type', 'text/xml');
      return res.send(`<Response>
  <Gather input="speech" speechTimeout="4" timeout="8" action="${BASE}/webhook/voice-intake?convId=${convId}&amp;step=date" method="POST">
    <Say voice="Polly.Joanna" language="en-US">${retry}</Say>
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${convId}&amp;step=date&amp;noInput=1</Redirect>
</Response>`);
    }

    const formatted = new Date(isoDate).toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    await db.updateConversation(convId, {
      scheduled_at: isoDate,
      stage: 'awaiting_address',
      collected_data: { ...cd, voice_stage: 'asking_address', date_iso: isoDate, date_raw: speech, no_input_count: 0 },
    }).catch(() => {});

    const askAddress = `${formatted} — we'll make it happen! Last step: what's the address where you'd like us to come out? Street, city, and state.`;
    db.appendMessage(convId, 'ai', askAddress).catch(() => {});
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response>
  <Gather input="speech" speechTimeout="6" timeout="10" action="${BASE}/webhook/voice-intake?convId=${convId}&amp;step=address" method="POST">
    <Say voice="Polly.Joanna" language="en-US">${askAddress}</Say>
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${convId}&amp;step=address&amp;noInput=1</Redirect>
</Response>`);
  }

  // ── STEP: address ─────────────────────────────────────────────────────────
  if (step === 'address') {
    const address = speech;
    db.appendMessage(convId, 'lead', `[Address]: ${address}`).catch(() => {});

    const isoDate   = cd.date_iso || conv.scheduled_at;
    const formatted = isoDate
      ? new Date(isoDate).toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : 'your scheduled time';
    const serviceRaw = cd.service_raw || conv.service_type || 'your project';

    await db.updateConversation(convId, {
      lead_address: address,
      stage: 'scheduled',
      collected_data: { ...cd, voice_stage: 'complete', address_raw: address, no_input_count: 0 },
      last_response_at: new Date().toISOString(),
    }).catch(() => {});

    // Confirmação por SMS para o lead
    const confirmSms = `✅ You're all set! Here's your FREE estimate summary:\n📋 ${serviceRaw}\n📅 ${formatted}\n📍 ${address}\n\n${client.business_name} will reach out to confirm. We look forward to meeting you!\n\nReply STOP to opt out.`;
    await twilioSvc.sendSms({
      to: `+${conv.lead_phone}`,
      from: client.twilio_number,
      body: confirmSms,
      credentials: clientCredentials(client),
    }).catch(() => {});
    db.appendMessage(convId, 'ai', confirmSms).catch(() => {});

    // Notifica o dono
    await twilioSvc.sendSms({
      to: client.owner_phone,
      from: client.twilio_number,
      body: `📞 NOVA VISITA AGENDADA – ${client.business_name}\nFone: +${conv.lead_phone}\nServiço: ${serviceRaw}\nData: ${formatted}\nEndereço: ${address}\n\nVer no dashboard para confirmar ✅`,
      credentials: clientCredentials(client),
    }).catch(() => {});

    const farewell = `Perfect! You're all set for ${formatted} at ${address}. You'll get a text confirmation right now with all the details. We can't wait to help you with ${serviceRaw}. Thank you for choosing ${client.business_name} and have an amazing day!`;
    db.appendMessage(convId, 'ai', farewell).catch(() => {});

    res.set('Content-Type', 'text/xml');
    return res.send(`<Response>
  <Say voice="Polly.Joanna" language="en-US">${farewell}</Say>
</Response>`);
  }

  // Fallback
  res.set('Content-Type', 'text/xml');
  res.send(`<Response><Say voice="Polly.Joanna" language="en-US">Thank you for calling ${client.business_name}. Have a wonderful day!</Say></Response>`);
}

// ── THUMBTACK LEAD WEBHOOK ────────────────────────────────────────────────────
// Payload: { clientId, leadPhone, leadName?, serviceNote?, apiKey }
// leadPhone = Thumbtack virtual number assigned to this lead
// The Twilio number on the Thumbtack profile must match client.twilio_number
router.post('/thumbtack-lead', express.json(), async (req, res) => {
  res.sendStatus(200);
  processThumbtackLead(req.body).catch(err => handleError('thumbtack', err));
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

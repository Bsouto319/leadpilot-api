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
const { sendEmail } = require('../services/gmail');
const { makeNotifyCall } = require('../services/twilio');

// Parser rápido de data por regex — cobre ~90% dos casos sem chamar OpenAI.
// Retorna ISO string ou null (fallback para GPT).
function fastParseDate(speech, tz) {
  const msg = (speech || '').toLowerCase();
  const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const todayDow = nowLocal.getDay();

  // Parse horário
  let h = 14, m = 0;
  const tm = msg.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (tm) {
    h = parseInt(tm[1]); m = tm[2] ? parseInt(tm[2]) : 0;
    if (tm[3].toLowerCase() === 'pm' && h < 12) h += 12;
    if (tm[3].toLowerCase() === 'am' && h === 12) h = 0;
  } else if (/\bmorning\b|\bearly\b/.test(msg)) h = 9;
  else if (/\bafternoon\b/.test(msg)) h = 14;
  else if (/\bevening\b|\bnight\b/.test(msg)) h = 18;

  const makeIso = (daysFromToday) => {
    const d = new Date(nowLocal);
    d.setDate(d.getDate() + daysFromToday);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };

  if (/\btoday\b|\btonight\b/.test(msg)) return makeIso(0);
  if (/\btomorrow\b/.test(msg)) return makeIso(1);

  const dowMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  for (const [name, dow] of Object.entries(dowMap)) {
    if (new RegExp(`\\b${name}\\b`).test(msg)) {
      let diff = dow - todayDow;
      if (diff <= 0) diff += 7;
      return makeIso(diff);
    }
  }

  const inMatch = msg.match(/\bin (\d+) days?\b/);
  if (inMatch) return makeIso(parseInt(inMatch[1]));

  return null; // GPT fallback para casos complexos
}

// Helper: returns <Play> if ElevenLabs phrase cached, otherwise <Say alice> fallback.
function el(client, phraseKey, fallbackText) {
  const BASE = process.env.BASE_URL || 'https://leads.btechsouto.shop';
  const hasEl = client.elevenlabs_greeting_url && elevenlabs.hasPhrase(client.id, phraseKey);
  if (!hasEl) return `<Say voice="alice" language="en-US">${fallbackText}</Say>`;
  return `<Play>${elevenlabs.phraseUrl(BASE, client.id, phraseKey)}</Play>`;
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

function detectRescheduling(text) {
  const msg = (text || '').toLowerCase();
  return /\b(reschedule|rescheduling|change\s+(the\s+)?(time|date|appointment|visit|day)|move\s+(the\s+)?(appointment|visit|date|time)|different\s+(time|day|date)|can\s+we\s+(change|move|push|shift)|push\s+it\s+(back|forward|out)|not\s+going\s+to\s+(make|work)|won'?t\s+(make\s+it|be\s+there|work)|can'?t\s+make\s+it|something\s+came\s+up|need\s+to\s+(cancel|change)\s+(the\s+)?(date|time|appointment)|postpone|cancel\s+(and\s+)?reschedule|another\s+(time|day|date)|different\s+(day|time)|(time|date|day)\s+(doesn'?t|won'?t|can'?t)\s+work)\b/.test(msg);
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
  if (/cabinet|countertop|counter\s*top|kitchen\s+remodel|kitchen\s+renovation/.test(msg)) return 'cabinets_countertops';
  if (/remodel|kitchen|bathroom|bath/.test(msg)) return 'remodel';
  if (/clean|cleaning|housekeep|maid|janitorial|house\s+clean/.test(msg)) return 'house_cleaning';
  if (/pool\s+cage|screen\s+(repair|room|enclosure)|lanai|birdcage/.test(msg)) return 'pool_screen';
  if (/floor|flooring|hardwood|laminate|vinyl|lvp|lvt/.test(msg)) return 'flooring';
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

async function analyzeAndUpdate(conversation, latestMessage) {
  try {
    const result = await openaiSvc.qualifyLead({
      name:        conversation.lead_name || 'Unknown',
      serviceType: conversation.service_type || 'general',
      serviceNote: latestMessage,
      businessName: 'contractor',
      phone:       conversation.lead_phone || '',
    });
    const updates = {};
    if (result.score != null) updates.score   = result.score;
    if (result.summary)       updates.summary = result.summary;
    if (Object.keys(updates).length) await db.updateConversation(conversation.id, updates);
  } catch (err) {
    logger.warn('webhook', `analyzeAndUpdate failed for conv=${conversation.id}: ${err.message}`);
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
    logger.warn('webhook', `no active client for number ${twilioNumber} — forwarding to Bruno as prospect reply`);
    notifyProspectReply(leadPhone, message).catch(() => {});
    return;
  }

  // 2. Check if lead already exists (scheduling or address reply)
  const existingConv = await db.getExistingConversation(client.id, leadPhone);
  if (existingConv) {
    // Log incoming message to history
    db.appendMessage(existingConv.id, 'lead', message).catch(() => {});
    analyzeAndUpdate(existingConv, message).catch(() => {});

    if (existingConv.stage === 'handoff') {
      logger.info('webhook', `lead ${leadPhone} already in human handoff, skipping AI`);
      return;
    }
    if (existingConv.stage === 'scheduled') {
      const tz = client.timezone || 'America/New_York';
      const formatted = existingConv.scheduled_at
        ? new Date(existingConv.scheduled_at).toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'your scheduled time';

      if (detectRescheduling(message)) {
        logger.info('webhook', `lead ${leadPhone} wants to reschedule — resetting to ai_responded`);
        await db.updateConversation(existingConv.id, {
          stage: 'ai_responded',
          scheduled_at: null,
          lead_address: null,
          collected_data: { ...(existingConv.collected_data || {}), rescheduled: true, sms_ai_responses: 0 },
          last_response_at: new Date().toISOString(),
        });
        return;
      }

      logger.info('webhook', `lead ${leadPhone} already scheduled, ignoring repeat message`);
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
  // Re-fetch conversa para evitar race condition: dois webhooks simultâneos criam duas ligações
  const activeCallStatuses = ['queued', 'initiated', 'ringing', 'in-progress'];
  let convFresh;
  try { convFresh = await db.getConversationById(conversation.id); } catch {}
  if (convFresh?.call_sid && activeCallStatuses.includes(convFresh.call_status)) {
    logger.warn('webhook', `skipping outbound call — active call already exists sid=${convFresh.call_sid} status=${convFresh.call_status}`);
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

  // 9. Notify owner via email
  if (client.owner_email) {
    sendEmail({
      to: client.owner_email,
      subject: `🔔 New Lead — ${client.business_name}`,
      body: `New lead incoming!\n\nName: ${leadName}\nPhone: +${leadPhone}\nService: ${serviceType.replace(/_/g, ' ')}\n\nLexy is calling them now. Dashboard:\nhttps://app.contatobtech.com.br`,
    }).catch(err => logger.warn('webhook', `owner email notify failed: ${err.message}`));
  }

  // Log first message to history
  db.appendMessage(conversation.id, 'lead', message).catch(() => {});
  analyzeAndUpdate(conversation, message).catch(() => {});

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

    if (client.owner_email) {
      sendEmail({
        to: client.owner_email,
        subject: `✅ Appointment Confirmed — ${client.business_name}`,
        body: `Address received — visit is confirmed!\n\nName: ${conversation.lead_name}\nPhone: +${conversation.lead_phone}\nDate: ${formatted}\nAddress: ${address}\n\nDashboard: https://app.contatobtech.com.br`,
      }).catch(() => {});
    }
    if (client.owner_phone) {
      makeNotifyCall({
        to: client.owner_phone,
        from: client.twilio_number,
        message: `Hey! You have a new confirmed appointment from ${client.business_name}. ${conversation.lead_name || 'A lead'} scheduled for ${formatted} at ${address}. Check your email for details!`,
        credentials: clientCredentials(client),
      }).catch(err => logger.warn('webhook', `owner notify call failed: ${err.message}`));
    }

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
      await db.updateConversation(conversation.id, {
        collected_data: { ...cd, sms_ai_responses: clarifyCount },
      }).catch(() => {});
      logger.info('webhook', `could not parse date from reply: "${message}", no clarify SMS sent (${clarifyCount}/${MAX_SMS_AI_RESPONSES})`);
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

    // Notify owner of pending appointment (awaiting address)
    if (client.owner_email) {
      sendEmail({
        to: client.owner_email,
        subject: `📅 Appointment Pending Address — ${client.business_name}`,
        body: `Visit scheduled — waiting for address.\n\nName: ${conversation.lead_name || 'Customer'}\nPhone: +${conversation.lead_phone}\nService: ${(conversation.service_type || '').replace(/_/g, ' ')}\nDate: ${formatted}\n\nWaiting for lead to confirm address...`,
      }).catch(err => logger.warn('webhook', `owner email notify failed: ${err.message}`));
    }

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

  // Move stage from new_lead → ai_responded once any call has been attempted
  const terminalStatuses = ['completed', 'no-answer', 'busy', 'failed'];
  if (terminalStatuses.includes(CallStatus)) {
    try {
      const convForStage = await db.getConversationByCallSid(CallSid);
      if (convForStage && convForStage.stage === 'new_lead') {
        await db.updateConversation(convForStage.id, { stage: 'ai_responded' });
        logger.info('webhook', `stage new_lead→ai_responded for conv=${convForStage.id} after call ${CallStatus}`);
      }
    } catch (err) {
      logger.warn('webhook', `stage update after call failed: ${err.message}`);
    }
  }

  // Fallback SMS when outbound call to lead was not answered
  if (Direction === 'outbound-api' && ['no-answer', 'busy', 'failed'].includes(CallStatus)) {
    try {
      const conv = await db.getConversationByCallSid(CallSid);
      if (conv && conv.clients) {
        const client = conv.clients;
        const leadNameRaw = conv.lead_name && conv.lead_name !== 'Caller' && conv.lead_name !== 'Customer' ? conv.lead_name : null;
        logger.info('webhook', `outbound call ${CallStatus} for ${conv.lead_phone} — no fallback SMS (email only policy)`);

        // Alert all configured phones when lead does not answer
        const leadName = leadNameRaw || 'Unknown';
        const alertServiceLabel = (conv.service_type || 'general').replace(/_/g, ' ');
        const statusLabel = CallStatus === 'no-answer' ? 'did not answer' : CallStatus === 'busy' ? 'line was busy' : 'call failed';
        const alertBody = `⚠️ LEAD ALERT — ${client.business_name}\nLead ${statusLabel}.\n\nName: ${leadName}\nPhone: +${conv.lead_phone}\nService: ${alertServiceLabel}\nSource: ${conv.source || 'unknown'}\n\nFallback SMS sent automatically. Follow up via dashboard:\nhttps://app.contatobtech.com.br`;

        const alertPhones = (client.alert_phones || client.owner_phone || '')
          .split(',').map(p => p.trim()).filter(Boolean);
        const adminPhone = process.env.ALERT_PHONE;
        if (adminPhone && !alertPhones.includes(adminPhone)) alertPhones.push(adminPhone);

        for (const phone of alertPhones) {
          await twilioSvc.sendSms({
            to: phone,
            from: client.twilio_number,
            body: alertBody,
            credentials: clientCredentials(client),
          }).catch(() => {});
          logger.info('webhook', `alert sent to ${phone} — lead ${conv.lead_phone} ${statusLabel}`);
        }
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
    return res.send(`<Response><Say voice="alice" language="en-US">We didn't catch that. We'll follow up with you soon. Thank you!</Say></Response>`);
  }

  // Parse date/time and book calendar async
  processGather({ speech, conversationId, clientId }).catch(err => handleError('gather', err));

  res.set('Content-Type', 'text/xml');
  res.send(`<Response>
  <Say voice="alice" language="en-US">Perfect! We have noted your preference and our team will confirm shortly. Thank you and have a wonderful day!</Say>
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

  // 5. Notify owner via email + call (with AI score if available)
  const scheduledLabel = startDate.toLocaleString('en-US', { timeZone: client.timezone || 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const tierEmojiV  = conv.score >= 70 ? '🔥' : conv.score >= 40 ? '⚡' : conv.score ? '❄️' : '';
  const tierVoiceV  = conv.score >= 70 ? 'This is a HIGH quality lead. ' : conv.score >= 40 ? 'This is a warm lead. ' : '';

  if (client.owner_email) {
    const emailBody = [
      `Lead scheduled via voice call!`,
      ``,
      `Phone: +${conv.lead_phone}`,
      `Name: ${conv.lead_name || 'Unknown'}`,
      `Service: ${(conv.service_type || '').replace(/_/g, ' ')}`,
      `Date: ${scheduledLabel}`,
      `Lead said: "${speech}"`,
      conv.score != null ? `\n── AI Qualification ──\nScore: ${tierEmojiV} ${conv.score}%` : '',
      conv.summary ? `Insight: ${conv.summary}` : '',
      `\nDashboard: https://app.contatobtech.com.br`,
    ].filter(Boolean).join('\n');

    sendEmail({
      to: client.owner_email,
      subject: `${tierEmojiV} Scheduled via Voice — ${conv.lead_name || 'Lead'} | ${client.business_name}`,
      body: emailBody,
    }).catch(err => logger.warn('webhook', `owner email notify failed: ${err.message}`));
  }
  if (conv.lead_email) {
    sendEmail({
      from: `${client.business_name} <noreply@btechsouto.shop>`,
      to: conv.lead_email,
      subject: `✅ Your appointment is confirmed — ${client.business_name}`,
      body: `Hi ${conv.lead_name || 'there'},\n\nYour appointment with ${client.business_name} has been confirmed!\n\nDate: ${scheduledLabel}\nService: ${(conv.service_type || '').replace(/_/g, ' ')}\n\nIf you need to reschedule or have questions, please give us a call.\n\nThank you,\n${client.business_name}`,
    }).catch(() => {});
  }
  if (client.owner_phone) {
    makeNotifyCall({
      to: client.owner_phone,
      from: client.twilio_number,
      message: `Hey! Lexy just scheduled a new appointment for ${client.business_name}. ${tierVoiceV}The lead is confirmed for ${scheduledLabel}. Check your email for details!`,
      credentials: clientCredentials(client),
    }).catch(err => logger.warn('webhook', `owner notify call failed: ${err.message}`));
  }
}

// ── INBOUND CALL — AI INTAKE CONVERSATION ────────────────────────────────────
// Lead liga → IA atende, coleta serviço + data + endereço → salva lead completo
// Rodrigo vê no dashboard e decide quando confirmar/ligar de volta

router.post('/voice', webhookRateLimit, (req, res) => {
  startVoiceIntake(req, res).catch(err => {
    logger.error('webhook', 'voice intake error', err.message);
    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Say voice="alice" language="en-US">We're sorry, we're experiencing a technical issue. Please try again in a moment. Goodbye!</Say></Response>`);
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
    return res.send(`<Response><Say voice="alice" language="en-US">This number is not currently active. Goodbye!</Say></Response>`);
  }

  const BASE = process.env.BASE_URL || 'https://leads.btechsouto.shop';

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

  // Responde IMEDIATAMENTE — usa <Play> (ElevenLabs pré-gerado) se disponível, senão Alice (Twilio)
  const greetingTwiml = client.elevenlabs_greeting_url
    ? `<Play>${client.elevenlabs_greeting_url}</Play>`
    : `<Say voice="alice" language="en-US">Hi! Thanks for calling ${client.business_name}. What's your first name?</Say>`;
  res.set('Content-Type', 'text/xml');
  res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="8" action="${BASE}/webhook/voice-intake?callSid=${callSid}&amp;step=name" method="POST">
    ${greetingTwiml}
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?callSid=${callSid}&amp;step=name&amp;noInput=1</Redirect>
</Response>`);

  // DB async — tem ~2.5s (tempo do greeting falar) antes do lead terminar de responder
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
    res.send(`<Response><Say voice="alice" language="en-US">I'm sorry, something went wrong. Our team will follow up with you by text. Have a great day!</Say></Response>`);
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
    return res.send(`<Response><Say voice="alice" language="en-US">Sorry, I couldn't find your appointment. Please try calling again. Goodbye!</Say></Response>`);
  }

  // Sempre usar conv.id para DB e URLs — funciona com ambos os modos de lookup
  const id = conv.id;

  const client  = conv.clients;
  const BASE    = process.env.BASE_URL || 'https://leads.btechsouto.shop';
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
  <Gather input="speech" speechTimeout="auto" timeout="8" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=${step}" method="POST">
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
    updateConv({
      lead_name: leadName,
      collected_data: { ...cd, voice_stage: 'asking_service', name_raw: speech, no_input_count: 0 },
    });

    const transition = `Nice to meet you, ${leadName}! So, what project are you looking to get done today?`;
    db.appendMessage(id, 'ai', transition).catch(() => {});
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="8" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=service" method="POST">
    ${el(client, 'ask_service_suffix', `Great! So, what type of project are you looking to get done?`)}
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=service&amp;noInput=1</Redirect>
</Response>`);
  }

  // ── STEP: service ─────────────────────────────────────────────────────────
  if (step === 'service') {
    const serviceType = detectServiceType(speech);
    db.appendMessage(id, 'lead', `[Service]: ${speech}`).catch(() => {});

    updateConv({
      service_type: serviceType,
      collected_data: { ...cd, voice_stage: 'asking_date', service_raw: speech, no_input_count: 0 },
    });

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
    return res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="8" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=date" method="POST">
    ${el(client, 'ask_date_suffix', `Perfect! What day this week or next works best for your completely FREE in-home estimate?`)}
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=date&amp;noInput=1</Redirect>
</Response>`);
  }

  // ── STEP: date ────────────────────────────────────────────────────────────
  if (step === 'date') {
    db.appendMessage(id, 'lead', `[Date]: ${speech}`).catch(() => {});
    const encodedSpeech = encodeURIComponent(speech);
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response>
  ${el(client, 'waiting_moment', `Got it! Just a moment...`)}
  <Redirect method="POST">${BASE}/webhook/voice-parse-date?convId=${id}&amp;speech=${encodedSpeech}</Redirect>
</Response>`);
  }

  // ── STEP: address ─────────────────────────────────────────────────────────
  if (step === 'address') {
    const address    = speech;
    const isoDate    = cd.date_iso || conv.scheduled_at;
    const formatted  = isoDate
      ? new Date(isoDate).toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : 'your scheduled time';
    const serviceRaw = cd.service_raw || conv.service_type || 'your project';
    const farewell   = `Perfect! You're all set. You'll receive a text confirmation right now with all the details. One of our team members will personally reach out to confirm everything — you're in great hands! Thank you so much for choosing ${client.business_name}, and have an amazing day!`;

    // Respond immediately so Twilio plays farewell without waiting for DB/SMS
    res.set('Content-Type', 'text/xml');
    res.send(`<Response>
  ${el(client, 'booking_confirmed', farewell)}
</Response>`);

    // Async: DB write + SMS confirmations (non-blocking)
    ;(async () => {
      db.appendMessage(id, 'lead', `[Address]: ${address}`).catch(() => {});
      await updateConv({
        lead_address: address,
        stage: 'scheduled',
        collected_data: { ...cd, voice_stage: 'complete', address_raw: address, no_input_count: 0 },
        last_response_at: new Date().toISOString(),
      }).catch(() => {});

      // Calendar update with address
      if (client.google_refresh_token && client.google_calendar_id) {
        calendarSvc.updateEventAddress({
          refreshToken: client.google_refresh_token,
          calendarId: client.google_calendar_id,
          leadPhone: conv.lead_phone,
          address,
          scheduledAt: isoDate,
        }).catch(() => {});
      }

      const confirmSms = `✅ You're all set! Here's your FREE estimate summary:\n📋 ${serviceRaw}\n📅 ${formatted}\n📍 ${address}\n\n${client.business_name} will reach out to personally confirm your appointment — a real team member will contact you soon!\n\n💬 Questions? Just reply here. Reply STOP to opt out.`;
      await twilioSvc.sendSms({
        to: `+${conv.lead_phone}`,
        from: client.twilio_number,
        body: confirmSms,
        credentials: clientCredentials(client),
      }).catch(() => {});
      db.appendMessage(id, 'ai', confirmSms).catch(() => {});
      db.appendMessage(id, 'ai', farewell).catch(() => {});

      const tierEmoji   = conv.score >= 70 ? '🔥' : conv.score >= 40 ? '⚡' : conv.score ? '❄️' : '';
      const scoreLabel  = conv.score != null ? ` — ${conv.score}% score` : '';
      const tierVoice   = conv.score >= 70 ? 'This is a HIGH quality lead. ' : conv.score >= 40 ? 'This is a warm lead. ' : '';

      if (client.owner_email) {
        const emailBody = [
          `Lexy just confirmed a new appointment!`,
          ``,
          `Name: ${conv.lead_name || 'Unknown'}`,
          `Phone: +${conv.lead_phone}`,
          `Service: ${serviceRaw}`,
          `Date: ${formatted}`,
          `Address: ${address}`,
          conv.score != null ? `\n── AI Qualification ──\nScore: ${tierEmoji} ${conv.score}%` : '',
          conv.summary ? `Insight: ${conv.summary}` : '',
          `\nDashboard: https://app.contatobtech.com.br`,
        ].filter(Boolean).join('\n');

        sendEmail({
          to: client.owner_email,
          subject: `${tierEmoji} Appointment Confirmed${scoreLabel} — ${conv.lead_name || 'Lead'} | ${client.business_name}`,
          body: emailBody,
          }).catch(() => {});
      }
      if (conv.lead_email) {
        sendEmail({
          from: `${client.business_name} <noreply@btechsouto.shop>`,
          to: conv.lead_email,
          subject: `✅ Appointment Confirmed — ${client.business_name}`,
          body: `Hi ${conv.lead_name || 'there'},\n\nYour appointment with ${client.business_name} is confirmed!\n\nDate: ${formatted}\nService: ${serviceRaw}\nAddress on file: ${address}\n\nIf you need to reschedule or have any questions, please give us a call.\n\nThank you,\n${client.business_name}`,
        }).catch(() => {});
      }
      if (client.owner_phone) {
        makeNotifyCall({
          to: client.owner_phone,
          from: client.twilio_number,
          message: `Hey! Lexy just booked a new appointment for ${client.business_name}. ${tierVoice}${conv.lead_name || 'The lead'} is confirmed for ${formatted} at ${address}. Check your email for full details!`,
          credentials: clientCredentials(client),
        }).catch(() => {});
      }
    })().catch(() => {});

    return;
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
    res.send('<Response><Say voice="alice" language="en-US">We\'re sorry, our team is temporarily unavailable. We\'ll text you shortly. Goodbye!</Say></Response>');
  });
});

async function resumeWithAI(req, res, callSid) {
  const conv = await db.getConversationWithClientByCallSid(callSid).catch(() => null);
  const client = conv?.clients;
  const BASE = process.env.BASE_URL || 'https://leads.btechsouto.shop';

  if (!client) {
    res.set('Content-Type', 'text/xml');
    return res.send('<Response><Say voice="alice" language="en-US">Thank you for calling. Our team will follow up with you shortly. Goodbye!</Say></Response>');
  }

  const id = conv.id;
  const fallbackGreeting = `Thank you for calling ${client.business_name}! My name is Lexy, your scheduling assistant. I'm here to get you set up with a completely FREE, no-obligation in-home estimate. So, what project are you looking to get done?`;

  res.set('Content-Type', 'text/xml');
  res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="8" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=service" method="POST">
    ${el(client, 'fallback_ai_takeover', fallbackGreeting)}
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=service&amp;noInput=1</Redirect>
</Response>`);
}

// ── PROSPECT REPLY NOTIFIER — forward cold-outreach replies to Bruno via WhatsApp
async function notifyProspectReply(fromPhone, text) {
  const uazapiUrl   = process.env.UAZAPI_URL   || 'https://btechsoutoshop.uazapi.com';
  const uazapiToken = process.env.UAZAPI_TOKEN;
  const alertPhone  = (process.env.ALERT_PHONE || '5561982025951').replace('+', '');

  if (!uazapiToken) {
    logger.warn('webhook', 'notifyProspectReply: UAZAPI_TOKEN not set — skipping');
    return;
  }

  const msg = `📩 *LeadPilot — Prospect respondeu!*\n\nDe: +${fromPhone}\nMensagem: ${text}`;
  const r = await fetch(`${uazapiUrl}/message/sendText/${uazapiToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: alertPhone, text: msg }),
  });
  if (!r.ok) {
    const err = await r.text();
    logger.warn('webhook', `notifyProspectReply: UAZAPI ${r.status}: ${err.slice(0, 200)}`);
  } else {
    logger.info('webhook', `notifyProspectReply: WhatsApp alert sent for +${fromPhone}`);
  }
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
  logger.info('thumbtack', `native webhook received leadID=${body.leadID || 'N/A'} clientId=${clientId} body=${JSON.stringify(body)}`);

  // Mapeia payload nativo → formato interno
  const rawPhone  = body.customer?.phone || '';
  const leadName  = body.customer?.name  || 'Customer';
  const leadEmail = body.customer?.email || null;
  const category  = body.request?.category    || '';
  const desc      = body.request?.description || '';
  const location  = body.request?.location;
  const locationStr = location ? `${location.city || ''}, ${location.state || ''} ${location.zipCode || ''}`.trim() : '';
  const serviceNote = [category, desc, locationStr].filter(Boolean).join(' — ');

  processThumbtackLead({
    clientId,
    leadPhone: rawPhone,
    leadName,
    leadEmail,
    serviceNote: serviceNote || 'Thumbtack lead',
    thumbtackLeadId: body.leadID,
    apiKey: expectedSecret,
  }).catch(err => handleError('thumbtack', err));
});

// ── OUTBOUND CALL INTAKE — chamada feita pelo sistema, lead atende ────────────
// Lead recebeu ligação outbound (via SMS ou Thumbtack) e atendeu.
// Usa o mesmo fluxo de voz inteligente que o inbound, evitando o TwiML estático.
router.post('/voice-outbound-intake', (req, res) => {
  startOutboundVoiceIntake(req, res).catch(err => {
    logger.error('webhook', 'voice-outbound-intake error', err.message);
    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Say voice="alice" language="en-US">We're sorry, we're experiencing a technical issue. Goodbye!</Say></Response>`);
  });
});

async function startOutboundVoiceIntake(req, res) {
  const { conversationId, clientId } = req.query;
  const callSid = req.body.CallSid || '';
  const BASE = process.env.BASE_URL || 'https://leads.btechsouto.shop';

  let client;
  try { client = await db.getClientById(clientId); } catch {}
  if (!client) {
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response><Say voice="alice" language="en-US">Thank you for calling. Have a wonderful day!</Say></Response>`);
  }

  // Atualiza call_sid na conversa existente — não cria nova
  if (conversationId && callSid) {
    db.updateConversation(conversationId, {
      call_sid: callSid,
      call_status: 'in-progress',
    }).catch(() => {});
    // Popula cache para eliminar round-trip nos próximos turns do voice-intake
    db.getConversationWithClient(conversationId).then(conv => {
      if (conv) db.cacheConvByCallSid(callSid, { ...conv, call_sid: callSid, clients: client });
    }).catch(() => {});
  }

  const greetingTwiml = client.elevenlabs_greeting_url
    ? `<Play>${client.elevenlabs_greeting_url}</Play>`
    : `<Say voice="alice" language="en-US">Hi! Thanks for answering. This is ${client.business_name}. What's your first name?</Say>`;

  res.set('Content-Type', 'text/xml');
  res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="8" action="${BASE}/webhook/voice-intake?callSid=${callSid}&amp;step=name" method="POST">
    ${greetingTwiml}
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?callSid=${callSid}&amp;step=name&amp;noInput=1</Redirect>
</Response>`);
}

// ── VOICE PARSE DATE — GPT parse assíncrono para eliminar silêncio ───────────
// Chamado via <Redirect> após o lead falar a data. Assim o Twilio já recebeu
// resposta e não conta latência do OpenAI como silêncio na ligação.
router.post('/voice-parse-date', (req, res) => {
  parseVoiceDate(req, res).catch(err => {
    logger.error('webhook', 'voice-parse-date error', err.message);
    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Say voice="alice" language="en-US">I'm sorry, something went wrong. Our team will follow up with you by text. Have a great day!</Say></Response>`);
  });
});

async function parseVoiceDate(req, res) {
  const { convId } = req.query;
  const speech = decodeURIComponent(req.query.speech || '');

  const conv = await db.getConversationWithClient(convId).catch(() => null);
  if (!conv) {
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response><Say voice="alice" language="en-US">Sorry, I couldn't find your appointment. Goodbye!</Say></Response>`);
  }

  const client  = conv.clients;
  const id      = conv.id;
  const BASE    = process.env.BASE_URL || 'https://leads.btechsouto.shop';
  const tz      = client.timezone || 'America/New_York';
  const cd      = conv.collected_data || {};
  const callSid = conv.call_sid;

  const updateConv = (updates) => {
    if (callSid) db.patchConvCache(callSid, updates);
    return db.updateConversation(id, updates).catch(() => {});
  };

  // Tenta parse rápido por regex (~0ms) — só chama GPT se falhar
  let isoDate = fastParseDate(speech, tz);
  if (!isoDate) {
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
  }

  if (!isoDate) {
    await updateConv({ collected_data: { ...cd, no_input_count: 0 } });
    const retry = `I didn't quite get that. Could you say a specific day and time? For example: "next Monday at 2pm" or "this Friday morning."`;
    db.appendMessage(id, 'ai', retry).catch(() => {});
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="8" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=date" method="POST">
    ${el(client, 'date_retry', retry)}
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=date&amp;noInput=1</Redirect>
</Response>`);
  }

  const formatted = new Date(isoDate).toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  await updateConv({
    scheduled_at: isoDate,
    stage: 'awaiting_address',
    collected_data: { ...cd, voice_stage: 'asking_address', date_iso: isoDate, date_raw: speech, no_input_count: 0 },
  });

  const askAddress = `${formatted} — we'll make it happen! Last step: what's the address where you'd like us to come out? Street, city, and state.`;
  db.appendMessage(id, 'ai', askAddress).catch(() => {});
  res.set('Content-Type', 'text/xml');
  return res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="10" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=address" method="POST">
    ${el(client, 'ask_address_suffix', `Excellent! Last step — what's the address where you'd like us to come out? Street, city, and state.`)}
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=address&amp;noInput=1</Redirect>
</Response>`);
}

// ── VOICE MESSAGE AUDIO PLAYBACK ──────────────────────────────────────────────
// Public — no auth — called by Twilio <Play> to stream the translated voice message
router.get('/voice-msg/:msgId', (req, res) => {
  const msgId = (req.params.msgId || '').replace(/[^a-z0-9\-]/gi, '');
  if (!msgId) return res.status(400).send('Bad Request');
  const nodePath = require('path');
  const nodeFs   = require('fs');
  const filePath = nodePath.join('/tmp', 'leadpilot-audio', `vmsg-${msgId}.mp3`);
  if (!nodeFs.existsSync(filePath)) return res.status(404).send('Not Found');
  res.set('Content-Type', 'audio/mpeg');
  res.sendFile(filePath);
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

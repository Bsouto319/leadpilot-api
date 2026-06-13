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
const { triggerZipQualifier } = require('../services/zipQualifier');

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

// Helper: returns <Play> ElevenLabs if phrase is cached, otherwise <Say alice> fallback.
function el(client, phraseKey, fallbackText) {
  const BASE = process.env.BASE_URL || 'https://leads.btechsouto.shop';
  if (elevenlabs.hasPhrase(client.id, phraseKey)) {
    return `<Play>${elevenlabs.phraseUrl(BASE, client.id, phraseKey)}</Play>`;
  }
  return `<Say voice="alice" language="en-US">${fallbackText}</Say>`;
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
function isWithinBusinessHours(timezone = 'America/New_York', startHour = 9, endHour = 17) {
  const now  = new Date();
  const hour = parseInt(now.toLocaleString('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }));
  return hour >= startHour && hour < endHour;
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
  const leadPhone    = normalizePhone(body.From);
  const twilioNumber = (body.To || '').trim();
  const message      = body.Body || '';
  const numMedia     = parseInt(body.NumMedia || '0');
  const mediaUrls    = [];
  for (let i = 0; i < numMedia; i++) {
    const url = body[`MediaUrl${i}`];
    if (url) mediaUrls.push(url);
  }

  if (!leadPhone) {
    logger.warn('webhook', 'SMS received with no From number, skipping');
    return;
  }

  logger.info('webhook', `inbound SMS from=${leadPhone} to=${twilioNumber}${numMedia ? ` media=${numMedia}` : ''}`);

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
    // Log incoming message + any media to history
    db.appendMessage(existingConv.id, 'lead', message || '[media]', mediaUrls[0] || null).catch(() => {});
    for (let i = 1; i < mediaUrls.length; i++) {
      db.appendMessage(existingConv.id, 'lead', '[media]', mediaUrls[i]).catch(() => {});
    }
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
    if (existingConv.stage === 'form_filled') {
      // Lead already has address from form — treat SMS reply as date/scheduling response
      logger.info('webhook', `form_filled lead ${leadPhone} replied — routing to scheduling`);
      await processSchedulingReply({ client, conversation: { ...existingConv, stage: 'ai_responded' }, message });
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

  // 9. Notify owner via email (HTML)
  if (client.owner_email || client.admin_email) {
    const { buildNewLeadAlertEmail, clientBranding } = require('../services/followup');
    const branding = clientBranding(client);
    const { subject: alertSubject, html: alertHtml } = buildNewLeadAlertEmail({
      leadName, leadPhone, serviceType,
      agentName: client.agent_name,
      businessName: client.business_name,
      ...branding,
    });
    const alertRecipients = [...new Set([client.owner_email, client.secondary_email, client.admin_email].filter(Boolean))];
    for (const to of alertRecipients) {
      sendEmail({ from: `${client.business_name} <noreply@btechsouto.shop>`, to, subject: alertSubject, html: alertHtml })
        .catch(err => logger.warn('webhook', `owner email notify failed ${to}: ${err.message}`));
    }
  }

  // Log first message + any media to history
  db.appendMessage(conversation.id, 'lead', message || '[media]', mediaUrls[0] || null).catch(() => {});
  for (let i = 1; i < mediaUrls.length; i++) {
    db.appendMessage(conversation.id, 'lead', '[media]', mediaUrls[i]).catch(() => {});
  }
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

    triggerZipQualifier(conversation.id, client.id, address).catch(() => {});

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

    if (client.owner_email || client.admin_email) {
      const confirmRecipients = [...new Set([client.owner_email, client.admin_email].filter(Boolean))];
      for (const to of confirmRecipients) {
        sendEmail({
          from: `${client.business_name} <noreply@btechsouto.shop>`,
          to,
          subject: `✅ Appointment Confirmed — ${client.business_name}`,
          body: `Address received — visit is confirmed!\n\nName: ${conversation.lead_name}\nPhone: +${conversation.lead_phone}\nDate: ${formatted}\nAddress: ${address}`,
        }).catch(() => {});
      }
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
    if (client.owner_email || client.admin_email) {
      const pendingRecipients = [...new Set([client.owner_email, client.admin_email].filter(Boolean))];
      for (const to of pendingRecipients) {
        sendEmail({
          from: `${client.business_name} <noreply@btechsouto.shop>`,
          to,
          subject: `📅 Appointment Pending Address — ${client.business_name}`,
          body: `Visit scheduled — waiting for address.\n\nName: ${conversation.lead_name || 'Customer'}\nPhone: +${conversation.lead_phone}\nService: ${(conversation.service_type || '').replace(/_/g, ' ')}\nDate: ${formatted}\n\nWaiting for lead to confirm address...`,
        }).catch(err => logger.warn('webhook', `owner email notify failed: ${err.message}`));
      }
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

  // Move stage → ai_responded once any call has been attempted
  const terminalStatuses = ['completed', 'no-answer', 'busy', 'failed'];
  if (terminalStatuses.includes(CallStatus)) {
    try {
      const convForStage = await db.getConversationByCallSid(CallSid);
      if (convForStage && (convForStage.stage === 'new_lead' || convForStage.stage === 'form_filled')) {
        await db.updateConversation(convForStage.id, { stage: 'ai_responded' });
        logger.info('webhook', `stage ${convForStage.stage}→ai_responded for conv=${convForStage.id} after call ${CallStatus}`);
      }
    } catch (err) {
      logger.warn('webhook', `stage update after call failed: ${err.message}`);
    }
  }

  // Follow-up email + alert when outbound call to lead was not answered
  if (Direction === 'outbound-api' && ['no-answer', 'busy', 'failed'].includes(CallStatus)) {
    try {
      const conv = await db.getConversationByCallSid(CallSid);
      if (conv && conv.clients) {
        const client = conv.clients;
        const leadNameRaw = conv.lead_name && conv.lead_name !== 'Caller' && conv.lead_name !== 'Customer' ? conv.lead_name : null;
        logger.info('webhook', `outbound call ${CallStatus} for ${conv.lead_phone} — sending follow-up email if available`);

        // Immediate follow-up email with catalog
        if (conv.lead_email && conv.follow_up_count === 0) {
          const { sendImmediateFollowUp } = require('../services/followup');
          sendImmediateFollowUp(conv).catch(err => logger.warn('webhook', `follow-up email failed: ${err.message}`));
        }

        // Schedule retry call — retry 1 in 2h, retry 2 in 24h
        const retryCount = conv.call_retry_count || 0;
        if (retryCount < 2) {
          const delayMs = retryCount === 0 ? 2 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
          const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
          db.markCallRetryScheduled(conv.id, nextRetryAt, retryCount + 1)
            .catch(err => logger.warn('webhook', `markCallRetryScheduled failed: ${err.message}`));
          logger.info('webhook', `retry ${retryCount + 1} scheduled at ${nextRetryAt} for conv=${conv.id}`);
        }

        // Alert all configured phones when lead does not answer
        const leadName = leadNameRaw || 'Unknown';
        const alertServiceLabel = (conv.service_type || 'general').replace(/_/g, ' ');
        const statusLabel = CallStatus === 'no-answer' ? 'did not answer' : CallStatus === 'busy' ? 'line was busy' : 'call failed';
        const alertBody = `⚠️ LEAD ALERT — ${client.business_name}\nLead ${statusLabel}.\n\nName: ${leadName}\nPhone: +${conv.lead_phone}\nService: ${alertServiceLabel}\nSource: ${conv.source || 'unknown'}\n\nFallback SMS sent automatically.`;

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
    ].filter(Boolean).join('\n');

    const voiceRecipients = [...new Set([client.owner_email, client.admin_email].filter(Boolean))];
    for (const to of voiceRecipients) {
      sendEmail({
        from: `${client.business_name} <noreply@btechsouto.shop>`,
        to,
        subject: `${tierEmojiV} Scheduled via Voice — ${conv.lead_name || 'Lead'} | ${client.business_name}`,
        body: emailBody,
      }).catch(err => logger.warn('webhook', `owner email notify failed: ${err.message}`));
    }
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
      message: `Hey! ${client.agent_name || 'Lexy'} just scheduled a new appointment for ${client.business_name}. ${tierVoiceV}The lead is confirmed for ${scheduledLabel}. Check your email for details!`,
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
    handleError('voice', err).catch(() => {});
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

  // Responde IMEDIATAMENTE — usa <Play> ElevenLabs se frase em cache, senão <Say> TTS
  const hasGreetingIn = elevenlabs.hasPhrase(client.id, 'greeting');
  const BASE_IN = process.env.BASE_URL || 'https://leads.btechsouto.shop';
  const greetingTwiml = hasGreetingIn
    ? `<Play>${elevenlabs.phraseUrl(BASE_IN, client.id, 'greeting')}</Play>`
    : `<Say voice="alice" language="en-US">Hi! Thanks for calling ${client.business_name}. What's your first name?</Say>`;

  // Warmup cache in background if cold
  if (client.elevenlabs_voice_id && !hasGreetingIn) {
    elevenlabs.generateAllClientPhrases(client.id, client.business_name, client.elevenlabs_voice_id || 'hope', client.agent_name)
      .catch(err => logger.warn('webhook', `bg regen all phrases failed: ${err.message}`));
  }

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
      email:   `No worries if you'd rather not — just say "skip" and we'll wrap up!`,
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
    // Detect voicemail automated messages — discard speech and hang up silently
    const voicemailPhrases = [
      /not able to connect/i,
      /please leave a (message|voicemail)/i,
      /leave a message after the (beep|tone)/i,
      /you.ve reached the voicemail/i,
      /no one is (available|here) to take your call/i,
      /unable to take your call/i,
      /press \d (to|for)/i,
      /currently (not available|unavailable)/i,
      /call cannot be completed/i,
      /our (business )?hours are/i,
      /voicemail (box|system|greeting)/i,
      /at the (beep|tone), please/i,
      /try (your call again|again later)/i,
    ];
    if (voicemailPhrases.some(p => p.test(speech))) {
      logger.info('webhook', `voicemail detected for conv=${id} — discarding and hanging up`);
      res.set('Content-Type', 'text/xml');
      return res.send(`<Response><Hangup/></Response>`);
    }

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

    // Static responses per service — mention pricing where it applies, avoid it where it varies too much
    const serviceResponses = {
      tile_install:         `Great, tile installation! Our tile work typically starts around $12 per square foot — but every project is unique, so let's get you a FREE in-home estimate to give you the exact number.`,
      flooring:            `Nice, flooring! Hardwood typically starts around $5 per square foot and luxury vinyl from $4 — we'll measure everything out during your FREE in-home estimate.`,
      house_cleaning:      `Perfect, house cleaning! Pricing depends on the size and frequency, so let's set up a FREE walkthrough to give you an exact quote.`,
      pool_screen:         `Got it, pool screen work! Pricing depends on the size and condition of the enclosure, so a FREE on-site estimate is the best way to get you an accurate number.`,
      cabinets_countertops:`Awesome, cabinets and countertops! Those vary a lot by material and layout, so let's do a FREE in-home estimate to nail down the details.`,
      custom_home:         `Excellent — custom home building! That's a big, exciting project. Pricing depends on the build, so let's schedule a FREE consultation to go over everything.`,
      remodel:             `Great, remodeling! Scope and materials make each project unique, so we'll give you a FREE in-home estimate with an exact number.`,
      renovation:          `Perfect, renovation! Every renovation is different, so a FREE estimate is the best way to get you accurate pricing.`,
      tile_replacement:    `Got it, tile repair or replacement! Pricing depends on the area and materials. We'll assess everything during your FREE in-home estimate.`,
      free_estimate:       `Of course — a free estimate! That's exactly what we offer. Let's get that on the calendar for you.`,
      general:             `That's right in our wheelhouse! Let's get a FREE in-home estimate scheduled so we can give you an accurate number.`,
    };
    const serviceLabel = (serviceType || 'general').replace(/_/g, ' ');
    const serviceReply = serviceResponses[serviceType] || serviceResponses.general;
    const transition = `${serviceReply} What day this week or next works best for you?`;

    db.appendMessage(id, 'ai', transition).catch(() => {});
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="8" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=date" method="POST">
    <Say voice="alice" language="en-US">${transition}</Say>
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
    const address = speech.trim();
    db.appendMessage(id, 'lead', `[Address]: ${address}`).catch(() => {});

    // Save to collected_data only — wait for confirmation before committing lead_address
    await updateConv({
      collected_data: { ...cd, voice_stage: 'confirming_address', address_raw: address, no_input_count: 0 },
    }).catch(() => {});

    const confirmAddress = `I have your address as: ${address}. Is that correct? Please say yes or no.`;
    db.appendMessage(id, 'ai', confirmAddress).catch(() => {});
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="8" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=address_confirm" method="POST">
    <Say voice="alice" language="en-US">${confirmAddress}</Say>
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=address_confirm&amp;noInput=1</Redirect>
</Response>`);
  }

  // ── STEP: address_confirm ─────────────────────────────────────────────────
  if (step === 'address_confirm') {
    const address = cd.address_raw || '';
    const isYes = /\b(yes|yeah|correct|right|that'?s right|that'?s correct|yep|yup|affirmative|sure|ok|okay|perfect|exactly|correct)\b/i.test(speech);
    const isNo  = /\b(no|nope|wrong|incorrect|not right|not correct|different|change|redo|actually)\b/i.test(speech);

    if (isNo) {
      const reAsk = `No problem! Let me get that again — please say your full address, including street number, city, and state.`;
      db.appendMessage(id, 'ai', reAsk).catch(() => {});
      res.set('Content-Type', 'text/xml');
      return res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="12" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=address" method="POST">
    <Say voice="alice" language="en-US">${reAsk}</Say>
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=address&amp;noInput=1</Redirect>
</Response>`);
    }

    if (!isYes) {
      // Unclear — re-ask confirmation
      const reConfirm = `I'm sorry, I didn't catch that. Is this address correct: ${address}? Please say yes or no.`;
      res.set('Content-Type', 'text/xml');
      return res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="8" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=address_confirm" method="POST">
    <Say voice="alice" language="en-US">${reConfirm}</Say>
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=address_confirm&amp;noInput=1</Redirect>
</Response>`);
    }

    // Confirmed — save address and move to email step
    await updateConv({
      lead_address: address,
      stage: 'awaiting_address',
      collected_data: { ...cd, voice_stage: 'asking_email', no_input_count: 0 },
    }).catch(() => {});

    triggerZipQualifier(id, conv.client_id, address).catch(() => {});

    const askEmail = `Perfect! And lastly — could I get your email address? We'll send you a quick form with details about your project and keep everything on file for you. Just say it slowly, like: "john at gmail dot com".`;
    db.appendMessage(id, 'ai', askEmail).catch(() => {});
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="12" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=email" method="POST">
    <Say voice="alice" language="en-US">${askEmail}</Say>
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=email&amp;noInput=1</Redirect>
</Response>`);
  }

  // ── STEP: email ───────────────────────────────────────────────────────────
  if (step === 'email') {
    const isoDate    = cd.date_iso || conv.scheduled_at;
    const formatted  = isoDate
      ? new Date(isoDate).toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : 'your scheduled time';
    const serviceRaw = cd.service_raw || conv.service_type || 'your project';
    const address    = cd.address_raw || conv.lead_address || '';

    // GPT-powered email parser — handles phone dictation patterns
    const skipWords = /\b(skip|no|nope|don't|dont|rather not|no thanks|no email|pass|none)\b/i;
    const isSkip = speech && skipWords.test(speech);
    let parsedEmail = null;
    if (speech && !isSkip) {
      try {
        const OpenAI = require('openai');
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const emailRes = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          max_tokens: 60,
          messages: [
            { role: 'system', content: 'The user dictated an email address over the phone. Convert the spoken text to a valid email format. Rules: "at" or "at sign" → @, "dot" → ., "underscore" or "underline" → _, "dash" or "hyphen" → -, remove spaces between characters. Common domains: gmail.com, yahoo.com, hotmail.com, outlook.com, icloud.com. If you cannot parse a valid email, respond with exactly: NONE' },
            { role: 'user', content: speech },
          ],
        });
        const raw = emailRes.choices[0].message.content.trim().toLowerCase();
        if (raw !== 'none' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw)) parsedEmail = raw;
      } catch {
        // Regex fallback
        const raw = speech.toLowerCase()
          .replace(/\bat\s+sign\b|\bat\b/g, '@').replace(/\bdot\b/g, '.')
          .replace(/\bunderscore\b|\bunderline\b/g, '_').replace(/\bdash\b|\bhyphen\b/g, '-')
          .replace(/\s/g, '');
        if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw)) parsedEmail = raw;
      }
    }

    if (parsedEmail) {
      // Read email back for confirmation before saving
      const spokenEmail = parsedEmail.replace('@', ' at ').replace(/\./g, ' dot ');
      const confirmEmail = `I have your email as: ${spokenEmail}. Is that correct? Say yes or no.`;
      db.appendMessage(id, 'ai', confirmEmail).catch(() => {});
      await updateConv({
        collected_data: { ...cd, email_raw: parsedEmail, voice_stage: 'confirming_email', no_input_count: 0 },
      }).catch(() => {});
      res.set('Content-Type', 'text/xml');
      return res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="8" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=email_confirm" method="POST">
    <Say voice="alice" language="en-US">${confirmEmail}</Say>
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=email_confirm&amp;noInput=1</Redirect>
</Response>`);
    }

    // Email not understood — retry once before giving up
    if (!isSkip && !cd.email_retry) {
      const reAskEmail = `I'm sorry, I didn't quite catch that. Could you say your email one more time, nice and slowly? For example: "john at gmail dot com".`;
      db.appendMessage(id, 'ai', reAskEmail).catch(() => {});
      await updateConv({
        collected_data: { ...cd, email_retry: 1, no_input_count: 0 },
      }).catch(() => {});
      res.set('Content-Type', 'text/xml');
      return res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="14" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=email" method="POST">
    <Say voice="alice" language="en-US">${reAskEmail}</Say>
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=email&amp;noInput=1</Redirect>
</Response>`);
    }

    // Email explicitly skipped or 2nd attempt also failed — farewell
    const farewellNoEmail = `No problem! You're all set. One of our team members will personally reach out to confirm everything. Thank you so much for choosing ${client.business_name}, and have an amazing day!`;
    db.appendMessage(id, 'ai', farewellNoEmail).catch(() => {});
    res.set('Content-Type', 'text/xml');
    res.send(`<Response>
  ${el(client, 'booking_confirmed', farewellNoEmail)}
</Response>`);

    ;(async () => {
      await updateConv({
        stage: 'scheduled',
        collected_data: { ...cd, voice_stage: 'complete', no_input_count: 0 },
        last_response_at: new Date().toISOString(),
      }).catch(() => {});

      if (client.google_refresh_token && client.google_calendar_id && address) {
        calendarSvc.updateEventAddress({
          refreshToken: client.google_refresh_token,
          calendarId: client.google_calendar_id,
          leadPhone: conv.lead_phone,
          address,
          scheduledAt: isoDate,
        }).catch(() => {});
      }

      const tierEmoji  = conv.score >= 70 ? '🔥' : conv.score >= 40 ? '⚡' : conv.score ? '❄️' : '';
      const scoreLabel = conv.score != null ? ` — ${conv.score}% score` : '';
      const tierVoice  = conv.score >= 70 ? 'This is a HIGH quality lead. ' : conv.score >= 40 ? 'This is a warm lead. ' : '';
      const agentName  = client.agent_name || 'Lexy';

      if (client.owner_email) {
        const emailBody = [
          `${agentName} just confirmed a new appointment!`,
          ``,
          `Name: ${conv.lead_name || 'Unknown'}`,
          `Phone: +${conv.lead_phone}`,
          `Service: ${serviceRaw}`,
          `Date: ${formatted}`,
          `Address: ${address}`,
          `⚠️ Email not captured — follow up via dashboard.`,
          conv.score != null ? `\n── AI Qualification ──\nScore: ${tierEmoji} ${conv.score}%` : '',
          conv.summary ? `Insight: ${conv.summary}` : '',
          ``,
          client.website_url ? `Website: ${client.website_url}` : '',
          ``,
          client.business_name,
        ].filter(Boolean).join('\n');
        const apptRecipients1 = [...new Set([client.owner_email, client.admin_email].filter(Boolean))];
        for (const to of apptRecipients1) {
          sendEmail({
            from: `${client.business_name} <noreply@btechsouto.shop>`,
            to,
            subject: `${tierEmoji} Appointment Confirmed${scoreLabel} — ${conv.lead_name || 'Lead'} | ${client.business_name}`,
            body: emailBody,
          }).catch(() => {});
        }
      }

      const notifyMsg = `Hey! ${agentName} just booked a new appointment for ${client.business_name}. ${tierVoice}${conv.lead_name || 'The lead'} is confirmed for ${formatted} at ${address}. Check your email for full details!`;
      if (client.owner_phone) {
        makeNotifyCall({ to: client.owner_phone, from: client.twilio_number, message: notifyMsg, credentials: clientCredentials(client) }).catch(() => {});
      }
      if (client.office_phone) {
        makeNotifyCall({ to: client.office_phone, from: client.twilio_number, message: notifyMsg, credentials: clientCredentials(client) }).catch(() => {});
      }

      // Follow-up SMS to collect email since it wasn't captured during the call
      await twilioSvc.sendSms({
        to: `+${conv.lead_phone}`,
        from: client.twilio_number,
        body: `Hi ${conv.lead_name || 'there'}! Your appointment with ${client.business_name} is confirmed for ${formatted}. We'd love to send you a written confirmation — could you reply with your email address? Thanks! Reply STOP to opt out.`,
        credentials: clientCredentials(client),
      }).catch(() => {});
    })().catch(() => {});

    return;
  }

  // ── STEP: email_confirm ───────────────────────────────────────────────────
  if (step === 'email_confirm') {
    const isoDate    = cd.date_iso || conv.scheduled_at;
    const formatted  = isoDate
      ? new Date(isoDate).toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : 'your scheduled time';
    const serviceRaw = cd.service_raw || conv.service_type || 'your project';
    const address    = cd.address_raw || conv.lead_address || '';
    const emailRaw   = cd.email_raw;

    const isYes = /\b(yes|yeah|correct|right|that'?s right|yep|yup|sure|ok|okay|perfect|exactly)\b/i.test(speech);
    const isNo  = /\b(no|nope|wrong|incorrect|not right|different|change)\b/i.test(speech);

    if (!isYes) {
      // Re-ask email — go back to email step
      const reAsk = isNo
        ? `No problem — let me try again. Please say your email address slowly. For example: "john at gmail dot com".`
        : `I'm sorry, I didn't catch that. Is the email correct? Say yes or no, or say "skip" to continue without it.`;
      db.appendMessage(id, 'ai', reAsk).catch(() => {});
      res.set('Content-Type', 'text/xml');
      return res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="12" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=email" method="POST">
    <Say voice="alice" language="en-US">${reAsk}</Say>
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=email&amp;noInput=1</Redirect>
</Response>`);
    }

    // Email confirmed — farewell
    const farewell = `Perfect! You're all set — I'm sending a confirmation to ${emailRaw}. One of our team members will also be in touch to confirm. Thank you so much for choosing ${client.business_name}, and have an amazing day!`;
    db.appendMessage(id, 'ai', farewell).catch(() => {});
    res.set('Content-Type', 'text/xml');
    res.send(`<Response>
  <Say voice="alice" language="en-US">${farewell}</Say>
</Response>`);

    ;(async () => {
      if (emailRaw) {
        await updateConv({ lead_email: emailRaw }).catch(() => {});
        db.appendMessage(id, 'lead', `[Email]: ${emailRaw}`).catch(() => {});
        logger.info('webhook', `email confirmed from voice: ${emailRaw} for conv=${id}`);
      }

      await updateConv({
        stage: 'scheduled',
        collected_data: { ...cd, voice_stage: 'complete', no_input_count: 0 },
        last_response_at: new Date().toISOString(),
      }).catch(() => {});

      if (client.google_refresh_token && client.google_calendar_id && address) {
        calendarSvc.updateEventAddress({
          refreshToken: client.google_refresh_token,
          calendarId: client.google_calendar_id,
          leadPhone: conv.lead_phone,
          address,
          scheduledAt: isoDate,
        }).catch(() => {});
      }

      const tierEmoji  = conv.score >= 70 ? '🔥' : conv.score >= 40 ? '⚡' : conv.score ? '❄️' : '';
      const scoreLabel = conv.score != null ? ` — ${conv.score}% score` : '';
      const tierVoice  = conv.score >= 70 ? 'This is a HIGH quality lead. ' : conv.score >= 40 ? 'This is a warm lead. ' : '';
      const agentName  = client.agent_name || 'Lexy';

      if (client.owner_email) {
        const emailBody = [
          `${agentName} just confirmed a new appointment!`,
          ``,
          `Name: ${conv.lead_name || 'Unknown'}`,
          `Phone: +${conv.lead_phone}`,
          emailRaw ? `Email: ${emailRaw}` : '',
          `Service: ${serviceRaw}`,
          `Date: ${formatted}`,
          `Address: ${address}`,
          conv.score != null ? `\n── AI Qualification ──\nScore: ${tierEmoji} ${conv.score}%` : '',
          conv.summary ? `Insight: ${conv.summary}` : '',
          ``,
          client.website_url ? `Website: ${client.website_url}` : '',
          ``,
          client.business_name,
        ].filter(Boolean).join('\n');
        const apptRecipients2 = [...new Set([client.owner_email, client.admin_email].filter(Boolean))];
        for (const to of apptRecipients2) {
          sendEmail({
            from: `${client.business_name} <noreply@btechsouto.shop>`,
            to,
            subject: `${tierEmoji} Appointment Confirmed${scoreLabel} — ${conv.lead_name || 'Lead'} | ${client.business_name}`,
            body: emailBody,
          }).catch(() => {});
        }
      }

      if (emailRaw) {
        sendEmail({
          to: emailRaw,
          subject: `✅ Appointment Confirmed — ${client.business_name}`,
          body: `Hi ${conv.lead_name || 'there'},\n\nYour appointment with ${client.business_name} is confirmed!\n\nDate: ${formatted}\nService: ${serviceRaw}\nAddress: ${address}\n\nIf you need to reschedule or have any questions, just give us a call.\n\nThank you,\n${client.business_name}${client.website_url ? '\n' + client.website_url : ''}`,
        }).catch(() => {});
      }

      const notifyMsg2 = `Hey! ${agentName} just booked a new appointment for ${client.business_name}. ${tierVoice}${conv.lead_name || 'The lead'} is confirmed for ${formatted} at ${address}. Check your email for full details!`;
      if (client.owner_phone) {
        makeNotifyCall({ to: client.owner_phone, from: client.twilio_number, message: notifyMsg2, credentials: clientCredentials(client) }).catch(() => {});
      }
      if (client.office_phone) {
        makeNotifyCall({ to: client.office_phone, from: client.twilio_number, message: notifyMsg2, credentials: clientCredentials(client) }).catch(() => {});
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
  const agentName = client.agent_name || 'Lexy';
  const fallbackGreeting = `Thank you for calling ${client.business_name}! My name is ${agentName}, your scheduling assistant. I'm here to get you set up with a completely FREE, no-obligation in-home estimate. So, what project are you looking to get done?`;

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

// ── CF7 WEBSITE WEBHOOK ────────────────────────────────────────────────────────
// WordPress Contact Form 7 + plugin "CF7 to Webhook" by Moranet
// Campos: your-name, your-email, your-phone, your-date, your-subject, your-message
// URL de configuração: /webhook/cf7?clientId=XXX&secret=lp-thumbtack-2026-secure
router.post('/cf7', express.urlencoded({ extended: true }), express.json(), async (req, res) => {
  const rawBody = req.body;
  // Normalize CF7 plugin "fields[your-name]" bracket format → flat object
  const body = {};
  for (const [k, v] of Object.entries(rawBody)) {
    const m = k.match(/^fields\[(.+)\]$/);
    body[m ? m[1] : k] = v;
  }

  // Accept clientId from query params or body; secret is optional (WordPress encodes & as &amp; breaking multi-param URLs)
  const clientId = req.query.clientId || body.clientId || body.client_id || rawBody.clientId;
  if (!clientId) {
    logger.warn('cf7', 'missing clientId — add as query param or CF7 hidden field');
    return res.sendStatus(200);
  }

  logger.info('cf7', `website lead received clientId=${clientId} fields=${JSON.stringify(body)}`);

  // Support both CF7 default field names (your-*) and custom names (name, phone, etc.)
  const getField = (obj, ...keys) => { for (const k of keys) { const v = String(obj[k] || '').trim(); if (v) return v; } return ''; };
  const leadName  = getField(body, 'your-name', 'name', 'full-name', 'full_name') || 'Customer';
  const leadEmail = getField(body, 'your-email', 'your-e-mail', 'email') || null;
  // Scan all body keys for phone — handles any CF7 field naming variant
  const rawPhone = (() => {
    const explicit = getField(body, 'your-phone', 'your-phone-number', 'phone', 'tel', 'tel-1', 'telephone', 'phone-number');
    if (explicit) return explicit;
    const key = Object.keys(body).find(k => /phone/i.test(k));
    return key ? String(body[key] || '').trim() : '';
  })();
  const visitDate       = getField(body, 'your-date', 'date', 'date-of-visit', 'visit-date', 'visit_date');
  const bestTime        = getField(body, 'your-subject', 'your-best-time', 'your-best-time-to-contact-you', 'subject', 'time', 'best-time');
  const serviceType     = getField(body, 'your-project', 'your-service', 'service', 'service-type', 'project', 'project-type', 'service_type');
  const additionalNotes = getField(body, 'your-message', 'message', 'additional-notes', 'notes', 'comments');
  const leadAddress     = getField(body, 'address', 'lead-address', 'your-address', 'street-address') || null;

  if (!rawPhone) {
    logger.warn('cf7', `missing phone field — body keys: ${Object.keys(body).join(', ')}`);
    return res.sendStatus(200);
  }

  const serviceNote = [
    serviceType      && `Service: ${serviceType}`,
    visitDate        && `Preferred visit date: ${visitDate}`,
    bestTime         && `Best time: ${bestTime}`,
    leadAddress      && `Address: ${leadAddress}`,
    additionalNotes  && `Notes: ${additionalNotes}`,
  ].filter(Boolean).join(' | ') || 'Website contact form';

  // Convert visitDate + bestTime into scheduledAt ISO in the client's timezone
  let scheduledAt = null;
  if (visitDate) {
    const hourMap = {
      morning: 9, 'early morning': 9,
      'late morning': 11,
      noon: 12, midday: 12,
      afternoon: 14, 'early afternoon': 13, 'mid afternoon': 14, 'late afternoon': 16,
      evening: 17, 'early evening': 17,
      '9am': 9, '9 am': 9, '10am': 10, '10 am': 10, '11am': 11, '11 am': 11,
      '12pm': 12, '12 pm': 12, '1pm': 13, '1 pm': 13,
      '2pm': 14, '2 pm': 14, '3pm': 15, '3 pm': 15,
      '4pm': 16, '4 pm': 16, '5pm': 17, '5 pm': 17,
    };
    const bt = (bestTime || '').toLowerCase().trim();
    // Parse time string → { hour, minute }
    let hour = null; let minute = 0;

    // Try map first (morning/afternoon/etc)
    const mapped = hourMap[bt];
    if (mapped != null) { hour = mapped; }

    // Try "H:MM AM/PM" or "H:MM" or "H AM/PM" patterns
    if (hour == null) {
      const timeMatch = bt.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
      if (timeMatch) {
        let h = parseInt(timeMatch[1]);
        const m = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
        const meridiem = timeMatch[3];
        if (meridiem === 'pm' && h < 12) h += 12;
        if (meridiem === 'am' && h === 12) h = 0;
        hour = h; minute = m;
      }
    }

    // Fallback
    if (hour == null) { hour = 10; minute = 0; }

    // Clamp to 9:00–17:00 range
    const totalMins = hour * 60 + minute;
    const clampedMins = Math.max(9 * 60, Math.min(17 * 60, totalMins));
    hour   = Math.floor(clampedMins / 60);
    minute = clampedMins % 60;

    try {
      // Convert local Eastern time → UTC without relying on server's local timezone.
      // Uses Date.UTC() + Intl.DateTimeFormat.formatToParts() — both timezone-agnostic.
      const tz = 'America/New_York';
      const [yr, mo, dy] = visitDate.split('-').map(Number);
      // Build a pseudo-UTC timestamp treating the local time as UTC temporarily
      const pseudoMs = Date.UTC(yr, mo - 1, dy, hour, minute, 0, 0);
      const pseudoDate = new Date(pseudoMs);
      // Find what Eastern time shows at pseudoMs (tells us the offset)
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      });
      const p = {};
      for (const { type, value } of fmt.formatToParts(pseudoDate)) p[type] = value;
      const tzH  = parseInt(p.hour) === 24 ? 0 : parseInt(p.hour);
      const tzMs = Date.UTC(parseInt(p.year), parseInt(p.month) - 1, parseInt(p.day), tzH, parseInt(p.minute), 0);
      // offsetMs: how far pseudo-UTC drifts from real Eastern local → add it back to get true UTC
      const d = new Date(pseudoMs + (pseudoMs - tzMs));
      if (!isNaN(d)) scheduledAt = d.toISOString();
    } catch { /* invalid date, skip */ }
  }

  // Double-booking guard: reject if slot already taken (±30 min window)
  if (scheduledAt) {
    try {
      const conflict = await db.checkSlotConflict(clientId, scheduledAt, 30);
      if (conflict) {
        logger.warn('cf7', `slot conflict clientId=${clientId} scheduledAt=${scheduledAt}`);
        return res.status(409).json({
          message: 'This time slot is already booked. Please choose a different date or time.',
        });
      }
    } catch (err) {
      logger.warn('cf7', `slot conflict check failed: ${err.message} — proceeding`);
      // Don't block lead on DB error — better to double-book than lose a lead
    }
  }

  res.sendStatus(200);

  // Detect showroom visit — no home address needed when lead is coming to the showroom
  const allFormText = [serviceType, additionalNotes, bestTime].filter(Boolean).join(' ');
  const isShowroomVisit = !leadAddress && /\bshowroom\b/i.test(allFormText);
  const effectiveAddress = leadAddress || (isShowroomVisit ? 'Showroom visit' : null);

  processThumbtackLead({
    clientId,
    leadPhone: rawPhone,
    leadName,
    leadEmail,
    serviceNote,
    serviceType: serviceType || undefined,
    source: 'website',
    scheduledAt,
    leadAddress: effectiveAddress,
  }).catch(err => handleError('cf7', err));
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

  const BASE_OUT = process.env.BASE_URL || 'https://leads.btechsouto.shop';
  const hasGreetingOut = elevenlabs.hasPhrase(client.id, 'greeting');
  const greetingTwimlOut = hasGreetingOut
    ? `<Play>${elevenlabs.phraseUrl(BASE_OUT, client.id, 'greeting')}</Play>`
    : `<Say voice="alice" language="en-US">Hi! Thanks for answering. This is ${client.business_name}. What's your first name?</Say>`;

  // Warmup cache in background if cold
  if (client.elevenlabs_voice_id && !hasGreetingOut) {
    elevenlabs.generateAllClientPhrases(client.id, client.business_name, client.elevenlabs_voice_id || 'hope', client.agent_name)
      .catch(err => logger.warn('webhook', `outbound bg regen all phrases failed: ${err.message}`));
  }

  res.set('Content-Type', 'text/xml');
  res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="8" action="${BASE}/webhook/voice-intake?callSid=${callSid}&amp;step=name" method="POST">
    ${greetingTwimlOut}
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

  // If address already collected (showroom visit or prior form submission), skip to email
  if (conv.lead_address) {
    await updateConv({
      scheduled_at: isoDate,
      stage: 'awaiting_address',
      collected_data: { ...cd, voice_stage: 'asking_email', date_iso: isoDate, date_raw: speech, no_input_count: 0 },
    });
    const confirmMsg = `${formatted} — perfect! Last step: could I get your email address so we can send you a written confirmation?`;
    db.appendMessage(id, 'ai', confirmMsg).catch(() => {});
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response>
  <Gather input="speech" speechTimeout="auto" timeout="12" action="${BASE}/webhook/voice-intake?convId=${id}&amp;step=email" method="POST">
    ${el(client, 'ask_email_suffix', confirmMsg)}
  </Gather>
  <Redirect method="POST">${BASE}/webhook/voice-intake?convId=${id}&amp;step=email&amp;noInput=1</Redirect>
</Response>`);
  }

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

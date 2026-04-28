const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const db = require('../services/supabase');
const twilioSvc = require('../services/twilio');
const openaiSvc = require('../services/openai');
const calendarSvc = require('../services/calendar');
const { handleError } = require('../middleware/alerting');

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

  // 6. Send SMS to lead — with business hours check and required compliance footer
  try {
    const tz = client.timezone || 'America/New_York';
    const greeting = leadName && leadName !== 'Customer' ? ` ${leadName}` : '';
    let smsBody;
    if (isWithinBusinessHours(tz)) {
      smsBody = `Hi${greeting}! This is ${client.business_name}. We just called about your ${serviceType.replace(/_/g, ' ')} request.\n\nReply with your preferred day and time to schedule your FREE estimate — we'll confirm right away! 📅\n\nReply STOP to opt out.`;
    } else {
      smsBody = `Hi${greeting}! This is ${client.business_name}. We received your ${serviceType.replace(/_/g, ' ')} request.\n\nReply with your preferred day and time to schedule your FREE estimate and we'll confirm first thing in the morning! 📅\n\nReply STOP to opt out.`;
    }
    await twilioSvc.sendSms({
      to: `+${leadPhone}`,
      from: client.twilio_number,
      body: smsBody,
      credentials: clientCredentials(client),
    });
  } catch (err) {
    await handleError('twilio', err);
  }

  // 7. Make outbound call
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
      body: `NEW LEAD – ${client.business_name}\nName: ${leadName}\nPhone: +${leadPhone}\nService: ${serviceType}\nCall + SMS sent to lead.`,
      credentials: clientCredentials(client),
    });
  } catch (err) {
    await handleError('twilio', err);
  }

  logger.info('webhook', `lead processed id=${conversation.id} phone=${leadPhone}`);
}

// Process scheduling reply from lead
async function processAddressReply({ client, conversation, message }) {
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

    await twilioSvc.sendSms({
      to: `+${conversation.lead_phone}`,
      from: client.twilio_number,
      body: `✅ All set! Your appointment with ${client.business_name} is confirmed:\n📅 ${formatted}\n📍 ${address}\n\nWe'll see you then! Reply STOP to cancel.`,
      credentials: clientCredentials(client),
    });

    await twilioSvc.sendSms({
      to: client.owner_phone,
      from: client.twilio_number,
      body: `ADDRESS CONFIRMED – ${client.business_name}\nName: ${conversation.lead_name}\nPhone: +${conversation.lead_phone}\nTime: ${formatted}\nAddress: ${address}`,
      credentials: clientCredentials(client),
    });

    logger.info('webhook', `address captured for ${conversation.lead_phone}: ${address}`);
  } catch (err) {
    await handleError('address-capture', err);
  }
}

async function processSchedulingReply({ client, conversation, message }) {
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const now = new Date().toISOString();
    const tz  = client.timezone || 'America/New_York';

    // Parse date/time from SMS
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 100,
      messages: [
        {
          role: 'system',
          content: `Today is ${now}. Extract a specific ISO 8601 datetime from the user's message. If vague (e.g. "tomorrow afternoon"), pick 2pm. If no day, use next business day. Timezone: ${tz}. If the message contains NO date or time information at all, respond with exactly: INVALID. Otherwise respond ONLY with the ISO datetime.`,
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
        body: `Thanks for reaching out! To schedule your free estimate with ${client.business_name}, please reply with a specific day and time — for example: "Monday at 2pm" or "Friday morning". 📅`,
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
    await twilioSvc.sendSms({
      to: `+${conversation.lead_phone}`,
      from: client.twilio_number,
      body: `Great! ${formatted} works for us 📅\n\nOne last thing — what's the address for the estimate? (Street, City, State) 📍`,
      credentials: clientCredentials(client),
    });

    // Notify owner of pending appointment
    await twilioSvc.sendSms({
      to: client.owner_phone,
      from: client.twilio_number,
      body: `PENDING ADDRESS – ${client.business_name}\nName: ${conversation.lead_name || 'Customer'}\nPhone: +${conversation.lead_phone}\nService: ${conversation.service_type}\nTime: ${formatted}\n(Waiting for address)`,
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
      body: `SCHEDULED – ${client.business_name}\nPhone: ${conv.lead_phone}\nService: ${conv.service_type}\nTime: ${startDate.toLocaleString('en-US', { timeZone: client.timezone || 'America/New_York' })}\nLead said: "${speech}"`,
      credentials: clientCredentials(client),
    });
  } catch (err) {
    await handleError('twilio', err);
  }
}

module.exports = router;

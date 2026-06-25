const express = require('express');
const router  = express.Router();
const db      = require('../services/supabase');
const { invalidateClientCacheById } = require('../services/supabase');
const { calcLeadScore, detectArea, enableForwarding, disableForwarding, findNumberId } = require('../services/dialpad');
const logger  = require('../utils/logger');

const CP_CLIENT_ID    = '5221cab9-a741-4ddc-a752-2359826fba95';
const CP_DIALPAD_NUM  = '+18033738191';
const WEBHOOK_SECRET  = process.env.DIALPAD_WEBHOOK_SECRET || 'dialpad-cp-2026';

// ─── Inbound call events from Dialpad ───────────────────────────────────────
router.post('/webhook/dialpad/:clientId', express.json(), async (req, res) => {
  res.sendStatus(200); // always ack first

  try {
    const { clientId } = req.params;
    const event = req.body;
    if (!event || !event.call_id) return;

    const callerNum  = (event.from_number || event.caller_id || '').replace(/\D/g, '');
    const callerName = event.caller_name || event.from_name || null;
    const direction  = event.direction   || 'inbound';
    const status     = mapStatus(event.event || event.type);
    const duration   = event.duration    || 0;
    const recordUrl  = event.recording_url || null;
    const startedAt  = event.date_started  || event.started_at || new Date().toISOString();
    const area       = detectArea('+' + callerNum);
    const score      = calcLeadScore({ duration, direction, started_at: startedAt });

    // Upsert dialpad_calls
    const { error: upsertErr } = await db.supabaseClient()
      .from('dialpad_calls')
      .upsert({
        client_id:       clientId,
        dialpad_call_id: String(event.call_id),
        caller_number:   callerNum,
        caller_name:     callerName,
        direction,
        status,
        duration_seconds: duration,
        recording_url:   recordUrl,
        started_at:      startedAt,
        handled_by:      'secretary',
        lead_score:      score,
        area,
        raw_payload:     event,
      }, { onConflict: 'dialpad_call_id', ignoreDuplicates: false });

    if (upsertErr) logger.error('[Dialpad webhook] upsert error', upsertErr);

    // Every inbound call (missed OR answered) → create/update lead in Kanban
    if (callerNum && direction === 'inbound') {
      const phone = callerNum.startsWith('1') ? callerNum : '1' + callerNum;
      const exists = await db.checkDuplicate(clientId, phone, 120); // 2h dedup window
      if (!exists) {
        const isMissed = status === 'missed' || status === 'voicemail';
        const leadStage = isMissed ? 'new_lead' : 'ai_responded';
        const sourceTag = isMissed ? 'dialpad_missed' : 'dialpad_answered';
        const areaLabel = area ? ` · Area: ${area}` : '';
        const durLabel  = duration ? ` · ${duration}s` : '';
        await db.supabaseClient().from('conversations').insert({
          client_id:    clientId,
          lead_name:    callerName || 'Caller',
          lead_phone:   phone,
          source:       sourceTag,
          stage:        leadStage,
          service_type: 'unknown',
          email_body:   `${isMissed ? 'Missed' : 'Answered'} call via Dialpad (${CP_DIALPAD_NUM})${areaLabel}${durLabel}`,
          created_at:   new Date().toISOString(),
        });
        logger.info(`[Dialpad] ${isMissed ? 'Missed' : 'Answered'} call → lead created stage=${leadStage} for ${phone}`);
      }
    }
  } catch (err) {
    logger.error('[Dialpad webhook] error', err);
  }
});

// ─── Dialpad Call Router webhook ─────────────────────────────────────────────
// Dialpad chama esta URL ao receber uma ligação no número atribuído ao Call Router.
// Nós respondemos com JSON dizendo para onde rotear:
//   Alice ON  → phone_number +18038825001 (Twilio/Alice)
//   Alice OFF → user 6084954296598528 (Sara/Glauber no Dialpad)
const CP_SARA_USER_ID    = '6084954296598528';
const CP_ALICE_TWILIO    = '+18038825001';
const CP_CALLROUTER_ID   = '5575748513636352';

router.post('/dialpad/callrouter/:clientId', express.json(), async (req, res) => {
  try {
    const { clientId } = req.params;
    const event = req.body;
    logger.info(`[Dialpad CallRouter] clientId=${clientId} from=${event.from_number} to=${event.to_number}`);

    const { data: client } = await db.supabaseClient()
      .from('clients')
      .select('dialpad_alice_active')
      .eq('id', clientId)
      .single();

    const aliceActive = client?.dialpad_alice_active || false;

    if (aliceActive) {
      // Encaminha para Alice via Twilio
      logger.info('[Dialpad CallRouter] Alice ON → routing to Twilio');
      return res.json({ action: 'route', target_type: 'phone_number', target_id: CP_ALICE_TWILIO });
    } else {
      // Encaminha para Sara/Glauber no Dialpad (comportamento padrão)
      logger.info('[Dialpad CallRouter] Alice OFF → routing to Sara');
      return res.json({ action: 'route', target_type: 'user', target_id: CP_SARA_USER_ID });
    }
  } catch (err) {
    logger.error('[Dialpad CallRouter] error', err);
    // fallback: Sara atende
    return res.json({ action: 'route', target_type: 'user', target_id: CP_SARA_USER_ID });
  }
});

// ─── Toggle Alice ON / OFF ────────────────────────────────────────────────────
// Alice ON  → habilita forwarding do usuário Dialpad para o Twilio da Alice
// Alice OFF → desabilita forwarding; Sara recebe chamadas no Dialpad normalmente
router.post('/dialpad/toggle', express.json(), async (req, res) => {
  try {
    const { clientId, active } = req.body;
    if (!clientId || typeof active !== 'boolean') {
      return res.status(400).json({ error: 'clientId and active (bool) required' });
    }

    const { data: client, error: clientErr } = await db.supabaseClient()
      .from('clients')
      .select('business_name, dialpad_twilio_forward_number, dialpad_user_id')
      .eq('id', clientId)
      .single();

    if (clientErr || !client) return res.status(404).json({ error: 'Client not found' });

    const dialpadUserId = client.dialpad_user_id || (clientId === CP_CLIENT_ID ? CP_SARA_USER_ID : null);
    if (dialpadUserId) {
      const { enableForwarding, disableForwarding } = require('../services/dialpad');
      if (active) {
        await enableForwarding(dialpadUserId, client.dialpad_twilio_forward_number || CP_ALICE_TWILIO);
      } else {
        await disableForwarding(dialpadUserId);
      }
    }

    const { error: updateErr } = await db.supabaseClient()
      .from('clients')
      .update({ dialpad_alice_active: active })
      .eq('id', clientId);

    if (updateErr) {
      logger.error('[Dialpad toggle] DB update error', updateErr.message);
      return res.status(500).json({ error: 'DB update failed: ' + updateErr.message });
    }

    invalidateClientCacheById(clientId);
    logger.info(`[Dialpad] Alice toggle → ${active ? 'ON' : 'OFF'} for ${client.business_name}`);
    return res.json({ ok: true, alice_active: active });
  } catch (err) {
    logger.error('[Dialpad toggle] error', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Get toggle state ─────────────────────────────────────────────────────────
router.get('/dialpad/status/:clientId', async (req, res) => {
  try {
    const { data, error } = await db.supabaseClient()
      .from('clients')
      .select('dialpad_alice_active, dialpad_number_id')
      .eq('id', req.params.clientId)
      .single();

    if (error) return res.status(404).json({ error: 'Client not found' });
    return res.json({ alice_active: data.dialpad_alice_active || false });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Call analytics ───────────────────────────────────────────────────────────
router.get('/dialpad/analytics/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const days = parseInt(req.query.days || '30');
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const { data: calls, error } = await db.supabaseClient()
      .from('dialpad_calls')
      .select('*')
      .eq('client_id', clientId)
      .gte('started_at', since)
      .order('started_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const total    = calls.length;
    const missed   = calls.filter(c => c.status === 'missed').length;
    const answered = calls.filter(c => c.status === 'answered').length;
    const avgDur   = total ? Math.round(calls.reduce((s, c) => s + (c.duration_seconds || 0), 0) / total) : 0;

    // Peak hours
    const hourBuckets = Array(24).fill(0);
    calls.forEach(c => {
      if (c.started_at) hourBuckets[new Date(c.started_at).getHours()]++;
    });
    const peakHour = hourBuckets.indexOf(Math.max(...hourBuckets));

    // Area breakdown
    const areaCounts = {};
    calls.forEach(c => { areaCounts[c.area || 'Unknown'] = (areaCounts[c.area || 'Unknown'] || 0) + 1; });

    return res.json({
      period_days:  days,
      total,
      answered,
      missed,
      miss_rate:    total ? Math.round((missed / total) * 100) : 0,
      avg_duration: avgDur,
      peak_hour:    peakHour,
      by_area:      areaCounts,
      calls,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

function mapStatus(event) {
  const e = (event || '').toLowerCase();
  if (e.includes('miss') || e.includes('no_answer')) return 'missed';
  if (e.includes('connect') || e.includes('answer') || e.includes('hung_up') || e.includes('ended')) return 'answered';
  if (e.includes('voicemail')) return 'voicemail';
  return 'ringing';
}

module.exports = router;

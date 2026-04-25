const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

const SUPABASE_URL = 'https://pvphgusjofufwtyiyviu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2cGhndXNqb2Z1Znd0eWl5dml1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyNjkwODYsImV4cCI6MjA5MDg0NTA4Nn0.0aA8YNmhVusNuBjWZoEZW50dTRZWowm9AoNVoyGCXBM';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getClientByTwilioNumber(twilioNumber) {
  const { data, error } = await supabase
    .from('clients')
    .select('*, pricing(*)')
    .eq('twilio_number', twilioNumber)
    .eq('active', true)
    .single();

  if (error) throw new Error(`Supabase getClient: ${error.message}`);
  return data;
}

async function getExistingConversation(clientId, leadPhone) {
  const { data } = await supabase
    .from('conversations')
    .select('*')
    .eq('client_id', clientId)
    .eq('lead_phone', leadPhone)
    .in('stage', ['ai_responded', 'new_lead'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return data || null;
}

async function checkDuplicate(clientId, leadPhone, minutes = 60) {
  const { data, error } = await supabase.rpc('check_duplicate_lead', {
    p_client_id: clientId,
    p_lead_phone: leadPhone,
    p_minutes: minutes,
  });
  if (error) throw new Error(`Supabase checkDuplicate: ${error.message}`);
  return data;
}

async function saveLead({ clientId, leadPhone, leadName = 'Customer', source, serviceType, message }) {
  const { data, error } = await supabase
    .from('conversations')
    .insert({
      client_id: clientId,
      lead_name: leadName,
      lead_phone: leadPhone,
      source,
      stage: 'new_lead',
      service_type: serviceType,
      email_body: message,
    })
    .select()
    .single();

  if (error) throw new Error(`Supabase saveLead: ${error.message}`);
  return data;
}

async function updateConversation(id, fields) {
  const { error } = await supabase
    .from('conversations')
    .update(fields)
    .eq('id', id);
  if (error) throw new Error(`Supabase updateConversation: ${error.message}`);
}

async function updateConversationByCallSid(callSid, fields) {
  const { error } = await supabase
    .from('conversations')
    .update(fields)
    .eq('call_sid', callSid);
  if (error) throw new Error(`Supabase updateConversationByCallSid: ${error.message}`);
}

async function saveError(service, level, message, stack) {
  await supabase.from('system_errors').insert({ service, level, message, stack }).then(({ error }) => {
    if (error) logger.error('supabase', 'failed to save error log', error.message);
  });
}

async function getLeads({ page = 1, limit = 20, search = '', stage = '' } = {}) {
  const from = (page - 1) * limit;
  let query = supabase
    .from('conversations')
    .select('*, clients(business_name, twilio_number)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, from + limit - 1);
  if (stage) query = query.eq('stage', stage);
  if (search) query = query.or(`lead_phone.ilike.%${search}%,lead_name.ilike.%${search}%`);
  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { data, count };
}

async function getAllLeadsForExport() {
  const { data, error } = await supabase
    .from('conversations')
    .select('*, clients(business_name)')
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) throw new Error(error.message);
  return data;
}

async function getWeeklyStats() {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const { data, error } = await supabase
    .from('conversations')
    .select('stage, client_id, clients(business_name, owner_phone, twilio_number)')
    .gte('created_at', weekAgo.toISOString());
  if (error) throw new Error(error.message);
  // group by client
  const map = {};
  (data || []).forEach(r => {
    const id = r.client_id;
    if (!map[id]) map[id] = { client: r.clients, total: 0, scheduled: 0, responded: 0 };
    map[id].total++;
    if (r.stage === 'scheduled')    map[id].scheduled++;
    if (r.stage === 'ai_responded') map[id].responded++;
  });
  return Object.values(map);
}

async function getLeadById(id) {
  const { data, error } = await supabase
    .from('conversations')
    .select('*, clients(business_name, twilio_number, owner_phone)')
    .eq('id', id)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function getClients() {
  const { data, error } = await supabase
    .from('clients')
    .select('id, business_name, twilio_number, owner_phone, active, timezone, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data;
}

async function updateClient(id, fields) {
  const { error } = await supabase.from('clients').update(fields).eq('id', id);
  if (error) throw new Error(error.message);
}

async function getErrors() {
  const { data, error } = await supabase
    .from('system_errors')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return data;
}

async function getAppointments() {
  const { data, error } = await supabase
    .from('conversations')
    .select('*, clients(business_name, twilio_number, owner_phone)')
    .in('stage', ['scheduled', 'ai_responded'])
    .order('scheduled_at', { ascending: true, nullsFirst: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function getDayStats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const [todayRes, weekRes, callsRes] = await Promise.all([
    supabase.from('conversations').select('id', { count: 'exact' }).gte('created_at', today.toISOString()),
    supabase.from('conversations').select('id', { count: 'exact' }).gte('created_at', weekAgo.toISOString()),
    supabase.from('conversations').select('id', { count: 'exact' }).gte('created_at', today.toISOString()).not('call_sid', 'is', null),
  ]);

  const totalToday = todayRes.count || 0;
  const callsToday = callsRes.count || 0;

  return {
    leadsToday: totalToday,
    callsToday,
    responseRate: totalToday > 0 ? Math.round((callsToday / totalToday) * 100) : 0,
    leadsWeek: weekRes.count || 0,
  };
}

async function getHourlyLeads() {
  const since = new Date();
  since.setHours(since.getHours() - 24);

  const { data, error } = await supabase
    .from('conversations')
    .select('created_at')
    .gte('created_at', since.toISOString());

  if (error) throw new Error(error.message);

  const hours = Array(24).fill(0);
  (data || []).forEach(row => {
    const h = new Date(row.created_at).getHours();
    hours[h]++;
  });
  return hours;
}

async function optOutLead(leadPhone, twilioNumber) {
  await supabase.from('sms_opt_outs').upsert({ lead_phone: leadPhone, twilio_number: twilioNumber, opted_out_at: new Date().toISOString() });
}

async function optInLead(leadPhone, twilioNumber) {
  await supabase.from('sms_opt_outs').delete().eq('lead_phone', leadPhone).eq('twilio_number', twilioNumber);
}

async function isOptedOut(leadPhone, twilioNumber) {
  const { data } = await supabase.from('sms_opt_outs').select('id').eq('lead_phone', leadPhone).eq('twilio_number', twilioNumber).single();
  return !!data;
}

module.exports = {
  getClientByTwilioNumber,
  getExistingConversation,
  checkDuplicate,
  saveLead,
  updateConversation,
  updateConversationByCallSid,
  saveError,
  getLeads,
  getAllLeadsForExport,
  getWeeklyStats,
  getLeadById,
  getClients,
  updateClient,
  getErrors,
  getAppointments,
  optOutLead,
  optInLead,
  isOptedOut,
  getDayStats,
  getHourlyLeads,
};

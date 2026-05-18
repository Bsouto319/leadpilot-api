const OpenAI = require('openai');
const logger = require('../utils/logger');

let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

async function generateVoiceScript({ businessName, serviceType, pricing, systemPrompt }) {
  const pricingText = pricing && pricing.length > 0
    ? pricing.map(p => `${p.label || p.service_type}: ${p.notes || 'FREE estimate'}`).join(', ')
    : 'FREE in-home estimate';

  const defaultPrompt = `Generate a short, warm voice script for an AI assistant calling a lead on behalf of ${businessName}.
Rules:
- Introduce as the assistant of ${businessName}
- Mention you received their ${serviceType.replace(/_/g, ' ')} request
- Say you are ready to help schedule a FREE estimate or consultation
- Ask them to reply to the text message with their preferred day and time
- Max 3 sentences — clear, warm, professional
- NEVER mention specific prices
Respond ONLY with the script, no quotes or labels.`;

  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 150,
    temperature: 0.6,
    messages: [
      { role: 'system', content: systemPrompt || defaultPrompt },
      { role: 'user',   content: `Write the voice script for a ${serviceType.replace(/_/g, ' ')} request.` },
    ],
  });

  const script = completion.choices[0].message.content.trim();
  logger.info('openai', `script generated for ${businessName} / ${serviceType}`);
  return script;
}

// Deep lead qualification — analyzes Thumbtack/inbound lead data and returns score + insight.
// Used to populate score/summary on the dashboard card immediately after lead arrives.
async function qualifyLead({ name, serviceType, serviceNote, businessName, phone }) {
  const openai = getOpenAI();

  const prompt = `You are an expert lead qualification AI for a home services contractor (flooring, tile, remodeling, custom homes).

Analyze this inbound lead and respond ONLY with valid JSON:
{
  "score": <integer 0-100: buying intent + job value + project specificity + urgency>,
  "tier": <"hot" | "warm" | "cold">,
  "job_value_estimate": <estimated job value in USD as integer, or null if impossible to estimate>,
  "summary": "<2 sentences max: what they need, key signals (urgency/size/quality), and why the score is what it is>",
  "signals": [<list of 2-4 short signal strings, e.g. "urgency detected", "large project", "vague request", "premium intent">]
}

Scoring guide:
- 80-100 (hot): specific project, clear scope, urgency signals, high job value
- 50-79 (warm): reasonable project description, moderate specificity, no red flags
- 0-49 (cold): vague request, "just browsing", very small job, or signs of price shopping only

Job value reference for ${businessName}:
- Tile install (bathroom): $2,000–$8,000 | full house: $8,000–$25,000
- Kitchen remodel: $15,000–$60,000 | bathroom remodel: $8,000–$30,000
- Custom home build: $200,000–$800,000+
- Repair/replacement: $500–$3,000
- General/estimate: estimate based on description

Lead data:
- Name: ${name || 'Unknown'}
- Phone area code: ${phone ? phone.slice(0, 3) : 'unknown'}
- Service type: ${serviceType.replace(/_/g, ' ')}
- Job description: "${serviceNote || 'No description provided'}"`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 400,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
  });

  const json = JSON.parse(completion.choices[0].message.content);
  const score    = Math.max(0, Math.min(100, parseInt(json.score) || 0));
  const tier     = ['hot', 'warm', 'cold'].includes(json.tier) ? json.tier : (score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold');
  const summary  = (json.summary || '').slice(0, 300);
  const jobValue = parseInt(json.job_value_estimate) || null;
  const signals  = Array.isArray(json.signals) ? json.signals.slice(0, 4) : [];

  logger.info('openai', `lead qualified: score=${score} tier=${tier} value=$${jobValue} — ${name}`);
  return { score, tier, summary, jobValue, signals };
}

module.exports = { generateVoiceScript, qualifyLead };

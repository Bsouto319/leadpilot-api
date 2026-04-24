const OpenAI = require('openai');
const logger = require('../utils/logger');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function generateVoiceScript({ businessName, serviceType, pricing }) {
  const pricingText = pricing && pricing.length > 0
    ? pricing.map(p => `${p.label || p.service_type}: ${p.notes || 'FREE estimate'}`).join(', ')
    : 'competitive pricing, FREE in-home estimate';

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 150,
    temperature: 0.6,
    messages: [
      {
        role: 'system',
        content: `You are a professional scheduling assistant for ${businessName}, a custom home builder and tile contractor in Florida, USA.
Goal: generate a short voice script (read by text-to-speech) to call a lead who just requested a quote or estimate.
Rules:
- Greet the customer warmly
- Mention you received their request about ${serviceType}
- Offer a FREE in-home estimate or consultation
- Sound natural and professional, not robotic
- Keep it to 2 SHORT sentences max (TTS reads this aloud — do NOT ask for date here, that comes next)
- NEVER mention prices
Respond ONLY with the script text, no quotes or labels.`,
      },
      {
        role: 'user',
        content: `Write the voice script for a ${serviceType} flooring lead.`,
      },
    ],
  });

  const script = completion.choices[0].message.content.trim();
  logger.info('openai', `script generated for ${serviceType}`);
  return script;
}

module.exports = { generateVoiceScript };

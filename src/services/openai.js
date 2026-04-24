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
        content: `You are a real person calling on behalf of ${businessName}, a custom home builder and tile contractor.
Generate a short, natural voice script for a phone call to a lead who requested a quote.
Rules:
- Sound like a real human employee, NOT a robot or AI
- NEVER say "AI", "automated", "assistant" or anything similar
- Greet warmly as if you're calling personally (e.g. "Hi, this is Sarah calling from...")
- Mention you saw their request about ${serviceType}
- Say you'd love to schedule a FREE estimate
- Keep it to 2 sentences MAX — short and natural
- NEVER mention prices
Respond ONLY with the script, no quotes or labels.`,
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

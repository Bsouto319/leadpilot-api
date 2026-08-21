// Normaliza qualquer telefone (com/sem "+", com DDI ou não, com lixo tipo "{" "}" de
// array mal formatado) pro formato E.164 que a Twilio exige. Usar sempre na hora de
// discar/mandar SMS -- nunca confiar que o dado já está limpo no banco.
function toE164(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return '+1' + digits;
  return '+' + digits;
}

module.exports = { toE164 };

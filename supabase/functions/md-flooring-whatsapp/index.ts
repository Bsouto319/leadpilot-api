import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// Assistente pessoal do Bruno via WhatsApp pra organizar leads da MD Flooring
// Solutions que chegam por fora do fluxo automático (SMS/telefone direto,
// não passam pelo webhook do Thumbtack/site). A extração por IA e o
// salvamento acontecem no próprio LeadPilot (endpoint protegido por
// ADMIN_KEY, já tem a chave da OpenAI configurada) -- essa função só precisa
// falar com a UAZAPI.
//
// Payload real da UAZAPI (evento "messages", confirmado em
// https://docs.uazapi.com/webhook/messages -- NÃO é o formato
// body.data.key.remoteJid que o gz-whatsapp assume, esse formato causava
// falha silenciosa: remoteJid/messageType vinham undefined):
// { EventType, message: { sender, chatid, fromMe, isGroup, messageType,
//   text, messageid, ... } }

const UAZAPI_BASE = "https://btechsoutoshop.uazapi.com";
const LEADPILOT_API = "https://leads.btechsouto.shop";
const MD_FLOORING_CLIENT_ID = "2b917476-bda9-4e5e-9f4e-6bd0d1238b5a";
// Só o Bruno usa esse assistente -- qualquer outro remetente é ignorado.
const AUTHORIZED_PHONE = "5561982025951";

serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  let body: any;
  try { body = await req.json(); } catch { return new Response("ok", { status: 200 }); }

  const msg = body?.message;
  if (!msg || msg.fromMe === true || msg.isGroup === true) return new Response("ok", { status: 200 });

  const senderJid: string = msg.sender || msg.chatid || "";
  const phone = senderJid.replace(/@.*/, "").replace("+", "");
  const messageType = String(msg.messageType || "").toLowerCase();
  const messageId: string = msg.messageid || msg.id || "";
  console.log("MDF-DEBUG sender:", senderJid, "| phone:", phone, "| type:", messageType);

  if (phone !== AUTHORIZED_PHONE) {
    console.log("MDF-DEBUG rejected: phone mismatch, expected", AUTHORIZED_PHONE);
    return new Response("ok", { status: 200 });
  }

  const UAZAPI_TOKEN = Deno.env.get("UAZAPI_TOKEN")!;
  const ADMIN_KEY = Deno.env.get("LEADPILOT_ADMIN_KEY")!;

  try {
    let text = "";
    if (messageType === "conversation" || messageType === "extendedtextmessage") {
      text = msg.text || "";
    } else if (messageType === "audiomessage") {
      text = await transcreverAudio(messageId, UAZAPI_TOKEN);
      if (!text) {
        await replyText(phone, "Não consegui transcrever o áudio. Manda por texto?", UAZAPI_TOKEN);
        return new Response("ok", { status: 200 });
      }
    } else {
      console.log("MDF-DEBUG ignored messageType:", messageType);
      return new Response("ok", { status: 200 });
    }

    if (!text.trim()) return new Response("ok", { status: 200 });

    const resp = await fetch(`${LEADPILOT_API}/api/cron/manual-lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY },
      body: JSON.stringify({
        client_id: MD_FLOORING_CLIENT_ID,
        raw_text: text,
        service_type: "flooring",
        timezone: "America/New_York",
      }),
    });
    const result = await resp.json();

    if (!resp.ok || !result.ok) {
      await replyText(phone, "⚠️ " + (result.error || `Erro ${resp.status}`), UAZAPI_TOKEN);
      return new Response("ok", { status: 200 });
    }

    const aviso = result.warning ? `⚠️ ${result.warning}\n\n` : "";
    await replyText(phone, `${aviso}✅ ${result.message}`, UAZAPI_TOKEN);
  } catch (e) {
    console.error("md-flooring-whatsapp error:", e);
    await replyText(phone, "Erro ao processar. Tenta de novo em instantes.", UAZAPI_TOKEN);
  }

  return new Response("ok", { status: 200 });
});

// ─── UAZAPI ──────────────────────────────────────────────────────────────────

async function replyText(phone: string, text: string, token: string) {
  try {
    const resp = await fetch(`${UAZAPI_BASE}/send/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "token": token },
      body: JSON.stringify({ number: phone, text }),
    });
    console.log("MDF UAZAPI-SEND:", resp.status);
  } catch (e) {
    console.error("replyText error:", e);
  }
}

// Transcrição embutida da própria UAZAPI (POST /message/download com
// transcribe:true) -- não precisa baixar base64 nem chamar Whisper na mão.
async function transcreverAudio(messageId: string, token: string): Promise<string> {
  if (!messageId) return "";
  try {
    const resp = await fetch(`${UAZAPI_BASE}/message/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "token": token },
      body: JSON.stringify({ id: messageId, transcribe: true }),
    });
    if (!resp.ok) {
      console.log("MDF-DEBUG transcribe failed:", resp.status, await resp.text());
      return "";
    }
    const json = await resp.json();
    return json.transcription || "";
  } catch (e) {
    console.error("transcreverAudio error:", e);
    return "";
  }
}

# LeadPilot API

Backend de automação de leads via SMS e voz para empresas de construção/flooring/tile nos EUA. Responde leads em 60 segundos, liga automaticamente, agenda visitas e faz follow-up — tudo sem intervenção humana.

**Stack:** Node.js · Express · Supabase · Twilio · OpenAI GPT-4o-mini · Google Calendar

---

## Como Funciona

```
Lead (Thumbtack / Angi / Google)
        │
        ▼ SMS ou email Thumbtack
┌───────────────────┐
│  /webhook/sms     │  Lead inicia contato
│  /webhook/thumbtack-lead │
└────────┬──────────┘
         │ 60 segundos
         ▼
┌───────────────────┐
│  Ligação Twilio   │  AI atende, coleta serviço/data/endereço
│  SMS de follow-up │  Enviados simultaneamente
└────────┬──────────┘
         │
         ▼ Lead responde com data
┌───────────────────┐
│  GPT-4o-mini      │  Interpreta data → pede endereço
└────────┬──────────┘
         │ Lead responde com endereço
         ▼
┌───────────────────┐
│  Google Calendar  │  Cria evento confirmado
│  SMS de confirmação│
│  Notificação dono │  Em Português
└────────┬──────────┘
         │
         ▼ Crons automáticos
┌───────────────────┐
│  D-1: Reminder    │
│  D+3/D+7: Follow-up│
│  Pós visita: Review│
│  No-show: Re-engage│
└───────────────────┘
```

---

## Estágios do Lead

| Stage | Descrição |
|-------|-----------|
| `new_lead` | Lead acabou de entrar no sistema |
| `ai_responded` | Sistema respondeu, aguardando agendamento |
| `awaiting_address` | Data definida, aguardando endereço |
| `scheduled` | Visita agendada com data + endereço |
| `completed` | Visita realizada |
| `no_show` | Lead não apareceu |
| `opted_out` | Lead enviou STOP |

---

## Variáveis de Ambiente

Copie `.env.example` para `.env` e preencha:

```env
# Servidor
PORT=3000
BASE_URL=https://seu-dominio.com          # URL pública do backend (sem barra final)

# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=eyJ...                       # Anon key do projeto

# Twilio (principal)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxx
ALERT_FROM=+19418456110                   # Número Twilio que envia SMS/faz ligações

# Twilio API Key (para browser click-to-call)
TWILIO_API_KEY=SKxxxxxxxxxxxxxxxx         # Criar em: console.twilio.com/us1/account/keys
TWILIO_API_SECRET=xxxxxxxxxxxxxxxx
TWILIO_TWIML_APP_SID=APxxxxxxxxxxxxxxxx  # Criado via POST /api/admin/setup-voice-app

# Admin
ADMIN_KEY=sua-chave-secreta              # Header x-admin-key para rotas admin/cron
ALERT_PHONE=+5561999999999               # Telefone que recebe alertas de erro

# OpenAI
OPENAI_API_KEY=sk-proj-...

# Google (OAuth — para Calendar e Gmail/Thumbtack)
GOOGLE_CLIENT_ID=xxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxx

# Thumbtack (opcional)
THUMBTACK_WEBHOOK_SECRET=seu-secret      # Valida requisições do webhook Thumbtack
```

---

## Endpoints

### Webhooks (`/webhook`) — chamados pelo Twilio/Thumbtack

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/webhook/sms` | SMS inbound do Twilio. Detecta opt-out/opt-in/HELP, processa resposta do lead, chama IA, agenda. |
| POST | `/webhook/thumbtack-lead` | Recebe lead do Thumbtack (via Zapier ou direto). Body JSON com nome, telefone, serviço. |
| POST | `/webhook/voice-outbound` | TwiML para click-to-call do browser. Retorna `<Dial>` com o número destino. |
| POST | `/webhook/voice` | TwiML para chamada inbound. IA atende o lead por voz. |
| POST | `/webhook/voice-intake` | Processador multi-etapa da coleta por voz (serviço → data → endereço). |
| POST | `/webhook/call-status` | Callback de status da ligação Twilio (completed/failed/busy). |
| POST | `/webhook/call-gather` | Resultado de speech recognition da ligação. Interpreta data falada. |

### Admin (`/api/admin`) — requer header `x-admin-key`

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/admin/health` | Health check — retorna uptime e timestamp. |
| GET | `/api/admin/stats` | Estatísticas do dia/semana: leads, ligações, taxa de conversão, distribuição por hora. |
| GET | `/api/admin/leads` | Lista paginada de leads com filtro por stage e cliente. |
| GET | `/api/admin/leads/export/csv` | Exporta todos os leads como arquivo CSV. |
| GET | `/api/admin/leads/:id` | Detalhes completos de um lead. |
| PATCH | `/api/admin/leads/:id` | Atualiza stage, notes, nome ou scheduled_at de um lead. |
| GET | `/api/admin/leads/:id/messages` | Histórico de mensagens da conversa. |
| POST | `/api/admin/leads/:id/send-sms` | Envia SMS manual para o lead. |
| GET | `/api/admin/clients` | Lista todos os clientes ativos. |
| POST | `/api/admin/clients` | Cria novo cliente. |
| PATCH | `/api/admin/clients/:id` | Atualiza configurações do cliente (timezone, prompt IA, credenciais Twilio, etc.). |
| GET | `/api/admin/appointments` | Lista agendamentos (scheduled / awaiting_address). |
| PATCH | `/api/admin/appointments/:id` | Atualiza agendamento. |
| POST | `/api/admin/weekly-report` | Dispara relatório semanal via SMS para todos os clientes. |
| POST | `/api/admin/test-alert` | Envia SMS de teste para validar sistema de alertas. |
| GET | `/api/admin/errors` | Últimos 20 erros registrados no banco. |
| POST | `/api/admin/twilio-fix` | Diagnóstica conta Twilio (voice capabilities, geo permissions). |
| POST | `/api/admin/setup-voice-app` | Cria TwiML App no Twilio para click-to-call (rodar uma vez). |
| POST | `/api/admin/voice-token` | Gera Access Token JWT para Twilio Voice JS SDK (browser softphone). |

### Cron (`/api/cron`) — requer header `x-admin-key`

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/cron/reminders` | Envia SMS de reminder 24h antes dos agendamentos. |
| POST | `/api/cron/followups` | Envia follow-up D+3 e D+7 para leads sem agendamento. |
| POST | `/api/cron/reviews` | Pede review Google para leads com visita concluída. |
| POST | `/api/cron/noshows` | Re-engaja leads que não apareceram na visita. |

---

## Cron Jobs (automáticos)

Todos rodam no timezone `America/New_York`:

| Horário | Job | O que faz |
|---------|-----|-----------|
| 9h diário | reminders | SMS de lembrete 24h antes da visita |
| 10h diário | followups | "Ainda tem interesse?" para leads de D+3 e D+7 |
| 18h diário | reviews | Solicita review Google pós-visita |
| 20h diário | noshows | Re-engaja leads que faltaram |
| Segunda 8h | weekly-report | Resumo semanal para os donos de cada empresa |
| A cada 10min | thumbtack-poll | Verifica email Gmail de cada cliente por leads novos do Thumbtack |

---

## Multi-Tenant: Adicionando Novo Cliente

Cada cliente é um registro na tabela `clients` do Supabase. Para adicionar:

```sql
INSERT INTO clients (
  business_name,
  twilio_number,       -- número Twilio comprado para este cliente
  owner_phone,         -- telefone do dono (notificações em Português)
  owner_email,
  timezone,            -- ex: 'America/New_York', 'America/Chicago'
  review_link,         -- link Google Review do negócio
  ai_system_prompt,    -- (opcional) prompt customizado para a IA
  voice_script         -- (opcional) script customizado para ligação
) VALUES (
  'Empresa do Cliente',
  '+15551234567',
  '+5561999990000',
  'cliente@email.com',
  'America/New_York',
  'https://g.page/r/...',
  NULL,                -- usa prompt padrão
  NULL                 -- usa script padrão
);
```

Depois configure o número Twilio do cliente para apontar os webhooks para este backend:
- **SMS Webhook:** `POST https://seu-dominio/webhook/sms`
- **Voice Webhook:** `POST https://seu-dominio/webhook/voice`

---

## Click-to-Call (Browser Softphone)

Permite ligar para leads diretamente do dashboard, usando o número Twilio (`+19418456110`) como caller ID.

### Setup (uma vez por conta Twilio)

```bash
# 1. Criar API Key no Twilio Console
# console.twilio.com/us1/account/keys → Create API Key
# Salvar Key SID (SK...) e Secret

# 2. Adicionar no Coolify:
TWILIO_API_KEY=SKxxxx
TWILIO_API_SECRET=xxxx

# 3. Criar TwiML App via API
curl -X POST https://seu-dominio/api/admin/setup-voice-app \
  -H "x-admin-key: sua-chave"

# 4. Copiar o TwiML App SID retornado e adicionar no Coolify:
TWILIO_TWIML_APP_SID=APxxxx
```

### Como funciona

```
Browser (Dashboard React)
   │ POST /api/voice-token (Vercel)
   │ → proxy para POST /api/admin/voice-token (Backend)
   │ ← JWT AccessToken (TTL 1h)
   │
   │ device.connect({ To: '+15551234567' })
   │ → Twilio Cloud
   │ → POST /webhook/voice-outbound (TwiML App)
   │ → <Dial callerId="+19418456110">número</Dial>
   │
   ▼ Ligação conectada no browser
```

### Arquitetura Vercel (dashboard)

- `api/voice-token.js` — proxy para o backend (evita HTTPS/mixed-content)
- `api/voice-outbound.js` — TwiML fallback (caso backend indisponível)

---

## Compliance SMS (EUA)

- **TCPA:** Lead sempre inicia o contato (Mobile Originated = consentimento estabelecido)
- **STOP/HELP/START:** Detectados e tratados automaticamente
- **Business hours:** SMS só enviados entre 8h–21h no timezone do cliente
- **A2P 10DLC:** Brand e Campaign registrados no Twilio

---

## Deploy (Coolify)

O backend roda em Docker no VPS `31.97.240.160` via Coolify. Deploy automático: push para `main` → Coolify rebuild.

```
Repositório: github.com/Bsouto319/leadpilot-api (branch: main)
Container:   asso488k40o4gsc8c0w80gcw-*
URL interna: http://asso488k40o4gsc8c0w80gcw.31.97.240.160.sslip.io
URL pública: https://leads.btechsouto.shop (DNS pendente → Hostinger)
Dashboard:   https://leadpilot-dashboard-mu.vercel.app
```

Para ver logs em tempo real no VPS:
```bash
ssh root@31.97.240.160
docker logs -f <container_id> --tail 100
```

---

## Desenvolvimento Local

```bash
git clone https://github.com/Bsouto319/leadpilot-api.git
cd leadpilot-api
npm install
cp .env.example .env   # preencher variáveis
npm run dev            # nodemon, reload automático
```

Para receber webhooks do Twilio localmente:
```bash
npx ngrok http 3000
# Configurar a URL do ngrok nos webhooks do número Twilio
```

---

## Estrutura do Projeto

```
leadpilot-api/
├── src/
│   ├── server.js              # Entry point, cron jobs, middleware
│   ├── routes/
│   │   ├── webhook.js         # SMS, voz, Thumbtack, click-to-call
│   │   ├── admin.js           # Gestão de leads, clientes, voice token
│   │   └── cron.js            # Endpoints para crons manuais
│   ├── services/
│   │   ├── supabase.js        # Queries ao banco de dados
│   │   ├── twilio.js          # SMS, ligações, validação de assinatura
│   │   ├── openai.js          # GPT-4o-mini: scripts de voz, respostas IA
│   │   ├── calendar.js        # Google Calendar API
│   │   ├── gmail.js           # Gmail polling para leads do Thumbtack
│   │   └── thumbtack.js       # Parsing e injeção de leads do Thumbtack
│   ├── middleware/
│   │   ├── alerting.js        # Alertas de erro via SMS + log no banco
│   │   └── errorHandler.js    # Express error handler global
│   └── utils/
│       └── logger.js          # Logger estruturado com timestamp
├── public/
│   └── call.html              # Página standalone de click-to-call (legado)
├── .env.example
├── Dockerfile
└── package.json
```

---

## Primeiro Cliente

**Denali Custom Homes** — tile installation, Sarasota FL  
Contato: Rodrigo · `732-556-7962` · `denalicustomhomes@outlook.com`  
Número Twilio: `+19418456110`  
Dashboard: login com `denalicustomhomes@outlook.com`

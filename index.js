const express = require('express')
const Database = require('better-sqlite3')
const { google } = require('googleapis')
const nodemailer = require('nodemailer')
const app = express()
app.use(express.json())

// ─── Configurações ─────────────────────────────────────────────────────────────

const INSTANCE_ID    = process.env.INSTANCE_ID    || '3F424535214202979B1E7A94F00847F6'
const INSTANCE_TOKEN = process.env.INSTANCE_TOKEN || 'EA8E2F27C3F469BA1874CEED'
const CLIENT_TOKEN   = process.env.CLIENT_TOKEN   || 'F778ca59b075541ad8cfd7e6cb843fc52S'
const CLAUDE_KEY     = process.env.CLAUDE_KEY
const CALENDAR_ID    = process.env.CALENDAR_ID    || 'ygshubo@gmail.com'
const EMAIL_USER     = process.env.EMAIL_USER || 'kidesignmadeiras@gmail.com'
const EMAIL_PASS     = process.env.EMAIL_PASS || 'lgrifedhewiuvlcg'

const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS
  ? JSON.parse(process.env.GOOGLE_CREDENTIALS)
  : require('./bot-clinica-498513-4ecc9c74721e.json')

// ─── Banco de dados ────────────────────────────────────────────────────────────

const db = new Database('clinica.db')

db.exec(`CREATE TABLE IF NOT EXISTS pacientes (
  telefone    TEXT PRIMARY KEY,
  nome        TEXT,
  nascimento  TEXT,
  sexo        TEXT,
  endereco    TEXT,
  plano       TEXT,
  motivo      TEXT,
  email       TEXT,
  agendamento TEXT,
  lembrete_dia TEXT,
  lembrete_2h  TEXT,
  criado      TEXT,
  atualizado  TEXT
)`)

db.exec(`CREATE TABLE IF NOT EXISTS historico (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  telefone  TEXT,
  role      TEXT,
  content   TEXT,
  criado    TEXT
)`)

// Migrações seguras para bancos já existentes
const migracoes = [
  "ALTER TABLE pacientes ADD COLUMN email TEXT",
  "ALTER TABLE pacientes ADD COLUMN agendamento TEXT",
  "ALTER TABLE pacientes ADD COLUMN lembrete_dia TEXT",
  "ALTER TABLE pacientes ADD COLUMN lembrete_2h TEXT",
]
migracoes.forEach(sql => { try { db.exec(sql) } catch (_) {} })

// ─── Helpers de data ───────────────────────────────────────────────────────────

// Retorna o dia da semana (0=Dom, 1=Seg, ..., 6=Sáb) para uma data 'DD/MM/AAAA'
function diaDaSemana(dataStr) {
  const [dia, mes, ano] = dataStr.split('/')
  return new Date(`${ano}-${mes}-${dia}T12:00:00`).getDay()
}

// Retorna os slots de horário disponíveis conforme o dia da semana
function slotsPermitidos(dow) {
  if (dow === 0) return []                          // Domingo: fechado
  if (dow === 6) return gerarSlots(8, 12)           // Sábado: 08h-12h
  return gerarSlots(8, 18)                          // Seg-Sex: 08h-18h
}

function gerarSlots(inicio, fim) {
  const slots = []
  for (let h = inicio; h < fim; h++) slots.push(`${String(h).padStart(2, '0')}:00`)
  return slots
}

// Converte 'DD/MM/AAAA HH:MM' para objeto Date no fuso de Brasília
function parseDatetimeBR(agendamento) {
  const [data, hora] = agendamento.split(' às ')
  const [dia, mes, ano] = data.split('/')
  const [hh, mm] = hora.split(':')
  return new Date(`${ano}-${mes}-${dia}T${hh}:${mm}:00-03:00`)
}

// ─── Google Calendar ───────────────────────────────────────────────────────────

function getCalendarClient() {
  const auth = new google.auth.JWT(
    GOOGLE_CREDENTIALS.client_email,
    null,
    GOOGLE_CREDENTIALS.private_key,
    ['https://www.googleapis.com/auth/calendar']
  )
  return google.calendar({ version: 'v3', auth })
}

async function verificarHorariosLivres(dataStr) {
  const dow = diaDaSemana(dataStr)
  const permitidos = slotsPermitidos(dow)

  if (permitidos.length === 0) return { fechado: true, livres: [] }

  const [dia, mes, ano] = dataStr.split('/')
  const inicio = new Date(`${ano}-${mes}-${dia}T00:00:00-03:00`)
  const fim    = new Date(`${ano}-${mes}-${dia}T23:59:59-03:00`)

  const calendar = getCalendarClient()
  const resp = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: inicio.toISOString(),
    timeMax: fim.toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  })

  const ocupados = (resp.data.items || []).map(e =>
    new Date(e.start.dateTime || e.start.date).getHours()
  )

  const livres = permitidos.filter(slot => !ocupados.includes(parseInt(slot)))
  return { fechado: false, livres }
}

async function criarEvento(paciente, dataStr, horaStr) {
  const [dia, mes, ano] = dataStr.split('/')
  const [hh, mm] = horaStr.split(':')
  const inicio = new Date(`${ano}-${mes}-${dia}T${hh}:${mm}:00-03:00`)
  const fim    = new Date(inicio.getTime() + 60 * 60 * 1000)

  const calendar = getCalendarClient()
  await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource: {
      summary: `Consulta - ${paciente.nome}`,
      description: [
        `Paciente: ${paciente.nome}`,
        `Telefone: ${paciente.telefone}`,
        `E-mail: ${paciente.email || 'não informado'}`,
        `Motivo: ${paciente.motivo}`,
        `Plano: ${paciente.plano || 'Particular'}`,
      ].join('\n'),
      start: { dateTime: inicio.toISOString(), timeZone: 'America/Sao_Paulo' },
      end:   { dateTime: fim.toISOString(),    timeZone: 'America/Sao_Paulo' }
    }
  })
}

// ─── E-mail ────────────────────────────────────────────────────────────────────

function getMailTransporter() {
  if (!EMAIL_USER || !EMAIL_PASS) return null
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
  })
}

async function enviarEmail(destinatario, assunto, corpo) {
  const transporter = getMailTransporter()
  if (!transporter) {
    console.log('E-mail não configurado, pulando envio para:', destinatario)
    return
  }
  await transporter.sendMail({
    from: `"Clínica Geral" <${EMAIL_USER}>`,
    to: destinatario,
    subject: assunto,
    text: corpo
  })
  console.log('E-mail enviado para:', destinatario)
}

// ─── WhatsApp ──────────────────────────────────────────────────────────────────

async function enviar(telefone, mensagem) {
  const url = `https://api.z-api.io/instances/${INSTANCE_ID}/token/${INSTANCE_TOKEN}/send-text`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Token': CLIENT_TOKEN },
    body: JSON.stringify({ phone: telefone, message: mensagem })
  })
  if (!resp.ok) console.error('Erro Z-API:', resp.status, await resp.text())
}

// ─── Lembretes ─────────────────────────────────────────────────────────────────

function montarMensagemLembrete(paciente, tipo) {
  const quando = tipo === 'dia' ? 'amanhã' : 'em aproximadamente 2 horas'
  return (
    `Olá, ${paciente.nome}! 😊\n\n` +
    `Passando para lembrá-lo(a) da sua consulta na *Clínica Geral* marcada para *${quando}*.\n\n` +
    `📅 Data e horário: *${paciente.agendamento}*\n` +
    `🏥 Motivo: ${paciente.motivo}\n` +
    `💳 Plano: ${paciente.plano || 'Particular'}\n\n` +
    `Por favor, chegue com *10 minutos de antecedência* e traga um documento de identidade e o cartão do plano de saúde (se houver).\n\n` +
    `Em caso de imprevisto, entre em contato conosco para reagendar.\n\n` +
    `Até logo! 🌟`
  )
}

async function verificarEEnviarLembretes() {
  const agora = new Date()
  const pacientes = db.prepare("SELECT * FROM pacientes WHERE agendamento IS NOT NULL").all()

  for (const p of pacientes) {
    try {
      const dtConsulta = parseDatetimeBR(p.agendamento)
      const diffMs = dtConsulta.getTime() - agora.getTime()
      const diffHoras = diffMs / (1000 * 60 * 60)

      // Lembrete do dia anterior: entre 23h e 25h antes da consulta
      if (!p.lembrete_dia && diffHoras >= 23 && diffHoras <= 25) {
        const msg = montarMensagemLembrete(p, 'dia')
        await enviar(p.telefone, msg)
        if (p.email) {
          await enviarEmail(
            p.email,
            'Lembrete de consulta — Clínica Geral',
            msg.replace(/\*/g, '')
          )
        }
        db.prepare("UPDATE pacientes SET lembrete_dia = datetime('now') WHERE telefone = ?").run(p.telefone)
        console.log(`Lembrete dia anterior enviado: ${p.telefone}`)
      }

      // Lembrete 2h antes: entre 1h55 e 2h05 antes da consulta
      if (!p.lembrete_2h && diffHoras >= 1.916 && diffHoras <= 2.083) {
        const msg = montarMensagemLembrete(p, '2h')
        await enviar(p.telefone, msg)
        if (p.email) {
          await enviarEmail(
            p.email,
            'Sua consulta é hoje! — Clínica Geral',
            msg.replace(/\*/g, '')
          )
        }
        db.prepare("UPDATE pacientes SET lembrete_2h = datetime('now') WHERE telefone = ?").run(p.telefone)
        console.log(`Lembrete 2h enviado: ${p.telefone}`)
      }
    } catch (err) {
      console.error(`Erro ao processar lembrete de ${p.telefone}:`, err.message)
    }
  }
}

// Verifica lembretes a cada 5 minutos
setInterval(verificarEEnviarLembretes, 5 * 60 * 1000)

// ─── Banco: helpers ────────────────────────────────────────────────────────────

function getHistorico(telefone) {
  return db.prepare("SELECT role, content FROM historico WHERE telefone = ? ORDER BY id ASC").all(telefone)
    .map(r => ({ role: r.role, content: r.content }))
}

function addMsg(telefone, role, content) {
  db.prepare("INSERT INTO historico (telefone, role, content, criado) VALUES (?, ?, ?, datetime('now'))").run(telefone, role, content)
  db.prepare("DELETE FROM historico WHERE telefone = ? AND id NOT IN (SELECT id FROM historico WHERE telefone = ? ORDER BY id DESC LIMIT 20)").run(telefone, telefone)
}

function getPaciente(telefone) {
  return db.prepare('SELECT * FROM pacientes WHERE telefone = ?').get(telefone)
}

function salvar(telefone, d) {
  const p = getPaciente(telefone)
  if (p) {
    db.prepare(`UPDATE pacientes SET
      nome        = COALESCE(?, nome),
      nascimento  = COALESCE(?, nascimento),
      sexo        = COALESCE(?, sexo),
      endereco    = COALESCE(?, endereco),
      plano       = COALESCE(?, plano),
      motivo      = COALESCE(?, motivo),
      email       = COALESCE(?, email),
      agendamento = COALESCE(?, agendamento),
      atualizado  = datetime('now')
      WHERE telefone = ?`)
      .run(d.nome||null, d.nascimento||null, d.sexo||null, d.endereco||null,
           d.plano||null, d.motivo||null, d.email||null, d.agendamento||null, telefone)
  } else {
    db.prepare(`INSERT INTO pacientes
      (telefone, nome, nascimento, sexo, endereco, plano, motivo, email, agendamento, criado, atualizado)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
      .run(telefone, d.nome||null, d.nascimento||null, d.sexo||null, d.endereco||null,
           d.plano||null, d.motivo||null, d.email||null, d.agendamento||null)
  }
}

// ─── IA ────────────────────────────────────────────────────────────────────────

async function perguntarIA(telefone, mensagem) {
  const p = getPaciente(telefone)
  addMsg(telefone, 'user', mensagem)

  const dadosColetados = p ? [
    p.nome       ? `Nome: ${p.nome}`            : null,
    p.nascimento ? `Nascimento: ${p.nascimento}` : null,
    p.sexo       ? `Sexo: ${p.sexo}`            : null,
    p.endereco   ? `Endereço: ${p.endereco}`    : null,
    p.plano      ? `Plano: ${p.plano}`          : null,
    p.motivo     ? `Motivo: ${p.motivo}`        : null,
    p.email      ? `E-mail: ${p.email}`         : null,
  ].filter(Boolean) : []

  const dadosFaltando = p ? [
    !p.nome       ? 'nome completo'      : null,
    !p.nascimento ? 'data de nascimento' : null,
    !p.sexo       ? 'sexo'              : null,
    !p.endereco   ? 'endereço'          : null,
    !p.plano      ? 'plano de saúde'    : null,
    !p.motivo     ? 'motivo da consulta' : null,
    !p.email      ? 'e-mail (opcional)' : null,
  ].filter(Boolean) : ['nome completo','data de nascimento','sexo','endereço','plano de saúde','motivo da consulta','e-mail (opcional)']

  const cadastroCompleto = dadosFaltando.filter(d => !d.includes('opcional')).length === 0
  const jaAgendado = p && p.agendamento

  let fase, instrucoesFase
  if (jaAgendado) {
    fase = 'CONCLUIDO'
    instrucoesFase = `O paciente já está com consulta agendada para ${p.agendamento}. Responda com simpatia se ele perguntar algo.`
  } else if (cadastroCompleto) {
    fase = 'AGENDAMENTO'
    instrucoesFase = `O cadastro está completo. Agora pergunte qual data e horário o paciente prefere para a consulta.
Horário de funcionamento: segunda a sexta das 08h às 18h, sábado das 08h às 12h. Domingos fechado. Consultas em horas exatas (08:00, 09:00, 10:00...).
Quando o paciente informar data e horário, adicione ao final da resposta:
AGENDA: DATA:DD/MM/AAAA|HORA:HH:MM
(converta expressões como "amanhã", "quinta" para a data real; hoje é ${new Date().toLocaleDateString('pt-BR')})`
  } else {
    fase = 'CADASTRO'
    const resumo = dadosColetados.length > 0
      ? `Já coletados: ${dadosColetados.join(', ')}.\nAinda faltam: ${dadosFaltando.join(', ')}.`
      : `Nenhum dado coletado ainda.`
    instrucoesFase = `SITUAÇÃO DO CADASTRO:\n${resumo}

Colete os dados que FALTAM, um por vez, de forma leve e espontânea. NUNCA peça um dado já coletado.
O e-mail é opcional — se o paciente disser que não tem ou não quiser informar, aceite e siga em frente.
Sempre que coletar dados novos, adicione ao final da resposta:
DADOS: NOME:valor|NASC:valor|SEXO:valor|END:valor|PLANO:valor|MOTIVO:valor|EMAIL:valor
(inclua apenas os dados coletados NESSA mensagem; se o paciente recusou o e-mail, use EMAIL:nao_informado)`
  }

  const system = `Você é Ana, recepcionista da Clínica Geral. Você é calorosa, empática e conversa de forma completamente natural — como uma atendente humana real, não um robô.

FASE ATUAL: ${fase}

${instrucoesFase}

INSTRUÇÕES GERAIS:
- Converse naturalmente, respondendo primeiro ao que o paciente disse
- Use o nome do paciente com moderação — só ocasionalmente
- Varie bastante as formas de perguntar — nunca repita a mesma estrutura
- Demonstre empatia quando o paciente mencionar dor ou dificuldades
- Se o paciente fizer uma pergunta fora do escopo, responda com simpatia e volte ao fluxo
- NUNCA mostre os blocos DADOS ou AGENDA ao paciente — são apenas para sistema interno

Responda sempre em português brasileiro.`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system, messages: getHistorico(telefone) })
  })

  const apiData = await response.json()
  if (!apiData.content || !apiData.content[0]) {
    console.error('Resposta inesperada da API:', JSON.stringify(apiData))
    return 'Desculpe, tive um probleminha aqui. Pode repetir?'
  }

  const texto = apiData.content[0].text

  // Extrai e salva dados cadastrais
  const matchDados = texto.match(/DADOS:(.*)/i)
  if (matchDados) {
    const d = {}
    matchDados[1].split('|').forEach(parte => {
      const m = parte.match(/(\w+):(.+)/)
      if (!m) return
      const k = m[1].trim().toUpperCase()
      const v = m[2].trim()
      if (v === '?' || v === '') return
      if (k === 'NOME')   d.nome = v
      if (k === 'NASC')   d.nascimento = v
      if (k === 'SEXO')   d.sexo = v
      if (k === 'END')    d.endereco = v
      if (k === 'PLANO')  d.plano = v
      if (k === 'MOTIVO') d.motivo = v
      if (k === 'EMAIL' && v !== 'nao_informado') d.email = v
    })
    if (Object.keys(d).length > 0) {
      salvar(telefone, d)
      console.log('Dados salvos:', d)
    }
  }

  // Extrai e processa agendamento
  let mensagemExtra = ''
  const matchAgenda = texto.match(/AGENDA:\s*DATA:(\d{2}\/\d{2}\/\d{4})\|HORA:(\d{2}:\d{2})/i)
  if (matchAgenda) {
    const dataStr = matchAgenda[1]
    const horaStr = matchAgenda[2]
    try {
      const { fechado, livres } = await verificarHorariosLivres(dataStr)

      if (fechado) {
        mensagemExtra = `\n\nInfelizmente não atendemos nesse dia. Funcionamos de segunda a sexta das 8h às 18h e sábados das 8h às 12h. Qual outro dia prefere?`
      } else if (livres.includes(horaStr)) {
        const pacienteAtual = getPaciente(telefone)
        await criarEvento(pacienteAtual, dataStr, horaStr)
        salvar(telefone, { agendamento: `${dataStr} às ${horaStr}` })
        console.log(`Consulta agendada: ${telefone} — ${dataStr} ${horaStr}`)
        mensagemExtra = `\n\n✅ Consulta confirmada para *${dataStr} às ${horaStr}*! Você receberá um lembrete no dia anterior e 2 horas antes. Até lá! 😊`
      } else {
        const lista = livres.length > 0 ? livres.join(', ') : 'nenhum disponível nesse dia'
        mensagemExtra = `\n\nInfelizmente o horário das ${horaStr} já está ocupado. Os horários disponíveis em ${dataStr} são: *${lista}*. Qual prefere?`
      }
    } catch (err) {
      console.error('Erro ao agendar:', err)
      mensagemExtra = '\n\nTive um problema ao verificar a agenda. Pode tentar novamente?'
    }
  }

  // Remove blocos internos antes de enviar ao paciente
  const limpo = texto.replace(/\n?DADOS:.*$/im, '').replace(/\n?AGENDA:.*$/im, '').trim()
  const resposta = limpo + mensagemExtra

  addMsg(telefone, 'assistant', limpo)
  return resposta
}

// ─── Rotas ─────────────────────────────────────────────────────────────────────

app.post('/webhook', async function(req, res) {
  try {
    const body = req.body
    if (body.fromMe) return res.status(200).send('ok')
    const mensagem = body.text?.message
    const telefone = body.phone
    if (!mensagem || !telefone) return res.status(200).send('ok')
    console.log(`De ${telefone}: ${mensagem}`)
    const resposta = await perguntarIA(telefone, mensagem)
    await enviar(telefone, resposta)
    res.status(200).send('ok')
  } catch (err) {
    console.error('Erro no webhook:', err)
    res.status(200).send('ok')
  }
})

app.get('/pacientes', function(req, res) {
  res.json(db.prepare('SELECT * FROM pacientes ORDER BY atualizado DESC').all())
})

app.get('/health', function(req, res) {
  res.json({ status: 'ok', uptime: process.uptime() })
})

const PORTA = process.env.PORT || 8080
app.listen(PORTA, function() { console.log('Rodando na porta ' + PORTA) })

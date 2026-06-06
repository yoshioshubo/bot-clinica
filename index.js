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
const OPENAI_KEY     = process.env.OPENAI_KEY
const CALENDAR_ID    = process.env.CALENDAR_ID    || 'ygshubo@gmail.com'
const EMAIL_USER     = process.env.EMAIL_USER      || 'kidesignmadeiras@gmail.com'
const EMAIL_PASS     = process.env.EMAIL_PASS      || 'lgrifedhewiuvlcg'
const SHEET_ID       = process.env.SHEET_ID        || null
const OWNER_EMAIL    = process.env.OWNER_EMAIL     || 'ygshubo@gmail.com'

// Config carregada da planilha (valores padrão enquanto não carrega)
let clinicaConfig = {
  nome:              'Clínica',
  recepcionista:     'Ana',
  especialidade:     '',
  endereco:          '',
  telefone:          '',
  convenios:         '',
  pagamentos:        'todas as formas',
  estacionamento:    'não informado',
  elevador:          'não informado',
  referencia:        '',
  horario_seg_sex:   '08:00-18:00',
  horario_sab:       '08:00-12:00',
  duracao_consulta:  60,
  observacoes:       '',
}

const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS
  ? JSON.parse(process.env.GOOGLE_CREDENTIALS)
  : require('./bot-clinica-498513-4ecc9c74721e.json')

// ─── Banco de dados ────────────────────────────────────────────────────────────

const db = new Database('clinica.db')

db.exec(`CREATE TABLE IF NOT EXISTS pacientes (
  telefone      TEXT PRIMARY KEY,
  nome          TEXT,
  cpf           TEXT,
  nascimento    TEXT,
  sexo          TEXT,
  cep           TEXT,
  logradouro    TEXT,
  numero        TEXT,
  complemento   TEXT,
  endereco      TEXT,
  plano         TEXT,
  motivo        TEXT,
  email         TEXT,
  agendamento   TEXT,
  event_id      TEXT,
  status        TEXT DEFAULT 'ativo',
  lembrete_dia  TEXT,
  lembrete_2h   TEXT,
  criado        TEXT,
  atualizado    TEXT
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
  "ALTER TABLE pacientes ADD COLUMN cep TEXT",
  "ALTER TABLE pacientes ADD COLUMN logradouro TEXT",
  "ALTER TABLE pacientes ADD COLUMN numero TEXT",
  "ALTER TABLE pacientes ADD COLUMN complemento TEXT",
  "ALTER TABLE pacientes ADD COLUMN cpf TEXT",
  "ALTER TABLE pacientes ADD COLUMN event_id TEXT",
  "ALTER TABLE pacientes ADD COLUMN status TEXT DEFAULT 'ativo'",
]
migracoes.forEach(sql => { try { db.exec(sql) } catch (_) {} })

// ─── Helpers de data ───────────────────────────────────────────────────────────

function agoraBrasilia() {
  // Retorna um objeto Date ajustado para o fuso America/Sao_Paulo (UTC-3)
  const agora = new Date()
  const brasiliaStr = agora.toLocaleString('en-CA', { timeZone: 'America/Sao_Paulo', hour12: false })
  // en-CA retorna formato YYYY-MM-DD, HH:MM:SS
  return new Date(brasiliaStr.replace(', ', 'T'))
}

function dataHoje() {
  const d = agoraBrasilia()
  const dia = String(d.getDate()).padStart(2, '0')
  const mes = String(d.getMonth() + 1).padStart(2, '0')
  const ano = d.getFullYear()
  return `${dia}/${mes}/${ano}`
}

function diaSemanaHoje() {
  const DIAS = ['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado']
  return DIAS[agoraBrasilia().getDay()]
}

// Retorna o dia da semana (0=Dom, 1=Seg, ..., 6=Sáb) para uma data 'DD/MM/AAAA'
function diaDaSemana(dataStr) {
  const [dia, mes, ano] = dataStr.split('/')
  return new Date(`${ano}-${mes}-${dia}T12:00:00-03:00`).getDay()
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

// ─── Google Sheets (Configuração da Clínica) ───────────────────────────────────

function getSheetsClient() {
  const auth = new google.auth.JWT(
    GOOGLE_CREDENTIALS.client_email,
    null,
    GOOGLE_CREDENTIALS.private_key,
    ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
  )
  return { sheets: google.sheets({ version: 'v4', auth }), drive: google.drive({ version: 'v3', auth }) }
}

const TEMPLATE_ROWS = [
  ['Campo', 'Valor', 'Descrição'],
  ['nome_clinica', '', 'Nome completo da clínica'],
  ['nome_recepcionista', 'Ana', 'Nome da recepcionista virtual'],
  ['especialidade', '', 'Ex: Psicologia, Odontologia'],
  ['endereco', '', 'Endereço completo da clínica'],
  ['telefone', '', 'Telefone de contato (com DDD)'],
  ['convenios', '', 'Convênios aceitos (separados por vírgula)'],
  ['pagamentos', '', 'Formas de pagamento aceitas'],
  ['estacionamento', 'Sim', 'Sim ou Não'],
  ['elevador', 'Sim', 'Sim ou Não'],
  ['ponto_referencia', '', 'Ponto de referência para localização'],
  ['horario_seg_sex', '08:00-18:00', 'Horário seg a sex (formato HH:MM-HH:MM)'],
  ['horario_sab', '08:00-12:00', 'Horário sábado (deixe vazio se não atender)'],
  ['duracao_consulta', '60', 'Duração da consulta em minutos'],
  ['observacoes', '', 'Informações extras para a recepcionista'],
]

async function criarPlanilhaConfig() {
  try {
    const { sheets, drive } = getSheetsClient()

    // Cria a planilha
    const resp = await sheets.spreadsheets.create({
      resource: {
        properties: { title: 'Bot Clínica — Configuração' },
        sheets: [{ properties: { title: 'Configuracao' } }]
      }
    })
    const spreadsheetId = resp.data.spreadsheetId

    // Preenche o template
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Configuracao!A1',
      valueInputOption: 'RAW',
      resource: { values: TEMPLATE_ROWS }
    })

    // Formata cabeçalho
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [{
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { backgroundColor: { red: 0.2, green: 0.5, blue: 0.8 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } },
            fields: 'userEnteredFormat'
          }
        }]
      }
    })

    // Compartilha com o dono
    await drive.permissions.create({
      fileId: spreadsheetId,
      resource: { type: 'user', role: 'writer', emailAddress: OWNER_EMAIL }
    })

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('✅ PLANILHA DE CONFIGURAÇÃO CRIADA!')
    console.log(`📋 Link: https://docs.google.com/spreadsheets/d/${spreadsheetId}`)
    console.log(`🔑 Adicione no Railway: SHEET_ID=${spreadsheetId}`)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    return spreadsheetId
  } catch (err) {
    console.error('Erro ao criar planilha:', err.message)
    return null
  }
}

async function lerConfigPlanilha(spreadsheetId) {
  try {
    const { sheets } = getSheetsClient()
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Configuracao!A2:B99'
    })
    const rows = resp.data.values || []
    const config = {}
    rows.forEach(([campo, valor]) => { if (campo && valor !== undefined) config[campo] = valor })

    // Aplica na config global
    if (config.nome_clinica)        clinicaConfig.nome            = config.nome_clinica
    if (config.nome_recepcionista)  clinicaConfig.recepcionista   = config.nome_recepcionista
    if (config.especialidade)       clinicaConfig.especialidade   = config.especialidade
    if (config.endereco)            clinicaConfig.endereco        = config.endereco
    if (config.telefone)            clinicaConfig.telefone        = config.telefone
    if (config.convenios)           clinicaConfig.convenios       = config.convenios
    if (config.pagamentos)          clinicaConfig.pagamentos      = config.pagamentos
    if (config.estacionamento)      clinicaConfig.estacionamento  = config.estacionamento
    if (config.elevador)            clinicaConfig.elevador        = config.elevador
    if (config.ponto_referencia)    clinicaConfig.referencia      = config.ponto_referencia
    if (config.horario_seg_sex)     clinicaConfig.horario_seg_sex = config.horario_seg_sex
    if (config.horario_sab)         clinicaConfig.horario_sab     = config.horario_sab
    if (config.duracao_consulta)    clinicaConfig.duracao_consulta = parseInt(config.duracao_consulta) || 60
    if (config.observacoes)         clinicaConfig.observacoes     = config.observacoes

    console.log('✅ Configuração carregada da planilha:', clinicaConfig.nome)
  } catch (err) {
    console.error('Erro ao ler planilha:', err.message)
  }
}

async function inicializarConfig() {
  console.log('SHEET_ID:', SHEET_ID || 'não definido')
  if (SHEET_ID) {
    console.log('Lendo configuração da planilha...')
    await lerConfigPlanilha(SHEET_ID)
  } else {
    console.log('SHEET_ID não definido — criando planilha template...')
    await criarPlanilhaConfig()
  }
}

// ─── CEP ───────────────────────────────────────────────────────────────────────

async function buscarCep(cep) {
  const cepLimpo = cep.replace(/\D/g, '')
  if (cepLimpo.length !== 8) return null
  try {
    const resp = await fetch(`https://viacep.com.br/ws/${cepLimpo}/json/`)
    const data = await resp.json()
    if (data.erro) return null
    return {
      logradouro: data.logradouro,
      bairro: data.bairro,
      cidade: data.localidade,
      uf: data.uf
    }
  } catch (err) {
    console.error('Erro ao buscar CEP:', err.message)
    return null
  }
}

// ─── Transcrição de Áudio (Whisper) ────────────────────────────────────────────

async function transcreverAudio(audioUrl) {
  try {
    // Baixa o áudio
    console.log('Baixando áudio de:', audioUrl)
    const audioResp = await fetch(audioUrl)
    if (!audioResp.ok) throw new Error(`Erro ao baixar áudio: ${audioResp.status}`)
    const audioBuffer = await audioResp.arrayBuffer()
    console.log('Áudio baixado, tamanho:', audioBuffer.byteLength, 'bytes')

    // Monta o FormData para o Whisper
    const formData = new FormData()
    formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg; codecs=opus' }), 'audio.ogg')
    formData.append('model', 'whisper-1')
    formData.append('language', 'pt')

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: formData
    })

    const data = await resp.json()
    console.log('Resposta Whisper:', JSON.stringify(data))
    if (!data.text) throw new Error(`Transcrição falhou: ${JSON.stringify(data)}`)
    console.log('Áudio transcrito:', data.text)
    return data.text
  } catch (err) {
    console.error('Erro ao transcrever áudio:', err.message)
    return null
  }
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
  const resp = await calendar.events.insert({
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
  return resp.data.id
}

async function cancelarEvento(eventId) {
  try {
    const calendar = getCalendarClient()
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId })
    console.log('Evento cancelado no Google Agenda:', eventId)
  } catch (err) {
    console.error('Erro ao cancelar evento:', err.message)
  }
}

async function reagendarEvento(paciente, eventId, dataStr, horaStr) {
  const [dia, mes, ano] = dataStr.split('/')
  const [hh, mm] = horaStr.split(':')
  const inicio = new Date(`${ano}-${mes}-${dia}T${hh}:${mm}:00-03:00`)
  const fim    = new Date(inicio.getTime() + 60 * 60 * 1000)

  const calendar = getCalendarClient()
  await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    resource: {
      summary: `Consulta - ${paciente.nome}`,
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
        if (p.email && p.email !== 'nao_informado') {
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
        if (p.email && p.email !== 'nao_informado') {
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
      cpf         = COALESCE(?, cpf),
      nascimento  = COALESCE(?, nascimento),
      sexo        = COALESCE(?, sexo),
      cep         = COALESCE(?, cep),
      logradouro  = COALESCE(?, logradouro),
      numero      = COALESCE(?, numero),
      complemento = COALESCE(?, complemento),
      endereco    = COALESCE(?, endereco),
      plano       = COALESCE(?, plano),
      motivo      = COALESCE(?, motivo),
      email       = COALESCE(?, email),
      agendamento = COALESCE(?, agendamento),
      event_id    = COALESCE(?, event_id),
      status      = COALESCE(?, status),
      atualizado  = datetime('now')
      WHERE telefone = ?`)
      .run(d.nome||null, d.cpf||null, d.nascimento||null, d.sexo||null,
           d.cep||null, d.logradouro||null, d.numero||null, d.complemento||null,
           d.endereco||null, d.plano||null, d.motivo||null,
           d.email||null, d.agendamento||null, d.event_id||null, d.status||null, telefone)
  } else {
    db.prepare(`INSERT INTO pacientes
      (telefone, nome, cpf, nascimento, sexo, cep, logradouro, numero, complemento, endereco, plano, motivo, email, agendamento, event_id, status, criado, atualizado)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativo', datetime('now'), datetime('now'))`)
      .run(telefone, d.nome||null, d.cpf||null, d.nascimento||null, d.sexo||null,
           d.cep||null, d.logradouro||null, d.numero||null, d.complemento||null,
           d.endereco||null, d.plano||null, d.motivo||null,
           d.email||null, d.agendamento||null, d.event_id||null)
  }
}

// ─── IA ────────────────────────────────────────────────────────────────────────

async function perguntarIA(telefone, mensagem) {
  const p = getPaciente(telefone)
  addMsg(telefone, 'user', mensagem)

  // Sub-fase do endereço
  const enderecoCompleto = p && p.endereco
  const aguardandoNumero = p && p.logradouro && !p.numero
  const aguardandoComplemento = p && p.numero && !p.complemento

  const dadosColetados = p ? [
    p.nome        ? `Nome: ${p.nome}`              : null,
    p.cpf         ? `CPF: ${p.cpf}`               : null,
    p.nascimento  ? `Nascimento: ${p.nascimento}`  : null,
    p.sexo        ? `Sexo: ${p.sexo}`              : null,
    p.logradouro  ? `Logradouro: ${p.logradouro}`  : null,
    p.numero      ? `Número: ${p.numero}`          : null,
    p.complemento ? `Complemento: ${p.complemento}`: null,
    enderecoCompleto ? `Endereço: ${p.endereco}`   : null,
    p.plano       ? `Plano: ${p.plano}`            : null,
    p.motivo      ? `Motivo: ${p.motivo}`          : null,
    p.email       ? `E-mail: ${p.email}`           : null,
  ].filter(Boolean) : []

  const dadosFaltando = p ? [
    !p.nome          ? 'nome completo'       : null,
    !p.cpf           ? 'CPF'                : null,
    !p.nascimento    ? 'data de nascimento'  : null,
    !p.sexo          ? 'sexo'               : null,
    !enderecoCompleto ? 'endereço'           : null,
    !p.plano         ? 'plano de saúde'     : null,
    !p.motivo        ? 'motivo da consulta'  : null,
    !p.email         ? 'e-mail'             : null,
  ].filter(Boolean) : ['nome completo','data de nascimento','sexo','endereço','plano de saúde','motivo da consulta','e-mail']

  const cadastroCompleto = dadosFaltando.length === 0
  const jaAgendado = p && p.agendamento
  const primeiroContato = !p || dadosColetados.length === 0

  let fase, instrucoesFase
  const statusAtual = p?.status || 'ativo'

  if (primeiroContato) {
    fase = 'RECEPCAO'
    instrucoesFase = `É o primeiro contato deste paciente. Cumprimente-o de forma calorosa, apresente-se como Ana da Clínica de Psicologia JF e pergunte como pode ajudá-lo.
NÃO inicie o cadastro ainda — espere o paciente demonstrar interesse em agendar.
Se ele tiver dúvidas, responda usando as informações da clínica abaixo.
Se ele quiser agendar, diga que vai precisar de alguns dados e inicie o cadastro naturalmente.`
  } else if (jaAgendado && statusAtual === 'cancelado') {
    fase = 'CANCELADO'
    instrucoesFase = `A consulta do paciente foi cancelada. Se ele quiser reagendar, pergunte nova data e horário.
Quando o paciente informar data e horário, adicione: AGENDA: DATA:DD/MM/AAAA|HORA:HH:MM
NUNCA confirme que a consulta foi marcada — apenas diga "Vou verificar a disponibilidade para você!" e aguarde.
Horário de funcionamento: segunda a sexta das 08h às 18h, sábado das 08h às 12h, domingo fechado.
Hoje é ${diaSemanaHoje()}, ${dataHoje()}.`
  } else if (jaAgendado) {
    fase = 'CONCLUIDO'
    instrucoesFase = `O paciente já está com consulta agendada para ${p.agendamento}.
Se ele quiser *cancelar*, confirme a intenção e use ao final: CANCELAR
Se ele quiser *reagendar*, pergunte nova data e horário e use: AGENDA: DATA:DD/MM/AAAA|HORA:HH:MM
Hoje é ${diaSemanaHoje()}, ${dataHoje()}. Horários: seg-sex 08h-18h, sáb 08h-12h, dom fechado.
Para qualquer outro assunto, responda com simpatia.`
  } else if (cadastroCompleto) {
    fase = 'AGENDAMENTO'
    instrucoesFase = `O cadastro está completo. Pergunte qual data e horário o paciente prefere para a consulta.

REGRAS RÍGIDAS DESTA FASE:
- Funcionamos de segunda a sexta das 08h às 18h, sábado das 08h às 12h, domingo fechado. Consultas em horas exatas.
- Hoje é ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.
- Quando o paciente informar uma data e horário, adicione ao final da sua resposta: AGENDA: DATA:DD/MM/AAAA|HORA:HH:MM
- NUNCA sugira horários alternativos — isso é tarefa do sistema, não sua.
- NUNCA diga que a consulta foi marcada, confirmada, agendada ou qualquer variação disso — APENAS diga "Vou verificar a disponibilidade para você!" e aguarde. A confirmação é feita EXCLUSIVAMENTE pelo sistema.
- Se o paciente pedir um dia ou horário fora do funcionamento (ex: domingo, ou sábado às 15h), informe gentilmente os dias e horários de atendimento e peça que escolha novamente.
- Se o paciente mencionar apenas uma data sem horário, ou apenas um horário sem data, peça os dois antes de gerar o AGENDA:.
- ATENÇÃO com os dias da semana: hoje é ${diaSemanaHoje()}, ${dataHoje()}. Converta sempre expressões como "próxima segunda" para a data real no formato DD/MM/AAAA.`
  } else {
    fase = 'CADASTRO'
    const resumo = dadosColetados.length > 0
      ? `Já coletados: ${dadosColetados.join(', ')}.\nAinda faltam: ${dadosFaltando.join(', ')}.`
      : `Nenhum dado coletado ainda.`
    // Instrução específica para sub-fase do endereço
    let instrucaoEndereco = ''
    if (aguardandoNumero) {
      instrucaoEndereco = `\nSUB-FASE ENDEREÇO: O CEP foi consultado e o logradouro é "${p.logradouro}". Informe isso ao paciente e pergunte o NÚMERO da residência. Quando ele informar, use DADOS: NUM:valor`
    } else if (aguardandoComplemento) {
      instrucaoEndereco = `\nSUB-FASE ENDEREÇO: O logradouro é "${p.logradouro}", número "${p.numero}". Pergunte se há complemento (apto, sala, bloco etc). Se sim, use DADOS: COMP:valor. Se não tiver, use DADOS: COMP:nao_tem`
    }

    instrucoesFase = `SITUAÇÃO DO CADASTRO:\n${resumo}
${instrucaoEndereco}

Colete os dados que FALTAM, um por vez, de forma leve e espontânea. NUNCA peça um dado já coletado.
CPF: Ao perguntar o CPF, explique que é para identificação segura do paciente. Aceite no formato com ou sem pontuação. Use DADOS: CPF:valor
SEXO: Ao perguntar o sexo, ofereça as opções de forma respeitosa e natural, por exemplo: "Para o cadastro, você se identifica como *Homem*, *Mulher* ou prefere *Não informar*?" — aceite qualquer resposta sem julgamento.
ENDEREÇO: Quando chegar a vez de coletar o endereço, peça o CEP. Quando o paciente informar o CEP, use DADOS: CEP:valor
O e-mail deve ser perguntado, mas é opcional — se o paciente não tiver ou não quiser informar, aceite com naturalidade e use DADOS: EMAIL:nao_informado
Quando TODOS os dados estiverem coletados, envie uma mensagem de confirmação no seguinte formato EXATO:
"Perfeito! Deixa eu confirmar seus dados:

• *Nome:* [nome]
• *CPF:* [cpf]
• *Data de nascimento:* [nascimento]
• *Sexo:* [sexo]
• *Endereço:* [endereço completo]
• *Plano de saúde:* [plano]
• *Motivo da consulta:* [motivo]"

Depois coloque exatamente: |||

Depois escreva:
"Está tudo correto? Responda *Sim* para confirmar ou *Não* para corrigir alguma informação 😊"

Sempre que coletar dados novos, adicione ao final da resposta:
DADOS: NOME:valor|CPF:valor|NASC:valor|SEXO:valor|CEP:valor|NUM:valor|COMP:valor|PLANO:valor|MOTIVO:valor|EMAIL:valor
(inclua apenas os campos coletados NESSA mensagem)`
  }

  const [hSegSexIni, hSegSexFim] = clinicaConfig.horario_seg_sex.split('-')
  const horarioSab = clinicaConfig.horario_sab ? `sábado das ${clinicaConfig.horario_sab.replace('-', ' às ')}` : 'não atende sábados'

  const system = `Você é ${clinicaConfig.recepcionista}, recepcionista da ${clinicaConfig.nome}. Você é calorosa, empática e conversa de forma completamente natural — como uma atendente humana real, não um robô.

INFORMAÇÕES DA CLÍNICA (use para responder dúvidas):
- Nome: ${clinicaConfig.nome}
- Especialidade: ${clinicaConfig.especialidade}
- Endereço: ${clinicaConfig.endereco}${clinicaConfig.referencia ? ` — Referência: ${clinicaConfig.referencia}` : ''}
- Elevador: ${clinicaConfig.elevador}
- Estacionamento: ${clinicaConfig.estacionamento}
- Convênios aceitos: ${clinicaConfig.convenios}
- Formas de pagamento: ${clinicaConfig.pagamentos}
- Horário de funcionamento: segunda a sexta das ${hSegSexIni} às ${hSegSexFim}, ${horarioSab}, domingo fechado
- Telefone para contato: ${clinicaConfig.telefone}${clinicaConfig.observacoes ? `\n- Observações: ${clinicaConfig.observacoes}` : ''}

FASE ATUAL: ${fase}

${instrucoesFase}

INSTRUÇÕES GERAIS:
- Converse naturalmente, respondendo primeiro ao que o paciente disse
- Use o nome do paciente com moderação — só ocasionalmente
- Varie bastante as formas de perguntar — nunca repita a mesma estrutura
- Demonstre empatia — especialmente em uma clínica de psicologia, o paciente pode estar em um momento delicado
- Se o paciente só quiser tirar dúvidas, responda com simpatia sem forçar o cadastro
- Ao final de uma conversa de dúvidas, pergunte gentilmente se deseja agendar uma consulta
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
  let mensagemCep = ''
  if (matchDados) {
    const d = {}
    matchDados[1].split('|').forEach(parte => {
      const m = parte.match(/(\w+):(.+)/)
      if (!m) return
      const k = m[1].trim().toUpperCase()
      const v = m[2].trim()
      if (v === '?' || v === '') return
      if (k === 'NOME')   d.nome = v
      if (k === 'CPF')    d.cpf = v.replace(/\D/g, '').replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
      if (k === 'NASC')   d.nascimento = v
      if (k === 'SEXO')   d.sexo = v
      if (k === 'CEP')    d.cep = v
      if (k === 'NUM')    d.numero = v
      if (k === 'COMP')   d.complemento = v !== 'nao_tem' ? v : 'nao_tem'
      if (k === 'PLANO')  d.plano = v
      if (k === 'MOTIVO') d.motivo = v
      if (k === 'EMAIL')  d.email = v
    })

    // Se veio CEP, busca o logradouro automaticamente
    if (d.cep) {
      const enderecoCep = await buscarCep(d.cep)
      if (enderecoCep) {
        d.logradouro = `${enderecoCep.logradouro}, ${enderecoCep.bairro}, ${enderecoCep.cidade} - ${enderecoCep.uf}`
        console.log('CEP encontrado:', d.logradouro)
      } else {
        mensagemCep = '\n\nNão encontrei esse CEP. Pode verificar e tentar novamente?'
        delete d.cep
      }
    }

    // Monta endereço completo quando tiver logradouro + número
    const pAtual = getPaciente(telefone)
    const logradouro = d.logradouro || pAtual?.logradouro
    const numero = d.numero || pAtual?.numero
    const complemento = d.complemento || pAtual?.complemento
    if (logradouro && numero) {
      const comp = complemento && complemento !== 'nao_tem' ? `, ${complemento}` : ''
      d.endereco = `${logradouro}, ${numero}${comp}`
    }

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
        // Se já tinha evento, cancela o antigo antes de criar novo
        if (pacienteAtual?.event_id) await cancelarEvento(pacienteAtual.event_id)
        const eventId = await criarEvento(pacienteAtual, dataStr, horaStr)
        salvar(telefone, { agendamento: `${dataStr} às ${horaStr}`, event_id: eventId, status: 'ativo' })
        db.prepare("UPDATE pacientes SET lembrete_dia = NULL, lembrete_2h = NULL WHERE telefone = ?").run(telefone)
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

  // Processa cancelamento
  if (/\bCANCELAR\b/.test(texto)) {
    const pacienteAtual = getPaciente(telefone)
    if (pacienteAtual?.event_id) await cancelarEvento(pacienteAtual.event_id)
    db.prepare("UPDATE pacientes SET status = 'cancelado', agendamento = NULL, event_id = NULL, lembrete_dia = NULL, lembrete_2h = NULL, atualizado = datetime('now') WHERE telefone = ?").run(telefone)
    console.log(`Consulta cancelada: ${telefone}`)
    mensagemExtra = `\n\n❌ Sua consulta foi cancelada. Se quiser reagendar, é só me avisar! 😊`
  }

  // Remove blocos internos antes de enviar ao paciente
  const limpo = texto.replace(/\n?DADOS:.*$/im, '').replace(/\n?AGENDA:.*$/im, '').replace(/\bCANCELAR\b/g, '').trim()

  // Se houver separador |||, retorna array com duas mensagens
  if (limpo.includes('|||')) {
    const partes = limpo.split('|||').map(p => p.trim()).filter(p => p.length > 0)
    const ultima = partes[partes.length - 1] + mensagemExtra + mensagemCep
    partes[partes.length - 1] = ultima
    addMsg(telefone, 'assistant', partes.join(' '))
    return partes
  }

  const resposta = limpo + mensagemExtra + mensagemCep
  addMsg(telefone, 'assistant', limpo)
  return resposta
}

// ─── Rotas ─────────────────────────────────────────────────────────────────────

app.post('/webhook', async function(req, res) {
  try {
    const body = req.body
    if (body.fromMe) return res.status(200).send('ok')
    const telefone = body.phone
    if (!telefone) return res.status(200).send('ok')

    let mensagem = body.text?.message

    // Log completo para debug de áudio
    if (!mensagem) console.log('BODY SEM TEXTO:', JSON.stringify(body))

    // Detecta áudio e transcreve
    if (!mensagem && body.audio?.audioUrl) {
      console.log(`Áudio recebido de ${telefone}, transcrevendo...`)
      const transcricao = await transcreverAudio(body.audio.audioUrl)
      if (!transcricao) {
        await enviar(telefone, 'Desculpe, não consegui entender o áudio. Pode digitar sua mensagem? 😊')
        return res.status(200).send('ok')
      }
      mensagem = transcricao
      console.log(`Áudio de ${telefone} transcrito: ${mensagem}`)
    }

    if (!mensagem) return res.status(200).send('ok')
    console.log(`De ${telefone}: ${mensagem}`)
    const resposta = await perguntarIA(telefone, mensagem)
    if (Array.isArray(resposta)) {
      for (const parte of resposta) {
        await enviar(telefone, parte)
        await new Promise(r => setTimeout(r, 800)) // pequena pausa entre mensagens
      }
    } else {
      await enviar(telefone, resposta)
    }
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
app.listen(PORTA, async function() {
  console.log('Rodando na porta ' + PORTA)
  await inicializarConfig()
})

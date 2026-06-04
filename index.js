const express = require('express')
const Database = require('better-sqlite3')
const app = express()
app.use(express.json())

const INSTANCE_ID = process.env.INSTANCE_ID || '3F424535214202979B1E7A94F00847F6'
const INSTANCE_TOKEN = process.env.INSTANCE_TOKEN || 'EA8E2F27C3F469BA1874CEED'
const CLIENT_TOKEN = process.env.CLIENT_TOKEN || 'F778ca59b075541ad8cfd7e6cb843fc52S'
const CLAUDE_KEY = process.env.CLAUDE_KEY

const db = new Database('clinica.db')
db.exec("CREATE TABLE IF NOT EXISTS pacientes (telefone TEXT PRIMARY KEY, nome TEXT, nascimento TEXT, sexo TEXT, endereco TEXT, plano TEXT, motivo TEXT, criado TEXT, atualizado TEXT)")

const historicos = {}

function getHistorico(telefone) {
  if (!historicos[telefone]) historicos[telefone] = []
  return historicos[telefone]
}

function addMsg(telefone, role, content) {
  if (!historicos[telefone]) historicos[telefone] = []
  historicos[telefone].push({ role, content })
  if (historicos[telefone].length > 20) historicos[telefone] = historicos[telefone].slice(-20)
}

function getPaciente(telefone) {
  return db.prepare('SELECT * FROM pacientes WHERE telefone = ?').get(telefone)
}

function salvar(telefone, d) {
  const p = getPaciente(telefone)
  if (p) {
    db.prepare("UPDATE pacientes SET nome = COALESCE(?, nome), nascimento = COALESCE(?, nascimento), sexo = COALESCE(?, sexo), endereco = COALESCE(?, endereco), plano = COALESCE(?, plano), motivo = COALESCE(?, motivo), atualizado = datetime('now') WHERE telefone = ?").run(d.nome||null, d.nascimento||null, d.sexo||null, d.endereco||null, d.plano||null, d.motivo||null, telefone)
  } else {
    db.prepare("INSERT INTO pacientes (telefone, nome, nascimento, sexo, endereco, plano, motivo, criado, atualizado) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))").run(telefone, d.nome||null, d.nascimento||null, d.sexo||null, d.endereco||null, d.plano||null, d.motivo||null)
  }
}

async function perguntarIA(telefone, mensagem) {
  const p = getPaciente(telefone)
  addMsg(telefone, 'user', mensagem)
  const cadastro = p
    ? "Nome:" + (p.nome||"?") + " Nasc:" + (p.nascimento||"?") + " Sexo:" + (p.sexo||"?") + " End:" + (p.endereco||"?") + " Plano:" + (p.plano||"?") + " Motivo:" + (p.motivo||"?")
    : "Nenhum dado ainda."

  const system = `Você é Ana, recepcionista da Clínica Geral. Você é calorosa, atenciosa e conversa de forma natural como uma pessoa real — sem soar robótica ou seguir um roteiro rígido.

Cadastro atual do paciente: ${cadastro}

Seu objetivo é coletar os dados marcados com "?" de forma leve e conversacional, como se fosse um bate-papo. Siga estas orientações:

- Responda primeiro ao que o paciente disse, depois faça UMA pergunta por vez de forma natural
- Use o nome do paciente com moderação — apenas ocasionalmente, não em toda mensagem
- Nunca repita perguntas já respondidas
- Se o paciente der uma informação sem você perguntar, aceite naturalmente e continue
- Varie as formas de perguntar — não use sempre a mesma estrutura
- Demonstre empatia quando o paciente mencionar sintomas ou dificuldades
- Quando todos os dados estiverem completos, confirme o agendamento de forma calorosa e natural
- Ao coletar um dado, adicione ao final em nova linha: DADOS: NOME:valor|NASC:valor|SEXO:valor|END:valor|PLANO:valor|MOTIVO:valor (só os coletados nessa mensagem)

Responda sempre em português brasileiro.`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system: system, messages: getHistorico(telefone) })
  })

  const data = await response.json()
  if (!data.content || !data.content[0]) {
    console.error('Resposta inesperada da API:', JSON.stringify(data))
    return 'Erro tecnico. Tente novamente em instantes.'
  }

  const texto = data.content[0].text
  const match = texto.match(/DADOS:(.*)/i)
  if (match) {
    const d = {}
    match[1].split('|').forEach(function(parte) {
      const m = parte.match(/(\w+):(.+)/)
      if (!m) return
      const k = m[1].trim().toUpperCase()
      const v = m[2].trim()
      if (v === '?' || v === '') return
      if (k === 'NOME') d.nome = v
      if (k === 'NASC') d.nascimento = v
      if (k === 'SEXO') d.sexo = v
      if (k === 'END') d.endereco = v
      if (k === 'PLANO') d.plano = v
      if (k === 'MOTIVO') d.motivo = v
    })
    if (Object.keys(d).length > 0) {
      salvar(telefone, d)
      console.log('Salvou:', d)
    }
  }

  const limpo = texto.replace(/DADOS:.*/i, '').trim()
  addMsg(telefone, 'assistant', limpo)
  return limpo
}

async function enviar(telefone, mensagem) {
  const url = 'https://api.z-api.io/instances/' + INSTANCE_ID + '/token/' + INSTANCE_TOKEN + '/send-text'
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Token': CLIENT_TOKEN },
    body: JSON.stringify({ phone: telefone, message: mensagem })
  })
  if (!resp.ok) {
    console.error('Erro ao enviar mensagem Z-API:', resp.status, await resp.text())
  }
}

app.post('/webhook', async function(req, res) {
  try {
    const body = req.body

    // Ignora mensagens enviadas pelo próprio bot
    if (body.fromMe) return res.status(200).send('ok')

    // Ignora eventos que não são mensagens de texto
    const mensagem = body.text?.message
    const telefone = body.phone

    if (!mensagem || !telefone) return res.status(200).send('ok')

    console.log('De ' + telefone + ': ' + mensagem)
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

// Usa a variável PORT do Railway (obrigatório), fallback 8080
const PORTA = process.env.PORT || 8080
app.listen(PORTA, function() { console.log('Rodando na porta ' + PORTA) })
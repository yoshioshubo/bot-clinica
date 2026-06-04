const express = require('express')
const Database = require('better-sqlite3')
const app = express()
app.use(express.json())

const INSTANCE_ID = process.env.INSTANCE_ID || '3F424535214202979B1E7A94F00847F6'
const INSTANCE_TOKEN = process.env.INSTANCE_TOKEN || 'EA8E2F27C3F469BA1874CEED'
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

  const system = "Voce e Ana, recepcionista virtual de uma clinica medica. Cadastro atual: " + cadastro + ". Instrucoes: colete apenas dados marcados com ?. Nunca repita perguntas respondidas. Um dado por vez de forma amigavel. Use o nome do paciente assim que souber. Ao coletar um dado, adicione ao final em nova linha: DADOS: NOME:valor|NASC:valor|SEXO:valor|END:valor|PLANO:valor|MOTIVO:valor (so os coletados agora). Quando tudo completo confirme e agradeca. Responda em portugues brasileiro."

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1024, system: system, messages: getHistorico(telefone) })
  })

  const data = await response.json()
  if (!data.content || !data.content[0]) return 'Erro tecnico. Tente novamente.'

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
  await fetch('https://api.z-api.io/instances/' + INSTANCE_ID + '/token/' + INSTANCE_TOKEN + '/send-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: telefone, message: mensagem })
  })
}

app.post('/webhook', async function(req, res) {
  try {
    const body = req.body
    if (!body.text || !body.phone) return res.status(200).send('ok')
    const telefone = body.phone
    const mensagem = body.text.message
    console.log('De ' + telefone + ': ' + mensagem)
    const resposta = await perguntarIA(telefone, mensagem)
    await enviar(telefone, resposta)
    res.status(200).send('ok')
  } catch (err) {
    console.error('Erro:', err)
    res.status(200).send('ok')
  }
})

app.get('/pacientes', function(req, res) {
  res.json(db.prepare('SELECT * FROM pacientes ORDER BY atualizado DESC').all())
})

const PORTA = process.env.PORT || 3000
app.listen(PORTA, function() { console.log('Rodando na porta ' + PORTA) })
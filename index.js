const express = require('express')
const Database = require('better-sqlite3')
const app = express()
app.use(express.json())

const INSTANCE_ID = process.env.INSTANCE_ID || '3F424535214202979B1E7A94F00847F6'
const INSTANCE_TOKEN = process.env.INSTANCE_TOKEN || 'EA8E2F27C3F469BA1874CEED'
const CLAUDE_KEY = process.env.CLAUDE_KEY

const db = new Database('clinica.db')

db.exec(`CREATE TABLE IF NOT EXISTS pacientes (
  telefone TEXT PRIMARY KEY,
  nome TEXT,
  nascimento TEXT,
  sexo TEXT,
  endereco TEXT,
  plano TEXT,
  motivo TEXT,
  criado TEXT DEFAULT (datetime('now')),
  atualizado TEXT DEFAULT (datetime('now'))
)`)

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
    db.prepare(`UPDATE pacientes SET
      nome = COALESCE(?, nome),
      nascimento = COALESCE(?, nascimento),
      sexo = COALESCE(?, sexo),
      endereco = COALESCE(?, endereco),
      plano = COALESCE(?, plano),
      motivo = COALESCE(?, motivo),
      atualizado = datetime('now')
      WHERE telefone = ?`
    ).run(d.nome||null, d.nascimento||null, d.sexo||null, d.endereco||null, d.plano||null, d.motivo||null, telefone)
  } else {
    db.prepare(`INSERT INTO pacientes (telefone, nome, nascimento, sexo, endereco, plano, motivo)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(telefone, d.nome||null, d.nascimento||null, d.sexo||null, d.endereco||null, d.plano||null, d.motivo||null)
  }
}

async function perguntarIA(telefone, mensagem) {
  const p = getPaciente(telefone)
  addMsg(telefone, 'user', mensagem)

  const cadastro = p
    ? `Nome: ${p.nome||'?'} | Nasc: ${p.nascimento||'?'} | Sexo: ${p.sexo||'?'} | End: ${p.endereco||'?'} | Plano: ${p.plano||'?'} | Motivo: ${p.motivo||'?'}`
    : 'Nenhum dado ainda.'

  const system = `Voce e Ana, recepcionista virtual de uma clinica medica.
Cadastro atual do paciente: ${cadastro}
Instrucoes:
- Colete apenas dados marcados com ?
- Nunca repita perguntas ja respondidas
- Um dado por vez, de forma amigavel
- Use o nome do paciente assim que souber
- Ao coletar um dado, adicione no final da resposta em nova linha: DADOS: NOME:valor|NASC:valor|SEXO:valor|END:valor|PLANO:valor|MOTIVO:valor
- Inclua apenas os campos coletados nessa mensagem
- Quando tudo estiver completo, confirme e agradeca
- Responda em portugues brasileiro`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: system,
      messages: getHistorico(telefone)
    })
  })

  const data = await response.json()
  if (!data.content || !data.content[0]) return 'Erro tecnico. Tente novamente.'

  const texto = data.content[0].text
  const match = texto.match(/DADOS:(.*)/i)
  if (match) {
    const d = {}
    const partes = match[1].split('|')
    partes.forEach(parte => {
      const m = parte.match(/(\w+):(.+)/)
      if (!m) return
      const chave = m[1].trim().toUpperCase()
      const valor = m[2].trim()
      if (valor === '?' || valor === '') return
      if (chave === 'NOME') d.nome = valor
      if (chave === 'NASC') d.nascimento = valor
      if (chave === 'SEXO') d.sexo = valor
      if (chave === 'END') d.endereco = valor
      if (chave === 'PLANO') d.plano = valor
      if (chave === 'MOTIVO') d.motivo = valor
    })
    if (Object.keys(d).length > 0) {
      salvar(telefone, d)
      console.log('Salvou:', d)
    }
  }

  const limpo = texto.replace(/DADOS:.*/i, '').trim()
  addMsg(telefon
const express = require('express')
const Database = require('better-sqlite3')
const app = express()
app.use(express.json())

const INSTANCE_ID = process.env.INSTANCE_ID || '3F424535214202979B1E7A94F00847F6'
const INSTANCE_TOKEN = process.env.INSTANCE_TOKEN || 'EA8E2F27C3F469BA1874CEED'
const CLIENT_TOKEN = process.env.CLIENT_TOKEN || 'F778ca59b075541ad8cfd7e6cb843fc52S'
const CLAUDE_KEY = process.env.CLAUDE_KEY

const db = new Database('clinica.db')

// Tabela de pacientes
db.exec("CREATE TABLE IF NOT EXISTS pacientes (telefone TEXT PRIMARY KEY, nome TEXT, nascimento TEXT, sexo TEXT, endereco TEXT, plano TEXT, motivo TEXT, criado TEXT, atualizado TEXT)")

// Tabela de histórico persistente
db.exec("CREATE TABLE IF NOT EXISTS historico (id INTEGER PRIMARY KEY AUTOINCREMENT, telefone TEXT, role TEXT, content TEXT, criado TEXT)")

function getHistorico(telefone) {
  const rows = db.prepare("SELECT role, content FROM historico WHERE telefone = ? ORDER BY id ASC").all(telefone)
  return rows.map(r => ({ role: r.role, content: r.content }))
}

function addMsg(telefone, role, content) {
  db.prepare("INSERT INTO historico (telefone, role, content, criado) VALUES (?, ?, ?, datetime('now'))").run(telefone, role, content)
  // Mantém apenas as últimas 20 mensagens por telefone
  db.prepare("DELETE FROM historico WHERE telefone = ? AND id NOT IN (SELECT id FROM historico WHERE telefone = ? ORDER BY id DESC LIMIT 20)").run(telefone, telefone)
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

  const dadosColetados = p ? [
    p.nome       ? `Nome: ${p.nome}`            : null,
    p.nascimento ? `Nascimento: ${p.nascimento}` : null,
    p.sexo       ? `Sexo: ${p.sexo}`            : null,
    p.endereco   ? `Endereço: ${p.endereco}`    : null,
    p.plano      ? `Plano: ${p.plano}`          : null,
    p.motivo     ? `Motivo: ${p.motivo}`        : null,
  ].filter(Boolean) : []

  const dadosFaltando = p ? [
    !p.nome       ? 'nome completo'      : null,
    !p.nascimento ? 'data de nascimento' : null,
    !p.sexo       ? 'sexo'              : null,
    !p.endereco   ? 'endereço'          : null,
    !p.plano      ? 'plano de saúde'    : null,
    !p.motivo     ? 'motivo da consulta' : null,
  ].filter(Boolean) : ['nome completo','data de nascimento','sexo','endereço','plano de saúde','motivo da consulta']

  const resumoCadastro = dadosColetados.length > 0
    ? `Já coletados: ${dadosColetados.join(', ')}.\nAinda faltam: ${dadosFaltando.join(', ')}.`
    : `Nenhum dado coletado ainda.`

  const system = `Você é Ana, recepcionista da Clínica Geral. Você é calorosa, empática e conversa de forma completamente natural — como uma atendente humana real, não um robô.

SITUAÇÃO DO CADASTRO:
${resumoCadastro}

INSTRUÇÕES DE COMPORTAMENTO:
- Converse naturalmente, respondendo primeiro ao que o paciente disse
- Colete os dados que FALTAM, um por vez, de forma leve e espontânea
- NUNCA peça um dado que já foi coletado
- Use o nome do paciente com moderação — só ocasionalmente, não em toda frase
- Varie bastante as formas de perguntar — nunca repita a mesma estrutura
- Demonstre empatia quando o paciente mencionar dor ou dificuldades
- Se o paciente já informou algo sem você perguntar, aceite naturalmente
- Se o paciente fizer uma pergunta fora do escopo (orçamento, preço, agenda), responda com simpatia que essa informação é passada pela equipe, e volte gentilmente ao cadastro
- Quando TODOS os dados estiverem coletados, confirme de forma calorosa e diga que entrarão em contato para confirmar o horário
- NUNCA mostre o bloco DADOS na mensagem para o paciente — ele é só para sistema interno

FORMATO INTERNO (invisível para o paciente):
Sempre que coletar um ou mais dados novos, adicione numa linha separada ao final da sua resposta:
DADOS: NOME:valor|NASC:valor|SEXO:valor|END:valor|PLANO:valor|MOTIVO:valor
(inclua apenas os dados coletados NESSA mensagem, os demais deixe em branco)

Responda sempre em português brasileiro.`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system: system, messages: getHistorico(telefone) })
  })

  const data = await response.json()
  if (!data.content || !data.content[0]) {
    console.error('Resposta inesperada da API:', JSON.stringify(data))
    return 'Desculpe, tive um probleminha aqui. Pode repetir?'
  }

  const texto = data.content[0].text

  // Extrai e salva os dados
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

  // Remove o bloco DADOS antes de enviar ao paciente
  const limpo = texto.replace(/\n?DADOS:.*$/im, '').trim()
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
    if (body.fromMe) return res.status(200).send('ok')
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

const PORTA = process.env.PORT || 8080
app.listen(PORTA, function() { console.log('Rodando na porta ' + PORTA) })

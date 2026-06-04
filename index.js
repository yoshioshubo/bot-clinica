const express = require('express')
const Database = require('better-sqlite3')
const app = express()
app.use(express.json())

const INSTANCE_ID = process.env.INSTANCE_ID || '3F424535214202979B1E7A94F00847F6'
const INSTANCE_TOKEN = process.env.INSTANCE_TOKEN || 'EA8E2F27C3F469BA1874CEED'
const CLAUDE_KEY = process.env.CLAUDE_KEY

const db = new Database('clinica.db')

db.exec('CREATE TABLE IF NOT EXISTS pacientes (telefone TEXT PRIMARY KEY, nome_completo TEXT, data_nascimento TEXT, sexo TEXT, endereco TEXT, plano_saude TEXT, motivo_consulta TEXT, data_cadastro TEXT DEFAULT (datetime(\'now\')), ultima_atualizacao TEXT DEFAULT (datetime(\'now\')))')

const historicos = {}

function getHistorico(telefone) {
  if (!historicos[telefone]) historicos[telefone] = []
  return historicos[telefone]
}

function addMensagem(telefone, role, content) {
  if (!historicos[telefone]) historicos[telefone] = []
  historicos[telefone].push({ role, content })
  if (historicos[telefone].length > 20) historicos[telefone] = historicos[telefone].slice(-20)
}

function getPaciente(telefone) {
  return db.prepare('SELECT * FROM pacientes WHERE telefone = ?').get(telefone)
}

function salvarPaciente(telefone, dados) {
  const existe = getPaciente(telefone)
  if (existe) {
    db.prepare('UPDATE pacientes SET nome_completo = COALESCE(?, nome_completo), data_nascimento = COALESCE(?, data_nascimento), sexo = COALESCE(?, sexo), endereco = COALESCE(?, endereco), plano_saude = COALESCE(?, plano_saude), motivo_consulta = COALESCE(?, motivo_consulta), ultima_atualizacao = datetime(\'now\') WHERE telefone = ?').run(dados.nome_completo || null, dados.data_nascimento || null, dados.sexo || null, dados.endereco || null, dados.plano_saude || null, dados.motivo_consulta || null, telefone)
  } else {
    db.prepare('INSERT INTO pacientes (telefone, nome_completo, data_nascimento, sexo, endereco, plano_saude, motivo_consulta) VALUES (?, ?, ?, ?, ?, ?, ?)').run(telefone, dados.nome_completo || null, dados.data_nascimento || null, dados.sexo || null, dados.endereco || null, dados.plano_saude || null, dados.motivo_consulta || null)
  }
}

async function perguntarIA(telefone, mensagem) {
  const paciente = getPaciente(telefone)
  addMensagem(telefone, 'user', mensagem)
  const historico = getHistorico(telefone)

  let cadastroAtual = 'Nenhum dado cadastrado ainda.'
  if (paciente) {
    cadastroAtual = 'Dados ja coletados: Nome: ' + (paciente.nome_completo || 'nao informado') + ' | Nascimento: ' + (paciente.data_nascimento || 'nao informado') + ' | Sexo: ' + (paciente.sexo || 'nao informado') + ' | Endereco: ' + (paciente.endereco || 'nao informado') + ' | Plano: ' + (paciente.plano_saude || 'nao informado') + ' | Motivo: ' + (paciente.motivo_consulta || 'nao informado')
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: 'Voce e Ana, recepcionista virtual de uma clinica medica. Seu objetivo e agendar consultas coletando os dados do paciente. CADASTRO ATUAL: ' + cadastroAtual + '. INSTRUCOES: Colete apenas dados ainda nao informados. Nunca repita perguntas ja respondidas. Colete um dado por vez de forma amigavel. Use o nome do paciente assim que souber. Quando coletar um dado nessa mensagem, adicione ao final: DADOS: NOME: valor | NASC: valor | SEXO: valor | END: valor | PLANO: valor | MOTIVO: valor (so os coletados agora). Quando todos os dados
const express = require('express')
const app = express()
app.use(express.json())

const INSTANCE_ID = process.env.INSTANCE_ID || '3F424535214202979B1E7A94F00847F6'
const INSTANCE_TOKEN = process.env.INSTANCE_TOKEN || 'EA8E2F27C3F469BA1874CEED'
const CLAUDE_KEY = process.env.CLAUDE_KEY

async function perguntarIA(mensagem) {
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
      system: 'Você é um atendente virtual simpático de uma clínica médica. Seu objetivo é agendar consultas coletando: nome completo, data de nascimento, sexo, telefone, endereço, plano de saúde e motivo da consulta. Colete um dado por vez, de forma natural e amigável. Responda sempre em português brasileiro.',
      messages: [{ role: 'user', content: mensagem }]
    })
  })
  const data = await response.json()
  console.log('Resposta Claude:', JSON.stringify(data))
  if (data.content && data.content[0] && data.content[0].text) {
    return data.content[0].text
  }
  return 'Desculpe, tive um problema técnico. Tente novamente em instantes.'
}
async function enviarMensagem(telefone, mensagem) {
  await fetch(`https://api.z-api.io/instances/${INSTANCE_ID}/token/${INSTANCE_TOKEN}/send-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: telefone, message: mensagem })
  })
}

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body
    if (!body.text || !body.phone) return res.status(200).send('ok')
    const telefone = body.phone
    const mensagem = body.text.message
    console.log('Mensagem de ' + telefone + ': ' + mensagem)
    const resposta = await perguntarIA(mensagem)
    await enviarMensagem(telefone, resposta)
    console.log('Resposta enviada: ' + resposta)
    res.status(200).send('ok')
  } catch (err) {
    console.error('Erro:', err)
    res.status(200).send('ok')
  }
})

const PORTA = process.env.PORT || 3000
app.listen(PORTA, () => {
  console.log('Servidor rodando na porta ' + PORTA)
})
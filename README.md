# Bot Clínica — Recepcionista Virtual via WhatsApp

Chatbot de atendimento para clínicas (psicologia, odontologia e similares), integrado ao WhatsApp via Z-API, com agendamento automático no Google Agenda, configuração por Google Sheets e lembretes por e-mail e WhatsApp.

## Funcionalidades

- Atendimento automatizado 24/7 pela "Ana" (IA com Claude)
- Cadastro completo de pacientes (nome, CPF, nascimento, sexo, endereço via CEP, convênio, e-mail)
- Agendamento, reagendamento e cancelamento de consultas
- Confirmação com endereço da clínica enviada ao paciente
- Lembretes automáticos: 1 dia antes e 2 horas antes da consulta (WhatsApp + e-mail)
- Transcrição de áudios enviados pelo paciente (OpenAI Whisper)
- Dashboard de gestão com DRE simplificado
- Arquitetura multi-tenant: um servidor atende múltiplas clínicas

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js + Express |
| IA | Claude (Anthropic) |
| WhatsApp | Z-API |
| Agenda | Google Calendar API |
| Configuração | Google Sheets API |
| Banco de dados | SQLite (better-sqlite3) |
| Áudio | OpenAI Whisper |
| E-mail | Nodemailer + Gmail |
| Hospedagem | Railway |

## Configuração

### 1. Variáveis de ambiente

Copie `.env.example` para `.env` e preencha:

```bash
cp .env.example .env
```

Todas as variáveis são obrigatórias. Veja descrição em `.env.example`.

### 2. Google Service Account

- Crie um projeto no Google Cloud Console
- Ative as APIs: Google Calendar e Google Sheets
- Crie uma Service Account e baixe o JSON de credenciais
- Cole o conteúdo do JSON na variável `GOOGLE_SERVICE_ACCOUNT_JSON` do Railway

### 3. Google Sheets — configuração da clínica

Crie uma planilha e compartilhe com o e-mail da Service Account (com permissão de Editor).

A planilha deve ter uma aba `Config` com as seguintes linhas (coluna A = chave, coluna B = valor):

| Chave | Exemplo |
|---|---|
| nome_clinica | Clínica Exemplo |
| nome_atendente | Ana |
| especialidade | Psicologia |
| endereco | Rua das Flores, 100, sala 5 |
| referencia | Próximo ao Shopping Central |
| elevador | Sim |
| telefone | 32 9 9999-0000 |
| convenios | Unimed, Bradesco Saúde |
| formas_pagamento | Cartão, PIX, Dinheiro |
| horarios | seg-sex 08:00-18:00, sab 08:00-12:00 |
| calendar_id | ID do Google Agenda da clínica |
| email_clinica | contato@clinica.com |

### 4. Google Calendar

- Compartilhe o calendário da clínica com o e-mail da Service Account (permissão de edição)
- Cole o ID do calendário na planilha de configuração

### 5. Deploy no Railway

```bash
railway up
```

Configure o webhook do Z-API para apontar para:
```
https://seu-projeto.railway.app/webhook
```

## Estrutura de arquivos

```
bot-clinica/
├── index.js              # Servidor principal
├── dashboard.html        # Painel de gestão
├── diagrama_arquitetura.html  # Diagrama da arquitetura
├── package.json
├── .env.example          # Modelo de variáveis de ambiente
└── .gitignore
```

## Segurança

- Credenciais nunca são versionadas (protegidas pelo `.gitignore`)
- Cada clínica tem banco de dados SQLite isolado
- Dados de pacientes seguem as diretrizes da LGPD

---

Desenvolvido para uso interno e revenda como SaaS para clínicas.

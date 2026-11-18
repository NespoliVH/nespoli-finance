# Nespoli Finance: backend

Servidor que guarda os dados do usuário, conversa com o Pluggy e roda as regras
de categorização, alertas e estimativa de IR. Arquitetura descrita na etapa 2 e
modelo de dados na etapa 3 da documentação do TCC.

## Tecnologias

Node.js 22, TypeScript, Fastify, PostgreSQL, Prisma 7 e Vitest.

## Como rodar

1. Tenha um PostgreSQL disponível e crie dois bancos, por exemplo `nespoli_dev` e `nespoli_test`.
2. Copie `.env.example` para `.env` e preencha (as chaves são geradas com `openssl rand -base64 32`).
3. Instale e prepare o banco:

```bash
npm install          # também gera o cliente do Prisma
npm run db:migrate   # cria as tabelas no banco de desenvolvimento
npm run dev          # servidor em http://localhost:3000
```

## Testes

```bash
npm test         # testes automáticos (recria o banco de teste a cada execução)
npm run typecheck
```

## Estrutura

| Caminho | Conteúdo |
| --- | --- |
| `prisma/schema.prisma` | As 11 tabelas da modelagem |
| `prisma/migrations/` | Histórico versionado de mudanças no banco |
| `src/config/env.ts` | Leitura e validação das variáveis de ambiente |
| `src/lib/crypto.ts` | Criptografia de campo (AES-256-GCM) e índice cego (HMAC) |
| `src/db.ts` | Conexão com o banco |
| `src/app.ts` | Montagem do servidor HTTP e suas rotas |
| `src/server.ts` | Ponto de entrada que inicia o servidor |
| `test/` | Testes automáticos |

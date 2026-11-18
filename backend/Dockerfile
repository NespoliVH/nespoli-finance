# Imagem do backend para a hospedagem. Serve para qualquer serviço que rode
# contêineres (Render, Railway, Fly.io). As variáveis de ambiente (chaves,
# banco, Pluggy) são configuradas no painel da hospedagem, nunca aqui.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# OpenSSL é usado pelo Prisma.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# Instala também as dependências de desenvolvimento: o servidor roda com tsx
# e as migrações usam a CLI do Prisma.
RUN npm ci --include=dev

COPY src ./src
COPY tsconfig.json ./

# Roda sem privilégios de administrador.
USER node
EXPOSE 3000

# Aplica as migrações pendentes e sobe o servidor.
CMD ["npm", "run", "start:prod"]

FROM node:22-alpine

# Le service tourne sans privileges : l'image node fournit deja un utilisateur
# `node` non root, autant s'en servir.
WORKDIR /app
COPY server.js ./

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000

# Le dossier des versions publiees est un volume : il doit survivre a chaque
# redeploiement du service.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -q -O- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]

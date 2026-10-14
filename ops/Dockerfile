# Image de l'application Wallindirain : Node.js sans aucune dépendance à installer.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# La structure /app/backend + /app/frontend doit être conservée : le serveur sert ../frontend
COPY backend/ /app/backend/
COPY frontend/ /app/frontend/
WORKDIR /app/backend
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/public/info >/dev/null || exit 1
CMD ["node", "src/server.js"]

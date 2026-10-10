# AuTomeDo server + web app in one container.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci && npm run build && npm prune --omit=dev
ENV HOST=0.0.0.0 \
    PORT=8787 \
    AUTOMEDO_DB=/data/automedo.db \
    AUTOMEDO_WEB_DIR=/app/apps/web/dist
VOLUME /data
EXPOSE 8787
CMD ["npm", "start", "-w", "@automedo/server"]

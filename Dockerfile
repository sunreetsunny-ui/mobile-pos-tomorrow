FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

COPY package.json ./
COPY server.js ./
COPY public ./public

RUN mkdir -p /data

EXPOSE 8080
CMD ["node", "server.js"]

FROM node:20-slim
WORKDIR /app
COPY package.json .
COPY server.js .
COPY public ./public
ENV NODE_ENV=production
ENV PORT=8767
EXPOSE 8767
CMD ["node", "server.js"]

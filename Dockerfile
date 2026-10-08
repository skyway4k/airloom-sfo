FROM node:20-slim
WORKDIR /app
# airloom-v27: bake the Bay Area basemap set into the image (free plan = no persistent disk;
# runtime FS is wiped on every sleep). Layer only depends on the schedule + bake script, so
# Docker layer cache skips the ~3 min download when only app code changes.
COPY tiles-schedule.json ./
COPY tools ./tools
RUN node tools/bake-tiles.js /app/tilecache 32
COPY package.json .
COPY server.js .
COPY public ./public
ENV NODE_ENV=production
ENV PORT=8767
ENV TILE_BAKED_DIR=/app/tilecache
EXPOSE 8767
CMD ["node", "server.js"]

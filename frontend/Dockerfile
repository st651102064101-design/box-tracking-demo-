# ── BoxTrace frontend (Next.js 14) ──────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
# Next.js bakes rewrites() into the build, so the backend URL must be present at
# BUILD time. Defaults to the compose service name; override with
#   docker compose build --build-arg BACKEND_URL=http://host:port
ARG BACKEND_URL=http://backend:4000
ENV BACKEND_URL=$BACKEND_URL
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.js ./next.config.js
EXPOSE 3000
CMD ["npm", "run", "start"]

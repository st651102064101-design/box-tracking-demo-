# ── SmartTrace frontend (Next.js 14) ──────────────────────────────────────────
FROM node:22-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev", "--", "-H", "0.0.0.0"]

FROM node:22-alpine AS build
WORKDIR /app
# Next.js bakes rewrites() into the build, so the backend URL must be present at
# BUILD time. Defaults to the compose service name; override with
#   docker compose build --build-arg BACKEND_URL=http://host:port
ARG BACKEND_URL=http://backend:4000
ENV BACKEND_URL=$BACKEND_URL
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
# Keep the complete Three.js runtime local to this deployment. The legacy 3D
# module must not depend on a CDN response that a LAN security proxy can alter.
COPY --from=build /app/node_modules/three/build ./public/vendor/three/build
COPY --from=build /app/node_modules/three/examples/jsm ./public/vendor/three/examples/jsm
# Serve the legacy 3D module under its own physical static filename. This
# avoids proxy/rewrite transformations on large ES modules used by old tabs.
RUN cp ./public/loc3d.js ./public/warehouse-3d-runtime.js
COPY --from=build /app/next.config.js ./next.config.js
EXPOSE 3000
CMD ["npm", "run", "start"]

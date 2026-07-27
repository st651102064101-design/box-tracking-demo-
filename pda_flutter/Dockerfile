# ── BoxTrace PDA (Flutter web) ──────────────────────────────────────────────
# must stay >= 3.27 — the UI uses Color.withValues, which older SDKs reject.
# Override with --build-arg FLUTTER_TAG=<x.y.z> to pin a reproducible build.
ARG FLUTTER_TAG=stable
FROM ghcr.io/cirruslabs/flutter:${FLUTTER_TAG} AS build
WORKDIR /app
# resolve deps first so edits to lib/ don't re-download the pub cache
COPY pubspec.yaml pubspec.lock* ./
RUN flutter pub get
COPY . .
RUN flutter build web --release

FROM nginx:alpine AS runtime
COPY --from=build /app/build/web /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

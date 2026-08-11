# ── SmartTrace PDA (Flutter web) ──────────────────────────────────────────────
# must stay >= 3.27 — the UI uses Color.withValues, which older SDKs reject.
# Override with --build-arg FLUTTER_TAG=<x.y.z> to pin a reproducible build.
ARG FLUTTER_TAG=stable
FROM ghcr.io/cirruslabs/flutter:${FLUTTER_TAG} AS build
WORKDIR /app
# resolve deps first so edits to lib/ don't re-download the pub cache
COPY pubspec.yaml pubspec.lock* ./
RUN flutter pub get
COPY . .
# --pwa-strategy=none disables the service worker Flutter otherwise registers.
# It caches the app shell ahead of the network, so it serves the previous build
# no matter what Cache-Control nginx sends — a terminal keeps running last
# week's app after a redeploy, and clearing it means touching every device by
# hand. Offline capability buys nothing here: the app already keeps its own
# state snapshot in SharedPreferences (see Prefs.stateCache), which is what a
# gate actually needs when the network drops.
RUN flutter build web --release --pwa-strategy=none

FROM nginx:alpine AS runtime
COPY --from=build /app/build/web /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

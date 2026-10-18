# webtor-relay image: the web app embedded, distroless static, non-root. The published image
# (ghcr.io/alexeychikk/webtor-relay) is built by ko from relay/.ko.yaml with the same settings.
# Build from the repository root (the web app is part of the image):
#   docker build -f relay/Dockerfile --build-arg VERSION=0.1.0 -t webtor-relay .
#   docker run -d -p 7881:7881 -p 42069:42069 -p 42069:42069/udp -v webtor-relay:/home/nonroot webtor-relay

FROM node:24-slim AS app
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html svelte.config.js tsconfig.json vite.config.ts ./
COPY src ./src
RUN pnpm build && find dist -name '*.map' -delete

# Keep in step with the Go version in mise.toml.
FROM golang:1.27 AS relay
ARG VERSION=dev
WORKDIR /src/relay
COPY relay/go.mod relay/go.sum ./
RUN go mod download
COPY relay/ ./
RUN rm -rf internal/webapp/dist
COPY --from=app /src/dist/ internal/webapp/dist/
RUN CGO_ENABLED=0 go build -trimpath -o /webtor-relay -ldflags "-s -w \
      -X github.com/alexeychikk/webtor/relay/internal/relay.Version=${VERSION} \
      -X main.defaultListen=0.0.0.0:7881 \
      -X main.defaultDataDir=/home/nonroot/webtor-relay" \
    ./cmd/webtor-relay

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=relay /webtor-relay /webtor-relay
# 7881: HTTP (put HTTPS in front, see README). 42069: BitTorrent peers, TCP and uTP (UDP).
EXPOSE 7881 42069/tcp 42069/udp
# Token and open torrents' data; distroless's /home/nonroot is owned by the non-root user, so a
# named volume mounted here is writable.
VOLUME /home/nonroot
USER 65532:65532
ENTRYPOINT ["/webtor-relay"]

# Self-host the example on workerd. Bundle it first (`pnpm build` in this folder), then:
#   docker build -t workerd-chats . && docker run -p 8080:8080 -v chats:/app/data workerd-chats
# Each chat's SQLite database lands in /app/data; keep that volume and the chats keep their files.
FROM node:24-bookworm-slim AS workerd
RUN npm install --global workerd@1.20261006.1 \
  && cp "$(node -p "require('/usr/local/lib/node_modules/workerd').default")" /workerd

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=workerd /workerd /usr/local/bin/workerd
WORKDIR /app
COPY workerd.capnp ./
COPY dist/worker.js dist/
RUN mkdir data
EXPOSE 8080
ENTRYPOINT ["workerd", "serve", "workerd.capnp", "--experimental"]

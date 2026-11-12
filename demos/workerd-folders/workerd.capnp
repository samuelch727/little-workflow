using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "folders", worker = .folders),
    (name = "chat-storage", disk = (path = "data", writable = true)),
    # Offline example: no outbound network access.
    (name = "internet", network = (allow = [])),
  ],
  sockets = [(name = "http", address = "127.0.0.1:8080", http = (), service = "folders")],
);
const folders :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "dist/worker.js")],
  compatibilityDate = "2026-10-01",
  durableObjectNamespaces = [(className = "Chat", uniqueKey = "workerd-folders-Chat", enableSql = true)],
  durableObjectStorage = (localDisk = "chat-storage"),
  bindings = [(name = "CHAT", durableObjectNamespace = "Chat")],
);

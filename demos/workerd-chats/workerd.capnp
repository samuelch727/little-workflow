# Self-hosted workerd: `pnpm build`, then `pnpm serve`. One process serves every chat; each
# chat is a Durable Object whose SQLite database lives under ./data.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "chats", worker = .chats),
    (name = "chat-storage", disk = (path = "data", writable = true)),
    (name = "data-api", external = (address = "127.0.0.1:8788", http = ())),
    # Models/ingest may run on this machine. For a different LAN host, allow only its
    # chosen IP/subnet here; workerd's implicit internet service blocks private IPs.
    (name = "internet", network = (
      allow = ["public", "127.0.0.1/32"],
      tlsOptions = (trustBrowserCas = true),
    )),
  ],
  sockets = [ (name = "http", address = "*:8080", http = (), service = "chats") ],
);

const chats :Workerd.Worker = (
  modules = [ (name = "worker.js", esModule = embed "dist/worker.js") ],
  compatibilityDate = "2026-10-01",
  durableObjectNamespaces = [ (className = "Chat", uniqueKey = "workerd-chats-Chat", enableSql = true) ],
  durableObjectStorage = (localDisk = "chat-storage"),
  bindings = [
    (name = "CHAT", durableObjectNamespace = "Chat"),
    (name = "DATA_API", service = "data-api"),
    (name = "DATA_API_TOKEN", fromEnvironment = "DATA_API_TOKEN"),
    # Unset, the chats run a scripted model that needs no key.
    (name = "DEEPSEEK_API_KEY", fromEnvironment = "DEEPSEEK_API_KEY"),
    (name = "MODEL_BASE_URL", fromEnvironment = "MODEL_BASE_URL"),
    (name = "MODEL_NAME", fromEnvironment = "MODEL_NAME"),
    (name = "MODEL_API_KEY", fromEnvironment = "MODEL_API_KEY"),
    (name = "LITTLEDB_URL", fromEnvironment = "LITTLEDB_URL"),
    (name = "LITTLEDB_API_KEY", fromEnvironment = "LITTLEDB_API_KEY"),
    (name = "TRACE_LIMIT", fromEnvironment = "TRACE_LIMIT"),
  ],
);

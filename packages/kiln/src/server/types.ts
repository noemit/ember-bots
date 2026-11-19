import type { Context } from "@earendil-works/chord";
import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import type {
  ConversationId,
  ConversationWatch,
  Harness,
  Storage,
  TaskGraphWatch,
} from "@earendil-works/pi-durable";
import type { AlignmentConfig } from "../alignment";
import type { CompactionSettings } from "../compaction-settings";
import type { HearthConfig } from "../config";
import type { CustomProviders } from "../custom-providers";
import type { LocalRuntimeProbe } from "../local-models";
import type { createLoginSupervisor } from "../login";
import type { HearthDefault } from "../models";
import type { OllamaSettings } from "../ollama-settings";
import type { hostMemory, scanLeftovers } from "../processes";
import type { createStreamLimiter } from "../streamLimit";

export type HearthServer = {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
};

export type ServerDeps = {
  config: HearthConfig;
  token: string;
  storage: Storage;
  harness: Harness;
  models: Models;
  defaultAgent: HearthDefault;
  /** Provider credential store; backs `GET /providers`. */
  store?: CredentialStore;
  /** Host-local path for explicit OpenCode migration; never taken from a request. */
  openCodeImportSource?: string;
  /** Config owner serializes this guard with custom provider edits and republishes imported keys. */
  alignmentConfig?: AlignmentConfig;
  /** Semver release from package.json, surfaced on `/health`. */
  version?: string;
  /** Short build id (git SHA), surfaced on `/health` so a client can name the running version. */
  build?: string;
  /** Graceful self-restart for `POST /admin/restart`; the host's supervisor brings Hearth back. */
  restart?: (reason: string) => void;
  /**
   * The boot-time probe of the local runtimes (Ollama, LM Studio), reported by `GET /providers`.
   * Optional so a test can build a server without touching loopback.
   */
  localRuntimes?: LocalRuntimeProbe[];
  customProviders?: CustomProviders;
  ollamaSettings?: OllamaSettings;
  compactionSettings?: CompactionSettings;
  /**
   * The host's process table and memory. Production leaves this out; a test passes a fake so the
   * routes can be exercised without depending on what is running on the machine under test.
   */
  processes?: { scan?: typeof scanLeftovers; memory?: typeof hostMemory };
};

export type WsData = {
  conversationId?: ConversationId;
  tasks?: boolean;
  /** The conversation's state watch (pi-durable 1.5.0 `Conversation.watch`). */
  watch?: ConversationWatch;
  graph?: TaskGraphWatch;
  /** Interval that keeps an idle stream alive; cleared when the socket closes. */
  keepalive?: ReturnType<typeof setInterval>;
  /** Set once a frame was dropped: the socket is closing and must not be sent to again. */
  lost?: boolean;
  /** Backpressure: nothing is written until Bun reports `drain` (see `src/stream.ts`). */
  paused?: boolean;
  pausedSince?: number;
  /** The remote address that opened this stream, released from the limiter when it closes. */
  peer?: string;
};

export type ServerRuntime = {
  readonly context: Context;
  readonly deps: ServerDeps;
  readonly scan: typeof scanLeftovers;
  readonly memory: typeof hostMemory;
  readonly runLiveModelRefresh: (
    providers?: readonly string[],
    signal?: AbortSignal
  ) => Promise<{ errors: string[] }>;
  readonly refreshModelCatalog: (reason: string) => void;
  readonly loginSupervisor: ReturnType<typeof createLoginSupervisor>;
  readonly streamLimiter: ReturnType<typeof createStreamLimiter>;
  readonly logRefusal: (peer: string, verdict: "rate" | "concurrent", now?: number) => void;
};

export type RouteContext = {
  readonly request: Request;
  readonly url: URL;
  readonly path: string;
  readonly runtime: ServerRuntime;
};

/**
 * `@exo/kit` — shared mechanism for small self-hosted services.
 *
 * Prefer the subpath entries (`@exo/kit/infra`, `@exo/kit/log`,
 * `@exo/kit/llm`, `@exo/kit/connector-sdk`): importing a subpath pulls in only
 * that module's peer dependencies, so a product that wants a logger does not
 * need a Postgres driver on disk. This root entry exists for discovery and
 * re-exports the types, not the factories.
 */
export type { Db, DbConfig, DbOutcome, RedisCache, RedisConfig, ErrorContext, ReportError, JsonRecord } from './infra/index.js';
export type { KitLogger, LoggerConfig, OpenObserveConfig, AuditRecord, LogFields } from './log/index.js';
export type { Llm, LlmConfig, ChatMessage, ChatProvider, GenerateOptions, ProviderName } from './llm/index.js';
export type { ConnectorHandlerOptions } from './connector-sdk/index.js';

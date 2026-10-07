import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Idempotente: aplica solo lo que falte. Es el mismo `d1_migrations` que lleva
// Wrangler, así que `/health` lo ve igual que en producción.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

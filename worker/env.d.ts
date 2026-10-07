/**
 * Secretos opcionales. `wrangler types` solo genera los de `secrets.required`
 * (`wrangler.jsonc`), y estos pueden faltar a propósito: sin ANTHROPIC_API_KEY
 * el ranking con IA queda desactivado, y el resto solo siembran datos iniciales.
 */
interface OptionalSecrets {
  ANTHROPIC_API_KEY?: string;
  FIRST_SUPERUSER_EMAIL?: string;
  FIRST_SUPERUSER_PASSWORD?: string;
  BOOTSTRAP_SCRAPER_API_KEY?: string;
}

interface Env extends OptionalSecrets {}

declare namespace Cloudflare {
  interface Env extends OptionalSecrets {}
}

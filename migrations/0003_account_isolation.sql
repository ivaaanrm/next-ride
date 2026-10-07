-- Aislamiento por cuenta: cada fila del dominio pasa a ser de una cuenta
-- (`user_id`), y ninguna cuenta ve, cuenta ni toca lo de otra. Hasta aquí todo
-- era global: con dos personas dentro, la segunda veía las ofertas de la
-- primera, y su scraper ingestaba en el mismo montón.
--
-- Escrita a mano sobre lo que propone drizzle-kit (el snapshot sí es suyo):
--
-- - `ADD COLUMN` y no reconstruir las tablas. En D1, el DROP TABLE de una
--   reconstrucción de `offers` ejecuta los ON DELETE CASCADE de su historial,
--   sus favoritos y sus rankings (`defer_foreign_keys` aplaza comprobaciones,
--   no acciones). Por eso `user_id` queda NULL-able para SQLite aunque Drizzle
--   la declare obligatoria; lo que no puede pasar —que una fila apunte a otra
--   cuenta— lo impiden los disparadores del final.
-- - Hasta hoy los datos eran de una sola persona, y pasan a la cuenta más
--   antigua con superusuario (o a la más antigua, si no hay ninguna). En una
--   base recién creada no hay nadie todavía: la semilla de rastreo se queda sin
--   dueña, invisible, y `bootstrap.ts` se la da al superusuario al sembrarlo.
-- - No es aditiva del todo, y es a sabiendas: las claves únicas globales (`url`,
--   `slug`) en las que se apoyaban los upserts del código anterior desaparecen.
--   Entre esta migración y el despliegue del código nuevo, la ingesta del código
--   viejo falla oferta a oferta (lectura y resto siguen). Desplegar fuera de la
--   hora del scraper.

-- ---- 1. La columna de dueña ------------------------------------------------- --
ALTER TABLE `api_keys` ADD `user_id` text REFERENCES `users`(`id`) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `dealers` ADD `user_id` text REFERENCES `users`(`id`) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `car_models` ADD `user_id` text REFERENCES `users`(`id`) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `offers` ADD `user_id` text REFERENCES `users`(`id`) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `ranking_runs` ADD `user_id` text REFERENCES `users`(`id`) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `score_config` ADD `user_id` text REFERENCES `users`(`id`) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `scrape_targets` ADD `user_id` text REFERENCES `users`(`id`) ON DELETE cascade;--> statement-breakpoint

-- ---- 2. Lo que ya había, a su dueña ------------------------------------------ --
-- Una API key es de quien la creó; la del bootstrap no tiene creador y es de
-- la dueña de los datos, que es para quien ingestaba.
UPDATE `api_keys` SET `user_id` = COALESCE(`created_by_id`, (SELECT `id` FROM `users` ORDER BY `is_superuser` DESC, `created_at`, `id` LIMIT 1));--> statement-breakpoint
UPDATE `dealers` SET `user_id` = (SELECT `id` FROM `users` ORDER BY `is_superuser` DESC, `created_at`, `id` LIMIT 1);--> statement-breakpoint
UPDATE `car_models` SET `user_id` = (SELECT `id` FROM `users` ORDER BY `is_superuser` DESC, `created_at`, `id` LIMIT 1);--> statement-breakpoint
UPDATE `offers` SET `user_id` = (SELECT `id` FROM `users` ORDER BY `is_superuser` DESC, `created_at`, `id` LIMIT 1);--> statement-breakpoint
UPDATE `ranking_runs` SET `user_id` = (SELECT `id` FROM `users` ORDER BY `is_superuser` DESC, `created_at`, `id` LIMIT 1);--> statement-breakpoint
UPDATE `score_config` SET `user_id` = (SELECT `id` FROM `users` ORDER BY `is_superuser` DESC, `created_at`, `id` LIMIT 1);--> statement-breakpoint
UPDATE `scrape_targets` SET `user_id` = (SELECT `id` FROM `users` ORDER BY `is_superuser` DESC, `created_at`, `id` LIMIT 1);--> statement-breakpoint

-- ---- 3. Las claves únicas pasan a ser por cuenta ----------------------------- --
-- La misma URL, el mismo dealer o la misma versión pueden estar en dos cuentas.
DROP INDEX `offers_url_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_offers_user_url` ON `offers` (`user_id`,`url`);--> statement-breakpoint
DROP INDEX `ix_offers_status_last_seen`;--> statement-breakpoint
CREATE INDEX `ix_offers_user_status_last_seen` ON `offers` (`user_id`,`status`,`last_seen_at`);--> statement-breakpoint
DROP INDEX `dealers_slug_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dealers_user_slug` ON `dealers` (`user_id`,`slug`);--> statement-breakpoint
DROP INDEX `car_models_slug_unique`;--> statement-breakpoint
DROP INDEX `uq_car_model_identity`;--> statement-breakpoint
DROP INDEX `ix_car_models_make_model_key`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_car_models_user_slug` ON `car_models` (`user_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_car_model_identity` ON `car_models` (`user_id`,`make`,`model`,`trim`);--> statement-breakpoint
CREATE INDEX `ix_car_models_user_key` ON `car_models` (`user_id`,`make_model_key`);--> statement-breakpoint
DROP INDEX `ix_ranking_runs_binomio_created`;--> statement-breakpoint
CREATE INDEX `ix_ranking_runs_user_binomio_created` ON `ranking_runs` (`user_id`,`make_model_key`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_score_config_user` ON `score_config` (`user_id`);--> statement-breakpoint
DROP INDEX `uq_scrape_target_source_model`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_scrape_target_source_model` ON `scrape_targets` (`user_id`,`source_id`,`make_model_key`);--> statement-breakpoint
DROP INDEX `ix_scrape_targets_active`;--> statement-breakpoint
CREATE INDEX `ix_scrape_targets_user_active` ON `scrape_targets` (`user_id`,`is_active`);--> statement-breakpoint
CREATE INDEX `ix_api_keys_user` ON `api_keys` (`user_id`);--> statement-breakpoint

-- ---- 4. Lo personal de las demás cuentas que apuntaba a datos ajenos -------- --
-- Un favorito sobre una oferta que ya no es suya no tiene nada que marcar.
DELETE FROM `offer_favorites`
WHERE `user_id` IS NOT (SELECT `o`.`user_id` FROM `offers` AS `o` WHERE `o`.`id` = `offer_favorites`.`offer_id`);--> statement-breakpoint
-- Un seguimiento sí se conserva: la versión seguida se copia en su cuenta (solo
-- su identidad; el PVP curado era de la otra) y el seguimiento pasa a la copia.
INSERT INTO `car_models` (`user_id`, `slug`, `make`, `model`, `trim`, `make_model_key`, `created_at`, `updated_at`)
SELECT DISTINCT `t`.`user_id`, `m`.`slug`, `m`.`make`, `m`.`model`, `m`.`trim`, `m`.`make_model_key`, `m`.`created_at`, `m`.`updated_at`
FROM `tracked_models` AS `t` JOIN `car_models` AS `m` ON `m`.`id` = `t`.`car_model_id`
WHERE `t`.`user_id` IS NOT `m`.`user_id`;--> statement-breakpoint
UPDATE `tracked_models` SET `car_model_id` = (
  SELECT `c`.`id` FROM `car_models` AS `c` JOIN `car_models` AS `m` ON `m`.`id` = `tracked_models`.`car_model_id`
  WHERE `c`.`user_id` = `tracked_models`.`user_id` AND `c`.`slug` = `m`.`slug`
)
WHERE `user_id` IS NOT (SELECT `m`.`user_id` FROM `car_models` AS `m` WHERE `m`.`id` = `tracked_models`.`car_model_id`);--> statement-breakpoint

-- ---- 5. Ninguna fila apunta a otra cuenta ------------------------------------ --
-- La API ya lo comprueba antes de escribir; esto es lo que queda si un día no lo
-- hace. Una oferta, su versión y su dealer son de la misma cuenta; un
-- seguimiento, un favorito o un veredicto del agente, de la cuenta de lo que
-- señalan.
CREATE TRIGGER `tg_offers_same_account_insert` BEFORE INSERT ON `offers`
WHEN NEW.`user_id` IS NULL
  OR NEW.`user_id` IS NOT (SELECT `user_id` FROM `car_models` WHERE `id` = NEW.`car_model_id`)
  OR NEW.`user_id` IS NOT (SELECT `user_id` FROM `dealers` WHERE `id` = NEW.`dealer_id`)
BEGIN
  SELECT RAISE(ABORT, 'offers: la oferta, su versión y su dealer tienen que ser de la misma cuenta');
END;--> statement-breakpoint
CREATE TRIGGER `tg_offers_same_account_update` BEFORE UPDATE OF `user_id`, `car_model_id`, `dealer_id` ON `offers`
WHEN NEW.`user_id` IS NULL
  OR NEW.`user_id` IS NOT (SELECT `user_id` FROM `car_models` WHERE `id` = NEW.`car_model_id`)
  OR NEW.`user_id` IS NOT (SELECT `user_id` FROM `dealers` WHERE `id` = NEW.`dealer_id`)
BEGIN
  SELECT RAISE(ABORT, 'offers: la oferta, su versión y su dealer tienen que ser de la misma cuenta');
END;--> statement-breakpoint
CREATE TRIGGER `tg_tracked_models_same_account_insert` BEFORE INSERT ON `tracked_models`
WHEN NEW.`user_id` IS NOT (SELECT `user_id` FROM `car_models` WHERE `id` = NEW.`car_model_id`)
BEGIN
  SELECT RAISE(ABORT, 'tracked_models: solo se sigue una versión de la propia cuenta');
END;--> statement-breakpoint
CREATE TRIGGER `tg_tracked_models_same_account_update` BEFORE UPDATE OF `user_id`, `car_model_id` ON `tracked_models`
WHEN NEW.`user_id` IS NOT (SELECT `user_id` FROM `car_models` WHERE `id` = NEW.`car_model_id`)
BEGIN
  SELECT RAISE(ABORT, 'tracked_models: solo se sigue una versión de la propia cuenta');
END;--> statement-breakpoint
CREATE TRIGGER `tg_offer_favorites_same_account_insert` BEFORE INSERT ON `offer_favorites`
WHEN NEW.`user_id` IS NOT (SELECT `user_id` FROM `offers` WHERE `id` = NEW.`offer_id`)
BEGIN
  SELECT RAISE(ABORT, 'offer_favorites: solo se marca una oferta de la propia cuenta');
END;--> statement-breakpoint
CREATE TRIGGER `tg_offer_favorites_same_account_update` BEFORE UPDATE OF `user_id`, `offer_id` ON `offer_favorites`
WHEN NEW.`user_id` IS NOT (SELECT `user_id` FROM `offers` WHERE `id` = NEW.`offer_id`)
BEGIN
  SELECT RAISE(ABORT, 'offer_favorites: solo se marca una oferta de la propia cuenta');
END;--> statement-breakpoint
CREATE TRIGGER `tg_offer_rankings_same_account_insert` BEFORE INSERT ON `offer_rankings`
WHEN (SELECT `user_id` FROM `ranking_runs` WHERE `id` = NEW.`run_id`) IS NULL
  OR (SELECT `user_id` FROM `ranking_runs` WHERE `id` = NEW.`run_id`)
     IS NOT (SELECT `user_id` FROM `offers` WHERE `id` = NEW.`offer_id`)
BEGIN
  SELECT RAISE(ABORT, 'offer_rankings: un run solo valora ofertas de su cuenta');
END;--> statement-breakpoint
CREATE TRIGGER `tg_offer_rankings_same_account_update` BEFORE UPDATE OF `run_id`, `offer_id` ON `offer_rankings`
WHEN (SELECT `user_id` FROM `ranking_runs` WHERE `id` = NEW.`run_id`) IS NULL
  OR (SELECT `user_id` FROM `ranking_runs` WHERE `id` = NEW.`run_id`)
     IS NOT (SELECT `user_id` FROM `offers` WHERE `id` = NEW.`offer_id`)
BEGIN
  SELECT RAISE(ABORT, 'offer_rankings: un run solo valora ofertas de su cuenta');
END;

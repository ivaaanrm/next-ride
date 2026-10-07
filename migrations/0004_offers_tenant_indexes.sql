-- Índices de `offers` pensados para un planificador sin estadísticas (D1 no
-- tiene `sqlite_stat1`): SQLite elige el índice que casa más columnas por
-- igualdad, sin saber cuántas filas hay detrás de cada una.
--
-- - Las candidatas del orden por puntuación (las 500 más baratas del filtro) y
--   el orden por precio salen ya ordenadas de (user_id, status, price): se leen
--   esas filas, y no todas las de la cuenta para ordenarlas antes. En
--   producción eran ~36.000 filas leídas por petición para devolver 500.
-- - Los índices de versión y de dealer llevan la cuenta detrás de la clave. Un
--   filtro `user_id = ? AND status = ? AND dealer_id = ?` empataba a dos
--   columnas entre (user_id, status) y (dealer_id, status), ganaba el de la
--   cuenta y se recorrían todas sus ofertas para sacar las de un dealer. Ahora
--   el de la clave casa tres. Siguen empezando por la clave: es lo que buscan
--   las uniones y las comprobaciones de claves ajenas.
--
-- Primero se crean y luego se borran los viejos, para no dejar ni un momento
-- sin índice por clave. Solo índices: ni reconstruye tablas ni toca datos.
CREATE INDEX `ix_offers_user_status_price` ON `offers` (`user_id`,`status`,`price`);--> statement-breakpoint
CREATE INDEX `ix_offers_model_user_status_price` ON `offers` (`car_model_id`,`user_id`,`status`,`price`);--> statement-breakpoint
CREATE INDEX `ix_offers_dealer_user_status_price` ON `offers` (`dealer_id`,`user_id`,`status`,`price`);--> statement-breakpoint
DROP INDEX `ix_offers_model_status_price`;--> statement-breakpoint
DROP INDEX `ix_offers_dealer_status`;

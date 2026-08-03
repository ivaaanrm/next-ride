FROM node:22-alpine AS build

WORKDIR /app

# pnpm viene por corepack, que ya trae Node 22: la versión sale del campo
# `packageManager` del package.json, así que imagen y portátil instalan con la
# misma. La variable calla el aviso interactivo que corepack saca al descargarla.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
# `--frozen-lockfile` requiere lockfile; si no existe (primer arranque) cae a
# `pnpm install`, que lo resuelve desde los rangos del package.json.
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
# Sin esta línea el manifest, los iconos y el service worker existen en el
# repositorio, pasan `check:pwa` —que audita el repositorio, no la imagen— y no
# están en el contenedor: la app no se puede instalar y no hay worker que
# registrar. Vite copia `public/` a `dist/` tal cual, sin tocar los nombres.
COPY public ./public

# Origen de la API horneado en el bundle. Sin valor, `src/lib/api.ts` cae a
# `/api/v1` relativo, que es lo que quiere el stack de desarrollo.
ARG VITE_API_BASE_URL

# El `unset` no sobra: un ARG declarado llega al RUN como variable de entorno
# aunque no se le pase valor, y Vite expone las `VITE_*` del entorno tal cual.
# `?? "/api/v1"` no rescata una cadena vacía —vacío no es nulo—, así que el
# cliente pediría `/offers` en lugar de `/api/v1/offers` y todo daría 404.
RUN if [ -z "$VITE_API_BASE_URL" ]; then unset VITE_API_BASE_URL; fi; pnpm build


FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# 127.0.0.1 explícito: `localhost` resuelve a ::1 y nginx solo escucha en IPv4.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
    CMD curl -fsS http://127.0.0.1/ >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]

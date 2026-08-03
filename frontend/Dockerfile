FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
# `npm ci` requiere lockfile; si no existe (primer arranque) cae a `npm install`.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
# Sin esta línea el manifest, los iconos y el service worker existen en el
# repositorio, pasan `check:pwa` —que audita el repositorio, no la imagen— y no
# están en el contenedor: la app no se puede instalar y no hay worker que
# registrar. Vite copia `public/` a `dist/` tal cual, sin tocar los nombres.
COPY public ./public

RUN npm run build


FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# 127.0.0.1 explícito: `localhost` resuelve a ::1 y nginx solo escucha en IPv4.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
    CMD curl -fsS http://127.0.0.1/ >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]

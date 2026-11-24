# A médiaszerver image-e (termék; kiemelési terv WP49). A hivatalos nginx image (njs 1.0.2) tagre ÉS digestre
# rögzítve, benne a konfig és az njs; az apps.json és a médiagyökér futáskor, csak olvasva csatolva (compose).
#
#   docker build -t media-server:dev .            (a server/-ből; kiadási címke és OCI-címkék: scripts/image-build.sh)
#
# Futáskor (compose): read_only gyökér, tmpfs a /etc/nginx/conf.d, /var/cache/nginx, /run, /tmp alá;
# /etc/nginx/secrets/apps.json és /srv/media csak olvasva.
FROM nginx:1.30.7-alpine@sha256:caf4e1e032a20f9c3c5e28fc7f25ffd768ad8677b4975c54193075997b3a97e3

LABEL org.opencontainers.image.title="media-server" \
      org.opencontainers.image.description="Védett médiaszerver: nginx + njs (HS256 és ES256 directory-token)" \
      org.opencontainers.image.licenses="UNLICENSED"

# Az image entrypointja csak a templates/ envsubst-jéhez kell (realip.conf a NET_GATEWAY-ből).
ENV NGINX_ENVSUBST_TEMPLATE_DIR=/etc/nginx/media/templates \
    NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/conf.d \
    NET_GATEWAY=172.29.90.1

COPY nginx/nginx.conf nginx/media.conf /etc/nginx/media/
COPY nginx/templates/*.template /etc/nginx/media/templates/
COPY njs/media.js njs/check-apps.js /etc/nginx/njs/
# root:root, a fájlok 0644, a könyvtárak 0755 (a munkapéldány umaskjától függetlenül): az nginx-felhasználó olvassa.
RUN chmod -R u=rwX,go=rX /etc/nginx/media /etc/nginx/njs

CMD ["nginx", "-c", "/etc/nginx/media/nginx.conf", "-g", "daemon off;"]

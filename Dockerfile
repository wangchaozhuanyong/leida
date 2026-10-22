# WeChat CloudRun ingress only; website and workers run on the Lighthouse server.
FROM node:24-alpine
WORKDIR /app
COPY --chown=0:0 --chmod=0444 scripts/cloudrun-gateway.mjs scripts/cloudrun-network-init.mjs ./
# The bootstrap sets two namespace-local sysctls, then drops UID/GID before listening.
USER 0:0
EXPOSE 8080
CMD ["node", "cloudrun-gateway.mjs", "http://10.0.0.8:8080"]

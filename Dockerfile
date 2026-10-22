# WeChat CloudRun ingress only; website and workers run on the Lighthouse server.
FROM node:24-alpine
WORKDIR /app
COPY --chown=0:0 --chmod=0444 scripts/signed-tls-proxy.mjs scripts/cloudrun-tls-start.mjs scripts/gateway-server-public.pem ./
USER node
EXPOSE 8080
CMD ["node", "cloudrun-tls-start.mjs"]

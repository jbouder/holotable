# The image the demo container runs. Cloudflare Containers pull from the
# Cloudflare Registry, Docker Hub, ECR or Artifact Registry, not GHCR, so
# `wrangler deploy` builds this one-line Dockerfile and pushes the result to the
# Cloudflare Registry. The deploy workflow pins QUICKSTART_IMAGE to the commit
# it is deploying (`sha-<short>-quickstart`); the default follows main.
ARG QUICKSTART_IMAGE=ghcr.io/jbouder/holotable:quickstart
FROM ${QUICKSTART_IMAGE}

/**
 * The one pinned Node base image. The root Dockerfile's `base` stage is the
 * single source (Dependabot bumps the digest there); every other Dockerfile
 * stage, compose service and test fixture uses the same reference, and
 * `pnpm docker:check-copy` fails on drift.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../..");
const NODE_BASE_IMAGE_PATTERN = /^FROM (node:26-trixie-slim@sha256:[a-f0-9]{64}) AS base$/m;

export function readNodeBaseImage(root = ROOT) {
  const match = NODE_BASE_IMAGE_PATTERN.exec(readFileSync(join(root, "Dockerfile"), "utf8"));
  if (!match?.[1])
    throw new Error(
      "Dockerfile must start its base stage FROM node:26-trixie-slim@sha256:<digest> AS base",
    );
  return match[1];
}

export const NODE_BASE_IMAGE = readNodeBaseImage();

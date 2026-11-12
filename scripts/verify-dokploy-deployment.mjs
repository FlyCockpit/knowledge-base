#!/usr/bin/env node
// Read-only verification on the single VPS. Never request env or container logs.
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const serviceFormat =
  '{"id":{{json .ID}},"version":{{json .Version.Index}},"image":{{json .Spec.TaskTemplate.ContainerSpec.Image}},"generation":{{json .Spec.TaskTemplate.ForceUpdate}},"mode":{{json .Spec.Mode}},"update":{{json .UpdateStatus}}}';
const taskFormat =
  '{"id":{{json .ID}},"node":{{json .NodeID}},"image":{{json .Spec.ContainerSpec.Image}},"generation":{{json .Spec.ForceUpdate}},"slot":{{json .Slot}},"desired":{{json .DesiredState}},"status":{{json .Status.State}},"container":{{json .Status.ContainerStatus}}}';
const containerFormat =
  '{"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}';

export function parseOptions(args) {
  const options = {};
  const allowed = new Set(["server", "worker", "url", "timeout-seconds"]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].replace(/^--/, "");
    if (
      !args[index].startsWith("--") ||
      !allowed.has(key) ||
      options[key] ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    )
      throw new Error(
        "Use --server <service> --worker <service> --url <https-origin> [--timeout-seconds 10800].",
      );
    options[key] = args[index + 1];
  }
  if (!options.server || !options.worker || !options.url)
    throw new Error("--server, --worker and --url are required.");
  for (const key of ["server", "worker"]) {
    if (options[key] && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options[key]))
      throw new Error(`Invalid ${key} service name.`);
  }
  const names = [options.server, options.worker].filter(Boolean);
  if (new Set(names).size !== names.length)
    throw new Error("Each role must name a different service.");
  const url = new URL(options.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("--url must be an HTTPS origin without credentials, query, or path.");
  const timeout = Number(options["timeout-seconds"] || 10800);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 21600)
    throw new Error("Timeout must be between 1 and 21600 seconds.");
  return { ...options, url: url.origin, timeout };
}

export function evaluateService(role, service, tasks) {
  if (!service.mode?.Replicated || service.mode.Replicated.Replicas < 1)
    throw new Error(`${role}: expected an enabled Replicated service.`);
  if (service.mode.Replicated.Replicas !== 1)
    throw new Error(`${role}: expected exactly one replica.`);
  if (/paused|rollback/.test(service.update?.State || ""))
    throw new Error(`${role}: rollout paused or rolled back; inspect Dokploy.`);
  const current = tasks.filter(
    (task) => task.image === service.image && (task.generation || 0) === (service.generation || 0),
  );
  // Historical completions and healthy old containers cannot satisfy this run.
  const selected = new Map();
  for (const task of current) {
    if (task.status === "failed" || task.status === "rejected")
      throw new Error(`${role}: a task from the selected deployment failed.`);
    if (task.status === "running" && task.desired === "running") selected.set(task.slot, task);
  }
  if (selected.size !== service.mode.Replicated.Replicas) return null;
  const accepted = [...selected.values()];
  // Rescheduling can leave an old running task with the same image/generation.
  if (tasks.some((task) => task.status === "running" && !accepted.includes(task))) return null;
  return accepted;
}

const compressionEncodings = new Set(["gzip", "br", "deflate", "zstd"]);

export function evaluateCompression(contentEncoding) {
  // `identity` means "no transformation", and rare multi-encodings list tokens
  // comma-separated; any compressing token counts as compressed.
  return (contentEncoding || "")
    .split(",")
    .some((token) => compressionEncodings.has(token.trim().toLowerCase()));
}

async function reportCompression(options, { fetchPage, log, deadline }) {
  // The Node server ships no compression middleware by design — that is the
  // proxy's job — and Traefik (Dokploy's default) has compression off. `/` is
  // the probe because it redirects to the SSR'd locale home, a full HTML
  // document safely above the ~1 KB threshold below which proxies legitimately
  // skip compressing. Managed platforms compress at an edge this script cannot
  // see, so a miss is a warning, never a verification failure.
  let response;
  try {
    response = await fetchPage(`${options.url}/`, {
      redirect: "follow",
      headers: { "accept-encoding": "gzip, br" },
      signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]),
    });
  } catch {
    log(
      "WARNING (non-fatal): response compression could not be verified because the request to the public site root failed after readiness passed. If this is a Dokploy deployment, confirm the Traefik compress middleware is attached to the server router",
    );
    return;
  }
  const encoding = response.headers.get("content-encoding") || "";
  let bytes = null;
  try {
    bytes = (await response.arrayBuffer()).byteLength;
  } catch {
    /* Body size unavailable; judge by the header alone. */
  }
  if (evaluateCompression(encoding)) {
    log(
      `Response compression verified: the public site root was served with content-encoding: ${encoding}.`,
    );
    return;
  }
  log(
    bytes !== null && bytes < 1024
      ? `WARNING (non-fatal): response compression could not be confirmed: the public site root response was only ${bytes} bytes, and proxies skip compressing bodies under ~1 KB. Re-check a full page manually, or enable the Traefik compress middleware`
      : `WARNING (non-fatal): the public site root responded uncompressed (${bytes === null ? "unknown size" : `${bytes} bytes`}, no content-encoding) — on Dokploy, Traefik's compress middleware is off by default, so every SSR page and JSON response ships uncompressed until you attach a compress middleware to the server router (the traefik.http.middlewares.<name>.compress and traefik.http.routers.<name>.middlewares labels). Platforms whose edge compresses for you can ignore this warning.`,
  );
}

async function docker(args, signal) {
  try {
    return (
      await execute("docker", args, { signal, timeout: 10_000, maxBuffer: 1024 * 1024 })
    ).stdout.trim();
  } catch {
    throw new Error(
      "Docker inspection failed. Run this on the single VPS with Docker access; no configuration was changed.",
    );
  }
}

export async function verifyDeployment(
  options,
  {
    inspect = docker,
    fetchReady = fetch,
    fetchPage = fetch,
    sleep = delay,
    signal = new AbortController().signal,
    log = console.log,
  } = {},
) {
  if (!options.worker) throw new Error("Dedicated worker service is required.");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(options.timeout * 1000)]);
  const services = ["server", "worker"].filter((role) => options[role]);
  const snapshots = new Map();
  for (const role of services) {
    snapshots.set(
      role,
      JSON.parse(
        await inspect(["service", "inspect", options[role], "--format", serviceFormat], deadline),
      ),
    );
  }
  log(
    "Checking the currently selected deployment. Run this after Dokploy finishes building each selected Application.",
  );
  while (!deadline.aborted) {
    let ready = true;
    let runtimeNode;
    for (const role of services) {
      const service = JSON.parse(
        await inspect(["service", "inspect", options[role], "--format", serviceFormat], deadline),
      );
      const previous = snapshots.get(role);
      if (
        service.id !== previous.id ||
        service.image !== previous.image ||
        service.generation !== previous.generation ||
        JSON.stringify(service.mode) !== JSON.stringify(previous.mode)
      )
        throw new Error(
          `${role}: deployment changed during verification; rerun after the new build finishes.`,
        );
      const ids = (
        await inspect(["service", "ps", "--quiet", "--no-trunc", options[role]], deadline)
      )
        .split(/\s+/)
        .filter(Boolean);
      const tasks = [];
      for (const id of ids)
        tasks.push(
          JSON.parse(
            await inspect(["inspect", "--type", "task", id, "--format", taskFormat], deadline),
          ),
        );
      const selected = evaluateService(role, service, tasks);
      if (!selected) {
        ready = false;
        continue;
      }
      for (const task of selected) {
        if (!task.node || (runtimeNode && task.node !== runtimeNode))
          throw new Error("Server and worker must run on the same host.");
        runtimeNode = task.node;
        if (!task.container?.ContainerID) {
          ready = false;
          continue;
        }
        const container = JSON.parse(
          await inspect(
            [
              "inspect",
              "--type",
              "container",
              task.container.ContainerID,
              "--format",
              containerFormat,
            ],
            deadline,
          ),
        );
        if (container.health === "unhealthy")
          throw new Error(`${role}: selected container is unhealthy.`);
        if (container.health === null)
          throw new Error(`${role}: image has no healthcheck; startup cannot be verified.`);
        if (!container.running || container.health !== "healthy") ready = false;
      }
    }
    if (ready) {
      try {
        const response = await fetchReady(`${options.url}/ready`, {
          redirect: "error",
          signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]),
        });
        const body = await response.json();
        ready = response.status === 200 && body.ok === true;
      } catch {
        ready = false;
      }
    }
    if (ready && !deadline.aborted) {
      await reportCompression(options, { fetchPage, log, deadline });
      log(
        "Deployment verified: selected runtime containers are healthy, and the public readiness endpoint passed.",
      );
      return;
    }
    try {
      await sleep(5000, undefined, { signal: deadline });
    } catch {
      /* Timeout or shutdown. */
    }
  }
  throw new Error(
    "Deployment verification timed out or was cancelled. Check the selected task and readiness failure in Dokploy; no rollback or database change was performed.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(name, () => controller.abort());
  try {
    await verifyDeployment(parseOptions(process.argv.slice(2)), { signal: controller.signal });
  } catch (error) {
    // Never echo command output, Docker config, response bodies, or URL errors.
    console.error(
      error instanceof TypeError || error instanceof SyntaxError
        ? "Invalid configuration or unexpected inspection response; deployment was not verified."
        : error.message,
    );
    process.exitCode = 1;
  }
}

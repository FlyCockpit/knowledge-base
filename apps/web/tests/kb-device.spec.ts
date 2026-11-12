import { spawn } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomUUID,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { KbBrowserFixtureData } from "../../../packages/test-utils/src/kb/browser";

const raw = process.env.KB_BROWSER_FIXTURE;
if (!raw) throw new Error("Run through pnpm test:kb -- browser");
const fx = JSON.parse(raw) as KbBrowserFixtureData;

test.beforeEach(async ({ page }) => {
  await page.context().addCookies([
    { ...fx.cookie, url: fx.origin, httpOnly: true },
    { ...fx.mcp.cookie, url: fx.origin, httpOnly: true },
  ]);
});
async function start(page: Page) {
  const response = await page.request.post(`${fx.origin}/api/auth/device/code`, {
    headers: { Origin: fx.origin },
    data: { client_id: "kb-cli", scope: "mcp:read mcp:write" },
  });
  expect(response.status()).toBe(200);
  return response.json() as Promise<{
    user_code: string;
    device_code: string;
    verification_uri_complete: string;
  }>;
}
async function review(page: Page, userCode: string) {
  await page.goto(`${fx.origin}/en-US/device?user_code=${userCode}`);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
}
async function state(page: Page, userCode: string) {
  const response = await page.request.get(`${fx.origin}/fixture/device/state?userCode=${userCode}`);
  return response.json() as Promise<{
    intent: {
      decision: string;
      consumedAt: string | null;
      selection: { recipients: unknown[] };
    } | null;
  }>;
}

test("R34b F3 numeric and mixed links claim the exact code; invalid and expired codes stay visible", async ({
  page,
}) => {
  const numeric = await start(page);
  expect(
    (
      await page.request.post(`${fx.origin}/fixture/device/numeric`, {
        data: { userCode: numeric.user_code },
      })
    ).ok(),
  ).toBe(true);
  const claims: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/device")
      claims.push(new URL(request.url()).searchParams.get("user_code")!);
  });
  await review(page, "23456789");
  expect(claims).toContain("23456789");
  expect((await state(page, "23456789")).intent?.decision).toBe("pending");
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Deny", exact: true }).press("Enter");
  await expect(page.getByText("Device denied", { exact: true })).toBeVisible();
  const mixed = await start(page);
  await review(page, mixed.user_code);
  expect(claims).toContain(mixed.user_code);
  await page.goto(`${fx.origin}/en-US/device?user_code=bad!`);
  await expect(page.getByText(/Enter the 8-character code exactly/)).toBeVisible();
  await page.request.post(`${fx.origin}/fixture/device/expire`, {
    data: { userCode: mixed.user_code },
  });
  await page.goto(`${fx.origin}/en-US/device?user_code=${mixed.user_code}`);
  await expect(page.getByText("This code can't be used", { exact: true })).toBeVisible();
});

test("R34b F1 committed approval with a lost reply and minted PAT shows uncertainty immediately and on re-entry", async ({
  page,
}) => {
  const code = await start(page);
  await review(page, code.user_code);
  let secret = "";
  await page.route("**/api/auth/device/approve", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const exchanged = await page.request.post(
      `${fx.origin}/rpc/cliCredentials/exchangeDeviceCode`,
      {
        headers: { "x-csrf-token": "orpc" },
        data: { json: { deviceCode: code.device_code, name: "Reply lost device" } },
      },
    );
    expect(exchanged.status()).toBe(200);
    secret = (await exchanged.json()).json.secret;
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/Your decision may have been saved/)).toBeVisible();
  await expect(page.getByText(/Nothing was approved/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Review access tokens" })).toBeVisible();
  expect((await state(page, code.user_code)).intent?.consumedAt).toBeTruthy();
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
    secret,
  );
  await page.reload();
  await expect(
    page.getByText(/An earlier approval may still have created an active access token/),
  ).toBeVisible();
  await expect(page.getByText(/Nothing was approved/)).toHaveCount(0);
  await page.getByRole("link", { name: "Review access tokens" }).click();
  const row = page
    .locator("li")
    .filter({ has: page.getByText("Reply lost device", { exact: true }) });
  await row.getByRole("button", { name: "Revoke Reply lost device", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByPlaceholder("Reply lost device").fill("Reply lost device");
  await dialog.getByRole("button", { name: "Revoke", exact: true }).press("Enter");
  await expect
    .poll(async () => {
      const response = await page.request.get(`${fx.origin}/fixture/mcp/state`);
      const result = (await response.json()) as {
        tokens: { name: string; revokedAt: string | null }[];
      };
      return result.tokens.find((token) => token.name === "Reply lost device")?.revokedAt;
    })
    .toBeTruthy();
  await expect(
    row.getByRole("button", { name: "Revoke Reply lost device", exact: true }),
  ).toHaveCount(0);
});

test("R34b F2 actual CLI registers its private-file key, browser selects exact unchecked records, PAT decrypts only that recipient", async ({
  page,
}) => {
  const browserLogs: string[] = [];
  page.on("console", (message) => browserLogs.push(message.text()));
  page.on("pageerror", (error) => browserLogs.push(error.message));
  const directory = mkdtempSync(join(tmpdir(), "kb-device-browser-cli-"));
  const keyPair = generateKeyPairSync("x25519");
  const id = randomUUID();
  const privateBytes = keyPair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const keyFile = join(directory, "recipient.json");
  writeFileSync(keyFile, JSON.stringify({ id, private_key: [...privateBytes] }), { mode: 0o600 });
  const cli = spawn(
    process.env.CARGO_TARGET_DIR
      ? join(process.env.CARGO_TARGET_DIR, "debug/kb")
      : resolve(import.meta.dirname, "../../cli/target/debug/kb"),
    [
      "login",
      "--server",
      fx.origin,
      "--allow-loopback-http",
      "--recipient-key-file",
      keyFile,
      "--name",
      "Browser recipient CLI",
    ],
    {
      env: {
        ...process.env,
        KB_CONFIG_DIR: join(directory, "config"),
        KB_DATA_DIR: join(directory, "data"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  cli.stdout.on("data", (bytes) => {
    stdout += bytes;
  });
  cli.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const exited = new Promise<number | null>((done, fail) => {
    cli.on("exit", done);
    cli.on("error", fail);
  });
  try {
    await expect.poll(() => /open (\S+) and enter code ([A-Z0-9]+)/.exec(stderr)?.[1]).toBeTruthy();
    const match = /open (\S+) and enter code ([A-Z0-9]+)/.exec(stderr)!;
    const fixtureResponse = await page.request.get(`${fx.origin}/fixture/device/sealed`);
    const sealed = (await fixtureResponse.json()) as {
      kbId: string;
      name: string;
      reference: string;
    };
    const requests: { path: string; body: string | null; nonce: string | undefined }[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        [
          "/api/auth/device",
          "/rpc/cliCredentials/selectDeviceIntent",
          "/api/auth/device/approve",
        ].includes(path)
      )
        requests.push({
          path,
          body: request.postData(),
          nonce: request.headers()["x-device-approval-nonce"],
        });
    });
    await page.goto(match[1]!);
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Add sealed record", exact: true }),
    ).toBeDisabled();
    const recipient = page.getByRole("group", { name: "Sealed values (optional)" });
    await expect(recipient).toContainText(id);
    const kb = page.getByRole("group", { name: sealed.name, exact: true });
    await kb.getByRole("checkbox", { name: `${sealed.name}: Read`, exact: true }).press("Space");
    await page.getByLabel("Exact sealed reference", { exact: true }).fill(sealed.reference);
    const local = await page.evaluate(() => {
      const expiry = new Date(Date.now() + 3600000);
      return new Date(expiry.getTime() - expiry.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
    });
    await page.getByLabel("Sealed access expires at", { exact: true }).fill(local);
    await recipient
      .getByRole("checkbox", { name: "Approve this exact record for this recipient key" })
      .press("Space");
    await page.getByLabel("Exact sealed reference", { exact: true }).fill("*");
    await page.getByRole("button", { name: "Add sealed record", exact: true }).press("Enter");
    await expect(page.getByRole("alert")).toContainText("Paste the exact reference");
    expect(requests.map((r) => r.path)).toEqual(["/api/auth/device"]);
    await page.getByLabel("Exact sealed reference", { exact: true }).fill(sealed.reference);
    await page.getByRole("button", { name: "Add sealed record", exact: true }).press("Enter");
    await expect(
      page.getByRole("button", { name: "Remove sealed record", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("Device approved", { exact: true })).toBeVisible();
    expect(await exited).toBe(0);
    expect(requests.map((r) => r.path)).toEqual([
      "/api/auth/device",
      "/rpc/cliCredentials/selectDeviceIntent",
      "/api/auth/device/approve",
    ]);
    const selected = JSON.parse(requests[1]!.body!).json;
    expect(requests[2]!.nonce).toBe(selected.nonce);
    expect(selected.selection.recipients).toEqual([
      expect.objectContaining({
        kbId: sealed.kbId,
        recipientKeyId: id,
        recipientPublicKey: keyPair.publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64"),
      }),
    ]);
    const resource = `${fx.origin}/mcp`;
    const credentialFile = join(
      directory,
      "data/credentials",
      `${createHash("sha256").update(resource).digest("hex")}.json`,
    );
    const secret = (JSON.parse(readFileSync(credentialFile, "utf8")) as { secret: string }).secret;
    expect(stdout + stderr).not.toContain(secret);
    expect(browserLogs.join("\n")).not.toContain(secret);
    expect(JSON.stringify(requests)).not.toContain(privateBytes.toString("base64"));
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
      secret,
    );
    const response = await page.request.post(`${fx.origin}/fixture/device/resolve`, {
      data: { secret, recipientKeyId: id },
    });
    expect(response.ok()).toBe(true);
    const envelope = await response.json();
    const shared = diffieHellman({
      privateKey: keyPair.privateKey,
      publicKey: createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b656e032100", "hex"),
          Buffer.from(envelope.envelope.ephemeralPublicKey, "base64"),
        ]),
        format: "der",
        type: "spki",
      }),
    });
    const key = Buffer.from(
      hkdfSync(
        "sha256",
        shared,
        createHash("sha256").update(sealed.reference).digest(),
        Buffer.from(`kb/sealed/1\0${id}\0${envelope.expiresAt}`),
        32,
      ),
    );
    try {
      const cipher = Buffer.from(envelope.envelope.ciphertext, "base64");
      const decrypt = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(envelope.envelope.nonce, "base64"),
      );
      decrypt.setAAD(Buffer.from(`${sealed.reference}\0${id}\0${envelope.expiresAt}`));
      decrypt.setAuthTag(cipher.subarray(-16));
      const plaintext = Buffer.concat([decrypt.update(cipher.subarray(0, -16)), decrypt.final()]);
      expect(plaintext.toString()).toBe("browser-device-sealed-canary");
      plaintext.fill(0);
    } finally {
      shared.fill(0);
      key.fill(0);
    }
  } finally {
    if (cli.exitCode === null) cli.kill("SIGKILL");
    await exited;
    privateBytes.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const delivery of ["success", "failure"] as const) {
  test(`R34b replacement owns selection and pending controls after an older ${delivery}`, async ({
    page,
  }) => {
    const a = await start(page);
    const b = await start(page);
    const keyPair = generateKeyPairSync("x25519");
    const recipientKey = {
      recipientKeyId: randomUUID(),
      recipientPublicKey: keyPair.publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64"),
    };
    for (const code of [a, b]) {
      const response = await page.request.post(
        `${fx.origin}/rpc/cliCredentials/registerDeviceRecipient`,
        {
          headers: { "x-csrf-token": "orpc" },
          data: { json: { deviceCode: code.device_code, recipientKey } },
        },
      );
      expect(response.status()).toBe(200);
    }
    const sealedResponse = await page.request.get(`${fx.origin}/fixture/device/sealed`);
    const sealed = (await sealedResponse.json()) as { name: string; reference: string };
    await review(page, a.user_code);
    await page
      .getByRole("group", { name: sealed.name, exact: true })
      .getByRole("checkbox", { name: `${sealed.name}: Read`, exact: true })
      .press("Space");
    await page.getByLabel("Exact sealed reference", { exact: true }).fill(sealed.reference);
    const expiry = await page.evaluate(() => {
      const value = new Date(Date.now() + 3600000);
      return new Date(value.getTime() - value.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
    });
    await page.getByLabel("Sealed access expires at", { exact: true }).fill(expiry);
    await page
      .getByRole("checkbox", { name: "Approve this exact record for this recipient key" })
      .press("Space");
    await page.getByRole("button", { name: "Add sealed record", exact: true }).press("Enter");
    await expect(
      page.getByRole("button", { name: "Remove sealed record", exact: true }),
    ).toBeVisible();
    let reached = () => {};
    let release = () => {};
    const ready = new Promise<void>((done) => {
      reached = done;
    });
    const held = new Promise<void>((done) => {
      release = done;
    });
    await page.route("**/rpc/cliCredentials/selectDeviceIntent", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      reached();
      await held;
      if (delivery === "success") await route.fulfill({ response });
      else await route.abort("failed");
    });
    try {
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await ready;
      await expect(page.getByRole("button", { name: "Approving…", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeDisabled();
      await expect(page.getByLabel("Exact sealed reference", { exact: true })).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Remove sealed record", exact: true }),
      ).toBeDisabled();
      await page.evaluate(async (code) => {
        const router = (
          window as unknown as {
            __mcpRouter: { history: { push(url: string): void }; load(): Promise<void> };
          }
        ).__mcpRouter;
        router.history.push(`/en-US/device?user_code=${code}`);
        await router.load();
      }, b.user_code);
      await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
      await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Remove sealed record", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Add sealed record", exact: true }),
      ).toBeDisabled();
      if (delivery === "success") {
        const finished = page.waitForResponse("**/api/auth/device/approve");
        release();
        await (await finished).finished();
      } else {
        const finished = page.waitForEvent("requestfailed", {
          predicate: (request) => request.url().endsWith("/rpc/cliCredentials/selectDeviceIntent"),
        });
        release();
        await finished;
      }
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      await expect
        .poll(async () => (await state(page, a.user_code)).intent?.decision)
        .toBe(delivery === "success" ? "approved" : "pending");
      expect((await state(page, b.user_code)).intent?.selection).toBeNull();
      await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "Remove sealed record", exact: true }),
      ).toHaveCount(0);
    } finally {
      release();
    }
  });
}

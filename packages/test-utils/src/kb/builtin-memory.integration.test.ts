import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { dockerFixtureLabels, drainDockerFixtures, withDockerContainer } from "./docker.js";
import { NODE_BASE_IMAGE } from "./node-image.mjs";

afterEach(drainDockerFixtures, 300_000);

it.each([512, 1024, 1280, 1536, 2048, 4096])(
  "46r10 detects a real %i MiB cgroup and recommends only fitting registry options",
  { timeout: 60_000 },
  async (mib) => {
    const bytes = mib * 1024 ** 2;
    const source = `import { detectMemoryBudget } from './apps/worker/src/lib/memory-budget.ts';
    import { builtinRecommendations } from './packages/api/src/lib/kb/builtin-registry.ts';
    import { createQwenSupervisor } from './apps/worker/src/lib/qwen-lifecycle.ts';
    import { probeQwenRuntime } from './apps/worker/src/lib/qwen-probe.ts';
    const budget = detectMemoryBudget();
    let spawns=0, releases=0, rejected=0;
    if (${mib} <= 1024) {
      const runtime={modelId:'qwen3-embedding-0.6b-q8_0',epoch:1,config:{contextTokens:1024,kvKeyType:'f16',kvValueType:'f16'}};
      const supervisor=createQwenSupervisor({childEntry:'/unused',modelPath:'/unused',
        lease:{acquire:async()=>true,renew:async()=>true,release:async()=>{releases++;}},
        spawn:()=>{spawns++;throw new Error('unsafe spawn');}});
      for (const op of ['embed','countTokens','probe']) {
        try { await (op==='probe' ? supervisor.probe(runtime) : supervisor[op]({purpose:'query',texts:['test'],runtime})); }
        catch { rejected++; }
      }
      await supervisor.close();
      try { await probeQwenRuntime({modelId:runtime.modelId,childEntry:'/unused',modelPath:'/unused',config:runtime.config,spawn:()=>{spawns++;throw new Error('unsafe spawn');}}); }
      catch { rejected++; }
    }
    console.log(JSON.stringify({budget,rows:builtinRecommendations(budget?.budgetBytes ?? null),spawns,releases,rejected}));`;
    const name = `kb-memory-${randomUUID()}`;
    const out = await withDockerContainer(name, () =>
      execFileSync(
        "docker",
        [
          "run",
          "--name",
          name,
          ...dockerFixtureLabels(),
          "--rm",
          "--network=none",
          `--memory=${bytes}`,
          `--memory-swap=${bytes}`,
          "--mount",
          `type=bind,src=${resolve(".")},dst=/workspace,readonly`,
          "--workdir=/workspace",
          NODE_BASE_IMAGE,
          "node",
          "--import=tsx",
          "--input-type=module",
          "-e",
          source,
        ],
        { encoding: "utf8", timeout: 50_000 },
      ),
    );
    const result = JSON.parse(out);
    expect(result.budget).toMatchObject({ budgetBytes: bytes, source: "cgroup-v2" });
    expect(result.rows).toHaveLength(8);
    if (mib <= 1024) {
      expect(result.spawns).toBe(0);
      expect(result.rejected).toBe(4);
      expect(result.releases).toBe(3);
    }
    const recommended = result.rows.filter((r: { recommended: boolean }) => r.recommended);
    expect(recommended).toHaveLength(mib < 1280 ? 0 : 1);
    if (recommended.length)
      expect(recommended[0]).toMatchObject({
        modelId: "embeddinggemma-2-q8_0",
        contextTokens: 1024,
      });
    for (const row of result.rows) {
      expect(row.percent).toBeCloseTo((row.bytes / bytes) * 100, 6);
      expect(row.level === "block").toBe(row.bytes / bytes >= 0.9);
      if (row.recommended || row.smaller) expect(row.bytes / bytes).toBeLessThan(0.9);
    }
  },
);

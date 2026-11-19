import assert from "node:assert/strict";
import { before, test } from "node:test";
import { DEPENDABOT, createServer } from "./lib/server.mjs";
import { ensureFetchMetadata, runWorkflow } from "./lib/runner.mjs";

const DEP = "a".repeat(40);
const ATTACK = "b".repeat(40);
const UNSIGNED = "c".repeat(40);
const PR = "https://github.com/acme/widgets/pull/7";

function message({ from = "1.2.3", to = "1.2.4", updateType = "version-update:semver-patch", bump = true, type = true } = {}) {
  const bumpLine = bump ? `Bumps lodash from ${from} to ${to}.\n` : "";
  const typeLine = type ? `  update-type: ${updateType}\n` : "";
  return `${bumpLine}---\nupdated-dependencies:\n- dependency-name: lodash\n  dependency-type: direct:production\n${typeLine}...\n`;
}

function botCommit({ sha = DEP, files, ...messageOpts } = {}) {
  return {
    sha,
    author: DEPENDABOT,
    message: message(messageOpts),
    verified: true,
    files: files ?? { "package.json": `{"lodash":"${messageOpts.to ?? "1.2.4"}"}\n` },
    write: true,
  };
}

function attackerCommit(sha = ATTACK) {
  return {
    sha,
    author: "mallory",
    message: "add an unreviewed workflow backdoor",
    verified: false,
    files: { "pwned.txt": "not-from-dependabot\n" },
    write: true,
  };
}

function detail(server, result) {
  return JSON.stringify({
    skipped: result && result.skipped,
    steps: result && result.steps.map((step) => ({
      name: step.name,
      id: step.id,
      status: step.status,
      outputs: step.outputs,
      stderr: step.stderr,
      stdout: step.stdout && step.stdout.slice(0, 500),
    })),
    trace: server.trace(),
  }, null, 2);
}

function untrustedApprovals(server) {
  return server.state.reviews.filter((review) => {
    if (review.state !== "APPROVE") return false;
    const commit = server.commitBySha(review.commitSha);
    return !commit || commit.author !== DEPENDABOT || commit.verified !== true;
  });
}

function untrustedMerged(server) {
  return server.mergedCommits().filter((commit) => commit.author !== DEPENDABOT || commit.verified !== true);
}

function assertDidNotTakeUntrusted(server, result) {
  const info = detail(server, result);
  assert.deepEqual(untrustedMerged(server).map((commit) => commit.sha), [], info);
  assert.deepEqual(untrustedApprovals(server).map((review) => review.commitSha), [], info);
  assert.equal(server.baseHas("pwned.txt"), false, info);
}

before(() => {
  ensureFetchMetadata("v2.2.0");
});

async function withServer(run) {
  const server = createServer();
  const url = await server.listen();
  try {
    await run(server, url);
  } finally {
    await server.close();
  }
}

test("fetch-metadata v2.2.0 reports a patch update when a later commit is not dependabot's", async () => {
  await withServer(async (server, url) => {
    server.reset([botCommit(), attackerCommit()]);
    const result = await runWorkflow(server, url, { actor: DEPENDABOT, prUrl: PR });
    const metadata = result.steps.find((step) => step.id === "dependabot-metadata");
    assert.equal(metadata && metadata.status, "success", detail(server, result));
    assert.equal(metadata.outputs["update-type"], "version-update:semver-patch", detail(server, result));
    assert.equal(server.state.commits.filter((commit) => commit.author !== DEPENDABOT).length, 1);
  });
});

test("extra commits already on the Dependabot branch are not approved or merged", async () => {
  await withServer(async (server, url) => {
    server.reset([botCommit(), attackerCommit()]);
    const result = await runWorkflow(server, url, { actor: DEPENDABOT, prUrl: PR });
    server.finishChecks();
    assertDidNotTakeUntrusted(server, result);
  });
});

test("a commit pushed after metadata lists commits is not approved or merged", async () => {
  await withServer(async (server, url) => {
    server.reset([botCommit()], { poisonAfterList: true, poisonCommit: attackerCommit() });
    const result = await runWorkflow(server, url, { actor: DEPENDABOT, prUrl: PR });
    server.finishChecks();
    assertDidNotTakeUntrusted(server, result);
  });
});

test("a write push after the clean check and before merge is not included", async () => {
  await withServer(async (server, url) => {
    server.reset([botCommit()]);
    const result = await runWorkflow(server, url, {
      actor: DEPENDABOT,
      prUrl: PR,
      pushBeforeMerge: attackerCommit(),
    });
    server.finishChecks();
    assertDidNotTakeUntrusted(server, result);
  });
});

test("a write push after auto-merge is armed is not squash-merged when checks pass", async () => {
  await withServer(async (server, url) => {
    server.reset([botCommit()]);
    const first = await runWorkflow(server, url, { actor: DEPENDABOT, prUrl: PR });
    assert.ok(server.state.autoMerge, detail(server, first));
    const pushed = server.pushCommit(attackerCommit());
    assert.equal(pushed.ok, true);
    const second = await runWorkflow(server, url, { actor: "mallory", prUrl: PR });
    server.finishChecks();
    assertDidNotTakeUntrusted(server, { steps: [...first.steps, ...second.steps], skipped: second.skipped });
  });
});

test("an empty update type is not auto-merged", async () => {
  await withServer(async (server, url) => {
    server.reset([
      botCommit({
        bump: false,
        type: false,
        files: { "empty.json": "{}\n" },
      }),
    ]);
    const result = await runWorkflow(server, url, { actor: DEPENDABOT, prUrl: PR });
    server.finishChecks();
    const info = detail(server, result);
    assert.equal(server.state.merged, false, info);
    assert.equal(server.baseHas("empty.json"), false, info);
  });
});

test("a clean verified patch update is squash-merged after checks pass", async () => {
  await withServer(async (server, url) => {
    server.reset([botCommit()]);
    const result = await runWorkflow(server, url, { actor: DEPENDABOT, prUrl: PR });
    server.finishChecks();
    const info = detail(server, result);
    assert.equal(server.state.merged, true, info);
    assert.equal(server.baseHas("package.json"), true, info);
    assert.deepEqual(untrustedMerged(server), [], info);
    assert.equal(server.baseHas("pwned.txt"), false, info);
  });
});

test("a minor update is not auto-merged", async () => {
  await withServer(async (server, url) => {
    server.reset([
      botCommit({
        from: "1.2.3",
        to: "1.3.0",
        updateType: "version-update:semver-minor",
        files: { "package.json": '{"lodash":"1.3.0"}\n' },
      }),
    ]);
    const result = await runWorkflow(server, url, { actor: DEPENDABOT, prUrl: PR });
    server.finishChecks();
    const info = detail(server, result);
    assert.equal(server.state.merged, false, info);
    assert.equal(server.baseHas("package.json"), false, info);
  });
});

test("a major update is not auto-merged", async () => {
  await withServer(async (server, url) => {
    server.reset([
      botCommit({
        from: "1.2.3",
        to: "2.0.0",
        updateType: "version-update:semver-major",
        files: { "package.json": '{"lodash":"2.0.0"}\n' },
      }),
    ]);
    const result = await runWorkflow(server, url, { actor: DEPENDABOT, prUrl: PR });
    server.finishChecks();
    assert.equal(server.state.merged, false, detail(server, result));
  });
});

test("an unverified Dependabot commit is not merged", async () => {
  await withServer(async (server, url) => {
    const commit = botCommit();
    commit.verified = false;
    commit.sha = UNSIGNED;
    server.reset([commit]);
    const result = await runWorkflow(server, url, { actor: DEPENDABOT, prUrl: PR });
    server.finishChecks();
    const info = detail(server, result);
    assert.equal(server.state.merged, false, info);
    assert.equal(server.state.reviews.length, 0, info);
  });
});

test("a later unverified commit by dependabot is not approved or merged", async () => {
  await withServer(async (server, url) => {
    const second = botCommit({
      sha: UNSIGNED,
      files: { "unsigned.txt": "unverified\n" },
    });
    second.verified = false;
    server.reset([botCommit(), second]);
    const result = await runWorkflow(server, url, { actor: DEPENDABOT, prUrl: PR });
    server.finishChecks();
    const info = detail(server, result);
    assert.equal(server.baseHas("unsigned.txt"), false, info);
    assert.deepEqual(untrustedMerged(server).map((commit) => commit.sha), [], info);
    assert.deepEqual(untrustedApprovals(server).map((review) => review.commitSha), [], info);
  });
});

test("a run whose actor is not Dependabot does not approve or merge", async () => {
  await withServer(async (server, url) => {
    server.reset([botCommit()]);
    const result = await runWorkflow(server, url, { actor: "mallory", prUrl: PR });
    server.finishChecks();
    const info = detail(server, result);
    assert.equal(result.skipped, true, info);
    assert.equal(server.state.merged, false, info);
    assert.equal(server.state.reviews.length, 0, info);
    assert.equal(server.state.autoMerge, null, info);
  });
});

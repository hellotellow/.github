#!/usr/bin/env node
// Stand-in for gh 2.103.0 `pr review`, `pr merge`, `pr view`, and `api`.
//
// pr review --approve follows cli/cli pkg/cmd/pr/review/review.go reviewRun
// and api/queries_pr_review.go AddReview (v2.103.0): the mutation carries
// pullRequestId, event, and body. commitOID is omitted, so the review binds
// to the current head.
//
// pr merge follows pkg/cmd/pr/merge/merge.go merge() and http.go
// mergePullRequest. expectedHeadOid is sent only for --match-head-commit
// (http.go:77-80). The SHA from the pull-request lookup is not used in its
// place. --auto enables auto-merge when mergeable_state is not CLEAN,
// HAS_HOOKS, or UNSTABLE (merge.go isImmediatelyMergeable).

import { spawnSync } from "node:child_process";

const apiBase = process.env.MOCK_GITHUB_URL;
if (!apiBase) {
  process.stderr.write("MOCK_GITHUB_URL is not set\n");
  process.exit(1);
}

const argv = process.argv.slice(2);

await fetch(`${apiBase}/_test/argv`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ argv }),
});

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function flag(name) {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) return undefined;
  return argv[index + 1];
}

function parsePrSelector(args) {
  const valueFlags = new Set([
    "--match-head-commit",
    "--repo",
    "--body",
    "--subject",
    "--json",
    "--jq",
    "--method",
    "--input",
    "-f",
    "--raw-field",
    "--hostname",
  ]);
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (valueFlags.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    values.push(token);
  }
  return values;
}

function parsePull(selector) {
  const match = String(selector).match(/\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) fail(`cannot parse pull request selector ${selector}`);
  return { owner: match[1], repo: match[2], number: match[3] };
}

async function getPull(selector) {
  const { owner, repo, number } = parsePull(selector);
  const response = await fetch(`${apiBase}/repos/${owner}/${repo}/pulls/${number}`);
  if (!response.ok) fail(`lookup failed ${response.status} ${await response.text()}`);
  return response.json();
}

async function graphql(query, input) {
  const response = await fetch(`${apiBase}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { input } }),
  });
  const body = await response.json();
  if (body.errors && body.errors.length) fail(body.errors.map((error) => error.message).join("\n"));
  return body;
}

async function review(args) {
  if (!args.includes("--approve") && !args.includes("--request-changes") && !args.includes("--comment")) {
    fail("--approve, --request-changes, or --comment required when not running interactively");
  }
  const selector = parsePrSelector(args).at(-1);
  if (!selector) fail("pull request required");
  const pull = await getPull(selector);
  const event = args.includes("--request-changes") ? "REQUEST_CHANGES" : args.includes("--comment") ? "COMMENT" : "APPROVE";
  await graphql(
    "mutation PullRequestReviewAdd($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { clientMutationId } }",
    { pullRequestId: pull.node_id, event, body: flag("--body") || "" },
  );
}

function immediatelyMergeable(mergeableState) {
  return ["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(String(mergeableState || "").toUpperCase());
}

async function merge(args) {
  const selector = parsePrSelector(args).at(-1);
  if (!selector) fail("pull request required");
  const pull = await getPull(selector);
  const disable = args.includes("--disable-auto");
  const autoFlag = args.includes("--auto");
  if (disable && autoFlag) fail("specify only one of `--auto`, `--disable-auto`, or `--admin`");
  if (disable) {
    await graphql(
      "mutation PullRequestAutoMergeDisable($prID: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $prID}) { clientMutationId } }",
      { pullRequestId: pull.node_id },
    );
    return;
  }
  const methods = ["--squash", "--merge", "--rebase"].filter((name) => args.includes(name));
  if (methods.length > 1) fail("only one of --merge, --rebase, or --squash can be enabled");
  if (methods.length === 0) fail("--merge, --rebase, or --squash required when not running interactively");
  const method = methods[0] === "--squash" ? "SQUASH" : methods[0] === "--rebase" ? "REBASE" : "MERGE";
  const input = { pullRequestId: pull.node_id, mergeMethod: method };
  const match = flag("--match-head-commit");
  if (match) input.expectedHeadOid = match;
  const arm = autoFlag && !immediatelyMergeable(pull.mergeable_state);
  if (!autoFlag && !immediatelyMergeable(pull.mergeable_state)) {
    fail(`pull request is not mergeable: ${pull.mergeable_state}`);
  }
  if (arm) {
    await graphql(
      "mutation PullRequestAutoMerge($input: EnablePullRequestAutoMergeInput!) { enablePullRequestAutoMerge(input: $input) { clientMutationId } }",
      input,
    );
    return;
  }
  await graphql(
    "mutation PullRequestMerge($input: MergePullRequestInput!) { mergePullRequest(input: $input) { clientMutationId } }",
    input,
  );
}

async function view(args) {
  const selector = parsePrSelector(args).at(-1);
  if (!selector) fail("pull request required");
  const pull = await getPull(selector);
  const fields = (flag("--json") || "headRefOid").split(",");
  const data = {};
  for (const field of fields) {
    if (field === "headRefOid") data.headRefOid = pull.head.sha;
    else if (field === "number") data.number = pull.number;
    else if (field === "state") data.state = pull.state;
    else if (field === "mergeable") data.mergeable = pull.mergeable_state;
    else fail(`unsupported --json field ${field}`);
  }
  const jq = flag("--jq");
  const json = JSON.stringify(data);
  if (!jq) {
    process.stdout.write(`${json}\n`);
    return;
  }
  const child = spawnSync("jq", ["-r", jq], { input: json, encoding: "utf8" });
  if (child.status !== 0) fail(child.stderr || "jq failed");
  process.stdout.write(child.stdout);
}

async function api(args) {
  let method = "GET";
  let path = null;
  let input = null;
  const fields = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--method" || token === "-X") {
      method = args[++i];
      continue;
    }
    if (token === "--input") {
      const source = args[++i];
      const raw = source === "-"
        ? await new Promise((resolve) => {
          const chunks = [];
          process.stdin.on("data", (chunk) => chunks.push(chunk));
          process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        })
        : source;
      input = raw ? JSON.parse(raw) : {};
      continue;
    }
    if (token === "-f" || token === "--raw-field") {
      const pair = args[++i];
      const eq = pair.indexOf("=");
      fields[pair.slice(0, eq)] = pair.slice(eq + 1);
      continue;
    }
    if (token.startsWith("-")) fail(`unsupported gh api flag ${token}`);
    path = token;
  }
  if (path === "graphql") {
    const query = fields.query || (input && input.query);
    const variables = { ...fields };
    delete variables.query;
    const response = await fetch(`${apiBase}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query,
        variables: input && input.variables ? input.variables : { input: { ...variables, ...(input || {}) } },
      }),
    });
    const body = await response.json();
    process.stdout.write(`${JSON.stringify(body)}\n`);
    if (body.errors && body.errors.length) process.exit(1);
    return;
  }
  if (!path) fail("gh api path required");
  const response = await fetch(`${apiBase}/${path.replace(/^\//, "")}`, {
    method,
    headers: { "content-type": "application/json" },
    body: input && method !== "GET" ? JSON.stringify(input) : undefined,
  });
  const text = await response.text();
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  if (!response.ok) process.exit(1);
}

const [group, command, ...rest] = argv;
try {
  if (group === "pr" && command === "review") await review(rest);
  else if (group === "pr" && command === "merge") await merge(rest);
  else if (group === "pr" && command === "view") await view(rest);
  else if (group === "api") await api([command, ...rest].filter((part) => part !== undefined));
  else fail(`unsupported gh command: ${argv.join(" ")}`);
} catch (error) {
  fail(error && error.stack ? error.stack : String(error));
}

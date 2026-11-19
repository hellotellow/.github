// Local stand-in for the GitHub operations this workflow reaches.
//
// Built from:
// - dependabot/fetch-metadata v2.2.0 src/dependabot/verified_commits.ts:32-56
//   (one GET /repos/{owner}/{repo}/pulls/{n}/commits, then commits[0] only)
// - cli/cli v2.103.0 pkg/cmd/pr/review/review.go:148-181 and
//   api/queries_pr_review.go:249-273 (addPullRequestReview with pullRequestId,
//   event, and body; commitOID is not sent)
// - cli/cli v2.103.0 pkg/cmd/pr/merge/merge.go:281-296 and
//   pkg/cmd/pr/merge/http.go:47-103 (expectedHeadOid is set only from
//   --match-head-commit; --auto calls enablePullRequestAutoMerge)
// - octokit/graphql-schema schema.graphql MergePullRequestInput.expectedHeadOid
//   (lines 21901-21903: if omitted, no check is performed) and
//   EnablePullRequestAutoMergeInput.expectedHeadOid (lines 12798-12800)
// - schema.graphql AddPullRequestReviewInput.commitOID (lines 842-845),
//   optional. REST "Create a review" defaults an omitted commit id to the
//   most recent commit on the pull request.
// - schema.graphql AutoMergeRequest (lines 1782-1820) has no expectedHeadOid
//   field. This stand-in still keeps the oid supplied at enable time and
//   applies MergePullRequestInput's mismatch rejection when the armed merge
//   later runs, which is the contract of `gh pr merge --match-head-commit`.
//
// Platform rules applied here, from GitHub's docs:
// - Auto-merge stays armed when the pusher has write permission. It is
//   disabled when someone without write permission pushes.
//   https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request
// - Dismissing stale approvals is optional and is left off.
//   https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
// - GET /repos/{owner}/{repo}/pulls/{n}/commits lists oldest first. Observed
//   on cli/cli pull 5692 (2022-05-23 commit before 2022-06-15 commit).

import http from "node:http";

export const DEPENDABOT = "dependabot[bot]";

export function createServer() {
  const state = {
    owner: "acme",
    repo: "widgets",
    number: 7,
    nodeId: "PR_node_7",
    baseRef: "main",
    headRef: "dependabot/npm_and_yarn/lodash-1.2.4",
    // Files on the default branch. Direct pushes are rejected; only a
    // completed pull-request merge writes here.
    baseFiles: { "README.md": "base\n" },
    // Commits oldest-first, matching the pulls list-commits response order.
    commits: [],
    reviews: [],
    // null, or { mergeMethod, expectedHeadOid: string|null }
    autoMerge: null,
    mergeState: "BLOCKED",
    merged: false,
    mergedCommitShas: [],
    poisonAfterList: false,
    poisoned: false,
    poisonCommit: null,
    commands: [],
    requests: [],
  };

  function head() {
    return state.commits[state.commits.length - 1] ?? null;
  }

  function commitBySha(sha) {
    return state.commits.find((commit) => commit.sha === String(sha).toLowerCase());
  }

  function treeOf(sha) {
    const files = { ...state.baseFilesAtOpen };
    for (const commit of state.commits) {
      Object.assign(files, commit.files);
      if (commit.sha === sha) break;
    }
    return files;
  }

  function toApiCommit(commit) {
    return {
      sha: commit.sha,
      author: { login: commit.author },
      commit: {
        message: commit.message,
        verification: { verified: commit.verified === true },
      },
    };
  }

  function prBody() {
    const tip = head();
    return {
      id: state.number,
      node_id: state.nodeId,
      number: state.number,
      state: state.merged ? "closed" : "open",
      merged: state.merged,
      mergeable_state: state.mergeState.toLowerCase(),
      title: "Bump lodash",
      head: { ref: state.headRef, sha: tip ? tip.sha : "" },
      base: { ref: state.baseRef },
      user: { login: DEPENDABOT },
    };
  }

  function squashMerge(expectedHeadOid) {
    const tip = head();
    if (!tip) return { ok: false, status: 422, message: "pull request has no commits" };
    if (expectedHeadOid && expectedHeadOid.toLowerCase() !== tip.sha) {
      return {
        ok: false,
        status: 409,
        message: `expected head oid ${expectedHeadOid} does not match current head ${tip.sha}`,
      };
    }
    const approved = state.reviews.some((review) => review.state === "APPROVE");
    if (!approved) {
      return { ok: false, status: 405, message: "base branch requires an approving review" };
    }
    if (state.mergeState === "BLOCKED") {
      return { ok: false, status: 405, message: "required status checks have not passed" };
    }
    const files = { ...state.baseFilesAtOpen };
    for (const commit of state.commits) Object.assign(files, commit.files);
    state.baseFiles = files;
    state.merged = true;
    state.mergedCommitShas = state.commits.map((commit) => commit.sha);
    state.autoMerge = null;
    state.mergeState = "CLEAN";
    return { ok: true };
  }

  function enableAutoMerge(input) {
    const tip = head();
    const expected = input.expectedHeadOid ? String(input.expectedHeadOid).toLowerCase() : null;
    if (expected && (!tip || expected !== tip.sha)) {
      return {
        ok: false,
        message: `expected head oid ${expected} does not match current head ${tip ? tip.sha : "none"}`,
      };
    }
    state.autoMerge = {
      mergeMethod: input.mergeMethod || "MERGE",
      expectedHeadOid: expected,
    };
    return { ok: true };
  }

  function addReview(input) {
    const tip = head();
    // queries_pr_review.go omits commitOID. REST create-review defaults that
    // omission to the most recent commit.
    const sha = input.commitOID || input.commit_id || (tip ? tip.sha : "");
    const event = String(input.event || input.state || "APPROVE").toUpperCase();
    const stateName = event === "APPROVE" ? "APPROVE" : event;
    state.reviews.push({
      state: stateName,
      commitSha: String(sha).toLowerCase(),
      body: input.body || "",
    });
    return { ok: true };
  }

  function finishChecks() {
    if (state.merged) return { merged: true, reason: "already merged" };
    state.mergeState = "CLEAN";
    if (!state.autoMerge) return { merged: false, reason: "auto-merge is not armed" };
    const expected = state.autoMerge.expectedHeadOid;
    const tip = head();
    if (expected && (!tip || expected !== tip.sha)) {
      return {
        merged: false,
        reason: `auto-merge expected ${expected} but head is ${tip ? tip.sha : "none"}`,
      };
    }
    const result = squashMerge(expected);
    return { merged: result.ok === true, reason: result.message || "merged" };
  }

  function pushCommit(commit) {
    // Same-repo Dependabot branches accept a push from a principal with write
    // access. A push that is rejected does not change the branch or auto-merge.
    // An accepted write push leaves auto-merge armed; GitHub disables it only
    // when the pusher lacks write permission (fork-head case), which this
    // same-repo branch does not allow.
    if (!commit.write) {
      return { ok: false, message: "write permission required to push to the pull request branch" };
    }
    state.commits.push({
      sha: String(commit.sha).toLowerCase(),
      author: commit.author,
      message: commit.message,
      verified: commit.verified === true,
      files: commit.files || {},
      write: true,
    });
    return { ok: true };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(error);
        }
      });
      req.on("error", reject);
    });
  }

  function send(res, status, body) {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    state.requests.push(`${req.method} ${url.pathname}`);
    try {
      if (req.method === "POST" && url.pathname === "/_test/argv") {
        const body = await readBody(req);
        state.commands.push(body.argv || []);
        return send(res, 204, "");
      }

      const commitsPath = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/commits$/);
      if (req.method === "GET" && commitsPath) {
        const payload = state.commits.map(toApiCommit);
        const body = JSON.stringify(payload);
        if (state.poisonAfterList && !state.poisoned && state.poisonCommit) {
          state.poisoned = true;
          state.commits.push(state.poisonCommit);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
        return;
      }

      const prPath = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/);
      if (req.method === "GET" && prPath) return send(res, 200, prBody());

      const reviewsPath = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/);
      if (req.method === "POST" && reviewsPath) {
        const body = await readBody(req);
        addReview(body);
        return send(res, 200, { id: state.reviews.length, state: "APPROVED" });
      }

      const mergePath = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/merge$/);
      if (req.method === "PUT" && mergePath) {
        const body = await readBody(req);
        const result = squashMerge(body.sha || body.expectedHeadOid || null);
        if (!result.ok) return send(res, result.status, { message: result.message });
        return send(res, 200, { merged: true, sha: head().sha });
      }

      if (req.method === "POST" && (url.pathname === "/graphql" || url.pathname === "/api/graphql")) {
        const body = await readBody(req);
        const query = String(body.query || "");
        const input = (body.variables && (body.variables.input || body.variables)) || {};
        if (/enablePullRequestAutoMerge/.test(query)) {
          const result = enableAutoMerge(input);
          if (!result.ok) {
            return send(res, 200, { data: null, errors: [{ message: result.message }] });
          }
          return send(res, 200, { data: { enablePullRequestAutoMerge: { clientMutationId: "1" } } });
        }
        if (/disablePullRequestAutoMerge/.test(query)) {
          state.autoMerge = null;
          return send(res, 200, { data: { disablePullRequestAutoMerge: { clientMutationId: "1" } } });
        }
        if (/addPullRequestReview/.test(query)) {
          addReview(input);
          return send(res, 200, { data: { addPullRequestReview: { clientMutationId: "1" } } });
        }
        if (/mergePullRequest/.test(query)) {
          const result = squashMerge(input.expectedHeadOid || null);
          if (!result.ok) {
            return send(res, 200, { data: null, errors: [{ message: result.message }] });
          }
          return send(res, 200, { data: { mergePullRequest: { clientMutationId: "1" } } });
        }
        return send(res, 200, { data: null, errors: [{ message: `unhandled graphql query: ${query.slice(0, 180)}` }] });
      }

      send(res, 404, { message: `no route for ${req.method} ${url.pathname}` });
    } catch (error) {
      send(res, 500, { message: error.message });
    }
  });

  return {
    state,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address();
          resolve(`http://127.0.0.1:${port}`);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
    reset(commits, { headRef, poisonAfterList = false, poisonCommit = null } = {}) {
      state.commits = commits.map((commit) => ({
        ...commit,
        sha: String(commit.sha).toLowerCase(),
      }));
      state.baseFiles = { "README.md": "base\n" };
      state.baseFilesAtOpen = { ...state.baseFiles };
      state.reviews = [];
      state.autoMerge = null;
      state.mergeState = "BLOCKED";
      state.merged = false;
      state.mergedCommitShas = [];
      state.poisonAfterList = poisonAfterList;
      state.poisoned = false;
      state.poisonCommit = poisonCommit
        ? { ...poisonCommit, sha: String(poisonCommit.sha).toLowerCase() }
        : null;
      state.commands = [];
      state.requests = [];
      if (headRef) state.headRef = headRef;
    },
    pushCommit,
    finishChecks,
    head,
    commitBySha,
    treeOf,
    baseHas(path) {
      return Object.prototype.hasOwnProperty.call(state.baseFiles, path);
    },
    mergedCommits() {
      return state.mergedCommitShas.map((sha) => commitBySha(sha)).filter(Boolean);
    },
    trace() {
      return {
        commands: state.commands,
        requests: state.requests,
        reviews: state.reviews,
        autoMerge: state.autoMerge,
        mergeState: state.mergeState,
        merged: state.merged,
        head: head() && head().sha,
        commitAuthors: state.commits.map((commit) => `${commit.sha.slice(0, 7)} ${commit.author} verified=${commit.verified}`),
        baseFiles: state.baseFiles,
      };
    },
  };
}

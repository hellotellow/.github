import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { evaluate, mentionsStatusFunction, substitute } from "./expr.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../..");
export const workflowPath = path.join(repoRoot, ".github/workflows/auto-merge.yaml");
const ghBin = path.resolve(here, "../bin");

export function ensureFetchMetadata(version = "v2.2.0") {
  const dir = path.join("/tmp", `fetch-metadata-${version}`);
  const dist = path.join(dir, "dist/index.js");
  if (!fs.existsSync(dist)) {
    execFileSync(
      "git",
      ["clone", "--depth", "1", "--branch", version, "https://github.com/dependabot/fetch-metadata.git", dir],
      { stdio: "inherit" },
    );
  }
  return dir;
}

function parseOutputFile(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const outputs = {};
  const lines = text.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const delimited = line.match(/^(.*)<<(\S+)$/);
    if (delimited) {
      const name = delimited[1];
      const marker = delimited[2];
      const body = [];
      i += 1;
      while (i < lines.length && lines[i] !== marker) {
        body.push(lines[i]);
        i += 1;
      }
      outputs[name] = body.join("\n");
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return outputs;
}

function runProcess(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd: repoRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function stepWillRun(step, ctx, priorFailed) {
  if (step.if == null) return !priorFailed;
  const expression = String(step.if);
  if (!mentionsStatusFunction(expression) && priorFailed) return false;
  return Boolean(evaluate(expression, ctx));
}

export async function runWorkflow(server, url, options) {
  const workflow = parse(fs.readFileSync(workflowPath, "utf8"));
  const actor = options.actor ?? "dependabot[bot]";
  const prUrl = options.prUrl ?? "https://github.com/acme/widgets/pull/7";
  const token = "placeholder-repo-token";
  const ctx = {
    github: { actor },
    inputs: { "pr-url": prUrl },
    secrets: { "repo-token": token },
    steps: {},
    __success: true,
  };
  const job = workflow.jobs.dependabot;
  const result = { skipped: false, steps: [], outputs: ctx.steps };
  if (!evaluate(job.if, ctx)) {
    result.skipped = true;
    return result;
  }

  let priorFailed = false;
  for (const step of job.steps) {
    const stepCtx = { ...ctx, __success: !priorFailed };
    if (!stepWillRun(step, stepCtx, priorFailed)) {
      result.steps.push({ name: step.name, id: step.id, status: "skipped" });
      continue;
    }

    const script = step.run ? substitute(step.run, ctx) : "";
    if (options.pushBeforeMerge && step.run && /\bpr\s+merge\b/.test(script)) {
      server.pushCommit(options.pushBeforeMerge);
    }

    const outputFile = path.join(os.tmpdir(), `gha-output-${process.pid}-${Math.random().toString(16).slice(2)}`);
    fs.writeFileSync(outputFile, "");
    const env = {
      ...process.env,
      PATH: `${ghBin}:${process.env.PATH}`,
      MOCK_GITHUB_URL: url,
      GITHUB_OUTPUT: outputFile,
      GITHUB_ACTOR: actor,
      GITHUB_REPOSITORY: "acme/widgets",
      GITHUB_API_URL: url,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_EVENT_NAME: "pull_request",
      PR_URL: prUrl,
    };
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.ALL_PROXY;
    delete env.http_proxy;
    delete env.https_proxy;
    if (step.env) {
      for (const [key, value] of Object.entries(step.env)) env[key] = substitute(String(value), ctx);
    }

    let outcome;
    if (step.uses) {
      const uses = String(step.uses);
      const pinned = uses.match(/^dependabot\/fetch-metadata@(.+)$/);
      if (!pinned) {
        outcome = { code: 1, stdout: "", stderr: `unsupported action ${uses}` };
      } else {
        const actionDir = ensureFetchMetadata(pinned[1]);
        const eventPath = path.join(os.tmpdir(), `gha-event-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
        const tip = server.head();
        fs.writeFileSync(eventPath, JSON.stringify({
          pull_request: {
            number: 7,
            body: options.body ?? "",
            user: { login: "dependabot[bot]" },
            head: { ref: server.state.headRef, sha: tip ? tip.sha : "" },
            base: { ref: "main" },
          },
        }));
        env.GITHUB_EVENT_PATH = eventPath;
        env.GITHUB_EVENT_NAME = "pull_request";
        env["INPUT_SKIP-COMMIT-VERIFICATION"] = "false";
        env["INPUT_SKIP-VERIFICATION"] = "false";
        // alert-lookup and compat-lookup are read with getInput, where any
        // non-empty string is on. The workflow leaves both unset.
        const withInputs = step.with || {};
        for (const [key, value] of Object.entries(withInputs)) {
          env[`INPUT_${key.replace(/ /g, "_").toUpperCase()}`] = substitute(String(value), ctx);
        }
        outcome = await runProcess(process.execPath, [path.join(actionDir, "dist/index.js")], env);
        fs.rmSync(eventPath, { force: true });
      }
    } else if (step.run) {
      outcome = await runProcess("bash", ["-eo", "pipefail", "-c", script], env);
    } else {
      outcome = { code: 1, stdout: "", stderr: "step has neither uses nor run" };
    }

    const outputs = parseOutputFile(outputFile);
    fs.rmSync(outputFile, { force: true });
    if (step.id) ctx.steps[step.id] = { outputs };
    const status = outcome.code === 0 ? "success" : "failure";
    if (status === "failure") priorFailed = true;
    result.steps.push({
      name: step.name,
      id: step.id,
      status,
      code: outcome.code,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      outputs,
    });
  }
  return result;
}

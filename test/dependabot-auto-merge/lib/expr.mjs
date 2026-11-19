// GitHub Actions expression subset used by .github/workflows/auto-merge.yaml
// and by the commit-binding fix that workflow is expected to grow.
// https://docs.github.com/en/actions/reference/workflows-and-actions/expressions

const TOKEN_SOURCE = String.raw`\s+|'(?:\\'|[^'])*'|"(?:\\"|[^"])*"|&&|\|\||!=|==|!|\(|\)|[A-Za-z_][\w.-]*`;

function tokenize(input) {
  const token = new RegExp(TOKEN_SOURCE, "y");
  const tokens = [];
  while (token.lastIndex < input.length) {
    const start = token.lastIndex;
    const match = token.exec(input);
    if (!match) {
      throw new Error(`Cannot parse expression at ${JSON.stringify(input.slice(start))}: ${input}`);
    }
    if (!/^\s+$/.test(match[0])) tokens.push(match[0]);
  }
  return tokens;
}

function unwrap(expr) {
  const trimmed = String(expr ?? "").trim();
  const wrapped = trimmed.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
  return (wrapped ? wrapped[1] : trimmed).trim();
}

function lookup(path, ctx) {
  const parts = path.split(".");
  let cur = ctx;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object" || !(part in cur)) return "";
    cur = cur[part];
  }
  return cur == null ? "" : cur;
}

function literal(token, ctx) {
  if (token.startsWith("'") || token.startsWith('"')) {
    return token.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"');
  }
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  return lookup(token, ctx);
}

function parse(tokens, ctx) {
  function parseOr() {
    let left = parseAnd();
    while (tokens[0] === "||") {
      tokens.shift();
      const right = parseAnd();
      left = truthy(left) || truthy(right);
    }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (tokens[0] === "&&") {
      tokens.shift();
      const right = parseNot();
      left = truthy(left) && truthy(right);
    }
    return left;
  }
  function parseNot() {
    if (tokens[0] === "!") {
      tokens.shift();
      return !truthy(parseNot());
    }
    return parseCmp();
  }
  function parseCmp() {
    let left = parsePrimary();
    if (tokens[0] === "==" || tokens[0] === "!=") {
      const op = tokens.shift();
      const right = parsePrimary();
      const same = String(left) === String(right);
      return op === "==" ? same : !same;
    }
    return left;
  }
  function parsePrimary() {
    if (tokens[0] === "(") {
      tokens.shift();
      const value = parseOr();
      if (tokens.shift() !== ")") throw new Error("Expected )");
      return value;
    }
    const token = tokens.shift();
    if (token == null) throw new Error("Unexpected end of expression");
    if (token === "success" || token === "failure" || token === "always" || token === "cancelled") {
      if (tokens[0] === "(") {
        tokens.shift();
        if (tokens.shift() !== ")") throw new Error(`Expected ) after ${token}()`);
        if (token === "success") return ctx.__success !== false;
        if (token === "failure") return ctx.__success === false;
        if (token === "always") return true;
        return false;
      }
    }
    return literal(token, ctx);
  }
  const value = parseOr();
  if (tokens.length) throw new Error(`Unexpected token ${tokens[0]}`);
  return value;
}

function truthy(value) {
  return !(value === false || value === null || value === undefined || value === "" || value === 0);
}

export function evaluate(expr, ctx) {
  const text = unwrap(expr);
  if (!text) return true;
  return parse(tokenize(text), ctx);
}

export function substitute(text, ctx) {
  return String(text ?? "").replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_all, inner) => {
    const value = evaluate(inner, ctx);
    return value == null ? "" : String(value);
  });
}

export function mentionsStatusFunction(expr) {
  return /\b(success|failure|always|cancelled)\s*\(/.test(unwrap(expr));
}

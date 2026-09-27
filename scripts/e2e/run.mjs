// End-to-end acceptance run against a real Paperclip host (local_trusted mode) and scripts/e2e/mock.mjs.
// Installs both plugins from this repository, configures them with company secrets, triggers real
// events and checks what reached the mock. Exits non-zero on the first failed check.
//
//   PC_API=http://localhost:3100/api MOCK_URL=http://127.0.0.1:18080 node scripts/e2e/run.mjs
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const API = process.env.PC_API ?? "http://localhost:3100/api";
const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:18080";
const PACKAGES =
  process.env.PLUGINS_DIR ?? fileURLToPath(new URL("../../packages", import.meta.url));
const BASE_URL = API.replace(/\/api$/, "");

// Test-only values created for this run.
const SECRETS = {
  ntfyToken: "tk_e2e_ntfy_token_7f3a9c",
  cfId: "cfid_e2e_client_4b21",
  appriseKey: "e2ekeyapprise9d1",
};

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", origin: BASE_URL },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) console.log(`  ${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return { status: res.status, ok: res.ok, json };
}

const mockRequests = async () => (await fetch(`${MOCK}/__requests`)).json();
const mockStatus = (code) => fetch(`${MOCK}/__status?code=${code}`, { method: "POST" });

/** Waits until `predicate(requests)` returns a value, or fails after `ms`. */
async function waitFor(label, predicate, ms = 30_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const found = predicate(await mockRequests());
    if (found) return found;
    await sleep(500);
  }
  check(label, false, "timed out waiting for the mock");
}

const ntfyRequests = (all, title) =>
  all.filter((r) => r.path === "/" && r.body?.topic === "paperclip-e2e" && r.body?.title === title);
const appriseRequests = (all, title) =>
  all.filter((r) => r.path === `/notify/${SECRETS.appriseKey}` && r.body?.title === title);

async function main() {
  const health = await call("GET", "/health");
  check("host is up", health.ok);

  // Companies: one configured, one not (criterion 5).
  const c1 = await call("POST", "/companies", { name: "E2E Notify Co" });
  const c2 = await call("POST", "/companies", { name: "E2E Unconfigured Co" });
  check("companies created", c1.ok && c2.ok);
  const company = c1.json;

  // Plugins installed from local paths, as `paperclipai plugin install <path>` does.
  const plugins = {};
  for (const name of ["ntfy", "apprise"]) {
    const r = await call("POST", "/plugins/install", {
      packageName: `${PACKAGES}/plugin-${name}`,
      isLocalPath: true,
    });
    check(`plugin-${name} installed`, r.ok && r.json?.status !== "error", r.json?.lastError ?? "");
    plugins[name] = r.json;
  }

  const contributions = await call("GET", "/plugins/ui-contributions");
  const slots = JSON.stringify(contributions.json);
  check(
    "settings pages registered",
    slots.includes("NtfySettingsPage") && slots.includes("AppriseSettingsPage"),
  );

  // Company secrets, then config saved through the host (Ajv validation + secret binding).
  const secretIds = {};
  for (const [key, value] of Object.entries(SECRETS)) {
    const r = await call("POST", `/companies/${company.id}/secrets`, { name: `e2e-${key}`, value });
    check(`secret ${key} created`, r.ok);
    secretIds[key] = r.json.id;
  }
  const ref = (key) => ({ type: "secret_ref", secretId: secretIds[key] });
  const ntfyConfig = {
    serverUrl: MOCK,
    topic: "paperclip-e2e",
    auth: { mode: "token", token: ref("ntfyToken") },
    extraHeaders: [{ name: "CF-Access-Client-Id", value: ref("cfId") }],
    paperclipBaseUrl: BASE_URL,
    network: { allowPrivateNetwork: true },
  };
  const appriseConfig = {
    apiUrl: MOCK,
    configKey: ref("appriseKey"),
    paperclipBaseUrl: BASE_URL,
    network: { allowPrivateNetwork: true },
  };
  for (const [name, configJson] of [
    ["ntfy", ntfyConfig],
    ["apprise", appriseConfig],
  ]) {
    const r = await call("POST", `/plugins/${plugins[name].id}/config`, {
      companyId: company.id,
      configJson,
    });
    check(`plugin-${name} config accepted by the host`, r.ok);
  }

  // Criterion 1: a default-on event gives exactly one notification per plugin.
  const issue = await call("POST", `/companies/${company.id}/issues`, {
    title: "E2E blocked issue",
  });
  check("issue created", issue.ok);
  const blocked = await call("PATCH", `/issues/${issue.json.id}`, { status: "blocked" });
  check("issue blocked", blocked.ok);
  const title = `${issue.json.identifier} is blocked`;
  const [ntfy] = await waitFor(
    "ntfy notification",
    (all) => ntfyRequests(all, title).at(0) && ntfyRequests(all, title),
  );
  check("ntfy priority is high (4)", ntfy.body.priority === 4);
  check(
    "ntfy click is the issue deep link",
    ntfy.body.click === `${BASE_URL}/${company.issuePrefix}/issues/${issue.json.identifier}`,
  );
  check(
    "ntfy token resolved from the secret",
    ntfy.headers.authorization === `Bearer ${SECRETS.ntfyToken}`,
  );
  check(
    "Cloudflare Access header resolved (criterion 8)",
    ntfy.headers["cf-access-client-id"] === SECRETS.cfId,
  );
  const [apprise] = await waitFor(
    "apprise notification",
    (all) => appriseRequests(all, title).at(0) && appriseRequests(all, title),
  );
  check(
    "apprise routed by the high tag (criterion 10)",
    apprise.body.tag === "alert" && apprise.body.type === "warning",
  );
  await sleep(3000);
  const all = await mockRequests();
  check(
    "exactly one notification per plugin (criteria 1, 2)",
    ntfyRequests(all, title).length === 1 && appriseRequests(all, title).length === 1,
  );

  // Settings page bridge: send-test and status with the company's secrets.
  for (const name of ["ntfy", "apprise"]) {
    const test = await call("POST", `/plugins/${plugins[name].id}/actions/send-test`, {
      companyId: company.id,
      params: {},
    });
    check(`plugin-${name} send-test`, test.ok && JSON.stringify(test.json).includes('"ok":true'));
    const status = await call("POST", `/plugins/${plugins[name].id}/data/status`, {
      companyId: company.id,
      params: {},
    });
    check(
      `plugin-${name} status shows the last delivery`,
      JSON.stringify(status.json).includes("lastSentAt"),
    );
  }

  // Criterion 7: outage → retry queue → delivered by the drain job once the server is back.
  await mockStatus(503);
  const issue2 = await call("POST", `/companies/${company.id}/issues`, {
    title: "E2E outage issue",
  });
  await call("PATCH", `/issues/${issue2.json.id}`, { status: "blocked" });
  const title2 = `${issue2.json.identifier} is blocked`;
  await waitFor("first attempt during the outage", (all) =>
    ntfyRequests(all, title2).find((r) => r.replied === 503),
  );
  await mockStatus(200);
  await sleep(31_000); // first retry backoff is 30 s
  const jobs = await call("GET", `/plugins/${plugins.ntfy.id}/jobs`);
  const drain = (Array.isArray(jobs.json) ? jobs.json : (jobs.json?.jobs ?? [])).find(
    (j) => j.jobKey === "delivery-drain",
  );
  check("delivery-drain job registered", Boolean(drain));
  const trigger = await call("POST", `/plugins/${plugins.ntfy.id}/jobs/${drain.id}/trigger`);
  check("delivery-drain triggered", trigger.ok);
  await waitFor(
    "retry delivered after the outage",
    (all) => ntfyRequests(all, title2).find((r) => r.replied === 200),
    60_000,
  );

  // Criterion 5: a company without config gets nothing.
  const other = await call("POST", `/companies/${c2.json.id}/issues`, {
    title: "E2E other company",
  });
  await call("PATCH", `/issues/${other.json.id}`, { status: "blocked" });
  await sleep(5000);
  const otherTitle = `${other.json.identifier} is blocked`;
  check(
    "unconfigured company notifies nobody",
    (await mockRequests()).every((r) => r.body?.title !== otherTitle),
  );

  // Criterion 11: no secret value in the plugin logs.
  for (const name of ["ntfy", "apprise"]) {
    const logs = JSON.stringify(
      (await call("GET", `/plugins/${plugins[name].id}/logs?limit=500`)).json,
    );
    const leaked = Object.entries(SECRETS).filter(([, value]) => logs.includes(value));
    check(
      `plugin-${name} logs contain no secret`,
      leaked.length === 0,
      leaked.map(([k]) => k).join(", "),
    );
  }
}

main()
  .then(() => console.log(`\n${results.length} checks passed`))
  .catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  });

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
const TOPIC_1 = "paperclip-e2e";
const TOPIC_3 = "paperclip-e2e-3";
const TEST_TITLE = "Paperclip test notification";

// Test-only values created for this run.
const SECRETS = {
  ntfyToken: "tk_e2e_ntfy_token_7f3a9c",
  cfId: "cfid_e2e_client_4b21",
  appriseKey: "e2ekeyapprise9d1",
};

// Paperclip requires a reason to enter "blocked" (blockers, an approval or an unblock descriptor).
const BLOCKED = {
  status: "blocked",
  unblockDescriptor: { owner: "board", action: "Review the E2E issue" },
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

/** Waits until `predicate(requests)` returns a value; the wait itself is a check. */
async function waitFor(label, predicate, ms = 30_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const found = predicate(await mockRequests());
    if (found) {
      check(label, true);
      return found;
    }
    await sleep(500);
  }
  check(label, false, "timed out waiting for the mock");
}

const ntfyRequests = (all, title, topic = TOPIC_1) =>
  all.filter((r) => r.path === "/" && r.body?.topic === topic && r.body?.title === title);
const appriseRequests = (all, title) =>
  all.filter((r) => r.path === `/notify/${SECRETS.appriseKey}` && r.body?.title === title);
const delivered = (requests) => requests.find((r) => r.replied === 200);

/** Array from a list endpoint that may wrap it (`{ jobs: [...] }`, `{ logs: [...] }`…). */
function listOf(json, key) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json[key])) return json[key];
  return [];
}

/** Every ISO timestamp in a run record, whatever the field names. */
const timesOf = (run) =>
  Object.values(run)
    .filter((v) => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v))
    .map((v) => Date.parse(v));

async function main() {
  const health = await call("GET", "/health");
  check("host is up", health.ok);

  // Companies: one with both plugins, one without config, one with ntfy on another topic (criterion 5).
  const [c1, c2, c3] = await Promise.all(
    ["E2E Notify Co", "E2E Unconfigured Co", "E2E Other Topic Co"].map((name) =>
      call("POST", "/companies", { name }),
    ),
  );
  check("companies created", c1.ok && c2.ok && c3.ok);
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
    contributions.ok && slots.includes("NtfySettingsPage") && slots.includes("AppriseSettingsPage"),
  );

  // Company secrets, then config saved through the host (Ajv validation + secret binding).
  const secretRef = {};
  for (const [companyId, keys] of [
    [company.id, Object.keys(SECRETS)],
    [c3.json.id, ["ntfyToken"]],
  ]) {
    for (const key of keys) {
      const r = await call("POST", `/companies/${companyId}/secrets`, {
        name: `e2e-${key}`,
        value: SECRETS[key],
      });
      check(`secret ${key} created`, r.ok);
      secretRef[`${companyId}:${key}`] = { type: "secret_ref", secretId: r.json.id };
    }
  }
  const ntfyConfig = (companyId, topic) => ({
    serverUrl: MOCK,
    topic,
    auth: { mode: "token", token: secretRef[`${companyId}:ntfyToken`] },
    ...(companyId === company.id
      ? { extraHeaders: [{ name: "CF-Access-Client-Id", value: secretRef[`${company.id}:cfId`] }] }
      : {}),
    paperclipBaseUrl: BASE_URL,
    network: { allowPrivateNetwork: true },
  });
  const appriseConfig = {
    apiUrl: MOCK,
    configKey: secretRef[`${company.id}:appriseKey`],
    paperclipBaseUrl: BASE_URL,
    network: { allowPrivateNetwork: true },
  };
  for (const [name, companyId, configJson] of [
    ["ntfy", company.id, ntfyConfig(company.id, TOPIC_1)],
    ["apprise", company.id, appriseConfig],
    ["ntfy", c3.json.id, ntfyConfig(c3.json.id, TOPIC_3)],
  ]) {
    const r = await call("POST", `/plugins/${plugins[name].id}/config`, { companyId, configJson });
    check(`plugin-${name} config accepted by the host`, r.ok);
  }

  // Criterion 1: a default-on event gives exactly one notification per plugin.
  const issue = await call("POST", `/companies/${company.id}/issues`, {
    title: "E2E blocked issue",
  });
  check("issue created", issue.ok);
  check("issue blocked", (await call("PATCH", `/issues/${issue.json.id}`, BLOCKED)).ok);
  const title = `${issue.json.identifier} is blocked`;
  const ntfy = await waitFor("ntfy notification", (all) => ntfyRequests(all, title).at(0));
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
    "Cloudflare Access header resolved on events",
    ntfy.headers["cf-access-client-id"] === SECRETS.cfId,
  );
  const apprise = await waitFor("apprise notification", (all) => appriseRequests(all, title).at(0));
  check(
    "apprise routed by the high tag (criterion 10)",
    apprise.body.tag === "alert" && apprise.body.type === "warning",
  );
  await sleep(8000);
  const afterFirst = await mockRequests();
  check(
    "exactly one notification per plugin (criterion 1)",
    ntfyRequests(afterFirst, title).length === 1 && appriseRequests(afterFirst, title).length === 1,
  );
  check(
    "configured topics stay apart (criterion 5)",
    ntfyRequests(afterFirst, title, TOPIC_3).length === 0,
  );

  // Criterion 5: a second company with another topic gets only its own events there.
  const issue3 = await call("POST", `/companies/${c3.json.id}/issues`, {
    title: "E2E other topic",
  });
  check(
    "company 3 issue blocked",
    issue3.ok && (await call("PATCH", `/issues/${issue3.json.id}`, BLOCKED)).ok,
  );
  const title3 = `${issue3.json.identifier} is blocked`;
  await waitFor("company 3 notified on its own topic (criterion 5)", (all) =>
    ntfyRequests(all, title3, TOPIC_3).at(0),
  );
  check(
    "company 3 not notified on company 1's topic",
    ntfyRequests(await mockRequests(), title3).length === 0,
  );

  // Settings page bridge: send-test and status with the company's secrets (criterion 8).
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
      status.ok && /"lastSentAt":"\d{4}-\d\d-\d\dT/.test(JSON.stringify(status.json)),
    );
  }
  const testRequest = (await mockRequests()).find(
    (r) => r.path === "/" && r.body?.title === TEST_TITLE,
  );
  check(
    "send-test carries the resolved Cloudflare Access header (criterion 8)",
    testRequest?.headers["cf-access-client-id"] === SECRETS.cfId,
  );

  // Criterion 7: outage → retry queue → delivered by the drain job once the server is back.
  await mockStatus(503);
  const issue2 = await call("POST", `/companies/${company.id}/issues`, {
    title: "E2E outage issue",
  });
  check(
    "outage issue blocked",
    issue2.ok && (await call("PATCH", `/issues/${issue2.json.id}`, BLOCKED)).ok,
  );
  const title2 = `${issue2.json.identifier} is blocked`;
  await waitFor("ntfy attempt failed during the outage", (all) =>
    ntfyRequests(all, title2).find((r) => r.replied === 503),
  );
  await waitFor("apprise attempt failed during the outage", (all) =>
    appriseRequests(all, title2).find((r) => r.replied === 503),
  );
  await mockStatus(200);
  await sleep(31_000); // the first retry is due 30 s after the failure

  for (const [name, requestsFor] of [
    ["ntfy", ntfyRequests],
    ["apprise", appriseRequests],
  ]) {
    const jobs = await call("GET", `/plugins/${plugins[name].id}/jobs`);
    const drain = listOf(jobs.json, "jobs").find((j) => j.jobKey === "delivery-drain");
    check(`plugin-${name} delivery-drain job registered`, Boolean(drain));
    const runsOf = async () =>
      listOf(
        (await call("GET", `/plugins/${plugins[name].id}/jobs/${drain.id}/runs?limit=50`)).json,
        "runs",
      );

    const early = delivered(requestsFor(await mockRequests(), title2));
    if (early) {
      // The scheduled run (every minute) got there first; prove it was a drain run.
      const scheduled = (await runsOf()).some(
        (run) =>
          run.trigger === "schedule" && timesOf(run).some((t) => t <= Date.parse(early.at) + 1000),
      );
      check(`plugin-${name} retry delivered by the scheduled drain (criterion 7)`, scheduled);
      continue;
    }
    const triggeredAt = Date.now();
    check(
      `plugin-${name} delivery-drain triggered`,
      (await call("POST", `/plugins/${plugins[name].id}/jobs/${drain.id}/trigger`)).ok,
    );
    const retry = await waitFor(
      `plugin-${name} retry delivered after the outage`,
      (all) => delivered(requestsFor(all, title2)),
      60_000,
    );
    const runs = await runsOf();
    const manual = runs.some((run) => run.trigger === "manual");
    const scheduledMeanwhile = runs.some(
      (run) =>
        run.trigger === "schedule" &&
        timesOf(run).some((t) => t >= triggeredAt && t <= Date.parse(retry.at)),
    );
    check(
      `plugin-${name} retry delivered by the manual drain run (criterion 7)`,
      manual && !scheduledMeanwhile,
    );
  }

  // Criterion 5: a company without config gets nothing.
  const other = await call("POST", `/companies/${c2.json.id}/issues`, {
    title: "E2E other company",
  });
  check(
    "unconfigured company issue blocked",
    other.ok && (await call("PATCH", `/issues/${other.json.id}`, BLOCKED)).ok,
  );
  await sleep(10_000);
  const otherTitle = `${other.json.identifier} is blocked`;
  check(
    "unconfigured company notifies nobody (criterion 5)",
    (await mockRequests()).every((r) => r.body?.title !== otherTitle),
  );

  // Criterion 11: no secret value in the plugin logs.
  for (const name of ["ntfy", "apprise"]) {
    const logs = await call("GET", `/plugins/${plugins[name].id}/logs?limit=500`);
    const entries = listOf(logs.json, "logs");
    check(
      `plugin-${name} logs readable`,
      logs.ok && entries.length > 0,
      `${entries.length} entries`,
    );
    const text = JSON.stringify(entries);
    const leaked = Object.entries(SECRETS).filter(([, value]) => text.includes(value));
    check(
      `plugin-${name} logs contain no secret (criterion 11)`,
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

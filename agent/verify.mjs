// Agente de verificación de Mergit — paso 1: leer el trabajo, no pagarlo todavía.
//
// Dado un pull request real, responde una sola pregunta: ¿el trabajo existe?
// Existe si el PR está mergeado y si el CI de su código quedó en verde.
// Devuelve la evidencia usada y su hash, que es exactamente lo que
// MergitEscrow registra en el evento BountySettled al liquidar.
//
//   node verify.mjs https://github.com/owner/repo/pull/123
//   node verify.mjs owner/repo#123 --json
//
// Sin token funciona contra repos públicos (60 consultas/hora). Con
// GITHUB_TOKEN en el entorno sube a 5000 y alcanza repos privados.
import { keccak256, toHex } from "viem";
import { pathToFileURL } from "node:url";
import { parseTarget } from "./chain.mjs";

const API = "https://api.github.com";

// Un check que termina así no bloquea el pago: neutral y skipped significan
// "no aplica", no "falló". Tratarlos como fallo dejaría sin cobrar trabajo bueno.
const PASSING = new Set(["success", "neutral", "skipped"]);
/** El estado que escribe el preflight. Ver `readCi`: no es CI. */
export const PAYABLE_CONTEXT = "mergit/payable";

// ───────────────────────────── Entrada ─────────────────────────────

async function gh(path) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mergit-agent",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(`${API}${path}`, { headers });
  if (res.status === 404) throw new Error(`no existe: ${path}`);
  if (res.status === 403 || res.status === 429) {
    // Un 403 puede ser el límite de consultas o un token sin permiso. Se distinguen
    // por el contador que queda: confundirlos manda a depurar al lugar equivocado.
    const left = res.headers.get("x-ratelimit-remaining");
    if (left === "0" || res.status === 429) {
      const reset = res.headers.get("x-ratelimit-reset");
      const when = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : "un rato";
      throw new Error(`GitHub cortó por límite de consultas. Se repone a las ${when}. Define GITHUB_TOKEN para subir el límite.`);
    }
    throw new Error(`GitHub negó el permiso en ${path}. Leer el CI necesita \`checks: read\` y \`statuses: read\` en el workflow.`);
  }
  if (!res.ok) throw new Error(`GitHub respondió ${res.status} en ${path}`);
  return res.json();
}

// ──────────────────────────── Verificación ─────────────────────────

/**
 * El CI se lee sobre el head del PR, no sobre el merge commit: es ahí donde
 * corrieron los tests del trabajo entregado. GitHub tiene dos mecanismos
 * distintos y conviven, así que hay que mirar los dos.
 */
async function readCi(owner, repo, sha) {
  const [runs, combined] = await Promise.all([
    gh(`/repos/${owner}/${repo}/commits/${sha}/check-runs`),
    gh(`/repos/${owner}/${repo}/commits/${sha}/status`),
  ]);

  const checks = (runs.check_runs ?? []).map((c) => ({
    name: c.name,
    status: c.status,
    conclusion: c.conclusion,
  }));
  // `mergit/payable` lo escribe nuestro preflight para avisar al mantenedor, junto
  // al botón de merge, si mergear va a pagar. **No es CI y no entra en el
  // veredicto ni en la evidencia:** contarlo haría que "no hay bounty todavía"
  // se leyera como tests fallidos, y que el hash de evidencia cambiara según
  // cuándo pasó el preflight. Se excluye por el nombre exacto, no por prefijo,
  // para no tocar nunca el CI de un repositorio que se llame parecido.
  const statuses = (combined.statuses ?? [])
    .filter((s) => s.context !== PAYABLE_CONTEXT)
    .map((s) => ({
      name: s.context,
      conclusion: s.state,
    }));

  if (checks.length === 0 && statuses.length === 0) {
    // Sin señal no se inventa un veredicto. "No hay CI" no es "el CI pasó".
    return { green: null, reason: "el repositorio no reporta CI para este commit", checks: [] };
  }

  const all = [...checks, ...statuses];
  const pending = checks.filter((c) => c.status !== "completed");
  if (pending.length > 0) {
    return { green: false, pending: true, reason: `todavía corriendo: ${pending.map((c) => c.name).join(", ")}`, checks: all };
  }

  const failed = all.filter((c) => !PASSING.has(c.conclusion));
  if (failed.length > 0) {
    return { green: false, reason: `falló: ${failed.map((c) => c.name).join(", ")}`, checks: all };
  }
  return { green: true, reason: `${all.length} checks en verde`, checks: all };
}

/**
 * Serialización estable: el hash tiene que salir idéntico en cada corrida y en
 * cualquier máquina, porque queda grabado on-chain y alguien lo va a recalcular
 * para auditar por qué se pagó.
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export async function verifyPullRequest({ owner, repo, number }) {
  const pr = await gh(`/repos/${owner}/${repo}/pulls/${number}`);
  const ci = pr.merged ? await readCi(owner, repo, pr.head.sha) : { green: null, reason: "el PR no está mergeado", checks: [] };

  const evidence = {
    repository: `${owner}/${repo}`,
    pullRequest: number,
    author: pr.user?.login ?? null,
    headSha: pr.head?.sha ?? null,
    mergeCommitSha: pr.merged ? pr.merge_commit_sha : null,
    mergedAt: pr.merged_at ?? null,
    baseRef: pr.base?.ref ?? null,
    checks: ci.checks.sort((a, b) => a.name.localeCompare(b.name)),
  };

  const reasons = [];
  if (!pr.merged) reasons.push("el pull request no está mergeado");
  if (pr.merged && ci.green !== true) reasons.push(ci.reason);

  return {
    verdict: pr.merged && ci.green === true,
    reasons,
    merged: Boolean(pr.merged),
    ciGreen: ci.green,
    ciPending: ci.pending === true,
    ciReason: ci.reason,
    evidence,
    evidenceHash: keccak256(toHex(canonical(evidence))),
  };
}

// ─────────────────────────────── CLI ───────────────────────────────

// Solo cuando se invoca directamente. Importado desde settle.mjs, este archivo
// es una librería y no debe tocar process.argv ni terminar el proceso.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const target = parseTarget(args.find((a) => !a.startsWith("--")));

  if (!target) {
    console.error("uso: node verify.mjs <url del PR | owner/repo#123> [--json]");
    process.exit(2);
  }

  const result = await verifyPullRequest(target);

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const { evidence: e } = result;
    console.log(`repositorio  : ${e.repository}#${e.pullRequest}`);
    console.log(`autor        : ${e.author}`);
    console.log(`mergeado     : ${result.merged ? `sí, en ${e.mergeCommitSha?.slice(0, 10)} (${e.mergedAt})` : "no"}`);
    console.log(`CI           : ${result.ciGreen === null ? "sin señal" : result.ciGreen ? "verde" : "no"} — ${result.ciReason}`);
    console.log(`evidencia    : ${result.evidenceHash}`);
    console.log(`
veredicto    : ${result.verdict ? "PAGAR" : "NO PAGAR"}`);
    if (!result.verdict) for (const r of result.reasons) console.log(`               · ${r}`);
  }

  process.exit(result.verdict ? 0 : 1);
}

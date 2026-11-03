// Mergit dentro de GitHub Actions: el merge dispara el pago sin que nadie
// escriba un comando.
//
// Corre en el repositorio que publica bounties, ante dos eventos:
//   - push a main           → acaba de mergearse algo
//   - workflow_run de "CI"   → terminaron las pruebas de algún commit
// Los dos pueden llegar en cualquier orden, así que cada corrida re-verifica
// desde cero y deja que verify.mjs decida. Si el PR aún no está mergeado o el
// CI sigue corriendo, sale en silencio: el siguiente evento lo intentará de nuevo.
// Si el bounty ya se pagó, también sale en silencio.
//
// Qué lee:
//   - el cuerpo del PR, una línea "Bounty: #N" que dice qué bounty cobra
//   - el registro on-chain (MergitRegistry): si el autor reclamó su login desde
//     su wallet, ahí está el destinatario, y el agente comprueba la prueba en
//     GitHub antes de pagar.
//   - mergit.json en la rama principal, para quien todavía no lo reclamó.
//     En los dos casos el destinatario es del autor del PR, no una dirección
//     que el agente elija.
//
// Variables de entorno (las pone el workflow):
//   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH
//   MERGIT_AGENT_KEY  clave del agente. Sin ella, todo corre en modo ensayo.
//   MERGIT_PR         opcional: número de PR a revisar, para una corrida manual.
import { readFileSync, appendFileSync } from "node:fs";
import { formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { settleBounty } from "./settle.mjs";
import { escrowAddress } from "./chain.mjs";
import { resolveWallet, registryAddress } from "./registry.mjs";
import { listBounties, isLive, closedIssues, bountyForIssue, pointsAtIssue, settlementOf } from "./bounties.mjs";
import { verifyPullRequest } from "./verify.mjs";

// Arriba, con las demás constantes. Estaba al final del fichero, y como el bucle
// que paga corre en el nivel superior antes de llegar ahí, el 3-nov-2026 el
// agente pagó dos bounties y se cayó al escribir los recibos: "Cannot access
// 'SITE' before initialization". El dinero salió; el recibo no.
const SITE = "https://www.mergit.xyz";
const API = "https://api.github.com";
/** Marca invisible del recibo, para saber si ya se escribió. */
const RECIBO = "<!-- mergit-receipt -->";
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const EVENT = process.env.GITHUB_EVENT_NAME;
const SEND = Boolean(process.env.MERGIT_AGENT_KEY);
const [OWNER, NAME] = REPO.split("/");

async function gh(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mergit-agent",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} en ${path}`);
  return res.status === 204 ? null : res.json();
}

const summary = [];
const say = (line) => {
  console.log(line);
  summary.push(line);
};

// ───────────────────── 1. ¿Qué commit disparó esto? ──────────────────

// En Actions siempre hay payload. Fuera de Actions no, y un ensayo local con
// MERGIT_PR no necesita ninguno: no hay que morir por un fichero que no toca.
const payload = process.env.GITHUB_EVENT_PATH
  ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
  : {};
// Un número de PR pasado a mano gana sobre el evento: sirve para reintentar una corrida.
const asked = Number(process.env.MERGIT_PR || payload.inputs?.pr) || null;
let sha;
if (asked) sha = null;
else if (EVENT === "push") sha = payload.after;
else if (EVENT === "workflow_run") sha = payload.workflow_run.head_sha;
else if (EVENT === "workflow_dispatch") sha = null;
else {
  say(`Mergit: ignoring event \`${EVENT}\`.`);
  process.exit(0);
}

// ─────────────────── 2. ¿Qué pull requests toca ese commit? ───────────

let prs;
if (asked) prs = [await gh(`/repos/${REPO}/pulls/${asked}`)];
else if (EVENT === "workflow_dispatch") prs = [];
else prs = await gh(`/repos/${REPO}/commits/${sha}/pulls`);
if (!prs.length) {
  say(`Mergit: no pull request is associated with \`${sha?.slice(0, 7)}\`. Nothing to do.`);
  finish();
}

const repoInfo = await gh(`/repos/${REPO}`);
const registry = await loadRegistry(repoInfo.default_branch);
const registryFunders = await loadFunders(repoInfo.default_branch);

// Los bounties vivos, una vez por corrida. Sirven para dos cosas: comprobar que
// el número que escribió el autor todavía vale, y resolverlo desde el issue
// cuando no vale o cuando no lo escribió.
//
// ⚠️ **Solo los del escrow donde esta corrida va a liquidar.** `settleBounty`
// paga en `escrowAddress()` y en ninguno más, mientras que `listBounties()` lee
// todos los despliegues, y los números se repiten entre uno y otro: hay un
// bounty #1 en la v1 y otro #1 en la v2. Sin este filtro, resolver un bounty en
// un escrow y liquidar su número en otro es un pago al bounty equivocado.
let catalogo = [];
try {
  const donde = escrowAddress().toLowerCase();
  const todos = await listBounties();
  catalogo = todos.filter((b) => b.address.toLowerCase() === donde);
  const fuera = todos.length - catalogo.length;
  if (fuera) console.log(`(${fuera} bounties quedan fuera: están en otro escrow, y este agente liquida en ${donde})`);
} catch (e) {
  console.log(`(no se pudo leer el catálogo de bounties: ${e.message})`);
}
const verifier = agentAddress();
// Quién puede financiar un bounty que este agente liquide. Sin lista, cualquiera,
// y entonces la única defensa contra un bounty intruso es negarse si hay dos.
const funders = registryFunders;

for (const pr of prs) {
  const tag = `#${pr.number}`;
  const author = pr.user.login;
  const bountyMatch = (pr.body ?? "").match(/^\s*bounty:\s*#?(\d+)\s*$/im);

  let bountyId = null;
  let origen = "";

  // 0 · ¿ya se le pagó? Un PR mergeado recibe más de una corrida: la del merge y
  //     la del CI de main. La primera paga y cierra el bounty; la segunda ya no
  //     lo encuentra vivo, y sin este paso comentaba "did not pay" en un PR que
  //     acababa de cobrar. Se reconoce por la evidencia grabada en el evento de
  //     pago, que tiene que ser idéntica a la de este PR: repositorio, número,
  //     autor, commits y CI. Un PR que perdió la carrera no puede coincidir.
  if (pr.merged_at && catalogo.length) {
    const cierra = closedIssues(pr.body);
    const pagados = catalogo.filter((b) => b.closed
      && (b.id === bountyMatch?.[1] || cierra.some((n) => pointsAtIssue(b.uri, OWNER, NAME, n))));
    if (pagados.length) {
      const propia = await verifyPullRequest({ owner: OWNER, repo: NAME, number: pr.number }).catch(() => null);
      for (const b of propia?.evidenceHash ? pagados : []) {
        const ev = await settlementOf(escrowAddress(), b.id).catch(() => null);
        if (ev && ev.evidenceHash === String(propia.evidenceHash).toLowerCase()) {
          bountyId = b.id;
          origen = "its own settlement on chain";
          break;
        }
      }
    }
  }

  // 1 · la línea explícita, si nombra un bounty que sigue vivo y es nuestro
  if (!bountyId && bountyMatch) {
    const pedido = catalogo.find((b) => b.id === bountyMatch[1]);
    if (!catalogo.length) {
      bountyId = bountyMatch[1];
      origen = "the `Bounty: #N` line";
    } else if (pedido && isLive(pedido) && (!verifier || pedido.verifier === verifier.toLowerCase())) {
      bountyId = pedido.id;
      origen = "the `Bounty: #N` line";
    }
  }

  // 2 · el issue que el pull request cierra. El número del bounty es un detalle
  //     del escrow: cambia cada vez que se repone, y el autor no tiene por qué
  //     enterarse. El issue no cambia.
  if (!bountyId && catalogo.length) {
    const issues = closedIssues(pr.body);
    const intentos = [];
    for (const n of issues) {
      const r = bountyForIssue({ bounties: catalogo, owner: OWNER, repo: NAME, issue: n, verifier, funders });
      if (r.bounty) { bountyId = r.bounty.id; origen = `issue #${n}`; break; }
      intentos.push(r.reason);
      if (r.ambiguous) break;   // con ambigüedad no se sigue probando: se para
    }
    if (!bountyId && intentos.length) {
      const motivo = intentos[intentos.length - 1];
      say(`${tag}: ${motivo}. Not paid.`);
      if (pr.merged_at) {
        // Para el mantenedor, que es quien puede arreglarlo: el contribuidor no
        // puede lanzar el workflow. El 3-nov-2026 se mergeó antes de reponer el
        // bounty, y la salida no estaba escrita en ningún sitio.
        await commentOnce(pr.number, [
          `**Mergit did not pay this pull request.** ${motivo}.`,
          ``,
          `Maintainers: if the bounty is funded after this merge, run the Mergit workflow by hand with this pull request's number (Actions → Mergit → Run workflow), and the agent pays it then. Nothing is lost by merging first.`,
        ].join("\n"));
      }
      continue;
    }
  }

  if (!bountyId) {
    say(`${tag}: no \`Bounty: #N\` line and no issue with an open bounty behind it. Not a bounty.`);
    continue;
  }
  if (origen !== "the `Bounty: #N` line") {
    say(`${tag}: bounty #${bountyId} resolved from ${origen}, not from the description.`);
  }

  // El registro on-chain manda; `mergit.json` es el camino viejo, todavía válido
  // mientras el autor no reclame su login.
  const who = await resolveWallet(author, registry[author.toLowerCase()], TOKEN);
  const developer = who.wallet;
  if (!developer) {
    say(`${tag}: ${who.reason}. Not paid.`);
    if (pr.merged_at) await comment(pr.number, `**Mergit did not pay this pull request.** ${who.reason}, so there is nowhere to send bounty #${bountyId}.`);
    continue;
  }
  // `paidVia` y no un ternario: decir "from mergit.json" cuando la wallet vino
  // del README de perfil es mentir en el registro de la corrida.
  if (origen !== "its own settlement on chain") say(`${tag}: paying @${author} at ${developer} (${paidVia(who, author)}).`);

  const r = await settleBounty({ bountyId, target: { owner: OWNER, repo: NAME, number: pr.number }, developer, send: SEND });
  const v = r.verdict;

  // El pago está aprobado pero corre la ventana de objeción del financiador.
  if (r.stage === "pending") {
    const when = new Date(r.claimableAt * 1000).toISOString().replace("T", " ").slice(0, 19);
    say(`${tag}: settlement proposed, claimable at ${when} UTC. Waiting out the challenge window.`);
    continue;
  }

  // Esperas: otro evento lo reintentará. Sin comentario, para no ensuciar el PR.
  if (r.stage === "verify" && !v.merged) { say(`${tag}: not merged yet. Waiting.`); continue; }
  if (r.stage === "verify" && v.ciPending) { say(`${tag}: CI still running on \`${v.evidence.headSha.slice(0, 7)}\`. Waiting for green.`); continue; }
  if (r.done) {
    // La corrida que pagó pudo caerse después de la transacción y antes del
    // recibo. Ver `reponerRecibo`.
    if (r.status === "Settled" && pr.merged_at) await reponerRecibo(pr, bountyId, developer, who, author, r);
    else say(`${tag}: bounty #${bountyId} is already ${r.status}. Nothing to do.`);
    continue;
  }

  // Rechazos reales: el PR está mergeado pero no se va a pagar.
  if (!r.ok) {
    const why =
      r.stage === "verify" && v.ciGreen === null ? "the repository reports no CI for the pull request's head commit, and missing checks are not passing checks" :
      r.stage === "verify" ? "its CI did not pass on the head commit" :
      r.reason;
    say(`${tag}: not paid. ${why}.`);
    await comment(pr.number, `**Mergit did not pay bounty #${bountyId}:** ${why}.`);
    continue;
  }

  if (r.stage === "dry-run") {
    const what = r.finalizing ? "Would finalize the pending payment of" : "Would pay";
    say(`${tag}: verified. ${what} ${formatEther(r.payout)} ETH to ${developer} (dry run: no MERGIT_AGENT_KEY).`);
    continue;
  }

  // Con ventana de objeción el pago no sale todavía: queda propuesto.
  if (r.stage === "proposed") {
    say(`${tag}: settlement proposed for ${developer}. The funder can challenge it. ${r.url}`);
    await comment(pr.number, [
      `**Mergit approved this pull request.**`,
      ``,
      `Bounty #${bountyId} will pay \`${developer}\` once the challenge window closes. Until then, the funder can object once.`,
      ``,
      `Verified: merged, CI green on \`${v.evidence.headSha.slice(0, 7)}\` · evidence \`${r.verdict.evidenceHash}\` · [transaction](${r.url})`,
    ].join("\n"));
    continue;
  }

  // Pagado.
  say(`${tag}: PAID ${formatEther(r.event.paidToDeveloper)} ETH to ${developer}${r.finalized ? " (finalized after the challenge window)" : ""}. ${r.url}`);
  await comment(pr.number, recibo({
    bountyId, developer, via: paidVia(who, author), author,
    paid: r.event.paidToDeveloper, fee: r.event.protocolFee,
    headSha: v.evidence.headSha, evidenceHash: r.event.evidenceHash, tx: r.tx, url: r.url,
  }));
}

finish();

// ─────────────────────────────── Utilidades ─────────────────────────

/**
 * La dirección con la que este agente firma. Sirve para descartar bounties que
 * nombran a otro verificador: este agente no puede liquidarlos, y proponerlos
 * solo confunde.
 *
 * Sin clave (modo ensayo) se puede fijar con MERGIT_VERIFIER para que el ensayo
 * diga la verdad. Si no hay ninguna de las dos, no se filtra por verificador.
 */
function agentAddress() {
  if (process.env.MERGIT_VERIFIER) return process.env.MERGIT_VERIFIER;
  const key = process.env.MERGIT_AGENT_KEY;
  if (!key) return null;
  try {
    return privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`).address;
  } catch {
    return null;
  }
}

/**
 * Los financiadores que este repositorio acepta, de `mergit.json`:
 *
 *     { "funders": ["0x23E8…7686"] }
 *
 * Financiar es abierto, así que cualquiera puede publicar un bounty de 1 wei
 * apuntando a un issue nuestro para crear una ambigüedad que bloquee el pago.
 * Con la lista, ese bounty intruso no entra en la cuenta. Sin lista, la única
 * defensa es que el agente se niegue cuando hay más de uno, que es lo que hace.
 */
async function loadFunders(branch) {
  try {
    const file = await gh(`/repos/${REPO}/contents/mergit.json?ref=${branch}`);
    const json = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    const l = json.funders ?? [];
    return Array.isArray(l) ? l.map((x) => String(x).toLowerCase()) : [];
  } catch {
    return [];
  }
}

async function loadRegistry(branch) {
  try {
    const file = await gh(`/repos/${REPO}/contents/mergit.json?ref=${branch}`);
    const json = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    return Object.fromEntries(Object.entries(json.wallets ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  } catch {
    return {};
  }
}

async function comment(number, body) {
  if (!TOKEN) return;
  try {
    await gh(`/repos/${REPO}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }), headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.log(`(could not comment on #${number}: ${e.message})`);
  }
}

/**
 * Comenta solo si ese mismo texto no está ya. Un merge dispara dos corridas, y
 * el 3-nov-2026 el PR #12 recibió el mismo rechazo dos veces seguidas.
 */
async function commentOnce(number, body) {
  if (!TOKEN) return;
  try {
    const previos = await gh(`/repos/${REPO}/issues/${number}/comments?per_page=100`);
    if ((previos || []).some((c) => String(c.body || "").trim() === body.trim())) return;
  } catch { /* si no se puede leer, se comenta: mejor repetido que callado */ }
  await comment(number, body);
}

function finish() {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Mergit\n\n${summary.map((l) => `- ${l}`).join("\n")}\n`);
  process.exit(0);
}

function recibo({ bountyId, developer, via, author, paid, fee, headSha, evidenceHash, tx, url }) {
  return [
    RECIBO,
    `**Mergit paid this pull request.**`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Bounty | #${bountyId} |`,
    `| Paid to | \`${developer}\` — ${via} |`,
    `| Amount | ${formatEther(paid)} ETH (protocol fee ${formatEther(fee)} ETH) |`,
    `| Verified | merged, CI green on head commit \`${headSha.slice(0, 7)}\` |`,
    `| Evidence hash | \`${evidenceHash}\` |`,
    `| Transaction | [${tx.slice(0, 10)}…${tx.slice(-4)}](${url}) on GIWA Sepolia |`,
    ``,
    `Your record: ${SITE}/p/${author}`,
    ``,
    `Put this in your profile README and it will show what your merged work was paid, read straight from the chain:`,
    ``,
    "```markdown",
    `[![Mergit](${SITE}/badge/${author}.svg)](${SITE}/p/${author})`,
    "```",
    ``,
    `Merge it. Get paid.`,
  ].join("\n");
}

/**
 * Escribe el recibo de un pago que ya ocurrió, si falta y si el pago fue a este
 * pull request. Que fue a este PR lo dice la cadena: la evidencia grabada en el
 * evento tiene que ser idéntica a la que el agente acaba de recalcular, y la
 * wallet, la misma. Un PR que perdió la carrera por el bounty no pasa.
 */
async function reponerRecibo(pr, bountyId, developer, who, author, r) {
  const tag = `#${pr.number}`;
  const previos = await gh(`/repos/${REPO}/issues/${pr.number}/comments?per_page=100`);
  const yaEsta = (previos || []).some((c) => {
    const b = String(c.body || "");
    return b.includes(RECIBO) || b.startsWith("**Mergit paid this pull request.**");
  });
  if (yaEsta) {
    say(`${tag}: bounty #${bountyId} is already Settled, and its receipt is there. Nothing to do.`);
    return;
  }
  const ev = await settlementOf(escrowAddress(), bountyId).catch(() => null);
  if (!ev) {
    say(`${tag}: bounty #${bountyId} is Settled but its event is not indexed yet. Run again in a minute.`);
    return;
  }
  const mismaEvidencia = ev.evidenceHash === String(r.verdict.evidenceHash).toLowerCase();
  const mismaWallet = ev.developer === String(developer).toLowerCase();
  if (!mismaEvidencia || !mismaWallet) {
    say(`${tag}: bounty #${bountyId} was paid, but not for this pull request. Nothing to do.`);
    return;
  }
  const url = `https://sepolia-explorer.giwa.io/tx/${ev.tx}`;
  say(`${tag}: bounty #${bountyId} was paid to this pull request without a receipt. Writing it now. ${url}`);
  await comment(pr.number, recibo({
    bountyId, developer, via: paidVia(who, author), author,
    paid: ev.paidToDeveloper, fee: ev.protocolFee,
    headSha: r.verdict.evidence.headSha, evidenceHash: ev.evidenceHash, tx: ev.tx, url,
  }));
}

/**
 * De donde salio la direccion que cobro. Son tres fuentes y hay que nombrarlas
 * distinto: decir "mergit.json" cuando el pago vino del README de perfil es
 * mentir justo en el sitio donde el recibo tiene que ser exacto.
 */
function paidVia(who, author) {
  if (who.source === "registry") return `registered on-chain by @${author}, proof in ${who.proof}`;
  if (who.source === "profile") return `@${author}'s profile README`;
  return `@${author}'s wallet in \`mergit.json\``;
}
// Avisa de lo que está a punto de costar dinero, antes de que cueste.
//
// El 25 de octubre los bounties #9 y #10 vencieron con cuatro pull requests
// listos para cobrar. No falló el producto: falló que nadie miró el calendario.
// El contrato no deja liquidar pasado el plazo, así que ocho personas
// trabajaron gratis por una fecha.
//
// Mira dos cosas cada día:
//   1. bounties abiertos a menos de N horas de vencer **con pull requests que
//      los nombran y siguen sin mergear**. Un bounty que vence sin candidatos no
//      es urgente: es un bounty que nadie tomó.
//   2. corridas atascadas en `action_required`, que es el botón de aprobar el
//      workflow de un primerizo sin pulsar. Sin CI no hay pago.
//
// **No tiene ninguna clave y no toca fondos.** Comenta en un issue fijo, que es
// lo que llega al correo. Edita el cuerpo siempre, y **solo comenta cuando hay
// algo urgente**, para que el aviso signifique algo.

//
// ⚠️ Un pull request puede reclamar un bounty de dos maneras: con la línea
// `Bounty: #N` o cerrando el issue que el bounty financia. **Las dos cuentan**,
// y por eso esto importa `agent/bounties.mjs` en vez de buscar solo la línea.
// Mirando solo la línea, un bounty repuesto —que es el caso que hizo falta este
// vigilante— se vería como un bounty que nadie tomó, justo cuando media docena
// de personas lo están esperando.
import { listBounties, isLive, closedIssues, pointsAtIssue, pointsAtRepo, LINEA_BOUNTY } from "../agent/bounties.mjs";

const MARCA = "<!-- mergit-watchdog -->";

const {
  GITHUB_TOKEN, GITHUB_REPOSITORY,
  AVISAR_A = "odiseo159-beep",
  HORAS = "72",
  MERGIT_VERIFIER = "",
  DRY_RUN = "",
  // El escrow donde liquida este repositorio. Avisar de un bounty que el agente
  // no puede pagar es avisar de nada.
  MERGIT_ESCROW = "0xffcf206ce1474263aaa3336fb9c8bc3d632e5879",
} = process.env;

const seco = DRY_RUN === "1";
const umbral = Number(HORAS) * 3600 * 1000;
const [owner, repo] = String(GITHUB_REPOSITORY).split("/");

async function gh(path, init) {
  const r = await fetch("https://api.github.com" + path, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      ...(GITHUB_TOKEN ? { Authorization: "Bearer " + GITHUB_TOKEN } : {}),
      ...((init && init.headers) || {}),
    },
  });
  if (!r.ok) throw new Error("GitHub " + r.status + " en " + path);
  return r.status === 204 ? null : r.json();
}

async function bountiesVivos() {
  // Un solo escrow, y si no responde, la corrida falla: GitHub avisa de un cron
  // que falla, y un vigilante que dice "no hay bounties" porque no pudo leer es
  // peor que uno que se queja.
  return (await listBounties({ address: MERGIT_ESCROW })).filter((b) =>
    isLive(b) && (!MERGIT_VERIFIER || b.verifier === MERGIT_VERIFIER.toLowerCase()));
}

/** ¿Este pull request reclama este bounty? Las mismas dos vías que el agente. */
const reclama = (pr, b) => {
  const body = String(pr.body || "");
  const m = body.match(LINEA_BOUNTY);
  if (m && m[1] === b.id && pointsAtRepo(b.uri, owner, repo)) return true;
  return closedIssues(body).some((n) => pointsAtIssue(b.uri, owner, repo, n));
};

async function main() {
  const vivos = await bountiesVivos();
  const abiertos = await gh("/repos/" + owner + "/" + repo + "/pulls?state=open&per_page=100");
  const candidatosDe = (b) => (abiertos || []).filter((p) => reclama(p, b));

  const urgentes = [];
  for (const b of vivos) {
    const falta = b.deadline * 1000 - Date.now();
    const candidatos = candidatosDe(b);
    if (falta <= umbral && candidatos.length) urgentes.push({ b, candidatos, falta });
  }

  // Un pull request **mergeado** que reclama un bounty que **sigue vivo** es un
  // pago que se perdió: una corrida cancelada por la cola del workflow, una que
  // se cayó, o un merge antes de financiar. Nada más lo detecta, porque ningún
  // evento nuevo va a disparar al agente sobre ese PR.
  const hace14 = Date.now() - 14 * 86400000;
  const mergeados = ((await gh("/repos/" + owner + "/" + repo + "/pulls?state=closed&sort=updated&direction=desc&per_page=50")) || [])
    .filter((p) => p.merged_at && Date.parse(p.merged_at) >= hace14);
  const sinPagar = [];
  for (const b of vivos) {
    for (const p of mergeados.filter((p) => reclama(p, b))) sinPagar.push({ b, p });
  }

  let atascadas = [];
  try {
    const runs = await gh("/repos/" + owner + "/" + repo + "/actions/runs?status=action_required&per_page=50");
    atascadas = (runs && runs.workflow_runs) || [];
  } catch { /* sin permiso de actions, se informa igual del resto */ }

  const horas = (ms) => (ms / 3600000).toFixed(1);
  const lineas = [];

  if (sinPagar.length) {
    lineas.push("### Merged, and the bounty is still open", "");
    for (const { b, p } of sinPagar) {
      lineas.push("- **#" + p.number + "** was merged " + String(p.merged_at).slice(0, 16).replace("T", " ")
        + " UTC and claims **bounty #" + b.id + "**, which is still open. The payment did not happen."
        + " Run Actions → Mergit → Run workflow with `" + p.number + "`, before the bounty closes in "
        + horas(b.deadline * 1000 - Date.now()) + " h.");
    }
    lineas.push("");
  }

  if (urgentes.length) {
    lineas.push("### Bounties about to expire with work waiting", "");
    for (const u of urgentes) {
      lineas.push("- **Bounty #" + u.b.id + "** (escrow " + u.b.escrow + ") closes in **" + horas(u.falta) + " h**, and "
        + u.candidatos.length + " open pull request" + (u.candidatos.length === 1 ? "" : "s") + " claim" + (u.candidatos.length === 1 ? "s" : "") + " it: "
        + u.candidatos.map((p) => "#" + p.number).join(", ")
        + ". After the deadline the contract refuses to settle, and the only way out is a refund.");
    }
    lineas.push("");
  }

  if (atascadas.length) {
    lineas.push("### Workflow runs waiting for approval", "");
    for (const r of atascadas.slice(0, 10)) {
      lineas.push("- [" + r.name + " on " + (r.head_branch || "?") + "](" + r.html_url + ") has been waiting since "
        + String(r.created_at).slice(0, 16).replace("T", " ") + " UTC. Until it runs there is no CI, and without CI the agent pays nobody.");
    }
    lineas.push("");
  }

  const estado = vivos.length
    ? vivos.map((b) => {
        const c = candidatosDe(b);
        return "- Bounty **#" + b.id + "** (" + b.escrow + "), " + horas(b.deadline * 1000 - Date.now()) + " h left"
          + (c.length ? ", claimed by " + c.map((p) => "#" + p.number).join(", ") : ", nobody has claimed it yet");
      }).join("\n")
    : "- No bounty is open right now.";

  const cuerpo = [
    MARCA,
    "Checked automatically once a day. Nothing here is written by hand, and this issue holds no key.",
    "",
    "## Open bounties",
    "",
    estado,
    "",
    "_Last checked " + new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC._",
  ].join("\n");

  const alerta = lineas.length
    ? ["@" + AVISAR_A + " something here needs a hand today.", "", ...lineas,
       "_Posted by the watchdog. It only comments when something is about to cost money._"].join("\n")
    : null;

  if (seco) {
    console.log("—— cuerpo del issue ——\n" + cuerpo);
    console.log("\n—— alerta ——\n" + (alerta || "(nada urgente, no comentaría)"));
    return;
  }

  // Un issue fijo. Editar el cuerpo no notifica a nadie, así que el aviso va en
  // un comentario, y solo cuando hay algo urgente.
  const encontrados = await gh("/repos/" + owner + "/" + repo + "/issues?state=all&per_page=100&labels=watchdog");
  let issue = (encontrados || []).find((i) => String(i.body || "").includes(MARCA));

  if (!issue) {
    issue = await gh("/repos/" + owner + "/" + repo + "/issues", {
      method: "POST",
      body: JSON.stringify({ title: "Mergit watchdog", body: cuerpo, labels: ["watchdog"] }),
    });
    console.log("issue creado: #" + issue.number);
  } else {
    await gh("/repos/" + owner + "/" + repo + "/issues/" + issue.number, {
      method: "PATCH", body: JSON.stringify({ body: cuerpo, state: "open" }),
    });
    console.log("issue #" + issue.number + " actualizado");
  }

  if (alerta) {
    await gh("/repos/" + owner + "/" + repo + "/issues/" + issue.number + "/comments", {
      method: "POST", body: JSON.stringify({ body: alerta }),
    });
    console.log("aviso publicado");
  } else {
    console.log("nada urgente, sin aviso");
  }
}

main().catch((e) => { console.error("watchdog:", e.message); process.exit(1); });

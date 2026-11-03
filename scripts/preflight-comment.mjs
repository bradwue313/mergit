// Le dice a quien abre un pull request qué le falta para poder cobrar, antes de
// que trabaje gratis. Seis de las ocho primeras personas que mandaron trabajo no
// podían cobrar, y ninguna lo supo hasta después.
//
// Comprueba dos cosas y nada más:
//   1. que el pull request apunte a un bounty vivo que nombre a nuestro agente
//      como verificador, por la línea `Bounty: #N` **o** por el issue que cierra
//   2. que el autor tenga una wallet que el agente pueda resolver
//
// Y lo dice en dos sitios:
//   - **un comentario** en el pull request, para quien lo mandó. Uno solo, que
//     se reescribe en cada cambio: ocho comentarios del mismo bot son ruido.
//   - **el estado `mergit/payable`**, junto al botón de merge, para quien lo
//     mergea. El 3-nov-2026 se mergearon dos pull requests antes de reponer sus
//     bounties: el comentario no sirvió porque el preflight nunca había corrido
//     sobre ellos, y nada en la pantalla del merge avisaba. Ahora sí: en verde
//     "merging pays bounty #N", en rojo "merging will NOT pay" y por qué.
//
// El agente y la página del expediente **excluyen `mergit/payable` del CI y de
// la evidencia** (agent/verify.mjs, site/p.html). Si se cambia el nombre aquí,
// hay que cambiarlo allí, o "todavía no hay bounty" se leería como tests rotos.
//
// Dos modos:
//   - con PR_NUMBER (evento `pull_request_target`): ese pull request, comentario
//     y estado.
//   - sin PR_NUMBER (cron o a mano): todos los abiertos. Solo estados, y solo
//     **edita** comentarios que ya existan: no crea ninguno, para no mandar diez
//     notificaciones de golpe. Es lo que pone al día el estado cuando lo que
//     cambió fue la cadena (se repuso un bounty) y no el pull request.
//
// **No tiene ninguna clave y no toca fondos.** Lee la cadena por el explorador y
// el README por raw.githubusercontent.com, así que no instala dependencias.
//
// ⚠️ Lo que decide aquí tiene que ser lo mismo que decide el agente al pagar, y
// por eso **importa `agent/bounties.mjs` en lugar de repetir la lógica**. Un
// preflight que contradice al pagador es peor que no tener preflight.
import { listBounties, isLive, closedIssues, bountyForIssue } from "../agent/bounties.mjs";

const EXPLORER = "https://sepolia-explorer.giwa.io";
const REGISTRY = "0x79d44543d20c7c6653f6626687d67d2cd7f2af9c";
const MARCA = "<!-- mergit-preflight -->";
const CONTEXTO = "mergit/payable";
const SITE = "https://www.mergit.xyz";

const {
  GITHUB_TOKEN, GITHUB_REPOSITORY,
  PR_NUMBER, PR_AUTHOR, PR_BODY = "", PR_HEAD_SHA = "",
  MERGIT_VERIFIER = "", DRY_RUN = "",
  // El escrow donde este repositorio liquida. Los números de bounty se repiten
  // entre despliegues, así que mirar más de uno es mirar bounties que el agente
  // no va a pagar.
  MERGIT_ESCROW = "0xffcf206ce1474263aaa3336fb9c8bc3d632e5879",
} = process.env;

const seco = DRY_RUN === "1";
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

async function logsOf(address) {
  const r = await fetch(EXPLORER + "/api/v2/addresses/" + address + "/logs");
  if (!r.ok) throw new Error("explorador " + r.status);
  const d = await r.json();
  return (d.items || []).filter((it) => it.decoded).map((it) => {
    const p = Object.fromEntries(it.decoded.parameters.map((x) => [x.name, x.value]));
    return { kind: it.decoded.method_call.split("(")[0], ...p };
  });
}

/** La wallet del autor, en el mismo orden que usa el agente antes de pagar. */
async function walletDe(login, registro) {
  const claim = registro.get(login.toLowerCase());
  if (claim) return { wallet: claim, source: "the on-chain registry" };

  try {
    const r = await fetch("https://raw.githubusercontent.com/" + login + "/" + login + "/HEAD/README.md");
    if (r.ok) {
      const body = await r.text();
      const found = new Set();
      for (const line of body.split(/[\r\n]+/)) {
        if (!/mergit/i.test(line)) continue;
        const m = line.match(/0x[a-fA-F0-9]{40}/);
        if (m) found.add(m[0].toLowerCase());
      }
      const u = [...found];
      if (u.length === 1) return { wallet: u[0], source: "the README of " + login + "/" + login };
      if (u.length > 1) return { wallet: null, varias: u.length };
    }
  } catch { /* sin README */ }
  return { wallet: null };
}

/** Las reclamaciones del registro, una vez por corrida y no una por pull request. */
async function registro() {
  const out = new Map();
  try {
    for (const e of await logsOf(REGISTRY)) {
      if (e.kind === "Claimed") out.set(String(e.login || "").toLowerCase(), String(e.wallet).toLowerCase());
    }
  } catch { /* el registro no manda: queda el README */ }
  return out;
}

const si = (t) => "- ✅ " + t;
const no = (t) => "- ❌ " + t;
/** Un estado de commit admite 140 caracteres. Lo largo va en el comentario. */
const corto = (t) => (t.length <= 140 ? t : t.slice(0, 139) + "…");

/**
 * Lo que este pull request puede cobrar, sin tocar nada. Devuelve el comentario,
 * el estado para el botón de merge, y si el pull request reclama algo: uno que
 * no nombra bounty ni cierra issue es un pull request normal y no lleva estado.
 */
function revisar({ number, author, body, mios, vivos, porId, nuestro, w }) {
  const m = String(body || "").match(/^[ \t]*bounty:[ \t]*#?(\d+)[ \t]*$/im);
  const cierra = closedIssues(body);
  const filas = [];
  let listo = true;

  // El mismo orden que el agente: la línea explícita si sigue sirviendo, y si no,
  // el issue que el pull request cierra.
  let elegido = null;
  let via = "";
  if (m && porId.has(m[1])) {
    const b = porId.get(m[1]);
    if (isLive(b) && nuestro(b)) { elegido = b; via = "line"; }
  }

  let ambiguo = null;
  if (!elegido) {
    for (const n of cierra) {
      const r = bountyForIssue({ bounties: mios, owner, repo, issue: n, verifier: MERGIT_VERIFIER || undefined });
      if (r.bounty) { elegido = r.bounty; via = "issue #" + n; break; }
      if (r.ambiguous) { ambiguo = r.reason; break; }
    }
  }

  const dias = (b) => ((b.deadline * 1000 - Date.now()) / 86400000).toFixed(1);
  let motivo = "";   // por qué no paga, en una línea, para el estado

  if (elegido && via === "line") {
    filas.push(si("**Bounty #" + elegido.id + "** is open on escrow " + elegido.escrow + ", and closes in " + dias(elegido) + " days."));
  } else if (elegido) {
    filas.push(si("This pull request closes " + via + ", and **bounty #" + elegido.id
      + "** funds it — open on escrow " + elegido.escrow + ", closing in " + dias(elegido) + " days. "
      + "The agent resolves it from the issue, so you do not need to touch the `Bounty: #N` line"
      + (m ? ", even though yours names #" + m[1] + ", which is no longer open" : "") + "."));
  } else if (ambiguo) {
    listo = false;
    motivo = "more than one open bounty fits the issue this closes";
    filas.push(no("**More than one open bounty points at the issue this closes**, so the agent refuses to choose. " + ambiguo));
  } else {
    listo = false;
    motivo = cierra.length
      ? "no open bounty for issue #" + cierra.join(", #") + ". Fund it first, or re-run Mergit after funding"
      : (m ? "bounty #" + m[1] + " is not open" : "this pull request points at no bounty");
    const comoApuntar = cierra.length
      ? "This pull request closes #" + cierra.join(", #") + ", but no open bounty points at "
        + (cierra.length === 1 ? "it" : "any of them") + "."
      : "The description has no `Closes #N` line either, so there is no issue to go by.";
    const linea = m
      ? "**Bounty #" + m[1] + " is not open"
        + (porId.has(m[1]) ? " any more: it was settled, refunded, or its deadline passed" : ", and may never have existed on this escrow")
        + ".** "
      : "**This pull request does not point at any bounty.** ";
    filas.push(no(linea + comoApuntar + " The surest way is a line saying `Closes #N` with the issue number: that one never changes, even when a bounty is refunded and funded again under a new number."));
  }

  if (w.wallet) {
    filas.push(si("The agent can pay **@" + author + "** at `" + w.wallet + "`, read from " + w.source + "."));
  } else if (w.varias) {
    listo = false;
    motivo = motivo || "@" + author + "'s profile README names " + w.varias + " addresses, so the agent pays none";
    filas.push(no("Your profile README names **" + w.varias + " different addresses** next to Mergit. The agent does not guess, so it pays none of them. Leave one."));
  } else {
    listo = false;
    motivo = motivo || "@" + author + " has no wallet the agent can read";
    filas.push(no("**The escrow has no address for @" + author + ".** A GitHub login is not an address. Put one line naming Mergit and your address in the README of `" + author + "/" + author + "`, the repository that has your own name. Nothing to connect, no gas, nothing to sign."));
  }

  // Qué hay abierto, solo cuando el pull request no encontró nada. Con el bounty
  // ya resuelto, enumerar los demás es ruido.
  const abiertos = vivos.length && !elegido
    ? "\nOpen right now: " + vivos.map((b) => "**bounty #" + b.id + "** for " + (b.uri || "(no reference)")).join(" · ") + ".\n"
    : "";

  const cuerpo = [
    MARCA,
    listo
      ? "### Ready to be paid\n\nMerge this with CI green and the agent settles the bounty on its own, then leaves the receipt here. Nobody approves the payment."
      : "### Not payable yet\n\nA machine checked the two things that decide whether you can be paid. This is not a review of your code.",
    "",
    filas.join("\n"),
    abiertos,
    "---",
    "",
    "On a first pull request the CI waits for a maintainer to approve the workflow run, so a missing check here is not something you did wrong.",
    "",
    "Read from GIWA Sepolia just now. The full record lives at " + SITE + "/p/" + author,
  ].join("\n");

  const estado = listo
    ? { state: "success", description: corto("Merging pays bounty #" + elegido.id + " to @" + author + "."), target_url: SITE + "/p/" + author }
    : {
        state: "failure",
        description: corto("Merging will NOT pay: " + motivo + "."),
        // Sin bounty, lo que falta es financiarlo; sin wallet, que el autor la ponga.
        target_url: elegido || ambiguo ? SITE + "/start" : SITE + "/post",
      };

  return { cuerpo, estado, reclama: Boolean(m || cierra.length) };
}

/** Escribe el estado solo si cambió: cada corrida lo repetiría, y GitHub los acumula. */
async function ponerEstado(sha, estado) {
  const actual = await gh("/repos/" + owner + "/" + repo + "/commits/" + sha + "/status").catch(() => null);
  const previo = ((actual && actual.statuses) || []).find((s) => s.context === CONTEXTO);
  if (previo && previo.state === estado.state && previo.description === estado.description) return "sin cambios";
  await gh("/repos/" + owner + "/" + repo + "/statuses/" + sha, {
    method: "POST", body: JSON.stringify({ ...estado, context: CONTEXTO }),
  });
  return estado.state;
}

async function main() {
  // Solo el escrow donde liquida este repositorio. Ver MERGIT_ESCROW arriba.
  const aqui = MERGIT_ESCROW.toLowerCase();
  const mios = (await listBounties()).filter((b) => b.address.toLowerCase() === aqui);
  const porId = new Map(mios.map((b) => [b.id, b]));
  const nuestro = (b) => !MERGIT_VERIFIER || b.verifier === MERGIT_VERIFIER.toLowerCase();
  const vivos = mios.filter((b) => isLive(b) && nuestro(b));
  const reg = await registro();
  const comun = { mios, vivos, porId, nuestro };

  const objetivos = PR_NUMBER
    ? [{ number: Number(PR_NUMBER), author: PR_AUTHOR, body: PR_BODY, sha: PR_HEAD_SHA, crear: true }]
    : ((await gh("/repos/" + owner + "/" + repo + "/pulls?state=open&per_page=100")) || []).map((p) => ({
        number: p.number, author: p.user.login, body: p.body || "", sha: p.head.sha, crear: false,
      }));

  for (const pr of objetivos) {
    const w = await walletDe(pr.author, reg);
    const r = revisar({ ...pr, ...comun, w });

    if (seco) {
      console.log("#" + pr.number + " " + (r.reclama ? r.estado.state + ": " + r.estado.description : "(no reclama nada: sin estado)"));
      if (PR_NUMBER) console.log(r.cuerpo);
      continue;
    }

    if (r.reclama && pr.sha) {
      try {
        console.log("#" + pr.number + " estado: " + (await ponerEstado(pr.sha, r.estado)));
      } catch (e) {
        console.log("#" + pr.number + " no se pudo escribir el estado: " + e.message);
      }
    }

    const previos = await gh("/repos/" + owner + "/" + repo + "/issues/" + pr.number + "/comments?per_page=100");
    const mio = (previos || []).find((c) => String(c.body || "").includes(MARCA));
    if (mio) {
      if (mio.body !== r.cuerpo) {
        await gh("/repos/" + owner + "/" + repo + "/issues/comments/" + mio.id, {
          method: "PATCH", body: JSON.stringify({ body: r.cuerpo }),
        });
        console.log("#" + pr.number + " comentario actualizado");
      }
    } else if (pr.crear) {
      await gh("/repos/" + owner + "/" + repo + "/issues/" + pr.number + "/comments", {
        method: "POST", body: JSON.stringify({ body: r.cuerpo }),
      });
      console.log("#" + pr.number + " comentario creado");
    }
  }
}

main().catch((e) => { console.error("preflight:", e.message); process.exit(1); });

// Qué bounties están vivos, y a qué issue apunta cada uno.
//
// Existe para que un contribuidor no tenga que saber el número del bounty.
// Ese número es un detalle del escrow, y lo estábamos metiendo en el contrato
// social con quien manda trabajo: cuatro de los primeros ocho escribieron el
// número del issue, que es lo que estaban mirando, y cuando hubo que devolver
// y reponer #9 y #10, los cuatro que lo tenían bien pasaron a tenerlo mal.
//
// Con esto el agente puede ir del pull request al issue que cierra, y del issue
// al bounty que lo financia.
//
// ───────────────────────────── Lo que NO hace ──────────────────────────────
//
// **No elige.** El `metadataURI` lo escribe quien financia, y financiar es
// abierto: cualquiera puede publicar un bounty de 1 wei apuntando a tu issue y
// poniendo a tu agente de verificador. Si eso bastara para elegir, bastaría
// para desviar un pago.
//
// Por eso, cuando más de un bounty encaja con el mismo issue, **esto devuelve
// la ambigüedad y no paga nadie**. Quien lo llama puede estrechar con una lista
// de financiadores aceptados (`funders` en `mergit.json`). Lo que no existe es
// "quedarse con el primero".
const EXPLORER = "https://sepolia-explorer.giwa.io";

/** Los dos escrows desplegados. `from` deja fuera los bounties de prueba. */
export const ESCROWS = [
  { v: "v1", address: "0xffcf206ce1474263aaa3336fb9c8bc3d632e5879", from: 3 },
  { v: "v2", address: "0x48d506080abdbed11f1acbe40f799301d9612ad5", from: 1 },
];

/** Más páginas que esto es un explorador que no termina, no un escrow con historia. */
const MAX_PAGINAS = 40;

/**
 * Todos los eventos decodificados de un contrato, **todas las páginas**.
 *
 * El explorador entrega 50 por página, los más nuevos primero. Leer solo la
 * primera funcionó mientras el escrow tenía 22 eventos; con unos 15 bounties
 * más, los más viejos se habrían caído de la lista y el agente habría dicho "no
 * open bounty" sobre un bounty vivo. Si una página falla, falla todo: una lista
 * a medias no se distingue de una lista completa.
 */
export async function logsOf(address) {
  const out = [];
  let params = null;
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    let d;
    try {
      const r = await fetch(`${EXPLORER}/api/v2/addresses/${address}/logs${qs}`, { signal: ctl.signal });
      if (!r.ok) throw new Error(`explorer answered ${r.status}`);
      d = await r.json();
    } finally {
      clearTimeout(t);
    }
    for (const it of d.items || []) {
      if (!it.decoded) continue;
      const p = Object.fromEntries(it.decoded.parameters.map((x) => [x.name, x.value]));
      out.push({ kind: it.decoded.method_call.split("(")[0], tx: it.transaction_hash, ...p });
    }
    params = d.next_page_params;
    if (!params) return out;
  }
  throw new Error(`explorer kept paginating past ${MAX_PAGINAS} pages for ${address}`);
}

/**
 * Los bounties con su estado calculado de los eventos. No firma nada y no
 * necesita ABI.
 *
 * Sin argumentos, los de todos los escrows conocidos, y uno que no responde se
 * salta: sirve para mostrar. Con `{ address }`, **solo ese escrow, y si no
 * responde, lanza**. Quien decide un pago tiene que usar esa forma: tragarse el
 * error dejaba una caída del explorador idéntica a "no hay bounties", y el
 * agente confiaba entonces a ciegas en la línea `Bounty: #N`.
 */
export async function listBounties({ address: solo } = {}) {
  const fuentes = solo
    ? [ESCROWS.find((e) => e.address === solo.toLowerCase()) ?? { v: "?", address: solo.toLowerCase(), from: 1 }]
    : ESCROWS;
  const out = [];
  for (const { v, address, from } of fuentes) {
    let ev;
    try { ev = await logsOf(address); } catch (e) { if (solo) throw e; continue; }
    const cerrados = new Set();
    for (const e of ev) {
      if (e.kind === "BountySettled" || e.kind === "BountyRefunded") cerrados.add(String(e.bountyId));
    }
    for (const e of ev) {
      if (e.kind !== "BountyPosted") continue;
      if (Number(e.bountyId) < from) continue;
      out.push({
        id: String(e.bountyId),
        escrow: v,
        address,
        funder: String(e.funder || "").toLowerCase(),
        verifier: String(e.verifier || "").toLowerCase(),
        amount: String(e.amount ?? "0"),
        deadline: Number(e.deadline || 0),
        uri: String(e.metadataURI || ""),
        closed: cerrados.has(String(e.bountyId)),
      });
    }
  }
  return out;
}

/**
 * El evento de pago de un bounty, si existe: a quién, cuánto, con qué evidencia
 * y en qué transacción. Sirve para reponer un recibo que no llegó a escribirse.
 */
export async function settlementOf(address, bountyId) {
  for (const e of await logsOf(address)) {
    if (e.kind !== "BountySettled" || String(e.bountyId) !== String(bountyId)) continue;
    return {
      developer: String(e.developer).toLowerCase(),
      paidToDeveloper: BigInt(e.paidToDeveloper),
      protocolFee: BigInt(e.protocolFee),
      evidenceHash: String(e.evidenceHash).toLowerCase(),
      tx: e.tx,
    };
  }
  return null;
}

/** Para meter un login o un repo en una expresión regular sin que "." valga por todo. */
const literal = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** La referencia del bounty, sin esquema ni www: `github.com/owner/repo/...`. */
const limpiar = (uri) => String(uri || "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "");

/**
 * ¿El bounty se financió para trabajo en este repositorio?
 *
 * Un pull request que nombra un bounty con `Bounty: #N` solo puede cobrar uno
 * cuyo enunciado apunte a su propio repositorio. Sin esta comprobación, un PR
 * de cualquier repositorio que use este agente podía cobrar un bounty
 * financiado para otro: el escrow v1 no guarda el enunciado, solo lo emite en
 * el evento, así que el contrato no lo puede impedir y esta es la única barrera.
 */
export function pointsAtRepo(uri, owner, repo) {
  return new RegExp(`^github\\.com/${literal(owner)}/${literal(repo)}(?:[/?#]|$)`, "i").test(limpiar(uri));
}

/** Vivo = ni liquidado ni devuelto, y con plazo por delante. */
export const isLive = (b, now = Date.now()) => !b.closed && b.deadline * 1000 > now;

/** Los números de issue que este pull request dice cerrar. */
export function closedIssues(body) {
  const out = new Set();
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[ \t:]*#(\d+)/gi;
  let m;
  while ((m = re.exec(String(body || "")))) out.add(Number(m[1]));
  return [...out];
}

/** ¿El enunciado de este bounty apunta a este issue de este repositorio? */
export function pointsAtIssue(uri, owner, repo, number) {
  const re = new RegExp(`^github\\.com/${literal(owner)}/${literal(repo)}/issues/${Number(number)}(?:[^0-9]|$)`, "i");
  return re.test(limpiar(uri));
}

/**
 * Cómo se lee la línea `Bounty: #N`. **Una sola línea, sin saltar a la
 * siguiente**: con `\s*` el agente aceptaba "Bounty:" en una línea y el número
 * en otra, y el preflight y el vigilante no. Los tres usan ahora esta.
 */
export const LINEA_BOUNTY = /^[ \t]*bounty:[ \t]*#?(\d+)[ \t]*$/im;

/**
 * El bounty que financia este issue, si no hay duda.
 *
 * Devuelve `{ bounty }` cuando hay exactamente uno, o `{ reason }` cuando no lo
 * hay o cuando hay varios. **Nunca devuelve "el primero".**
 *
 * @param {object} o
 * @param {string[]} [o.funders] direcciones aceptadas como financiador. Si se
 *   pasa, cualquier otro queda fuera, y con eso un bounty de 1 wei de un
 *   desconocido no puede crear ambigüedad.
 */
export function bountyForIssue({ bounties, owner, repo, issue, verifier, funders, now = Date.now() }) {
  let cand = bounties.filter((b) => isLive(b, now) && pointsAtIssue(b.uri, owner, repo, issue));
  if (verifier) cand = cand.filter((b) => b.verifier === verifier.toLowerCase());
  if (funders && funders.length) {
    const ok = new Set(funders.map((f) => String(f).toLowerCase()));
    cand = cand.filter((b) => ok.has(b.funder));
  }

  if (cand.length === 1) return { bounty: cand[0] };
  if (cand.length === 0) {
    return { reason: `no open bounty points at issue #${issue}` };
  }
  return {
    reason: `${cand.length} open bounties point at issue #${issue} (${cand.map((b) => "#" + b.id).join(", ")}), `
      + "so there is nothing to choose. Put the one you mean in a `Bounty: #N` line, "
      + "or list the funders you accept in mergit.json",
    ambiguous: cand,
  };
}

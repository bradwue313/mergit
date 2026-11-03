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

async function logsOf(address) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`${EXPLORER}/api/v2/addresses/${address}/logs`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`explorer answered ${r.status}`);
    const d = await r.json();
    return (d.items || []).filter((it) => it.decoded).map((it) => {
      const p = Object.fromEntries(it.decoded.parameters.map((x) => [x.name, x.value]));
      return { kind: it.decoded.method_call.split("(")[0], ...p };
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Todos los bounties de los dos escrows, con su estado calculado de los eventos.
 * No firma nada y no necesita ABI.
 */
export async function listBounties() {
  const out = [];
  for (const { v, address, from } of ESCROWS) {
    let ev;
    try { ev = await logsOf(address); } catch { continue; }
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
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`${EXPLORER}/api/v2/addresses/${address}/logs`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`explorer answered ${r.status}`);
    const d = await r.json();
    for (const it of d.items || []) {
      if (!it.decoded || !it.decoded.method_call.startsWith("BountySettled")) continue;
      const p = Object.fromEntries(it.decoded.parameters.map((x) => [x.name, x.value]));
      if (String(p.bountyId) !== String(bountyId)) continue;
      return {
        developer: String(p.developer).toLowerCase(),
        paidToDeveloper: BigInt(p.paidToDeveloper),
        protocolFee: BigInt(p.protocolFee),
        evidenceHash: String(p.evidenceHash).toLowerCase(),
        tx: it.transaction_hash,
      };
    }
    return null;
  } finally {
    clearTimeout(t);
  }
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
  const limpio = String(uri || "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const re = new RegExp(`^github\\.com/${owner}/${repo}/issues/${number}(?:[^0-9]|$)`, "i");
  return re.test(limpio);
}

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

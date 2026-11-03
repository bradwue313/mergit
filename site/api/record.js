// El expediente de un builder, legible por una máquina: /record/<login>.json
//
// Existe porque el proyecto ya asume que lo leen agentes: están AGENTS.md y
// /llms.txt. Un agente que evalúa a quién encargarle trabajo no debería tener
// que raspar una página hecha para humanos.
//
// Mismas reglas que /p y que el badge, y por las mismas razones:
//   · no cuenta lo que una wallet se pagó a sí misma
//   · deja fuera los bounties 1 y 2 de la v1, que fueron pruebas de julio
//   · un financiador que no se pudo leer no cuenta, para no inflar el número
//
// **Nunca llama a api.github.com.** Las funciones de Vercel salen por IPs
// compartidas y el límite sin autenticar, 60 por hora, se agotaría para todos.
// raw.githubusercontent.com sí, porque es un CDN y no gasta esa cuota. Por eso
// este endpoint no reconstruye el historial de wallets: eso necesita la lista de
// commits, que sí es API, y vive en /p/<login>, que corre en el navegador.

const EXPLORER = "https://sepolia-explorer.giwa.io";
const REGISTRY = "0x79d44543d20c7c6653f6626687d67d2cd7f2af9c";
const ESCROWS = [
  { v: "v1", address: "0xffcf206ce1474263aaa3336fb9c8bc3d632e5879", from: 3 },
  { v: "v2", address: "0x48d506080abdbed11f1acbe40f799301d9612ad5", from: 1 },
];
const LOGIN_OK = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// Todas las páginas (50 eventos cada una, los más nuevos primero). Si una falla,
// falla todo: un historial a medias no se distingue de uno completo.
async function logsOf(address) {
  const out = [];
  let params = null;
  for (let pagina = 0; pagina < 40; pagina++) {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    let data;
    try {
      const res = await fetch(`${EXPLORER}/api/v2/addresses/${address}/logs${qs}`, { signal: ctl.signal });
      if (!res.ok) throw new Error(String(res.status));
      data = await res.json();
    } finally {
      clearTimeout(t);
    }
    for (const it of data.items || []) {
      if (!it.decoded) continue;
      const p = Object.fromEntries(it.decoded.parameters.map((x) => [x.name, x.value]));
      out.push({
        kind: it.decoded.method_call.split("(")[0],
        block: Number(it.block_number),
        tx: it.transaction_hash,
        time: it.block_timestamp,
        ...p,
      });
    }
    params = data.next_page_params;
    if (!params) return out;
  }
  throw new Error("the explorer kept paginating");
}

async function walletFromRegistry(login) {
  const want = login.toLowerCase();
  const events = await logsOf(REGISTRY);
  let claimed = null;
  for (const e of events) {
    if (e.kind === "Claimed" && String(e.login || "").toLowerCase() === want) {
      if (!claimed || e.block >= claimed.block) claimed = e;
    }
  }
  if (!claimed) return null;
  let releasedAt = -1;
  for (const e of events) {
    if (e.kind === "Released" && e.loginHash === claimed.loginHash && e.block > releasedAt) releasedAt = e.block;
  }
  if (releasedAt > claimed.block) return null;
  return String(claimed.wallet || "").toLowerCase();
}

async function walletFromProfile(login) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(login)}/${encodeURIComponent(login)}/HEAD/README.md`;
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const body = await res.text();
    const found = new Set();
    for (const line of body.split(/[\r\n]+/)) {
      if (!/mergit/i.test(line)) continue;
      const m = line.match(/0x[a-fA-F0-9]{40}/);
      if (m) found.add(m[0].toLowerCase());
    }
    const unique = [...found];
    return unique.length === 1 ? unique[0] : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=120, s-maxage=120");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const file = String((req.query && (req.query.file || req.query.login)) || "");
  const login = file.replace(/\.json$/i, "");

  if (!LOGIN_OK.test(login)) {
    return res.status(400).json({ error: "that login does not look like a GitHub login", login: file });
  }

  try {
    let wallet = await walletFromRegistry(login);
    let source = "registry";
    if (!wallet) {
      wallet = await walletFromProfile(login);
      source = "profile";
    }
    if (!wallet) {
      return res.status(200).json({
        login,
        wallet: null,
        source: "none",
        payments: [],
        totals: { bountiesPaid: 0, distinctFunders: 0, weiPaid: "0" },
        note: "No wallet is tied to this login yet. Put one line naming Mergit and an address in the README of github.com/<login>/<login>, or register at https://www.mergit.xyz/register",
        readAt: new Date().toISOString(),
      });
    }

    const payments = [];
    const funders = new Set();
    let total = 0n;
    let reached = 0;

    for (const { v, address, from } of ESCROWS) {
      let events;
      try {
        events = await logsOf(address);
        reached++;
      } catch {
        continue;
      }
      const posted = new Map();
      for (const e of events) {
        if (e.kind !== "BountyPosted") continue;
        posted.set(String(e.bountyId), { funder: String(e.funder || "").toLowerCase(), task: e.metadataURI || null });
      }
      for (const e of events) {
        if (e.kind !== "BountySettled") continue;
        if (String(e.developer || "").toLowerCase() !== wallet) continue;
        if (Number(e.bountyId) < from) continue;
        const info = posted.get(String(e.bountyId)) || {};
        const self = info.funder === wallet;
        payments.push({
          bountyId: Number(e.bountyId),
          escrow: v,
          contract: address,
          // El enunciado lo escribió quien financió el bounty, no Mergit. Va
          // marcado para que nadie lo lea como un hecho verificado.
          taskAsStatedByFunder: info.task ?? null,
          funder: info.funder || null,
          selfFunded: self,
          paidToDeveloperWei: String(e.paidToDeveloper ?? "0"),
          protocolFeeWei: String(e.protocolFee ?? "0"),
          evidenceHash: e.evidenceHash ?? null,
          transaction: e.tx,
          at: e.time,
        });
        if (self) continue;
        total += BigInt(e.paidToDeveloper ?? 0);
        if (info.funder) funders.add(info.funder);
      }
    }

    payments.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const earned = payments.filter((p) => !p.selfFunded);

    return res.status(200).json({
      login,
      wallet,
      source,
      chain: { name: "GIWA Sepolia", id: 91342, explorer: EXPLORER },
      totals: {
        bountiesPaid: earned.length,
        distinctFunders: funders.size,
        weiPaid: String(total),
        selfFundedNotCounted: payments.length - earned.length,
      },
      payments,
      complete: reached === ESCROWS.length,
      profile: `https://www.mergit.xyz/p/${login}`,
      note: "Every field here is read from GIWA Sepolia at request time. Mergit writes none of it. `taskAsStatedByFunder` is free text written by whoever funded the bounty and is not verified.",
      readAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ error: "could not read the chain", detail: String(e && e.message || e) });
  }
};

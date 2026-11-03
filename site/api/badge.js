// Badge para el README de un desarrollador: /badge/<login>.svg
//
// Lee la cadena y, si el registro no sabe nada, el README del perfil. **Nunca
// llama a api.github.com**: las funciones de Vercel salen por IPs compartidas y
// el límite sin autenticar (60/hora) se agota enseguida, con lo que el badge
// quedaría roto para todos. raw.githubusercontent.com sí, porque es un CDN y no
// gasta esa cuota. La comprobación de la prueba vive en /p/<login>, que corre en
// el navegador de quien mira.
//
// Cuenta con las mismas reglas que /p: no suma lo que una wallet se pagó a sí
// misma, deja fuera los bounties 1 y 2 de la v1 (pruebas de julio), y si no se
// pudo leer quién financió un pago, ese financiador no cuenta. El número se
// queda corto antes que inflarse.
//
// Muestra bounties y financiadores, nunca ETH: en testnet el ETH sale de un
// faucet y ordenar por eso sería ordenar por quién usó más el faucet.

const EXPLORER = "https://sepolia-explorer.giwa.io";
const REGISTRY = "0x79d44543d20c7c6653f6626687d67d2cd7f2af9c";
const ESCROWS = [
  { v: "v1", address: "0xffcf206ce1474263aaa3336fb9c8bc3d632e5879", from: 3 },
  { v: "v2", address: "0x48d506080abdbed11f1acbe40f799301d9612ad5", from: 1 },
];

const LOGIN_OK = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// Todas las páginas (50 eventos cada una). Con solo la primera, el total de la
// insignia bajaría cuando el escrow creciera, y se vería como dinero perdido.
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
      out.push({ kind: it.decoded.method_call.split("(")[0], block: Number(it.block_number), ...p });
    }
    params = data.next_page_params;
    if (!params) return out;
  }
  throw new Error("the explorer kept paginating");
}

/** Qué wallet tiene registrado ese login ahora mismo. */
async function walletFor(login) {
  const want = login.toLowerCase();
  const events = await logsOf(REGISTRY);
  let claimed = null;
  let releasedAt = -1;
  for (const e of events) {
    if (e.kind === "Claimed" && String(e.login || "").toLowerCase() === want) {
      if (!claimed || e.block >= claimed.block) claimed = e;
    }
  }
  if (!claimed) return null;
  // un login liberado después de registrarse deja de estar tomado
  for (const e of events) {
    if (e.kind === "Released" && e.loginHash === claimed.loginHash && e.block > releasedAt) releasedAt = e.block;
  }
  if (releasedAt > claimed.block) return null;
  return String(claimed.wallet || "").toLowerCase();
}

/**
 * El README del perfil, que es el camino gratis y el que usa casi todo el mundo.
 *
 * Sin esto el badge le decía "not registered" a quien sí cobra, que es el peor
 * sitio donde podía fallar: el badge es el expediente viajando, lo que un dev
 * pega en su propio README.
 *
 * Misma regla que `agent/registry.mjs`: una línea que nombre a Mergit y lleve
 * una dirección. Si hay varias distintas no se adivina y no se enseña nada.
 */
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

/** Pagos que le hizo otro, y cuántos financiadores distintos fueron. */
async function recordOf(wallet) {
  let bounties = 0;
  const funders = new Set();
  for (const { address, from } of ESCROWS) {
    let events;
    try {
      events = await logsOf(address);
    } catch {
      continue; // un escrow que no responde no puede inventar un pago
    }
    const posted = new Map();
    for (const e of events) {
      if (e.kind === "BountyPosted") posted.set(String(e.bountyId), String(e.funder || "").toLowerCase());
    }
    for (const e of events) {
      if (e.kind !== "BountySettled") continue;
      if (String(e.developer || "").toLowerCase() !== wallet) continue;
      if (Number(e.bountyId) < from) continue;
      const funder = posted.get(String(e.bountyId)) || "";
      if (funder === wallet) continue;     // se lo pagó a sí mismo
      bounties++;
      if (funder) funders.add(funder);     // un financiador ilegible no cuenta
    }
  }
  return { bounties, funders: funders.size };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function svg(right, tone) {
  const LEFT = "mergit";
  const w = (t) => Math.round(t.length * 6.3) + 20;
  const lw = w(LEFT), rw = w(right), total = lw + rw;
  const fill = tone === "on" ? "#ff2d2d" : "#55555d";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="mergit: ${esc(right)}">
  <title>mergit: ${esc(right)}</title>
  <rect width="${lw}" height="20" fill="#0a0a0b"/>
  <rect x="${lw}" width="${rw}" height="20" fill="${fill}"/>
  <g font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" fill="#fff">
    <text x="${lw / 2}" y="14" text-anchor="middle" fill="#ededf0">${LEFT}</text>
    <text x="${lw + rw / 2}" y="14" text-anchor="middle">${esc(right)}</text>
  </g>
</svg>`;
}

// ───────────────────────────── la tarjeta ─────────────────────────────
// El README de un dev ya suele llevar tarjetas de 165 px de alto. Un pill de
// 20 px al lado se ve pobre, asi que esta mide lo mismo que esas y encaja.
//
// Sin fuentes web: GitHub sirve estas imagenes por su proxy y una @font-face
// nunca carga. Se usan pilas del sistema.

const MARK = `<g transform="translate(26,24) scale(0.30)">
    <path d="M18 72 V24 L50 56 L82 24 V72" fill="none" stroke="#ededf0" stroke-width="12" stroke-linecap="square" stroke-linejoin="round"/>
    <line x1="50" y1="56" x2="50" y2="92" stroke="#ff2d2d" stroke-width="12"/>
    <circle cx="18" cy="24" r="8.5" fill="#ededf0"/><circle cx="82" cy="24" r="8.5" fill="#ededf0"/>
    <circle cx="50" cy="56" r="12" fill="#ff2d2d"/>
  </g>`;

const SANS = "ui-sans-serif,-apple-system,Segoe UI,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

function card(login, state, bounties, funders) {
  const W = 480, H = 170;
  const dim = state !== "paid";
  const big = (x, n, label) => `
    <text x="${x}" y="108" font-family="${SANS}" font-size="52" font-weight="700" fill="${dim ? "#3a3a44" : "#ededf0"}">${n}</text>
    <text x="${x}" y="129" font-family="${MONO}" font-size="10.5" letter-spacing="1.6" fill="#6a6a74">${label}</text>`;

  let body;
  if (state === "unknown") {
    body = `<text x="26" y="104" font-family="${SANS}" font-size="20" fill="#6a6a74">That login does not look right.</text>`;
  } else if (state === "none") {
    body = `<text x="26" y="96" font-family="${SANS}" font-size="20" fill="#8a8a93">No wallet yet.</text>
    <text x="26" y="124" font-family="${MONO}" font-size="11.5" fill="#55555d">mergit.xyz/start</text>`;
  } else if (state === "zero" || state === "ready") {
    body = `<text x="26" y="96" font-family="${SANS}" font-size="20" fill="#8a8a93">Ready to be paid. Nothing yet.</text>
    <text x="26" y="124" font-family="${MONO}" font-size="11.5" fill="#55555d">the record starts at the first merge</text>`;
  } else {
    body = big(26, bounties, bounties === 1 ? "BOUNTY PAID" : "BOUNTIES PAID")
         + big(210, funders, funders === 1 ? "FUNDER" : "DIFFERENT FUNDERS");
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Mergit record for ${esc(login)}">
  <title>Mergit record for ${esc(login)}</title>
  <rect width="${W}" height="${H}" rx="8" fill="#0a0a0b" stroke="#26262c"/>
  <rect x="0" y="0" width="4" height="${H}" rx="2" fill="#ff2d2d"/>
  ${MARK}
  <text x="62" y="39" font-family="${MONO}" font-size="12" letter-spacing="3.4" fill="#ededf0">MERGIT</text>
  <text x="${W - 26}" y="39" text-anchor="end" font-family="${MONO}" font-size="12.5" fill="#8a8a93">@${esc(login)}</text>
  <line x1="26" y1="56" x2="${W - 26}" y2="56" stroke="#1d1d22"/>
  ${body}
  <line x1="26" y1="143" x2="${W - 26}" y2="143" stroke="#17171c"/>
  <text x="26" y="160" font-family="${MONO}" font-size="10" letter-spacing="1.5" fill="#4a4a54">READ FROM GIWA SEPOLIA</text>
  <text x="${W - 26}" y="160" text-anchor="end" font-family="${MONO}" font-size="10" letter-spacing="1.5" fill="#4a4a54">MERGIT.XYZ</text>
</svg>`;
}

module.exports = async (req, res) => {
  // Pase lo que pase se devuelve un SVG válido con 200. Una imagen rota en el
  // README de alguien es peor que no tener badge.
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const file = String((req.query && req.query.file) || "");
  const login = file.replace(/\.svg$/i, "");
  // Dos formatos sobre los mismos datos: el pill para una fila de badges, la
  // tarjeta para ir al lado de las que ya suele haber en un README.
  const isCard = String((req.query && req.query.style) || "") === "card";
  const out = (state, b, f, texto, tono) =>
    isCard ? card(login, state, b, f) : svg(texto, tono);

  if (!LOGIN_OK.test(login)) return res.status(200).send(out("unknown", 0, 0, "unknown login", "off"));

  try {
    // el mismo orden que sigue el agente antes de pagar: registro, luego README
    let wallet = await walletFor(login);
    let fuente = "registry";
    if (!wallet) {
      wallet = await walletFromProfile(login);
      fuente = "profile";
    }
    if (!wallet) return res.status(200).send(out("none", 0, 0, "no wallet yet", "off"));

    const { bounties, funders } = await recordOf(wallet);
    if (!bounties) return res.status(200).send(out(fuente === "profile" ? "ready" : "zero", 0, 0, "ready to be paid", "on"));

    const b = bounties === 1 ? "1 bounty" : `${bounties} bounties`;
    return res.status(200).send(out("paid", bounties, funders, `${b} · ${plural(funders, "funder")}`, "on"));
  } catch {
    return res.status(200).send(isCard ? card(login, "none", 0, 0) : svg("chain unreachable", "off"));
  }
};

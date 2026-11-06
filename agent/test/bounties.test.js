// Pruebas de las reglas que deciden quÃ© bounty reclama un pull request.
// Sin red: donde hace falta `fetch`, se sustituye por un doble de prueba.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  pointsAtRepo,
  pointsAtIssue,
  LINEA_BOUNTY,
  closedIssues,
  bountyForIssue,
  logsOf,
} from "../bounties.mjs";

describe("pointsAtRepo", () => {
  it("reconoce el mismo repositorio con o sin esquema, www o ruta interna", () => {
    assert.equal(pointsAtRepo("https://github.com/odiseo159-beep/mergit", "odiseo159-beep", "mergit"), true);
    assert.equal(pointsAtRepo("http://www.github.com/odiseo159-beep/mergit/issues/17", "odiseo159-beep", "mergit"), true);
    assert.equal(pointsAtRepo("github.com/ODISEO159-BEEP/MERGIT?tab=readme", "odiseo159-beep", "mergit"), true);
    assert.equal(pointsAtRepo("  https://github.com/odiseo159-beep/mergit#readme  ", "odiseo159-beep", "mergit"), true);
  });

  it("rechaza un repositorio cuyo nombre solo empieza igual (mergit frente a mergit-demo)", () => {
    assert.equal(pointsAtRepo("https://github.com/odiseo159-beep/mergit-demo", "odiseo159-beep", "mergit"), false);
    assert.equal(pointsAtRepo("https://github.com/odiseo159-beep/mergit-demo/issues/1", "odiseo159-beep", "mergit"), false);
  });

  it("rechaza otro dominio que lleve la misma ruta", () => {
    assert.equal(pointsAtRepo("https://evil.example/github.com/odiseo159-beep/mergit", "odiseo159-beep", "mergit"), false);
    assert.equal(pointsAtRepo("https://notgithub.com/odiseo159-beep/mergit", "odiseo159-beep", "mergit"), false);
  });

  it("rechaza texto libre que no sea una referencia al repositorio", () => {
    assert.equal(pointsAtRepo("arreglar bug en odiseo159-beep/mergit", "odiseo159-beep", "mergit"), false);
    assert.equal(pointsAtRepo("ver https://github.com/odiseo159-beep/mergit", "odiseo159-beep", "mergit"), false);
    assert.equal(pointsAtRepo("", "odiseo159-beep", "mergit"), false);
  });
});

describe("pointsAtIssue", () => {
  it("reconoce el issue exacto y no confunde el #1 con el #10", () => {
    assert.equal(pointsAtIssue("https://github.com/odiseo159-beep/mergit/issues/1", "odiseo159-beep", "mergit", 1), true);
    assert.equal(pointsAtIssue("https://github.com/odiseo159-beep/mergit/issues/1#issuecomment-2", "odiseo159-beep", "mergit", 1), true);
    assert.equal(pointsAtIssue("https://github.com/odiseo159-beep/mergit/issues/10", "odiseo159-beep", "mergit", 1), false);
    assert.equal(pointsAtIssue("https://github.com/odiseo159-beep/mergit/issues/19", "odiseo159-beep", "mergit", 1), false);
  });

  it("trata el punto en el nombre del propietario o del repositorio como carÃ¡cter literal", () => {
    assert.equal(pointsAtIssue("https://github.com/a.b/mergit/issues/5", "a.b", "mergit", 5), true);
    assert.equal(pointsAtIssue("https://github.com/axb/mergit/issues/5", "a.b", "mergit", 5), false);
    assert.equal(pointsAtIssue("https://github.com/odiseo/my.repo/issues/5", "odiseo", "my.repo", 5), true);
    assert.equal(pointsAtIssue("https://github.com/odiseo/myXrepo/issues/5", "odiseo", "my.repo", 5), false);
  });
});

describe("LINEA_BOUNTY", () => {
  it("lee la lÃ­nea Bounty: #N con saltos de lÃ­nea de Windows (CRLF) y de Unix (LF)", () => {
    const crlf = "DescripciÃ³n del cambio\r\nBounty: #17\r\nMÃ¡s texto";
    const m1 = LINEA_BOUNTY.exec(crlf);
    assert.ok(m1);
    assert.equal(m1[1], "17");

    const sinAlmohadilla = "  bounty: 42 \t\r\n";
    const m2 = LINEA_BOUNTY.exec(sinAlmohadilla);
    assert.ok(m2);
    assert.equal(m2[1], "42");
  });

  it("no salta a la lÃ­nea siguiente cuando el nÃºmero estÃ¡ debajo", () => {
    const salto = "Bounty:\n#17";
    const saltoCrlf = "Bounty: \r\n#17";
    assert.equal(LINEA_BOUNTY.exec(salto), null);
    assert.equal(LINEA_BOUNTY.exec(saltoCrlf), null);
  });

  it("ignora una menciÃ³n en mitad de una frase", () => {
    const frase = "Este pull request reclama Bounty: #17 dentro de una oraciÃ³n.";
    const sufijo = "Bounty: #17 (opcional)";
    assert.equal(LINEA_BOUNTY.exec(frase), null);
    assert.equal(LINEA_BOUNTY.exec(sufijo), null);
  });
});

describe("closedIssues", () => {
  it("reconoce todas las formas de close, fix y resolve sin duplicar nÃºmeros", () => {
    const cuerpo = [
      "close #1, closes #2, closed #3",
      "fix #4, fixes #5, fixed #6",
      "resolve #7, resolves #8, resolved #9",
      "Closes: #10",
      "FIXES\t#11",
      "Resolves:   #1",
    ].join("\r\n");

    assert.deepEqual(closedIssues(cuerpo), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(closedIssues(""), []);
    assert.deepEqual(closedIssues(null), []);
  });
});

describe("bountyForIssue", () => {
  const ahora = 1_700_000_000_000;
  const futuro = Math.floor(ahora / 1000) + 3600;
  const pasado = Math.floor(ahora / 1000) - 3600;

  const crearBounty = (campos = {}) => ({
    id: "7",
    escrow: "v2",
    address: "0x48d506080abdbed11f1acbe40f799301d9612ad5",
    funder: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    verifier: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    amount: "10000000000000000",
    deadline: futuro,
    uri: "https://github.com/odiseo159-beep/mergit/issues/17",
    closed: false,
    ...campos,
  });

  it("devuelve exactamente un bounty cuando solo hay un candidato vivo", () => {
    const unico = crearBounty({ id: "11" });
    const cerrado = crearBounty({ id: "12", closed: true });
    const vencido = crearBounty({ id: "13", deadline: pasado });
    const otroIssue = crearBounty({ id: "14", uri: "https://github.com/odiseo159-beep/mergit/issues/16" });

    const res = bountyForIssue({
      bounties: [cerrado, vencido, otroIssue, unico],
      owner: "odiseo159-beep",
      repo: "mergit",
      issue: 17,
      now: ahora,
    });

    assert.deepEqual(res, { bounty: unico });
  });

  it("devuelve una razÃ³n cuando ningÃºn bounty abierto apunta al issue", () => {
    const res = bountyForIssue({
      bounties: [crearBounty({ closed: true })],
      owner: "odiseo159-beep",
      repo: "mergit",
      issue: 17,
      now: ahora,
    });

    assert.equal(res.bounty, undefined);
    assert.match(res.reason, /no open bounty points at issue #17/);
  });

  it("devuelve ambigÃ¼edad y no elige ninguno cuando dos bounties abiertos apuntan al mismo issue", () => {
    const primero = crearBounty({ id: "21", funder: "0x1111111111111111111111111111111111111111" });
    const impostor = crearBounty({ id: "22", funder: "0x2222222222222222222222222222222222222222", amount: "1" });

    const res = bountyForIssue({
      bounties: [primero, impostor],
      owner: "odiseo159-beep",
      repo: "mergit",
      issue: 17,
      now: ahora,
    });

    assert.equal(res.bounty, undefined);
    assert.deepEqual(res.ambiguous, [primero, impostor]);
    assert.match(res.reason, /2 open bounties point at issue #17 \(#21, #22\)/);
  });

  it("estrecha los candidatos con la lista de funders aceptados", () => {
    const legitimo = crearBounty({ id: "31", funder: "0xaaaa000000000000000000000000000000000001" });
    const ruido = crearBounty({ id: "32", funder: "0xdddd000000000000000000000000000000000002", amount: "1" });

    const res = bountyForIssue({
      bounties: [legitimo, ruido],
      owner: "odiseo159-beep",
      repo: "mergit",
      issue: 17,
      funders: ["0xAAAA000000000000000000000000000000000001"],
      now: ahora,
    });

    assert.deepEqual(res, { bounty: legitimo });
  });
});

describe("logsOf", () => {
  const fetchOriginal = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = fetchOriginal;
  });

  it("sigue next_page_params a travÃ©s de varias pÃ¡ginas y decodifica los eventos", async () => {
    const urlsLlamadas = [];
    globalThis.fetch = async (url) => {
      urlsLlamadas.push(String(url));
      if (urlsLlamadas.length === 1) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              items: [
                {
                  transaction_hash: "0xabc1",
                  decoded: {
                    method_call: "BountyPosted(uint256 bountyId, string metadataURI)",
                    parameters: [
                      { name: "bountyId", value: "5" },
                      { name: "metadataURI", value: "https://github.com/odiseo159-beep/mergit/issues/17" },
                    ],
                  },
                },
                {
                  transaction_hash: "0xignorado",
                  decoded: null,
                },
              ],
              next_page_params: { block_number: "100", index: "2" },
            };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            items: [
              {
                transaction_hash: "0xabc2",
                decoded: {
                  method_call: "BountySettled(uint256 bountyId, address developer)",
                  parameters: [
                    { name: "bountyId", value: "5" },
                    { name: "developer", value: "0x38e0f40371be8b30f0909f890a1f701a25cd30cd" },
                  ],
                },
              },
            ],
            next_page_params: null,
          };
        },
      };
    };

    const eventos = await logsOf("0x48d506080abdbed11f1acbe40f799301d9612ad5");
    assert.equal(urlsLlamadas.length, 2);
    assert.match(urlsLlamadas[0], /\/logs$/);
    assert.match(urlsLlamadas[1], /\?block_number=100&index=2$/);
    assert.deepEqual(eventos, [
      {
        kind: "BountyPosted",
        tx: "0xabc1",
        bountyId: "5",
        metadataURI: "https://github.com/odiseo159-beep/mergit/issues/17",
      },
      {
        kind: "BountySettled",
        tx: "0xabc2",
        bountyId: "5",
        developer: "0x38e0f40371be8b30f0909f890a1f701a25cd30cd",
      },
    ]);
  });

  it("lanza un error cuando falla una pÃ¡gina del explorador", async () => {
    let llamadas = 0;
    globalThis.fetch = async () => {
      llamadas++;
      if (llamadas === 1) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              items: [],
              next_page_params: { block_number: "50", index: "1" },
            };
          },
        };
      }
      return {
        ok: false,
        status: 503,
        async json() {
          return {};
        },
      };
    };

    await assert.rejects(
      () => logsOf("0x48d506080abdbed11f1acbe40f799301d9612ad5"),
      /explorer answered 503/,
    );
  });
});
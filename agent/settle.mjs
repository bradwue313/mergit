// Agente de verificación de Mergit — paso 2: pagar lo que el paso 1 aprobó.
//
// Verifica el pull request, comprueba que el bounty siga abierto y que este
// agente sea su verificador, y libera el escrow al desarrollador dejando el
// hash de la evidencia grabado en el evento BountySettled.
//
//   node settle.mjs --bounty 2 --pr https://github.com/owner/repo/pull/7
//   node settle.mjs --bounty 2 --pr owner/repo#7 --developer 0xabc... --send
//
// Sin --send no se firma nada: simula la transacción contra la cadena y
// reporta qué pasaría. Es el modo por defecto a propósito.
//
// También es una librería: on-event.mjs llama a settleBounty() cuando GitHub
// avisa de un merge o de un CI terminado.
import { createWalletClient, http, formatEther, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pathToFileURL } from "node:url";
import {
  giwaSepolia,
  EXPLORER,
  ABI,
  STATUS,
  escrowFlavor,
  publicClient,
  fail,
  loadSecrets,
  escrowAddress,
  parseTarget,
  args,
} from "./chain.mjs";
import { verifyPullRequest } from "./verify.mjs";

/** La clave del agente: variable de entorno en CI, archivo local en la laptop. */
function agentKey() {
  return process.env.MERGIT_AGENT_KEY || loadSecrets()?.deployer?.privateKey || null;
}

/**
 * Todo el camino, sin imprimir nada. Devuelve un resultado estructurado con la
 * etapa donde terminó, para que quien llame decida cómo contarlo.
 *
 *   stage: "verify" | "bounty" | "simulate" | "dry-run" | "paid"
 *   ok:    true solo en "dry-run" y "paid"
 *   done:  true si el bounty ya no estaba abierto (otra corrida lo pagó antes)
 */
export async function settleBounty({ bountyId, target, developer, send = false }) {
  const address = escrowAddress();
  // La v2 puede dejar el pago pendiente durante la ventana de objeción. Se
  // detecta por la interfaz del contrato, no por configuración.
  const flavor = await escrowFlavor(address);
  const contract = { address, abi: flavor.abi };
  const STATUS = flavor.status;
  const result = { bountyId: String(bountyId), escrow: address, developer, v2: flavor.v2 };

  // 1. ¿Existe el trabajo?
  const verdict = await verifyPullRequest(target);
  result.verdict = verdict;
  if (!verdict.verdict) return { ...result, stage: "verify", ok: false, reason: verdict.reasons.join("; ") };

  // 2. ¿El bounty admite el pago?
  let bounty;
  try {
    bounty = await publicClient.readContract({ ...contract, functionName: "getBounty", args: [BigInt(bountyId)] });
  } catch {
    return { ...result, stage: "bounty", ok: false, reason: `bounty ${bountyId} does not exist` };
  }
  const [payout, fee] = await publicClient.readContract({ ...contract, functionName: "quote", args: [bounty.amount] });
  Object.assign(result, { bounty, status: STATUS[bounty.status], payout, fee });

  // Un pago pendiente no se vuelve a liquidar: se finaliza cuando vence la ventana.
  if (STATUS[bounty.status] === "Pending") {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now < BigInt(bounty.claimableAt)) {
      return {
        ...result,
        stage: "pending",
        ok: true,
        reason: `settlement waiting out the challenge window`,
        claimableAt: Number(bounty.claimableAt),
        proposedDeveloper: bounty.developer,
      };
    }
    return finalizeBounty({ bountyId, contract, bounty, result, send });
  }

  if (STATUS[bounty.status] !== "Open") {
    return { ...result, stage: "bounty", ok: false, done: true, status: STATUS[bounty.status], reason: `bounty is ${STATUS[bounty.status]}` };
  }
  if (BigInt(bounty.deadline) <= BigInt(Math.floor(Date.now() / 1000))) {
    return { ...result, stage: "bounty", ok: false, reason: "deadline passed; only a refund to the funder is possible" };
  }

  // 3. Simular, y solo después firmar
  const key = agentKey();
  const account = key ? privateKeyToAccount(key) : null;
  if (account && account.address.toLowerCase() !== bounty.verifier.toLowerCase()) {
    return { ...result, stage: "bounty", ok: false, reason: `this agent (${account.address}) is not the bounty's verifier` };
  }
  let request;
  try {
    ({ request } = await publicClient.simulateContract({
      ...contract,
      functionName: "settle",
      args: [BigInt(bountyId), developer, verdict.evidenceHash],
      // sin clave se simula como el verificador del bounty: una lectura, no firma nada
      account: account ?? bounty.verifier,
    }));
  } catch (e) {
    return { ...result, stage: "simulate", ok: false, reason: e.shortMessage ?? e.message };
  }

  if (!send || !account) return { ...result, stage: "dry-run", ok: true };

  // 4. Liquidar
  const wallet = createWalletClient({ account, chain: giwaSepolia, transport: http() });
  const hash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  let event = null;
  for (const log of receipt.logs) {
    try {
      const e = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
      if (e.eventName === "BountySettled") event = e.args;
    } catch {
      // un log ajeno en el mismo recibo
    }
  }
  const proposed = receipt.logs.some((log) => {
    try {
      return decodeEventLog({ abi: contract.abi, data: log.data, topics: log.topics }).eventName === "SettlementProposed";
    } catch {
      return false;
    }
  });

  return {
    ...result,
    stage: proposed ? "proposed" : "paid",
    ok: true,
    tx: hash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    event,
    hashMatches: event?.evidenceHash === verdict.evidenceHash,
    url: `${EXPLORER}/tx/${hash}`,
  };
}

/** Suelta un pago que ya cumplió su ventana de objeción. Lo puede llamar cualquiera. */
async function finalizeBounty({ bountyId, contract, bounty, result, send }) {
  const key = agentKey();
  const account = key ? privateKeyToAccount(key) : null;
  let request;
  try {
    ({ request } = await publicClient.simulateContract({
      ...contract,
      functionName: "finalize",
      args: [BigInt(bountyId)],
      account: account ?? bounty.verifier,
    }));
  } catch (e) {
    return { ...result, stage: "simulate", ok: false, reason: e.shortMessage ?? e.message };
  }
  if (!send || !account) return { ...result, stage: "dry-run", ok: true, finalizing: true, developer: bounty.developer };

  const wallet = createWalletClient({ account, chain: giwaSepolia, transport: http() });
  const hash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  let event = null;
  for (const log of receipt.logs) {
    try {
      const e = decodeEventLog({ abi: contract.abi, data: log.data, topics: log.topics });
      if (e.eventName === "BountySettled") event = e.args;
    } catch {
      // un log ajeno en el mismo recibo
    }
  }
  return {
    ...result,
    stage: "paid",
    ok: true,
    finalized: true,
    developer: bounty.developer,
    tx: hash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    event,
    url: `${EXPLORER}/tx/${hash}`,
  };
}

// ─────────────────────────────── CLI ───────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = args();
  const bountyId = arg.value("bounty");
  const prTarget = arg.value("pr");
  const send = arg.has("send");

  if (!bountyId || !prTarget) {
    console.error("uso: node settle.mjs --bounty <id> --pr <url|owner/repo#n> [--developer 0x...] [--send]");
    process.exit(2);
  }
  const target = parseTarget(prTarget) ?? fail(`no entiendo el pull request: ${prTarget}`);
  const developer = arg.value("developer") ?? loadSecrets()?.developer?.address;
  if (!developer) fail("falta la dirección del desarrollador: pásala con --developer 0x...");
  if (send && !agentKey()) fail("no encuentro la clave del agente (MERGIT_AGENT_KEY o WALLETS.secret.json)");

  const r = await settleBounty({ bountyId, target, developer, send });
  const v = r.verdict;

  console.log("1. verificando el pull request\n");
  console.log(`   ${v.evidence.repository}#${v.evidence.pullRequest} por ${v.evidence.author}`);
  console.log(`   mergeado: ${v.merged ? "sí" : "no"} · CI: ${v.ciReason}`);
  console.log(`   evidencia: ${v.evidenceHash}`);
  if (r.stage === "verify") fail(`el trabajo no pasa la verificación (${r.reason})`);
  console.log("   veredicto: PAGAR\n");

  console.log("2. revisando el bounty on-chain\n");
  if (r.bounty) {
    console.log(`   escrow     : ${r.escrow}`);
    console.log(`   bounty     : #${bountyId} · ${r.status} · ${formatEther(r.bounty.amount)} ETH`);
    console.log(`   verificador: ${r.bounty.verifier}`);
    console.log(`   reparto    : ${formatEther(r.payout)} ETH al desarrollador, ${formatEther(r.fee)} ETH de comisión`);
    console.log(`   destino    : ${developer}\n`);
  }
  if (r.stage === "bounty") fail(r.reason);

  // Con ventana de objeción, un pago ya aprobado solo espera a que venza.
  if (r.stage === "pending") {
    const faltan = r.claimableAt - Math.floor(Date.now() / 1000);
    console.log("   el pago ya está aprobado y espera la ventana de objeción\n");
    console.log(`   destinatario : ${r.proposedDeveloper}`);
    console.log(`   cobrable a   : ${new Date(r.claimableAt * 1000).toISOString()}`);
    console.log(`   faltan       : ${Math.max(0, faltan)} segundos\n`);
    console.log("Vuelve a correr este mismo comando cuando venza, para finalizarlo.");
    process.exit(0);
  }

  console.log("3. simulando la liquidación\n");
  if (r.stage === "simulate") fail(`la cadena rechaza la transacción: ${r.reason}`);
  console.log("   la cadena acepta la transacción\n");

  if (r.stage === "dry-run") {
    console.log(`ensayo, no se firmó nada. Repite con --send para ${r.finalizing ? "finalizar el pago pendiente" : "liquidar"} de verdad.`);
    process.exit(0);
  }

  // La v2 con ventana no paga aquí: deja el pago propuesto y objetable.
  if (r.stage === "proposed") {
    console.log(`4. pago propuesto en el bloque ${r.block} (gas ${r.gasUsed})\n`);
    console.log(`   destinatario : ${developer}`);
    console.log(`   evidencia    : ${v.evidenceHash}`);
    console.log("\n   el financiador puede objetarlo una vez mientras corra la ventana.");
    console.log("   pasada la ventana, este mismo comando suelta el pago.");
    console.log(`\n${r.url}`);
    process.exit(0);
  }

  console.log(`4. ${r.finalized ? "finalizado" : "liquidado"} en el bloque ${r.block} (gas ${r.gasUsed})\n`);
  console.log(`   pagado al desarrollador: ${formatEther(r.event.paidToDeveloper)} ETH`);
  console.log(`   comisión de protocolo  : ${formatEther(r.event.protocolFee)} ETH`);
  console.log(`   evidencia on-chain     : ${r.event.evidenceHash}`);
  if (!r.finalized) console.log(`   coincide con el paso 1 : ${r.hashMatches ? "sí" : "NO"}`);
  console.log(`
${r.url}`);

}

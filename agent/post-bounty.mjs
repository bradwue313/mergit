// Publica un bounty en GIWA Sepolia bloqueando el ETH enviado.
//
// En producción esto lo hace el protocolo que financia, no el agente. Aquí
// sirve para dejar un bounty abierto contra el que probar la liquidación.
//
//   node post-bounty.mjs --uri "github.com/owner/repo/issues/1"
//   node post-bounty.mjs --uri "..." --amount 0.0005 --days 7 --send
//
// Sin --send simula contra la cadena y no firma nada.
import { createWalletClient, http, formatEther, parseEther, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  giwaSepolia,
  EXPLORER,
  ABI,
  escrowFlavor,
  publicClient,
  fail,
  loadSecrets,
  escrowAddress,
  args,
} from "./chain.mjs";

const arg = args();
const metadataURI = arg.value("uri");
const amount = parseEther(arg.value("amount") ?? "0.0005");
const days = Number(arg.value("days") ?? 14);
const send = arg.has("send");

if (!metadataURI) {
  console.error('uso: node post-bounty.mjs --uri "<referencia del trabajo>" [--amount 0.0005] [--days 14] [--window 0] [--account deployer|developer] [--verifier 0x…] [--send]');
  console.error('     --window son los segundos de objeción del financiador; solo la v2 del escrow los acepta.');
  console.error('     --account es la cuenta de WALLETS.secret.json que financia. Por defecto, deployer.');
  process.exit(2);
}

// El agente solo paga un bounty cuyo enunciado apunte al repositorio del pull
// request. Un texto libre bloquea dinero que nadie puede cobrar. Igual que /post.
if (!/^(https?:\/\/)?(www\.)?github\.com\/[^/\s]+\/[^/\s#?]+/i.test(metadataURI)) {
  fail('--uri tiene que ser un enlace de GitHub, mejor a un issue: "https://github.com/owner/repo/issues/7". Con texto libre ningún PR lo puede cobrar.');
}
if (!/\/issues\/\d+\/?$/i.test(metadataURI)) {
  console.log("aviso: --uri no apunta a un issue. Quien contribuya tendrá que escribir la línea exacta `Bounty: #N`, no le bastará con `Closes #N`.\n");
}

// Quién financia. Por defecto la del agente, que es como se probó la demo. Para
// un bounty de verdad conviene `--account developer --verifier <agente>`: si
// financiador y verificador son la misma cuenta, el verificador se paga a quien
// quiere con dinero que es suyo, y eso no demuestra nada.
const cual = arg.value("account") ?? "deployer";
const secrets = loadSecrets();
const funderKey = secrets?.[cual]?.privateKey;
if (!funderKey) fail(`no encuentro la clave de "${cual}" en WALLETS.secret.json`);

const funder = privateKeyToAccount(funderKey);
// En la demo de testnet el financiador y el verificador son la misma cuenta.
// Es una limitación conocida y está declarada en /docs: en producción son
// partes distintas, y el contrato ya lo soporta sin cambios.
const verifier = arg.value("verifier") ?? funder.address;
const deadline = BigInt(Math.floor(Date.now() / 1000) + days * 86400);

const address = escrowAddress();
const flavor = await escrowFlavor(address);
const contract = { address, abi: flavor.abi };

// La v2 acepta una ventana de objeción por bounty. Cero, el valor por defecto,
// se comporta como la v1: el pago sale en el mismo bloque que la verificación.
const windowSeconds = Number(arg.value("window") ?? 0);
if (windowSeconds && !flavor.v2) fail("este escrow no tiene ventana de objeción: es la v1");
const balance = await publicClient.getBalance({ address: funder.address });

console.log(`escrow      : ${contract.address}`);
console.log(`financiador : ${funder.address} (saldo ${formatEther(balance)} ETH)`);
console.log(`verificador : ${verifier}`);
console.log(`importe     : ${formatEther(amount)} ETH`);
console.log(`plazo       : ${days} días`);
console.log(`trabajo     : ${metadataURI}\n`);

if (balance < amount) fail(`saldo insuficiente: hacen falta ${formatEther(amount)} ETH más el gas`);

const { request } = await publicClient.simulateContract({
  ...contract,
  functionName: "postBounty",
  args: flavor.v2 ? [verifier, deadline, windowSeconds, metadataURI] : [verifier, deadline, metadataURI],
  value: amount,
  account: funder,
});
console.log("la cadena acepta la transacción\n");

if (!send) {
  console.log("ensayo, no se firmó nada. Repite con --send para publicar el bounty.");
  process.exit(0);
}

const wallet = createWalletClient({ account: funder, chain: giwaSepolia, transport: http() });
const hash = await wallet.writeContract(request);
console.log(`tx enviada : ${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`confirmada en el bloque ${receipt.blockNumber}\n`);

for (const log of receipt.logs) {
  try {
    const event = decodeEventLog({ abi: contract.abi, data: log.data, topics: log.topics });
    if (event.eventName !== "BountyPosted") continue;
    console.log(`bounty #${event.args.bountyId} abierto con ${formatEther(event.args.amount)} ETH bloqueados`);
    console.log(`\nliquídalo con:\n  node settle.mjs --bounty ${event.args.bountyId} --pr <url del PR> --send`);
  } catch {
    // Un log ajeno en el mismo recibo.
  }
}

console.log(`\n${EXPLORER}/tx/${hash}`);

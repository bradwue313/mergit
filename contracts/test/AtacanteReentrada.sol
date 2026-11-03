// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IMergitEscrow {
    function postBounty(address verifier, uint64 deadline, string calldata metadataURI)
        external
        payable
        returns (uint256 bountyId);

    function settle(uint256 bountyId, address developer, bytes32 evidenceHash) external;

    function refund(uint256 bountyId) external;
}

/// @title  AtacanteReentrada — contrato auxiliar de pruebas para atacar nonReentrant
/// @notice Puede actuar como financiador, verificador y desarrollador receptor de ETH.
///         Al recibir fondos del escrow, intenta reentrar en `settle` o en `refund`,
///         tanto sobre el mismo bounty como sobre otro distinto, y registra el resultado.
contract AtacanteReentrada {
    enum ModoAtaque {
        Ninguno,
        ReentrarSettle,
        ReentrarRefund
    }

    IMergitEscrow public immutable escrow;

    ModoAtaque public modo;
    uint256 public bountyObjetivo;
    bool public propagarFallo;

    bool public reentradaIntentada;
    bool public reentradaExitosa;
    bytes public errorReentrada;
    uint256 public totalRecibido;

    constructor(IMergitEscrow escrow_) {
        escrow = escrow_;
    }

    function publicarBounty(address verificador, uint64 plazo, string calldata uri)
        external
        payable
        returns (uint256)
    {
        return escrow.postBounty{value: msg.value}(verificador, plazo, uri);
    }

    function configurarAtaque(ModoAtaque modo_, uint256 bountyObjetivo_, bool propagarFallo_) external {
        modo = modo_;
        bountyObjetivo = bountyObjetivo_;
        propagarFallo = propagarFallo_;
        reentradaIntentada = false;
        reentradaExitosa = false;
        delete errorReentrada;
    }

    function ejecutarSettle(uint256 bountyId, bytes32 evidencia) external {
        escrow.settle(bountyId, address(this), evidencia);
    }

    function ejecutarRefund(uint256 bountyId) external {
        escrow.refund(bountyId);
    }

    receive() external payable {
        totalRecibido += msg.value;

        ModoAtaque m = modo;
        if (m == ModoAtaque.Ninguno) return;
        modo = ModoAtaque.Ninguno;

        bytes memory payload = m == ModoAtaque.ReentrarSettle
            ? abi.encodeCall(IMergitEscrow.settle, (bountyObjetivo, address(this), bytes32(uint256(1))))
            : abi.encodeCall(IMergitEscrow.refund, (bountyObjetivo));

        reentradaIntentada = true;
        (bool ok, bytes memory datos) = address(escrow).call(payload);
        reentradaExitosa = ok;
        errorReentrada = datos;

        if (!ok && propagarFallo) {
            assembly {
                revert(add(datos, 32), mload(datos))
            }
        }
    }
}

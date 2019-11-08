import { vxm } from "@/store/";
import { multiContractAction, SemiAction } from "../contracts/multi";
import { ReserveInstance } from "@/types/bancor";
import { TokenAmount } from "bancorx/build/interfaces";
import { Symbol } from "eos-common";
import { rpc } from "./rpc";
import { JsonRpc } from "eosjs";
import { tableApi, TableWrapper, ReserveTable } from "./TableWrapper";

interface Action {
  account: string;
  name: string;
  data: any;
  authorization: Auth[];
}

type TxResponse = any;

interface Auth {
  actor: string;
  permission: string;
}

type GetAuth = () => Auth[];

type TriggerTx = (actions: Action[]) => Promise<TxResponse>;

class MultiContractTx {
  contractName: string;
  getAuth: GetAuth;
  triggerTx: TriggerTx;
  table: TableWrapper;

  constructor(
    contractName: string,
    getAuth: GetAuth,
    triggerTx: TriggerTx,
    tableApi: TableWrapper
  ) {
    this.contractName = contractName;
    this.getAuth = getAuth;
    this.triggerTx = triggerTx;
    this.table = tableApi;
  }

  async tx(actions: SemiAction[]) {
    const authedActions = actions.map((action: SemiAction) => ({
      ...action,
      authorization: this.getAuth()
    }));
    return this.triggerTx(authedActions);
  }

  deleteReserve(symbolCode: string, currency: string): Promise<TxResponse> {
    const action = multiContractAction.delreserve(
      symbolCode,
      currency
    ) as SemiAction;
    return this.tx([action]);
  }

  async toggleReserve(
    symbolCode: string,
    reserveSymbol: Symbol
  ): Promise<TxResponse> {
    const reserves = await this.table.getReservesMulti(symbolCode);
    const singleReserve = reserves.find((reserve: ReserveTable) =>
      reserve.balance.symbol.isEqual(reserveSymbol)
    );
    if (!singleReserve) throw new Error("Failed to find reserve");
    const action = multiContractAction.setreserve(
      symbolCode,
      `${singleReserve.balance.symbol
        .precision},${singleReserve.balance.symbol.code()}`,
      singleReserve.contract,
      !singleReserve.sale_enabled,
      singleReserve.ratio
    ) as SemiAction;
    return this.tx([action]);
  }

  setReserveAction(
    symbolCode: string,
    symbol: string,
    tokenContract: string,
    saleEnabled: boolean,
    ratio: number
  ): SemiAction {
    const adjustedRatio = ratio * 10000;
    const action = multiContractAction.setreserve(
      symbolCode,
      symbol,
      tokenContract,
      saleEnabled,
      adjustedRatio
    ) as SemiAction;
    return action;
  }

  setReserve(
    symbolCode: string,
    symbol: string,
    tokenContract: string,
    saleEnabled: boolean,
    ratio: number
  ): Promise<TxResponse> {
    const action = this.setReserveAction(
      symbolCode,
      symbol,
      tokenContract,
      saleEnabled,
      ratio
    ) as SemiAction;
    return this.tx([action]);
  }

  updateOwner(symbolCode: string, owner: string): Promise<TxResponse> {
    const action = multiContractAction.updateowner(
      symbolCode,
      owner
    ) as SemiAction;
    return this.tx([action]);
  }

  fund(quantity: string) {
    const action = multiContractAction.fund(
      this.getAuth()[0].actor,
      quantity
    ) as SemiAction;
    return this.tx([action]);
  }

  enableConversion(symbolCode: string, enabled: boolean): Promise<TxResponse> {
    const action = multiContractAction.enablecnvrt(
      symbolCode,
      enabled
    ) as SemiAction;
    return this.tx([action]);
  }

  createRelay(
    symbol: string,
    precision: number,
    initialSupply: number,
    maxSupply: number
  ): Promise<TxResponse> {
    const owner = this.getAuth()[0].actor;

    const action = multiContractAction.create(
      owner,
      `${initialSupply.toFixed(precision)} ${symbol}`,
      `${maxSupply.toFixed(precision)} ${symbol}`
    ) as SemiAction;

    return this.tx([action]);
  }

  setupTransfer(
    tokenContract: string,
    amountString: string,
    symbolCode: string
  ) {
    return this.tx([
      {
        account: tokenContract,
        name: "transfer",
        data: {
          from: this.getAuth()[0].actor,
          to: this.contractName,
          quantity: amountString,
          memo: `setup;${symbolCode}`
        }
      }
    ]);
  }

  // Creates a relay, adds liquidity and immediately
  // hits enableconvrt action regardless of whether or not it should run
  // purely to put it in 'launched' mode to ensure further liquidity is
  // correctly imbursed
  kickStartRelay(
    symbolCode: string,
    reserves: TokenAmount[],
    active: boolean = true,
    initialSupply: number = 1000,
    maxSupply: number = 10000000000,
    precision: number = 4
  ) {
    const createRelayAction = multiContractAction.create(
      this.getAuth()[0].actor,
      `${initialSupply.toFixed(precision)} ${symbolCode}`,
      `${maxSupply.toFixed(precision)} ${symbolCode}`
    ) as SemiAction;

    const setReserveActions = reserves.map((reserve: TokenAmount) =>
      this.setReserveAction(
        symbolCode,
        `${reserve.amount.symbol.precision},${reserve.amount.symbol.code()}`,
        reserve.contract,
        true,
        50
      )
    );
    const addLiquidityActions = this.addLiquidityActions(
      symbolCode,
      reserves,
      false
    );
    const enableRelayAction = this.enableConversion(symbolCode, true);

    const actions: any[] = [
      createRelayAction,
      ...addLiquidityActions,
      enableRelayAction
    ];
    if (!active) {
      actions.push(this.enableConversion(symbolCode, false));
    }

    return this.tx(actions);
  }

  addLiquidity(
    symbolCode: string,
    tokens: TokenAmount[],
    launched: boolean = true
  ) {
    return this.tx(this.addLiquidityActions(symbolCode, tokens, launched));
  }

  addLiquidityActions(
    symbolCode: string,
    tokens: TokenAmount[],
    launched: boolean = true
  ) {
    return tokens.map((token: TokenAmount) => ({
      account: token.contract,
      name: `transfer`,
      data: {
        from: this.getAuth()[0].actor,
        to: this.contractName,
        quantity: token.amount.toString(),
        memo: `${launched ? "fund" : "setup"};${symbolCode}`
      }
    }));
  }

  fundTransfer(
    tokenContract: string,
    amountString: string,
    symbolCode: string
  ) {
    return this.tx([
      {
        account: tokenContract,
        name: `transfer`,
        data: {
          from: this.getAuth()[0].actor,
          to: this.contractName,
          quantity: amountString,
          memo: `fund;${symbolCode}`
        }
      }
    ]);
  }
}

const getAuth: GetAuth = () => {
  const wallet = vxm.eosTransit.wallet;
  return [
    {
      // @ts-ignore
      actor: wallet.auth.accountName,
      // @ts-ignore
      permission: wallet.auth.permission
    }
  ];
};

export const multiContract = new MultiContractTx(
  "welovebancor",
  getAuth,
  vxm.eosTransit.tx,
  tableApi
);
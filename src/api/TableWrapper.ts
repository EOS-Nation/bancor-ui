import { vxm } from "@/store";
import { JsonRpc } from 'eosjs'

class TableWrapper {

  multiContract: string;
  rpc: JsonRpc;

  constructor(multiContract: string, rpc: JsonRpc) {
    this.multiContract = multiContract
    this.rpc = rpc;
  }


  public async getReservesMulti(symbol: string) {
    const table = await this.rpc.get_table_rows({
      code: this.multiContract,
      table: "reserves",
      scope: symbol,
      limit: 10
    });

    return table.rows;
  }

  public async getSettingsMulti(symbol: string) {
    const table = await this.rpc.get_table_rows({
      code: this.multiContract,
      table: "converters",
      scope: symbol,
      limit: 1
    });

    return table.rows[0]
  }

  public async getReserves(contractName: string, scope = contractName): Promise<{
    contract: string;
    currency: string;
    p_enabled: number;
    ratio: number;
  }[]> {
    const table = await this.rpc.get_table_rows({
      code: contractName,
      table: "reserves",
      scope: scope,
      limit: 2
    });

    return table.rows;
  }

  public async getSettings(contractName: string, scope = contractName): Promise<{
    enabled: number;
    fee: number;
    max_fee: number;
    network: string;
    require_balance: number;
    smart_contract: string;
    smart_currency: string;
    smart_enabled: number;
  }> {
    const table = await this.rpc.get_table_rows({
      code: contractName,
      table: 'settings',
      scope,
      limit: 1
    })
    return table.rows[0]
  }
}


export const tableApi = new TableWrapper('welovebancor', vxm.eosTransit.accessContext.eosRpc);